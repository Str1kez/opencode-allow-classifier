/**
 * The clean config a fresh install produces.
 *
 * Rules are matched in order and the last match wins: the catch-all `ask` must come first and the
 * deny rules after it, otherwise a deny is overridden by the ask and reaches the classifier.
 */

export interface PermissionRule {
  readonly action: "shell";
  readonly resource: string;
  readonly effect: "ask" | "deny";
}

export const CATCH_ALL_RULE: PermissionRule = { action: "shell", resource: "*", effect: "ask" };

export const DENY_RULES: readonly PermissionRule[] = [
  { action: "shell", resource: "git push --force*", effect: "deny" },
  { action: "shell", resource: "git push -f*", effect: "deny" },
  { action: "shell", resource: "git reset --hard*", effect: "deny" },
  { action: "shell", resource: "rm -rf*", effect: "deny" },
  { action: "shell", resource: "*--no-verify*", effect: "deny" },
  { action: "shell", resource: "*--dangerously-skip-permissions*", effect: "deny" },
];

export const PLUGIN_OPTIONS = { enabled: true } as const;

export interface PermissionRuleValue {
  readonly action: string;
  readonly resource: string;
  readonly effect: string;
}

export interface PluginValue {
  readonly package: string;
  readonly options: Readonly<Record<string, unknown>>;
}

export interface ClassifierConfigValue {
  readonly $schema: string;
  readonly permissions: readonly PermissionRuleValue[];
  readonly plugins: readonly PluginValue[];
}

export function cleanConfigValue(packageRoot: string): ClassifierConfigValue {
  return {
    $schema: "https://opencode.ai/config.json",
    permissions: [CATCH_ALL_RULE, ...DENY_RULES].map((rule) => ({ ...rule })),
    plugins: [{ package: packageRoot, options: { ...PLUGIN_OPTIONS } }],
  };
}

/** Two-space indentation, one rule per line and a trailing newline. */
export function cleanConfigText(packageRoot: string): string {
  const rules = [CATCH_ALL_RULE, ...DENY_RULES]
    .map(
      (rule) =>
        `    { "action": ${quote(rule.action)}, "resource": ${quote(rule.resource)}, "effect": ${quote(rule.effect)} }`,
    )
    .join(",\n");

  return `{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
${rules}
  ],
  "plugins": [
    {
      "package": ${quote(packageRoot)},
      "options": {
        "enabled": true
      }
    }
  ]
}
`;
}

/** True when the parsed config is structurally the clean layout. Comments and formatting do not count. */
export function isCleanConfig(value: unknown, packageRoot: string): boolean {
  return sameJson(value, cleanConfigValue(packageRoot));
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameJson(item, right[index]));
  }

  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
  }

  return Object.is(left, right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
