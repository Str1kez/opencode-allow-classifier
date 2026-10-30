import {
  ALLOWLIST_RULES,
  GUARD_RULES,
  HARD_ASK_RULES,
  TRUSTED_PROGRAM_DIRECTORIES,
  type AllowlistRule,
  type GuardRule,
  type HardAskRule,
} from "./rules.ts";
import { isPathLike, isTrustedProgramPath, programOf, resolvesOutsideCwd, resolvesToCwd, tokenize } from "./shell.ts";

export type Verdict = "allow" | "ask";

/**
 * Which stage produced the verdict. `cache` and `model` are unused until the classifier slice; they are
 * part of the contract now so the audit reader does not have to learn a second vocabulary later.
 * `default` marks the fall-through that asks the human because no rule matched yet.
 */
export type DecisionSource = "hard-ask" | "allowlist" | "default" | "cache" | "model" | "error";

export interface Decision {
  readonly verdict: Verdict;
  readonly source: DecisionSource;
  readonly rule: string;
  readonly probability: number | null;
  readonly model: string | null;
  /** Milliseconds spent deciding, rounded to two decimals. */
  readonly latency: number;
}

interface Segment {
  /** Raw resource as the scanner produced it, quotes and all. */
  readonly text: string;
  /** Raw text with `"` and `'` removed: what the shell actually passes as one word. */
  readonly expanded: string;
  readonly tokens: ReadonlyArray<string>;
}

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Programs that hide the real command behind an env prefix. */
const WRAPPERS = new Set(["env", "nohup", "command", "time", "exec"]);
/** Wrapper flags that consume the next token, so `env -u HOME sudo` still exposes `sudo`. */
const WRAPPER_VALUE_FLAGS = new Set(["-u", "--unset", "-C", "--chdir", "-o", "--output", "-a"]);

/**
 * Global flags that stand between a program and its subcommand. Values are written as separate tokens
 * (`git -C /tmp push`) or attached (`--git-dir=/x`), which is why both forms are handled.
 */
const PROGRAM_GLOBAL_FLAGS: Readonly<Record<string, { readonly withValue: readonly string[]; readonly boolean: readonly string[] }>> = {
  git: {
    withValue: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"],
    boolean: ["--no-pager", "--paginate", "--bare", "--literal-pathspecs", "--no-replace-objects", "--no-optional-locks"],
  },
  npm: {
    withValue: ["--prefix", "--registry", "--cache", "--userconfig", "--loglevel", "--workspace", "-w"],
    boolean: ["--global", "-g", "--silent", "-s", "--quiet", "-q"],
  },
  pnpm: {
    withValue: ["--prefix", "-C", "--dir", "--filter", "-F", "--registry"],
    boolean: ["--global", "-g", "--silent", "-s"],
  },
  yarn: {
    withValue: ["--prefix", "--cwd", "--registry"],
    boolean: ["--silent", "-s"],
  },
  uv: {
    withValue: ["--directory", "--project", "--config-file"],
    boolean: ["--no-config", "-q", "--quiet"],
  },
  brew: { withValue: [], boolean: ["--quiet", "-q", "--verbose", "-v"] },
  cargo: { withValue: ["--root"], boolean: ["--quiet", "-q", "--verbose", "-v"] },
};

/**
 * Resolves the command a segment actually runs, skipping env assignments (`FOO=1`), wrappers (`env`,
 * `nohup`, `command`, `time`) and leading backslashes (`\sudo`). `undefined` means the segment only
 * consists of prefixes. Global program flags are left in place; the hard-ask matcher skips them.
 */
function commandOf(tokens: ReadonlyArray<string>): { readonly program: string; readonly args: ReadonlyArray<string> } | undefined {
  let index = 0;

  while (index < tokens.length) {
    let token = tokens[index]!;
    while (token.startsWith("\\")) token = token.slice(1);

    if (token.length === 0 || ENV_ASSIGNMENT.test(token)) {
      index++;
      continue;
    }

    const program = programOf(token);
    if (!WRAPPERS.has(program)) return { program, args: tokens.slice(index + 1) };

    index++;
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      index += WRAPPER_VALUE_FLAGS.has(tokens[index]!) ? 2 : 1;
    }
  }

  return undefined;
}

/** Drops global flags so `git -C /tmp push` and `npm --prefix . install` match their subcommand. */
function skipGlobalFlags(program: string, args: ReadonlyArray<string>): ReadonlyArray<string> {
  const flags = PROGRAM_GLOBAL_FLAGS[program];
  if (flags === undefined) return args;

  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;

    if (flags.withValue.includes(name)) {
      index += token.includes("=") ? 1 : 2;
      continue;
    }
    if (flags.boolean.includes(token)) {
      index++;
      continue;
    }
    // Attached short value: `-C/tmp`, `-cfoo=bar`.
    const attached = flags.withValue.some(
      (flag) => flag.startsWith("-") && !flag.startsWith("--") && token.startsWith(flag) && token.length > flag.length,
    );
    if (attached) {
      index++;
      continue;
    }
    break;
  }

  return args.slice(index);
}

/** Operands of `rm`: flags dropped, `--` honoured, `-` (stdin) is not a path. */
function rmOperands(tokens: ReadonlyArray<string>): string[] {
  const operands: string[] = [];
  let optionsEnded = false;

  for (const token of tokens.slice(1)) {
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-") && token !== "-") continue;
    operands.push(token);
  }

  return operands;
}

function matchesHardAsk(rule: HardAskRule, tokens: ReadonlyArray<string>, cwd: string): boolean {
  const command = commandOf(tokens);
  if (command === undefined || !rule.programs.includes(command.program)) return false;

  if (rule.scope === "outside-cwd") {
    return rmOperands([command.program, ...command.args]).some((operand) => resolvesOutsideCwd(operand, cwd));
  }
  if (rule.bare === true) return command.args.length === 0;
  if (rule.arguments === undefined) return true;

  const args = skipGlobalFlags(command.program, command.args);
  return rule.arguments.some((run) => run.every((expected, index) => args[index] === expected));
}

function matchesAllowlist(rule: AllowlistRule, tokens: ReadonlyArray<string>): boolean {
  if (tokens.length < rule.prefix.length) return false;

  for (let index = 0; index < rule.prefix.length; index++) {
    const expected = rule.prefix[index];
    const actual = index === 0 ? programOf(tokens[0]) : tokens[index];
    if (expected !== actual) return false;
  }

  if (rule.exact === true && tokens.length !== rule.prefix.length) return false;
  if (rule.allowedTokens === undefined) return true;

  return tokens.slice(rule.prefix.length).every((token) => rule.allowedTokens?.includes(token) === true);
}

function matchesLongFlag(token: string, value: string): boolean {
  // Exact or `--flag=value`; `--pretty` must not look like `--pre`.
  return token === value || token.startsWith(`${value}=`);
}

/**
 * Every shape the shell could hand to the program: the raw resource, the same text with quotes removed
 * (`cat ".en""v"` is `.env`), and the glued tokens. A guard fires when any of them matches.
 */
function guardTexts(segment: Segment): ReadonlyArray<string> {
  return [segment.text, segment.expanded, segment.tokens.join(" ")].map((text) => text.toLowerCase());
}

/** `grep -r`, `-R`, `-rn`, `-d` and their long forms. */
const GREP_RECURSIVE_SHORT = /^-[^-]*[rRd]/;
const GREP_RECURSIVE_LONG = new Set(["--recursive", "--dereference-recursive", "--directories"]);

/**
 * `rg` flags that stop it from skipping hidden files, ignore files or binary files. Plain `rg` is a
 * different command: `-u`/`--no-ignore*` and friends make it read `.env` without naming it.
 */
const RG_UNRESTRICTED_LONG = new Set(["--unrestricted", "--hidden", "--binary", "--text", "--follow"]);

function hasRgUnrestrictedFlag(tokens: ReadonlyArray<string>): boolean {
  return tokens.slice(1).some((token) => {
    if (token.startsWith("--")) {
      const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      return RG_UNRESTRICTED_LONG.has(name) || name.startsWith("--no-ignore");
    }
    // Short clusters: `-u`, `-uuu`, `-a`, `-L`. `-U` (multiline) and `-A` (after-context) differ.
    return /^-[^-]*[uaL]/.test(token);
  });
}

function searchesCwdRecursively(tokens: ReadonlyArray<string>, cwd: string): boolean {
  const args = tokens.slice(1);
  const recursive = args.some((token) => {
    if (token.startsWith("--")) {
      const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
      return GREP_RECURSIVE_LONG.has(name);
    }
    return GREP_RECURSIVE_SHORT.test(token);
  });
  if (!recursive) return false;

  // The root is cwd when a positional operand is `.`, `./` or the cwd path itself. A pattern of `.`
  // is indistinguishable here and asks too; a false ask costs one keypress.
  return args.some((token) => !token.startsWith("-") && resolvesToCwd(token, cwd));
}

function readsOutsideCwd(tokens: ReadonlyArray<string>, cwd: string): boolean {
  return tokens.slice(1).some((token) => isPathLike(token) && resolvesOutsideCwd(token, cwd));
}

function matchesGuard(rule: GuardRule, segment: Segment, cwd: string): boolean {
  if ("program" in rule && rule.program !== undefined && programOf(segment.tokens[0]) !== rule.program) return false;

  switch (rule.kind) {
    case "substring":
      // Case-insensitive because macOS filesystems are: `cat CREDENTIALS` reads the same file.
      return guardTexts(segment).some((text) => text.includes(rule.value));
    case "metacharacter":
      // Raw text on purpose: tokenizing glues `;` to the previous word and hides the operator.
      // Trailing whitespace is trimmed so a resource that ends in a newline from the scanner is not
      // mistaken for an internal line break; an internal newline still asks.
      return rule.values.some((value) => segment.text.trimEnd().includes(value));
    case "token":
      return rule.values.some((value) => segment.tokens.includes(value));
    case "short-flag":
      // `-o out.patch` and `-oout.patch`, but not `--oneline`.
      return segment.tokens.some((token) => !token.startsWith("--") && token.startsWith(rule.value));
    case "long-flag":
      return segment.tokens.some((token) => matchesLongFlag(token, rule.value));
    case "program-path":
      return !isTrustedProgramPath(segment.tokens[0] ?? "", TRUSTED_PROGRAM_DIRECTORIES);
    case "outside-cwd":
      return readsOutsideCwd(segment.tokens, cwd);
    case "unrestricted-search":
      return hasRgUnrestrictedFlag(segment.tokens);
    case "cwd-root-search":
      return searchesCwdRecursively(segment.tokens, cwd);
  }
}

function finish(decision: Omit<Decision, "latency">, started: number): Decision {
  return { ...decision, latency: Math.round((performance.now() - started) * 100) / 100 };
}

/**
 * Verdict for a whole evaluation. Hard-ask anywhere wins; otherwise every resource must pass the same
 * two gates — an allowlist entry and the secret/write guard — or the whole call asks.
 */
export function decide(resources: ReadonlyArray<string>, cwd: string): Decision {
  const started = performance.now();
  const segments: Segment[] = resources.map((text) => ({
    text,
    expanded: text.replace(/["']/g, ""),
    tokens: tokenize(text),
  }));

  if (segments.length === 0) {
    return finish({ verdict: "ask", source: "default", rule: "empty-resources", probability: null, model: null }, started);
  }

  for (const segment of segments) {
    const rule = HARD_ASK_RULES.find((candidate) => matchesHardAsk(candidate, segment.tokens, cwd));
    if (rule !== undefined) {
      return finish({ verdict: "ask", source: "hard-ask", rule: rule.name, probability: null, model: null }, started);
    }
  }

  const allowlistRules: string[] = [];

  for (const segment of segments) {
    const rule = ALLOWLIST_RULES.find((candidate) => matchesAllowlist(candidate, segment.tokens));
    if (rule === undefined) {
      return finish({ verdict: "ask", source: "default", rule: "no-allowlist-match", probability: null, model: null }, started);
    }

    const guard = GUARD_RULES.find((candidate) => matchesGuard(candidate, segment, cwd));
    if (guard !== undefined) {
      return finish(
        { verdict: "ask", source: "allowlist", rule: `guard:${guard.name}`, probability: null, model: null },
        started,
      );
    }

    if (!allowlistRules.includes(rule.name)) allowlistRules.push(rule.name);
  }

  return finish(
    { verdict: "allow", source: "allowlist", rule: allowlistRules.join(","), probability: null, model: null },
    started,
  );
}
