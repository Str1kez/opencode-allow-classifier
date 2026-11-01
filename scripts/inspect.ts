import { findDuplicateKeys, lastMember, parseJsonc } from "./jsonc.ts";
import type { JsoncNode, JsoncObjectNode, JsoncScalarNode } from "./jsonc.ts";
import { CATCH_ALL_RULE, DENY_RULES, EXTERNAL_DIRECTORY_RULE, isPackageReference } from "./layout.ts";
import { parseTrustedCommands } from "../src/settings.ts";

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
  /** Non-empty `audit_dir` plugin option, or `null` when the default state directory applies. */
  readonly auditDir: string | null;
  /** Prefixes from `trusted_commands` that the plugin would actually accept. */
  readonly trustedCommands: readonly (readonly string[])[];
  readonly killSwitch: "enabled" | "disabled" | "unknown";
  readonly enabled: boolean | null;
}

export interface CatchAllReport {
  readonly present: boolean;
  readonly index: number | null;
  readonly firstAmongShell: boolean;
}

export interface ExternalDirectoryReport {
  readonly present: boolean;
  readonly index: number | null;
  readonly effect: string | null;
}

/**
 * Stable identifiers for inspect warnings. The prose in `warnings` is for humans and may be reworded;
 * automation keys on these codes, so `verify` never has to parse a sentence.
 *
 * Severity is not part of the code: `verify` owns the pass/warn/fail policy, and one code can carry
 * different weight there than a reader might expect.
 */
export const WARNING_CODES = [
  "config-root",
  "duplicate-key",
  "permissions",
  "catch-all-missing",
  "catch-all-multiple",
  "catch-all-order",
  "external-directory-missing",
  "external-directory-effect",
  "external-directory-stricter",
  "external-directory-multiple",
  "external-directory-dead-exception",
  "deny-missing",
  "deny-order",
  "plugin",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

interface Warning {
  readonly code: WarningCode;
  readonly text: string;
}

export interface InspectReport {
  readonly path: string;
  readonly exists: boolean;
  readonly rootType: JsoncNode["type"] | null;
  readonly rules: readonly RuleReport[];
  readonly catchAll: CatchAllReport;
  readonly externalDirectory: ExternalDirectoryReport;
  readonly denyAfterCatchAll: boolean;
  readonly missingDenyRules: readonly string[];
  readonly plugin: PluginReport;
  readonly warnings: readonly string[];
  /** One stable code per entry of `warnings`, in the same order. */
  readonly warningCodes: readonly WarningCode[];
}

/**
 * Reads the installed state out of a config. Warnings explain what is wrong; the caller decides what
 * to do. A syntactically valid config is always reportable, even when it is not installed.
 */
export function inspectConfig(text: string, path: string, packageRoot: string): InspectReport {
  const document = parseJsonc(text);
  const warnings: Warning[] = [];
  const warn = (code: WarningCode, message: string): void => {
    warnings.push({ code, text: message });
  };

  for (const duplicate of findDuplicateKeys(document.root)) {
    warn("duplicate-key", `duplicate key ${JSON.stringify(duplicate.key)} at ${duplicate.path}`);
  }
  const root = document.root;

  if (root.type !== "object") {
    warn("config-root", "config root is not an object");
    return {
      path,
      exists: true,
      rootType: root.type,
      rules: [],
      catchAll: { present: false, index: null, firstAmongShell: false },
      externalDirectory: { present: false, index: null, effect: null },
      denyAfterCatchAll: false,
      missingDenyRules: DENY_RULES.map((rule) => rule.resource),
      plugin: missingPlugin(),
      warnings: warnings.map((warning) => warning.text),
      warningCodes: warnings.map((warning) => warning.code),
    };
  }

  const rules = readRules(root, warnings);
  const shellRules = rules.filter((rule) => rule.action === "shell");
  const catchAllRules = rules.filter((rule) => rule.catchAll);
  const firstShell = shellRules[0]?.index ?? null;
  const catchAllIndex = catchAllRules[0]?.index ?? null;
  const firstAmongShell = catchAllIndex !== null && catchAllIndex === firstShell;

  if (catchAllIndex === null) {
    warn("catch-all-missing", `catch-all rule ${ruleLabel(CATCH_ALL_RULE)} is missing`);
  } else if (catchAllRules.length > 1) {
    warn("catch-all-multiple", `multiple catch-all rules at indexes ${catchAllRules.map((rule) => rule.index).join(", ")}`);
  }

  if (catchAllIndex !== null && !firstAmongShell) {
    warn(
      "catch-all-order",
      `catch-all is not the first shell rule (index ${catchAllIndex}, first shell rule is index ${firstShell})`,
    );
  }

  const externalDirectoryRules = rules.filter(
    (rule) => rule.action === EXTERNAL_DIRECTORY_RULE.action && rule.resource === EXTERNAL_DIRECTORY_RULE.resource,
  );
  const externalDirectory = externalDirectoryRules[0];
  if (externalDirectory === undefined) {
    warn(
      "external-directory-missing",
      `external_directory rule ${JSON.stringify(EXTERNAL_DIRECTORY_RULE.resource)} with effect ${JSON.stringify(EXTERNAL_DIRECTORY_RULE.effect)} is missing`,
    );
  } else if (externalDirectory.effect !== EXTERNAL_DIRECTORY_RULE.effect) {
    // A stricter `deny` only closes the policy further; anything else is a weaker rule than asked.
    const code = externalDirectory.effect === "deny" ? "external-directory-stricter" : "external-directory-effect";
    warn(
      code,
      `external_directory rule ${JSON.stringify(EXTERNAL_DIRECTORY_RULE.resource)} has effect ${JSON.stringify(externalDirectory.effect ?? "missing")}; expected ${JSON.stringify(EXTERNAL_DIRECTORY_RULE.effect)}`,
    );
  }
  if (externalDirectoryRules.length > 1) {
    warn(
      "external-directory-multiple",
      `multiple external_directory rules at indexes ${externalDirectoryRules.map((rule) => rule.index).join(", ")}`,
    );
  }
  if (externalDirectory !== undefined) {
    // Last match wins: a narrower rule before the catch-all can never apply, so its exception is dead.
    const deadExceptions = rules.filter(
      (rule) =>
        rule.action === EXTERNAL_DIRECTORY_RULE.action &&
        typeof rule.resource === "string" &&
        rule.resource !== EXTERNAL_DIRECTORY_RULE.resource &&
        rule.index < externalDirectory.index,
    );
    for (const rule of deadExceptions) {
      warn(
        "external-directory-dead-exception",
        `external_directory rule ${JSON.stringify(rule.resource)} at index ${rule.index} comes before the catch-all at index ${externalDirectory.index}; the catch-all wins by last match, so the narrower rule is dead`,
      );
    }
  }

  const denyRules = shellRules.filter((rule) => rule.effect === "deny");
  const denyResources = new Set(denyRules.map((rule) => rule.resource));
  const missingDenyRules = DENY_RULES.map((rule) => rule.resource).filter((resource) => !denyResources.has(resource));

  for (const resource of missingDenyRules) {
    warn("deny-missing", `deny rule ${JSON.stringify(resource)} is missing`);
  }

  if (catchAllIndex !== null) {
    for (const rule of denyRules) {
      if (rule.index < catchAllIndex) {
        warn(
          "deny-order",
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
    externalDirectory: {
      present: externalDirectory !== undefined,
      index: externalDirectory?.index ?? null,
      effect: externalDirectory?.effect ?? null,
    },
    denyAfterCatchAll,
    missingDenyRules,
    plugin,
    warnings: warnings.map((warning) => warning.text),
    warningCodes: warnings.map((warning) => warning.code),
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
  lines.push(
    `  external directory ask rule: ${yesNo(report.externalDirectory.present && report.externalDirectory.effect === "ask")}`,
  );
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

function readRules(root: JsoncObjectNode, warnings: Warning[]): RuleReport[] {
  const warn = (code: WarningCode, message: string): void => {
    warnings.push({ code, text: message });
  };
  const member = lastMember(root, "permissions");
  if (member === undefined) {
    warn("permissions", "permissions array is missing");
    return [];
  }
  if (member.value.type !== "array") {
    warn("permissions", "permissions is not an array");
    return [];
  }

  return member.value.items.map((item, index) => {
    if (item.type !== "object") {
      warn("permissions", `permissions[${index}] is not a rule object`);
      return { index, action: null, resource: null, effect: null, catchAll: false, valid: false };
    }

    const action = readString(item, "action");
    const resource = readString(item, "resource");
    const effect = readString(item, "effect");
    const catchAll = action === CATCH_ALL_RULE.action && resource === CATCH_ALL_RULE.resource && effect === CATCH_ALL_RULE.effect;

    if (action === null || resource === null || effect === null) {
      warn("permissions", `permissions[${index}] is not a complete rule object`);
      return { index, action, resource, effect, catchAll, valid: false };
    }

    return { index, action, resource, effect, catchAll, valid: true };
  });
}

function readPlugin(root: JsoncObjectNode, packageRoot: string, warnings: Warning[]): PluginReport {
  const warn = (code: WarningCode, message: string): void => {
    warnings.push({ code, text: message });
  };
  const member = lastMember(root, "plugins");
  if (member === undefined) {
    warn("plugin", "plugins array is missing");
    return missingPlugin();
  }
  if (member.value.type !== "array") {
    warn("plugin", "plugins is not an array");
    return missingPlugin();
  }
  if (member.value.items.length === 0) {
    warn("plugin", "plugins array has no entries");
    return missingPlugin();
  }

  const entries = member.value.items;
  const entry = entries.find((item) => referencesPackage(item, packageRoot));

  if (entry === undefined) {
    warn("plugin", `plugin entry for ${packageRoot} is not found`);
    return missingPlugin();
  }

  if (entry.type === "string") {
    warn("plugin", `plugin entry is a string; options cannot be passed`);
    return {
      present: true,
      type: "string",
      package: entry.value,
      packageMatches: true,
      options: { present: false, type: "missing" },
      auditDir: null,
      trustedCommands: [],
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
    warn("plugin", "plugin options are missing");
  } else if (optionsType === "other") {
    warn("plugin", "plugin options is not an object");
  }

  const optionsObject = optionsMember?.value.type === "object" ? optionsMember.value : null;
  const enabled = readEnabled(optionsObject, warnings);
  const killSwitch = enabled === null ? "unknown" : enabled ? "enabled" : "disabled";

  return {
    present: true,
    type: "object",
    package: packageName,
    packageMatches: true,
    options: { present: optionsPresent, type: optionsType },
    auditDir: readAuditDir(optionsObject),
    trustedCommands: readTrustedCommands(optionsObject),
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

function readEnabled(options: JsoncObjectNode | null, warnings: Warning[]): boolean | null {
  if (options === null) return null;
  const member = lastMember(options, "enabled");
  if (member === undefined) return null;
  if (member.value.type !== "boolean") {
    warnings.push({ code: "plugin", text: `plugin option "enabled" is not a boolean` });
    return null;
  }
  return member.value.value as boolean;
}

/** The plugin drops broken entries silently; inspect shows the list the plugin would actually match. */
function readTrustedCommands(options: JsoncObjectNode | null): readonly (readonly string[])[] {
  if (options === null) return [];
  const member = lastMember(options, "trusted_commands");
  if (member === undefined || member.value.type !== "array") return [];
  return parseTrustedCommands(member.value.items.map((item) => (item.type === "string" ? item.value : undefined)));
}

/** The plugin ignores an empty or non-string `audit_dir` and falls back to the state directory. */
function readAuditDir(options: JsoncObjectNode | null): string | null {
  if (options === null) return null;
  const value = readString(options, "audit_dir");
  return value === null || value.length === 0 ? null : value;
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
    auditDir: null,
    trustedCommands: [],
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
