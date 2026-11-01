import {
  ALLOWLIST_RULES,
  GUARD_RULES,
  HARD_ASK_RULES,
  TRUSTED_PROGRAM_DIRECTORIES,
  type AllowlistRule,
  type GuardRule,
  type HardAskRule,
} from "./rules.ts";
import { findExecCommands } from "./find.ts";
import {
  escapesCwd,
  isPathLike,
  isTrustedProgramPath,
  programOf,
  resolvesOutsideCwd,
  resolvesToCwd,
  shellActiveText,
  tokenize,
  type RealPathResolver,
} from "./shell.ts";

export type Verdict = "allow" | "ask";

/**
 * Which stage produced the verdict. `cache` and `model` are unused until the classifier slice; they are
 * part of the contract now so the audit reader does not have to learn a second vocabulary later.
 * `default` marks the fall-through that asks the human because no rule matched yet.
 *
 * The runtime list and the type come from one place: the report must not keep a second copy of the
 * source vocabulary.
 */
export const DECISION_SOURCES = ["hard-ask", "allowlist", "default", "cache", "model", "error"] as const;
export type DecisionSource = (typeof DECISION_SOURCES)[number];

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
interface GlobalFlags {
  readonly withValue: readonly string[];
  readonly boolean: readonly string[];
  /**
   * Flags that take a value only attached (`--flag=value`). The spaced form is not a value: git
   * accepts `--exec-path=X` only, so `git --exec-path foo log` never runs `log` and must not match it.
   */
  readonly attachedValue?: readonly string[];
}

const PROGRAM_GLOBAL_FLAGS: Readonly<Record<string, GlobalFlags>> = {
  git: {
    withValue: ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"],
    boolean: ["--no-pager", "--bare", "--literal-pathspecs", "--no-replace-objects", "--no-optional-locks"],
    attachedValue: ["--exec-path"],
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

/** Number of leading tokens the program parses as its own global flags before the subcommand. */
function globalFlagsLength(program: string, args: ReadonlyArray<string>): number {
  const flags = PROGRAM_GLOBAL_FLAGS[program];
  if (flags === undefined) return 0;

  let index = 0;
  while (index < args.length) {
    const token = args[index]!;
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;

    if (flags.withValue.includes(name)) {
      index += token.includes("=") ? 1 : 2;
      continue;
    }
    if (flags.attachedValue?.includes(name) === true) {
      // The spaced form is not a global flag at all; stop here so the allowlist does not match.
      if (!token.includes("=")) break;
      index++;
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

  return index;
}

/** Drops global flags so `git -C /tmp push` and `npm --prefix . install` match their subcommand. */
function skipGlobalFlags(program: string, args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.slice(globalFlagsLength(program, args));
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

/**
 * The allowlist sees the command after the program's own global flags. `git -C dir log` is `git log`
 * with a path the outside-cwd guard still checks; `git -c key=value log` is skipped here too and then
 * caught by the `git-command-override` guard, because a config value can name a program to run.
 */
function allowlistTokens(tokens: ReadonlyArray<string>): ReadonlyArray<string> {
  const first = tokens[0];
  if (first === undefined) return tokens;
  return [first, ...skipGlobalFlags(programOf(first), tokens.slice(1))];
}

function matchesAllowlist(rule: AllowlistRule, tokens: ReadonlyArray<string>): boolean {
  const effective = allowlistTokens(tokens);
  if (effective.length < rule.prefix.length) return false;

  for (let index = 0; index < rule.prefix.length; index++) {
    const expected = rule.prefix[index];
    const actual = index === 0 ? programOf(effective[0]) : effective[index];
    if (expected !== actual) return false;
  }

  if (rule.exact === true && effective.length !== rule.prefix.length) return false;

  const args = effective.slice(rule.prefix.length);

  if (rule.script !== undefined) {
    const script = args[0];
    if (script === undefined || !rule.script.test(script)) return false;
    // Everything after the script must be a file operand. Any flag (`-i`, `-e`) and the `--`
    // terminator reject the rule: `sed -n '1p' file -i` still edits in place, and the terminator is
    // not worth reasoning about.
    if (args.slice(1).some((token) => token.startsWith("-") && token !== "-")) return false;
  }

  if (rule.allowedTokens === undefined) return true;

  return args.every((token) => rule.allowedTokens?.includes(token) === true);
}

/**
 * Every shape the shell could hand to the program: the raw resource, the same text with quotes removed
 * (`cat ".en""v"` is `.env`), the glued tokens, and the text with backslash escapes resolved
 * (`cat .\env` is `cat .env`). A guard fires when any of them matches.
 */
function guardTexts(segment: Segment): ReadonlyArray<string> {
  return [segment.text, segment.expanded, segment.tokens.join(" "), segment.text.replaceAll(/\\(.)/g, "$1")].map(
    (text) => text.toLowerCase(),
  );
}

/** `grep -r`, `-R`, `-rn`, `-d` and their long forms. */
const GREP_RECURSIVE_SHORT = /^-[^-]*[rRd]/;
const GREP_RECURSIVE_LONG: readonly string[] = ["--recursive", "--dereference-recursive", "--directories"];

/**
 * GNU getopt_long accepts any unambiguous prefix: `--recurs` and `--direct=recurse` mean the full names.
 * Comparing exactly is a one-letter bypass of every long-flag guard, so all of them go through here.
 */
function longFlagName(token: string): string | undefined {
  if (!token.startsWith("--") || token.length <= 2) return undefined;
  return token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
}

function matchesLongFlagPrefix(token: string, canonicals: ReadonlyArray<string>): boolean {
  const name = longFlagName(token);
  return name !== undefined && canonicals.some((canonical) => canonical.startsWith(name));
}

/** Grep flags whose next token is a value, never a search root. */
const GREP_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "-m",
  "-A",
  "-B",
  "-C",
  "-d",
  "--regexp",
  "--file",
  "--max-count",
  "--after-context",
  "--before-context",
  "--context",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--directories",
  "--devices",
  "--binary-files",
  "--label",
]);

/** True for `-e PATTERN` and its glued forms `-re PATTERN` / `-ePATTERN`. */
function takesPatternFromArgs(token: string): boolean {
  if (token.startsWith("--")) return matchesLongFlagPrefix(token, ["--regexp", "--file"]);
  return /^-[^-]*[ef]/.test(token);
}

function positionalOperands(args: ReadonlyArray<string>): string[] {
  const operands: string[] = [];
  let skipNext = false;
  let optionsEnded = false;

  for (const token of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!optionsEnded && token === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith("-") && token !== "-") {
      const name = longFlagName(token) ?? token;
      skipNext = token.includes("=") ? false : GREP_VALUE_FLAGS.has(name) || takesPatternFromArgs(token);
      continue;
    }
    operands.push(token);
  }

  return operands;
}

/**
 * `rg` flags that stop it from skipping hidden files, ignore files or binary files. Plain `rg` is a
 * different command: `-u`/`--no-ignore*` and friends make it read `.env` without naming it.
 */
const RG_UNRESTRICTED_LONG: readonly string[] = ["--unrestricted", "--hidden", "--binary", "--text", "--follow"];

function hasRgUnrestrictedFlag(tokens: ReadonlyArray<string>): boolean {
  return tokens.slice(1).some((token) => {
    if (token.startsWith("--")) {
      const name = longFlagName(token);
      return (
        matchesLongFlagPrefix(token, RG_UNRESTRICTED_LONG) ||
        (name !== undefined && name.startsWith("--no-ignore"))
      );
    }
    // Short clusters: `-u`, `-uuu`, `-a`, `-L`. `-U` (multiline) and `-A` (after-context) differ.
    return /^-[^-]*[uaL]/.test(token);
  });
}

/**
 * A recursive grep reads files whose names never appear in argv. The root is the last positional
 * operand, and grep defaults it to the working directory when no file operand is given at all:
 * `grep -r TODO` dumps every file in the project, `.env` included.
 */
function searchesCwdRecursively(tokens: ReadonlyArray<string>, cwd: string): boolean {
  const args = tokens.slice(1);
  const recursive = args.some((token) =>
    token.startsWith("--") ? matchesLongFlagPrefix(token, GREP_RECURSIVE_LONG) : GREP_RECURSIVE_SHORT.test(token),
  );
  if (!recursive) return false;

  const operands = positionalOperands(args);
  if (operands.some((operand) => resolvesToCwd(operand, cwd))) return true;

  // grep needs a pattern and at least one file; `-e` supplies the pattern separately.
  const patternByFlag = args.some((token) => takesPatternFromArgs(token));
  return operands.length < (patternByFlag ? 1 : 2);
}

/** Every path a token could name: the token itself, a `--flag=value` value and a `-fvalue` value. */
function pathCandidates(token: string): string[] {
  const candidates = [token];
  const equals = token.indexOf("=");
  if (equals > 0) candidates.push(token.slice(equals + 1));

  const attached = /^-[A-Za-z](.+)$/.exec(token);
  if (attached?.[1] !== undefined) candidates.push(attached[1]);
  return candidates;
}

function readsOutsideCwd(tokens: ReadonlyArray<string>, cwd: string, realpath: RealPathResolver | undefined): boolean {
  return tokens.slice(1).some((token) =>
    pathCandidates(token).some(
      (candidate) =>
        (isPathLike(candidate) && resolvesOutsideCwd(candidate, cwd, realpath)) ||
        // A bare name cannot escape lexically, but it can be a symlink to a file outside the project.
        (realpath !== undefined && escapesCwd(candidate, cwd, realpath)),
    ),
  );
}

function matchesGuard(rule: GuardRule, segment: Segment, cwd: string, realpath: RealPathResolver | undefined): boolean {
  if ("program" in rule && rule.program !== undefined && programOf(segment.tokens[0]) !== rule.program) return false;

  switch (rule.kind) {
    case "substring":
      // Case-insensitive because macOS filesystems are: `cat CREDENTIALS` reads the same file.
      return guardTexts(segment).some((text) => text.includes(rule.value));
    case "active-substring":
      // Quoting matters here: `rg 'a > b'` passes one literal argument and no shell acts on it, while
      // `rg "$(id)"` still expands inside double quotes.
      return shellActiveText(segment.text).includes(rule.value);
    case "metacharacter":
      // Quoted and escaped text is blanked first: `rg "a|b"` is one literal argument, `find -name
      // '*.ts'` never reaches the shell. Inside double quotes only `$`, backtick, `\` and `!` survive.
      // The trailing `{}` placeholder from `find -exec ... {} \;` is not an operator either; the
      // expression itself is validated by the `find-exec` guard.
      return rule.values.some((value) =>
        shellActiveText(segment.text)
          .trimEnd()
          .replaceAll("{}", " ")
          .includes(value),
      );
    case "token":
      return rule.values.some((value) => segment.tokens.includes(value));
    case "short-flag":
      // `-o out.patch` and `-oout.patch`, but not `--oneline`.
      return segment.tokens.some((token) => !token.startsWith("--") && token.startsWith(rule.value));
    case "short-cluster":
      // `-f`, `-1f`, `-10F`: the letter anywhere inside the cluster.
      return segment.tokens.some(
        (token) =>
          !token.startsWith("--") && token.startsWith("-") && rule.values.some((value) => token.slice(1).includes(value)),
      );
    case "long-flag":
      return segment.tokens.some((token) => matchesLongFlagPrefix(token, [rule.value]));
    case "program-path":
      return !isTrustedProgramPath(segment.tokens[0] ?? "", TRUSTED_PROGRAM_DIRECTORIES);
    case "outside-cwd":
      return readsOutsideCwd(segment.tokens, cwd, realpath);
    case "unrestricted-search":
      return hasRgUnrestrictedFlag(segment.tokens);
    case "cwd-root-search":
      return searchesCwdRecursively(segment.tokens, cwd);
    case "git-command-override": {
      // Only the global region counts: `git log -c` is git's combined-diff flag, not a config override.
      const args = segment.tokens.slice(1);
      const globalFlags = args.slice(0, globalFlagsLength("git", args));
      return globalFlags.some(
        (token) =>
          (token.startsWith("-c") && !token.startsWith("--")) ||
          longFlagName(token) === "--config-env" ||
          // Bare `--exec-path` only prints the path; the `=` form points the lookup elsewhere.
          token.startsWith("--exec-path="),
      );
    }
    case "find-exec": {
      // A read-only program can still carry a dangerous flag: `find . -exec grep -r x {} \;` recurses
      // into a directory and reads the files its name never mentions. Run the spawned argv through
      // every other guard, exactly as if it had been typed on its own.
      const commands = findExecCommands(segment.tokens);
      if (commands === undefined) return true;

      return commands.some((argv) => {
        const spawned: Segment = { text: argv.join(" "), expanded: argv.join(" "), tokens: argv };
        return GUARD_RULES.some((guard) => guard.kind !== "find-exec" && matchesGuard(guard, spawned, cwd, realpath));
      });
    }
  }
}

function finish(decision: Omit<Decision, "latency">, started: number): Decision {
  return { ...decision, latency: Math.round((performance.now() - started) * 100) / 100 };
}

/**
 * Verdict for a whole evaluation. Hard-ask anywhere wins; otherwise every resource must pass the same
 * two gates — an allowlist entry and the secret/write guard — or the whole call asks.
 *
 * `realpath` is only used to see through symlinks; without it the path guards compare strings.
 */
export function decide(
  resources: ReadonlyArray<string>,
  cwd: string,
  realpath?: RealPathResolver,
): Decision {
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

    const guard = GUARD_RULES.find((candidate) => matchesGuard(candidate, segment, cwd, realpath));
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
