/**
 * The clean config a fresh install produces.
 *
 * Rules are matched in order and the last match wins: the shell catch-all `ask` must come first
 * among shell rules and the deny rules after it, otherwise a deny is overridden by the ask and
 * reaches the classifier. `external_directory * → ask` is a separate action: it covers `cd` targets
 * and reads/edits outside the project, which never reach the plugin as shell resources.
 */

export interface PermissionRule {
  readonly action: "shell" | "external_directory";
  readonly resource: string;
  readonly effect: "ask" | "deny";
}

export const CATCH_ALL_RULE: PermissionRule = { action: "shell", resource: "*", effect: "ask" };

/**
 * `cd` and any read/edit outside the project arrive as `external_directory`, not as `shell`
 * resources, so the shell catch-all never sees them. OpenCode's default is `allow`; asking here
 * restores V1 behaviour and is what makes `cd /tmp` and reads/edits outside the project stop
 * before execution. The trade-off is that every such read/edit prompts too.
 */
export const EXTERNAL_DIRECTORY_RULE: PermissionRule = {
  action: "external_directory",
  resource: "*",
  effect: "ask",
};

export const DENY_RULES: readonly PermissionRule[] = [
  { action: "shell", resource: "git push --force*", effect: "deny" },
  { action: "shell", resource: "git push -f*", effect: "deny" },
  { action: "shell", resource: "git reset --hard*", effect: "deny" },
  { action: "shell", resource: "rm -rf*", effect: "deny" },
  { action: "shell", resource: "*--no-verify*", effect: "deny" },
  { action: "shell", resource: "*--dangerously-skip-permissions*", effect: "deny" },
];

export const PLUGIN_OPTIONS = { enabled: true } as const;

export const PACKAGE_NAME = "@str1kez/opencode-allow-classifier";

/** A config may reference the local checkout by path or the package by name. */
export function isPackageReference(value: string, packageRoot: string): boolean {
  return value === packageRoot || value === PACKAGE_NAME;
}

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
    permissions: [CATCH_ALL_RULE, EXTERNAL_DIRECTORY_RULE, ...DENY_RULES].map((rule) => ({ ...rule })),
    plugins: [{ package: packageRoot, options: { ...PLUGIN_OPTIONS } }],
  };
}

/** Two-space indentation, one rule per line and a trailing newline. */
export function cleanConfigText(packageRoot: string): string {
  const rules = [CATCH_ALL_RULE, EXTERNAL_DIRECTORY_RULE, ...DENY_RULES]
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
