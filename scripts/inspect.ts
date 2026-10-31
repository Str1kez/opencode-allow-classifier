import { findDuplicateKeys, lastMember, parseJsonc } from "./jsonc.ts";
import type { JsoncNode, JsoncObjectNode, JsoncScalarNode } from "./jsonc.ts";
import { CATCH_ALL_RULE, DENY_RULES, isPackageReference } from "./layout.ts";

type JsoncStringNode = JsoncScalarNode & { readonly type: "string"; readonly value: string };

export interface RuleReport {
  readonly index: number;
  readonly action: string | null;
  readonly resource: string | null;
  readonly effect: string | null;
  readonly catchAll: boolean;
  readonly valid: boolean;
}

export interface OptionsReport {
  readonly present: boolean;
  readonly type: "object" | "missing" | "other";
}

export interface PluginReport {
  readonly present: boolean;
  readonly type: "object" | "string" | "missing";
  readonly package: string | null;
  readonly packageMatches: boolean;
  readonly options: OptionsReport;
  readonly killSwitch: "enabled" | "disabled" | "unknown";
  readonly enabled: boolean | null;
}

export interface CatchAllReport {
  readonly present: boolean;
  readonly index: number | null;
  readonly firstAmongShell: boolean;
}

export interface InspectReport {
  readonly path: string;
  readonly exists: boolean;
  readonly rootType: JsoncNode["type"] | null;
  readonly rules: readonly RuleReport[];
  readonly catchAll: CatchAllReport;
  readonly denyAfterCatchAll: boolean;
  readonly missingDenyRules: readonly string[];
  readonly plugin: PluginReport;
  readonly warnings: readonly string[];
}

/**
 * Reads the installed state out of a config. Warnings explain what is wrong; the caller decides what
 * to do. A syntactically valid config is always reportable, even when it is not installed.
 */
export function inspectConfig(text: string, path: string, packageRoot: string): InspectReport {
  const document = parseJsonc(text);
  const warnings = findDuplicateKeys(document.root).map(
    (duplicate) => `duplicate key ${JSON.stringify(duplicate.key)} at ${duplicate.path}`,
  );
  const root = document.root;

  if (root.type !== "object") {
    warnings.push("config root is not an object");
    return {
      path,
      exists: true,
      rootType: root.type,
      rules: [],
      catchAll: { present: false, index: null, firstAmongShell: false },
      denyAfterCatchAll: false,
      missingDenyRules: DENY_RULES.map((rule) => rule.resource),
      plugin: missingPlugin(),
      warnings,
    };
  }

  const rules = readRules(root, warnings);
  const shellRules = rules.filter((rule) => rule.action === "shell");
  const catchAllRules = rules.filter((rule) => rule.catchAll);
  const firstShell = shellRules[0]?.index ?? null;
  const catchAllIndex = catchAllRules[0]?.index ?? null;
  const firstAmongShell = catchAllIndex !== null && catchAllIndex === firstShell;

  if (catchAllIndex === null) {
    warnings.push(`catch-all rule ${ruleLabel(CATCH_ALL_RULE)} is missing`);
  } else if (catchAllRules.length > 1) {
    warnings.push(`multiple catch-all rules at indexes ${catchAllRules.map((rule) => rule.index).join(", ")}`);
  }

  if (catchAllIndex !== null && !firstAmongShell) {
    warnings.push(`catch-all is not the first shell rule (index ${catchAllIndex}, first shell rule is index ${firstShell})`);
  }

  const denyRules = shellRules.filter((rule) => rule.effect === "deny");
  const denyResources = new Set(denyRules.map((rule) => rule.resource));
  const missingDenyRules = DENY_RULES.map((rule) => rule.resource).filter((resource) => !denyResources.has(resource));

  for (const resource of missingDenyRules) {
    warnings.push(`deny rule ${JSON.stringify(resource)} is missing`);
  }

  if (catchAllIndex !== null) {
    for (const rule of denyRules) {
      if (rule.index < catchAllIndex) {
        warnings.push(
          `deny rule ${JSON.stringify(rule.resource)} at index ${rule.index} comes before the catch-all at index ${catchAllIndex}`,
        );
      }
    }
  }

  const denyAfterCatchAll =
    catchAllIndex !== null && denyRules.length > 0 && denyRules.every((rule) => rule.index > catchAllIndex);
  const plugin = readPlugin(root, packageRoot, warnings);

  return {
    path,
    exists: true,
    rootType: root.type,
    rules,
    catchAll: { present: catchAllIndex !== null, index: catchAllIndex, firstAmongShell },
    denyAfterCatchAll,
    missingDenyRules,
    plugin,
    warnings,
  };
}

export function formatInspectText(report: InspectReport): string {
  const lines = [`config: ${report.path}`, `exists: ${report.exists ? "yes" : "no"}`, `root: ${report.rootType ?? "unknown"}`];

  if (report.rules.length === 0) {
    lines.push("permissions: none");
  } else {
    lines.push("permissions:");
    for (const rule of report.rules) {
      const catchAll = rule.catchAll ? " (catch-all)" : "";
      const valid = rule.valid ? "" : " (invalid)";
      lines.push(
        `  ${rule.index}: ${rule.action ?? "?"} ${JSON.stringify(rule.resource ?? "?")} -> ${rule.effect ?? "?"}${catchAll}${valid}`,
      );
    }
  }

  lines.push("checks:");
  lines.push(`  catch-all first among shell rules: ${yesNo(report.catchAll.firstAmongShell)}`);
  lines.push(`  deny rules after catch-all: ${yesNo(report.denyAfterCatchAll)}`);
  lines.push(`  plugin entry: ${report.plugin.type}`);
  lines.push(
    `  plugin package: ${report.plugin.package ?? "none"} (matches: ${yesNo(report.plugin.packageMatches)})`,
  );
  lines.push(`  plugin options: ${report.plugin.options.type}`);
  lines.push(`  kill switch: ${report.plugin.killSwitch}`);
  lines.push(
    `  missing deny rules: ${
      report.missingDenyRules.length === 0
        ? "none"
        : report.missingDenyRules.map((resource) => JSON.stringify(resource)).join(", ")
    }`,
  );

  if (report.warnings.length === 0) {
    lines.push("warnings: none");
  } else {
    lines.push("warnings:");
    for (const warning of report.warnings) lines.push(`  - ${warning}`);
  }

  return `${lines.join("\n")}\n`;
}

export function formatInspectJson(report: InspectReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function readRules(root: JsoncObjectNode, warnings: string[]): RuleReport[] {
  const member = lastMember(root, "permissions");
  if (member === undefined) {
    warnings.push("permissions array is missing");
    return [];
  }
  if (member.value.type !== "array") {
    warnings.push("permissions is not an array");
    return [];
  }

  return member.value.items.map((item, index) => {
    if (item.type !== "object") {
      warnings.push(`permissions[${index}] is not a rule object`);
      return { index, action: null, resource: null, effect: null, catchAll: false, valid: false };
    }

    const action = readString(item, "action");
    const resource = readString(item, "resource");
    const effect = readString(item, "effect");
    const catchAll = action === CATCH_ALL_RULE.action && resource === CATCH_ALL_RULE.resource && effect === CATCH_ALL_RULE.effect;

    if (action === null || resource === null || effect === null) {
      warnings.push(`permissions[${index}] is not a complete rule object`);
      return { index, action, resource, effect, catchAll, valid: false };
    }

    return { index, action, resource, effect, catchAll, valid: true };
  });
}

function readPlugin(root: JsoncObjectNode, packageRoot: string, warnings: string[]): PluginReport {
  const member = lastMember(root, "plugins");
  if (member === undefined) {
    warnings.push("plugins array is missing");
    return missingPlugin();
  }
  if (member.value.type !== "array") {
    warnings.push("plugins is not an array");
    return missingPlugin();
  }
  if (member.value.items.length === 0) {
    warnings.push("plugins array has no entries");
    return missingPlugin();
  }

  const entries = member.value.items;
  const entry = entries.find((item) => referencesPackage(item, packageRoot));

  if (entry === undefined) {
    warnings.push(`plugin entry for ${packageRoot} is not found`);
    return missingPlugin();
  }

  if (entry.type === "string") {
    warnings.push(`plugin entry is a string; options cannot be passed`);
    return {
      present: true,
      type: "string",
      package: entry.value,
      packageMatches: true,
      options: { present: false, type: "missing" },
      killSwitch: "unknown",
      enabled: null,
    };
  }

  const packageName = readString(entry, "package");
  const optionsMember = lastMember(entry, "options");
  const optionsPresent = optionsMember !== undefined;
  const optionsType: OptionsReport["type"] =
    optionsMember === undefined ? "missing" : optionsMember.value.type === "object" ? "object" : "other";

  if (!optionsPresent) {
    warnings.push("plugin options are missing");
  } else if (optionsType === "other") {
    warnings.push("plugin options is not an object");
  }

  const enabled = readEnabled(optionsMember?.value.type === "object" ? optionsMember.value : null, warnings);
  const killSwitch = enabled === null ? "unknown" : enabled ? "enabled" : "disabled";

  return {
    present: true,
    type: "object",
    package: packageName,
    packageMatches: true,
    options: { present: optionsPresent, type: optionsType },
    killSwitch,
    enabled,
  };
}

function referencesPackage(entry: JsoncNode, packageRoot: string): entry is JsoncObjectNode | JsoncStringNode {
  if (entry.type === "string") return isPackageReference(entry.value as string, packageRoot);
  if (entry.type !== "object") return false;

  const packageName = readString(entry, "package");
  return packageName !== null && isPackageReference(packageName, packageRoot);
}

function readEnabled(options: JsoncObjectNode | null, warnings: string[]): boolean | null {
  if (options === null) return null;
  const member = lastMember(options, "enabled");
  if (member === undefined) return null;
  if (member.value.type !== "boolean") {
    warnings.push(`plugin option "enabled" is not a boolean`);
    return null;
  }
  return member.value.value as boolean;
}

function readString(object: JsoncObjectNode, key: string): string | null {
  const member = lastMember(object, key);
  if (member === undefined || member.value.type !== "string") return null;
  return member.value.value as string;
}

function missingPlugin(): PluginReport {
  return {
    present: false,
    type: "missing",
    package: null,
    packageMatches: false,
    options: { present: false, type: "missing" },
    killSwitch: "unknown",
    enabled: null,
  };
}

function ruleLabel(rule: { action: string; resource: string; effect: string }): string {
  return `{action: ${rule.action}, resource: ${JSON.stringify(rule.resource)}, effect: ${rule.effect}}`;
}

function yesNo(value: boolean): "yes" | "no" {
  return value ? "yes" : "no";
}
