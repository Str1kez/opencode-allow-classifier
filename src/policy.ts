import { ALLOWLIST_RULES, GUARD_RULES, HARD_ASK_RULES, type AllowlistRule, type GuardRule, type HardAskRule } from "./rules.ts";
import { programOf, resolvesOutsideCwd, tokenize } from "./shell.ts";

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
  readonly text: string;
  readonly tokens: ReadonlyArray<string>;
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
  if (!rule.programs.includes(programOf(tokens[0]))) return false;

  if (rule.scope === "outside-cwd") return rmOperands(tokens).some((operand) => resolvesOutsideCwd(operand, cwd));
  if (rule.arguments === undefined) return true;

  return rule.arguments.some((run) => run.every((expected, index) => tokens[index + 1] === expected));
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

function matchesGuard(rule: GuardRule, segment: Segment): boolean {
  switch (rule.kind) {
    case "substring":
      // Case-insensitive because macOS filesystems are: `cat CREDENTIALS` reads the same file.
      return segment.text.toLowerCase().includes(rule.value);
    case "token":
      return rule.values.some((value) => segment.tokens.includes(value));
    case "short-flag":
      // `-o out.patch` and `-oout.patch`, but not `--oneline`.
      return segment.tokens.some((token) => !token.startsWith("--") && token.startsWith(rule.value));
    case "long-flag":
      return segment.tokens.some((token) => matchesLongFlag(token, rule.value));
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
  const segments: Segment[] = resources.map((text) => ({ text, tokens: tokenize(text) }));

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

    const guard = GUARD_RULES.find((candidate) => matchesGuard(candidate, segment));
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
