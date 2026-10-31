/**
 * Plans a merge into an existing config.
 *
 * Only missing pieces are added: the catch-all, the required deny rules and the plugin entry.
 * Foreign rules, existing denies, user option values, comments and formatting stay in place.
 * Permission order is load-bearing, so a broken order is a conflict, never a silent rewrite.
 */

import {
  applyEdits,
  insertArrayItems,
  insertObjectMember,
  insertObjectMembers,
  lastMember,
  lineIndent,
  parseJsonc,
  removeArrayItems,
  replaceNode,
} from "./jsonc.ts";
import type { JsoncArrayNode, JsoncDocument, JsoncEdit, JsoncNode, JsoncObjectNode } from "./jsonc.ts";
import { CATCH_ALL_RULE, DENY_RULES, PLUGIN_OPTIONS, isPackageReference } from "./layout.ts";
import type { PermissionRule } from "./layout.ts";

export type PluginChange = "kept" | "added" | "added-options" | "replaced-string";

export interface MergeAdditions {
  /** The whole `permissions` array was added. */
  readonly permissionsArray: boolean;
  /** The whole `plugins` array was added. */
  readonly pluginsArray: boolean;
  readonly catchAll: boolean;
  /** Resources of the deny rules that were appended. */
  readonly denyRules: readonly string[];
  readonly plugin: PluginChange;
  /** Original string value when `plugin` is `replaced-string`. */
  readonly pluginString?: string;
}

export interface MergePlan {
  readonly edits: readonly JsoncEdit[];
  readonly additions: MergeAdditions;
}

export type MergeResult =
  | { readonly kind: "planned"; readonly plan: MergePlan }
  | {
      readonly kind: "conflict";
      readonly message: string;
      /** Correctly ordered hypothetical result, used only to print a proposed diff. */
      readonly proposedText?: string;
    };

interface RuleInfo {
  readonly index: number;
  readonly action: string | null;
  readonly resource: string | null;
  readonly effect: string | null;
}

interface MutableAdditions {
  permissionsArray: boolean;
  pluginsArray: boolean;
  catchAll: boolean;
  denyRules: string[];
  plugin: PluginChange;
  pluginString?: string;
}

export function planMerge(document: JsoncDocument, packageRoot: string): MergeResult {
  if (document.root.type !== "object") return conflict("config root is not an object");

  const edits: JsoncEdit[] = [];
  const rootMembers: string[] = [];
  const additions: MutableAdditions = {
    permissionsArray: false,
    pluginsArray: false,
    catchAll: false,
    denyRules: [],
    plugin: "kept",
  };

  const permissions = planPermissions(document, document.root, rootMembers, edits, additions, packageRoot);
  if (permissions !== null) return permissions;

  const plugins = planPlugins(document, document.root, rootMembers, edits, additions, packageRoot);
  if (plugins !== null) return plugins;

  if (rootMembers.length > 0) edits.push(insertObjectMembers(document, document.root, rootMembers));

  return { kind: "planned", plan: { edits, additions } };
}

function planPermissions(
  document: JsoncDocument,
  root: JsoncObjectNode,
  rootMembers: string[],
  edits: JsoncEdit[],
  additions: MutableAdditions,
  packageRoot: string,
): MergeResult | null {
  const member = lastMember(root, "permissions");
  if (member === undefined) {
    rootMembers.push(`"permissions": ${permissionsArrayText(document, root)}`);
    additions.permissionsArray = true;
    additions.catchAll = true;
    additions.denyRules.push(...DENY_RULES.map((rule) => rule.resource));
    return null;
  }

  if (member.value.type !== "array") return conflict('"permissions" is not an array');
  const array = member.value;
  const rules = readRules(array);
  const shellRules = rules.filter((rule) => rule.action === "shell");
  const firstShellIndex = shellRules[0]?.index ?? null;
  const catchAllRules = rules.filter(isCatchAll);

  if (catchAllRules.length > 1) {
    return conflict(`multiple catch-all rules at indexes ${catchAllRules.map((rule) => rule.index).join(", ")}`);
  }

  const catchAll = catchAllRules[0];
  if (catchAll !== undefined && catchAll.index !== firstShellIndex) {
    return orderConflict(document, array, catchAll, firstShellIndex, packageRoot);
  }

  const missing: PermissionRule[] = [];
  for (const required of DENY_RULES) {
    const sameResource = rules.filter(
      (rule) => rule.action === required.action && rule.resource === required.resource,
    );
    const differentEffect = sameResource.find((rule) => rule.effect !== required.effect);
    if (differentEffect !== undefined) {
      return conflict(
        `required deny rule ${JSON.stringify(required.resource)} exists with effect ${JSON.stringify(differentEffect.effect ?? "missing")}`,
      );
    }

    if (sameResource.length === 0) {
      missing.push(required);
      continue;
    }

    if (catchAll !== undefined && sameResource[0]!.index < catchAll.index) {
      return orderConflict(document, array, catchAll, firstShellIndex, packageRoot);
    }
  }

  const denyTexts = missing.map(ruleText);
  if (catchAll === undefined) {
    const insertIndex = firstShellIndex ?? array.items.length;
    if (insertIndex === array.items.length) {
      edits.push(insertArrayItems(document, array, insertIndex, [ruleText(CATCH_ALL_RULE), ...denyTexts]));
      additions.denyRules.push(...missing.map((rule) => rule.resource));
    } else {
      edits.push(insertArrayItems(document, array, insertIndex, [ruleText(CATCH_ALL_RULE)]));
      if (denyTexts.length > 0) {
        edits.push(insertArrayItems(document, array, array.items.length, denyTexts));
        additions.denyRules.push(...missing.map((rule) => rule.resource));
      }
    }
    additions.catchAll = true;
    return null;
  }

  if (denyTexts.length > 0) {
    edits.push(insertArrayItems(document, array, array.items.length, denyTexts));
    additions.denyRules.push(...missing.map((rule) => rule.resource));
  }

  return null;
}

function planPlugins(
  document: JsoncDocument,
  root: JsoncObjectNode,
  rootMembers: string[],
  edits: JsoncEdit[],
  additions: MutableAdditions,
  packageRoot: string,
): MergeResult | null {
  const member = lastMember(root, "plugins");
  if (member === undefined) {
    rootMembers.push(`"plugins": ${pluginsArrayText(document, root, packageRoot)}`);
    additions.plugin = "added";
    additions.pluginsArray = true;
    return null;
  }

  if (member.value.type !== "array") return conflict('"plugins" is not an array');
  const array = member.value;
  const matches = array.items.flatMap((item, index) => (referencesPackage(item, packageRoot) ? [{ item, index }] : []));

  if (matches.length === 0) {
    edits.push(insertArrayItems(document, array, array.items.length, [pluginObjectText(packageRoot)]));
    additions.plugin = "added";
    return null;
  }

  if (matches.length > 1) {
    return conflict(
      `multiple plugin entries for ${packageRoot} at indexes ${matches.map((match) => match.index).join(", ")}`,
    );
  }

  const entry = matches[0]!.item;
  if (entry.type === "string") {
    edits.push(replaceNode(entry, pluginObjectText(packageRoot)));
    additions.plugin = "replaced-string";
    additions.pluginString = entry.value as string;
    return null;
  }

  if (entry.type === "object" && lastMember(entry, "options") === undefined) {
    edits.push(insertObjectMember(document, entry, `"options": ${pluginOptionsText()}`));
    additions.plugin = "added-options";
  }

  return null;
}

function orderConflict(
  document: JsoncDocument,
  array: JsoncArrayNode,
  catchAll: RuleInfo,
  firstShellIndex: number | null,
  packageRoot: string,
): MergeResult {
  const message =
    `catch-all must be the first shell rule ` +
    `(found at index ${catchAll.index}, first shell rule is index ${firstShellIndex})\nfile left unchanged`;

  const proposedText = proposeOrderedMerge(document, array, catchAll.index, firstShellIndex, packageRoot);
  return proposedText === undefined ? { kind: "conflict", message } : { kind: "conflict", message, proposedText };
}

/**
 * Builds the file a correct order would have merged into. The real file is never reordered:
 * this text only feeds the diff shown to the user.
 */
function proposeOrderedMerge(
  document: JsoncDocument,
  array: JsoncArrayNode,
  catchAllIndex: number,
  firstShellIndex: number | null,
  packageRoot: string,
): string | undefined {
  if (firstShellIndex === null) return undefined;
  const reordered = moveCatchAllFirst(document, array, catchAllIndex, firstShellIndex);

  let reorderedDocument: JsoncDocument;
  try {
    reorderedDocument = parseJsonc(reordered);
  } catch {
    return undefined;
  }

  const merged = planMerge(reorderedDocument, packageRoot);
  if (merged.kind === "planned") return applyEdits(reordered, merged.plan.edits);

  // Another conflict stops the merge; the proposal still shows the order fix.
  return reordered;
}

function moveCatchAllFirst(
  document: JsoncDocument,
  array: JsoncArrayNode,
  catchAllIndex: number,
  firstShellIndex: number,
): string {
  const text = document.text;
  const catchAll = array.items[catchAllIndex]!;
  const firstShell = array.items[firstShellIndex]!;
  const multiline = text.slice(array.start, firstShell.start).includes("\n");
  const source = text.slice(catchAll.start, catchAll.end);
  const insertion = multiline ? `${source},\n${lineIndent(text, firstShell.start)}` : `${source}, `;

  return applyEdits(text, [
    ...removeArrayItems(text, array, [catchAllIndex]),
    { start: firstShell.start, end: firstShell.start, text: insertion },
  ]);
}

function readRules(array: JsoncArrayNode): RuleInfo[] {
  return array.items.map((item, index) => {
    if (item.type !== "object") return { index, action: null, resource: null, effect: null };
    return {
      index,
      action: readString(item, "action"),
      resource: readString(item, "resource"),
      effect: readString(item, "effect"),
    };
  });
}

function isCatchAll(rule: RuleInfo): boolean {
  return (
    rule.action === CATCH_ALL_RULE.action &&
    rule.resource === CATCH_ALL_RULE.resource &&
    rule.effect === CATCH_ALL_RULE.effect
  );
}

function referencesPackage(entry: JsoncNode, packageRoot: string): boolean {
  if (entry.type === "string") return isPackageReference(entry.value as string, packageRoot);
  if (entry.type !== "object") return false;
  const packageName = readString(entry, "package");
  return packageName !== null && isPackageReference(packageName, packageRoot);
}

function readString(object: JsoncObjectNode, key: string): string | null {
  const member = lastMember(object, key);
  if (member === undefined || member.value.type !== "string") return null;
  return member.value.value as string;
}

function permissionsArrayText(document: JsoncDocument, root: JsoncObjectNode): string {
  const childIndent = childIndentOf(document.text, root);
  const ruleIndent = childIndent + "  ";
  const rules = [CATCH_ALL_RULE, ...DENY_RULES].map(ruleText).join(`,\n${ruleIndent}`);
  return `[\n${ruleIndent}${rules}\n${childIndent}]`;
}

function pluginsArrayText(document: JsoncDocument, root: JsoncObjectNode, packageRoot: string): string {
  const childIndent = childIndentOf(document.text, root);
  return `[\n${childIndent}  ${pluginObjectText(packageRoot)}\n${childIndent}]`;
}

function childIndentOf(text: string, object: JsoncObjectNode): string {
  const last = object.members[object.members.length - 1];
  return last === undefined ? `${lineIndent(text, object.start)}  ` : lineIndent(text, last.start);
}

function ruleText(rule: PermissionRule): string {
  return (
    `{ "action": ${JSON.stringify(rule.action)}, ` +
    `"resource": ${JSON.stringify(rule.resource)}, ` +
    `"effect": ${JSON.stringify(rule.effect)} }`
  );
}

function pluginObjectText(packageRoot: string): string {
  return `{ "package": ${JSON.stringify(packageRoot)}, "options": ${pluginOptionsText()} }`;
}

function pluginOptionsText(): string {
  return `{ ${Object.entries(PLUGIN_OPTIONS)
    .map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`)
    .join(", ")} }`;
}

function conflict(message: string): MergeResult {
  return { kind: "conflict", message: `${message}\nfile left unchanged` };
}
