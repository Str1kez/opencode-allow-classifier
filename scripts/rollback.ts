/**
 * Reverses an install using the manifest recorded by `installConfig`.
 *
 * The common case is exact: the file still has the hash install wrote, so the recorded edits are
 * replayed backwards and the original bytes come back. A file changed after install is only touched
 * when every recorded addition is still present and unmodified; otherwise rollback refuses and
 * leaves the file alone. A stale or missing manifest never guesses.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { unifiedDiff } from "./diff.ts";
import { contentHash, readManifest, removeManifest } from "./install-manifest.ts";
import type { InstallManifest } from "./install-manifest.ts";
import {
  applyEdits,
  findDuplicateKeys,
  lastMember,
  parseJsonc,
  removeArrayItems,
  removeObjectMember,
  replaceNode,
  toValue,
} from "./jsonc.ts";
import type { JsoncArrayNode, JsoncDocument, JsoncEdit, JsoncNode, JsoncObjectNode } from "./jsonc.ts";
import { PLUGIN_OPTIONS, isPackageReference } from "./layout.ts";

export type RollbackStatus = "rolled-back" | "nothing" | "conflict" | "invalid";

export interface RollbackResult {
  readonly status: RollbackStatus;
  readonly path: string;
  readonly message: string;
  /** Unified diff of the proposed removal. Printed before the file is written. */
  readonly diff: string;
}

export interface RollbackOptions {
  /** Called with the diff right before a rollback writes or deletes the file. */
  readonly onDiff?: (diff: string) => void;
  /** Overrides the state directory for the install manifest; tests use a temp dir. */
  readonly env?: NodeJS.ProcessEnv;
}

export function rollbackConfig(path: string, options: RollbackOptions = {}): RollbackResult {
  const env = options.env ?? process.env;

  let manifest: InstallManifest | undefined;
  try {
    manifest = readManifest(path, env);
  } catch (error) {
    return invalid(path, `${errorMessage(error)}\nfile left unchanged`);
  }

  if (manifest === undefined) {
    return nothing(path, `nothing to remove: ${path}\nno install manifest found`);
  }

  if (!existsSync(path)) {
    if (manifest.original.exists) {
      return conflict(
        path,
        `refusing to roll back ${path}: the config file is missing\nfile left unchanged`,
        unifiedDiff(manifest.original.text, "", labels(path)),
      );
    }
    removeManifest(path, env);
    return nothing(path, `nothing to remove: ${path}\nconfig is already gone`);
  }

  let current: string;
  try {
    current = readFileSync(path, "utf8");
  } catch (error) {
    return invalid(path, `cannot read ${path}: ${errorMessage(error)}\nfile left unchanged`);
  }

  if (contentHash(current) === manifest.postInstallHash) {
    let reversed: string;
    try {
      reversed = reverseEdits(current, manifest);
    } catch (error) {
      return invalid(path, `cannot reverse the recorded edits for ${path}: ${errorMessage(error)}\nfile left unchanged`);
    }

    const expected = manifest.original.exists ? manifest.original.text : "";
    if (reversed !== expected) {
      return invalid(
        path,
        `install manifest for ${path} does not reproduce the recorded original\nfile left unchanged`,
      );
    }

    return finish(path, manifest, current, manifest.original.exists ? reversed : null, env, options);
  }

  const plan = planNodeReversal(current, manifest);
  if (plan.problems.length > 0) {
    const installed = reconstructInstalled(manifest);
    const diff =
      installed === undefined
        ? ""
        : unifiedDiff(installed, current, { from: `${path} (installed)`, to: `${path} (current)` });
    const problems = plan.problems.map((problem) => `- ${problem}`).join("\n");
    return conflict(
      path,
      `refusing to roll back ${path}: the config changed after install and the added nodes were edited or removed\n${problems}\nfile left unchanged`,
      diff,
    );
  }

  let proposed: string;
  try {
    proposed = applyEdits(current, plan.edits);
    parseJsonc(proposed);
  } catch (error) {
    return invalid(
      path,
      `refusing to roll back ${path}: node reversal produced invalid JSONC (${errorMessage(error)})\nfile left unchanged`,
    );
  }

  // Install created this file, so an empty object is rollback residue, not user data. Comments and
  // members added after install survive the edits and keep the file.
  const next = !manifest.original.exists && isEmptyObjectText(proposed) ? null : proposed;
  return finish(path, manifest, current, next, env, options);
}

/**
 * Removing members keeps the whitespace around them, so the result is `{\n  \n}`, not `{}`. Any
 * comment left in the file is non-whitespace and makes this false.
 */
function isEmptyObjectText(text: string): boolean {
  return text.replace(/\s+/g, "") === "{}";
}

function finish(
  path: string,
  manifest: InstallManifest,
  current: string,
  next: string | null,
  env: NodeJS.ProcessEnv,
  options: RollbackOptions,
): RollbackResult {
  const diff = unifiedDiff(current, next ?? "", labels(path));
  options.onDiff?.(diff);

  if (next === null) unlinkSync(path);
  else writeFileSync(path, next);
  removeManifest(path, env);

  return {
    status: "rolled-back",
    path,
    message: next === null ? `rolled back ${path}\nconfig file removed` : `rolled back ${path}`,
    diff,
  };
}

/** Replays the applied edits backwards against the post-install text. */
function reverseEdits(postInstall: string, manifest: InstallManifest): string {
  const ordered = [...manifest.edits].sort((left, right) => left.start - right.start || left.end - right.end);
  const inverse: JsoncEdit[] = [];
  let delta = 0;

  for (const edit of ordered) {
    const start = edit.start + delta;
    inverse.push({ start, end: start + edit.after.length, text: edit.before });
    delta += edit.after.length - (edit.end - edit.start);
  }

  return applyEdits(postInstall, inverse);
}

/** The text install wrote, rebuilt from the original and the recorded edits. */
function reconstructInstalled(manifest: InstallManifest): string | undefined {
  const base = manifest.original.exists ? manifest.original.text : "";
  try {
    return applyEdits(
      base,
      manifest.edits.map((edit) => ({ start: edit.start, end: edit.end, text: edit.after })),
    );
  } catch {
    return undefined;
  }
}

interface NodeReversal {
  readonly edits: readonly JsoncEdit[];
  readonly problems: readonly string[];
}

function planNodeReversal(text: string, manifest: InstallManifest): NodeReversal {
  let document: JsoncDocument;
  try {
    document = parseJsonc(text);
  } catch (error) {
    return { edits: [], problems: [`the config is not valid JSONC (${errorMessage(error)})`] };
  }
  if (document.root.type !== "object") {
    return { edits: [], problems: ["the config root is not an object"] };
  }

  const root = document.root;
  const duplicates = findDuplicateKeys(root);
  if (duplicates.length > 0) {
    return {
      edits: [],
      problems: [`duplicate keys in the config (${duplicates.map((duplicate) => `${duplicate.path}.${duplicate.key}`).join(", ")})`],
    };
  }

  const problems: string[] = [];
  const edits: JsoncEdit[] = [];
  const additions = manifest.additions;

  planPermissions(text, root, manifest, edits, problems);
  planPlugins(text, root, manifest, edits, problems);

  if (additions.schema) {
    const schema = lastMember(root, "$schema");
    if (schema === undefined) {
      problems.push('the "$schema" member is missing');
    } else if (schema.value.type !== "string" || schema.value.value !== "https://opencode.ai/config.json") {
      problems.push('the "$schema" member was changed after install');
    } else {
      edits.push(removeObjectMember(text, root, "$schema"));
    }
  }

  if (problems.length > 0) return { edits: [], problems };
  return { edits: coalesceDeletions(edits), problems };
}

/** Adjacent member removals can claim the same comma; one merged deletion covers both. */
function coalesceDeletions(edits: readonly JsoncEdit[]): JsoncEdit[] {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: JsoncEdit[] = [];
  for (const edit of ordered) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      previous.text === "" &&
      edit.text === "" &&
      edit.start <= previous.end
    ) {
      merged[merged.length - 1] = { start: previous.start, end: Math.max(previous.end, edit.end), text: "" };
      continue;
    }
    merged.push(edit);
  }
  return merged;
}

function planPermissions(
  text: string,
  root: JsoncObjectNode,
  manifest: InstallManifest,
  edits: JsoncEdit[],
  problems: string[],
): void {
  const additions = manifest.additions;
  if (
    !additions.permissionsArray &&
    !additions.catchAll &&
    additions.externalDirectory !== true &&
    additions.denyRules.length === 0
  ) {
    return;
  }

  const array = findArray(root, "permissions", problems);
  if (array === undefined) return;

  const removed = new Set<number>();

  if (additions.catchAll) {
    const matches = matchingIndexes(array, (node) => isRule(node, "shell", "*", "ask"));
    if (matches.length !== 1) {
      problems.push(
        matches.length === 0
          ? "the catch-all ask rule added by install is missing or changed"
          : "more than one catch-all ask rule is present; cannot tell which one install added",
      );
    } else {
      removed.add(matches[0]!);
    }
  }

  if (additions.externalDirectory === true) {
    const matches = matchingIndexes(array, (node) => isRule(node, "external_directory", "*", "ask"));
    if (matches.length !== 1) {
      problems.push(
        matches.length === 0
          ? "the external_directory ask rule added by install is missing or changed"
          : "more than one external_directory ask rule is present; cannot tell which one install added",
      );
    } else {
      removed.add(matches[0]!);
    }
  }

  for (const resource of additions.denyRules) {
    const matches = matchingIndexes(array, (node) => isRule(node, "shell", resource, "deny"));
    if (matches.length !== 1) {
      problems.push(
        matches.length === 0
          ? `the deny rule ${JSON.stringify(resource)} added by install is missing or changed`
          : `more than one deny rule ${JSON.stringify(resource)} is present; cannot tell which one install added`,
      );
      continue;
    }
    removed.add(matches[0]!);
  }

  if (problems.length > 0) return;

  if (additions.permissionsArray && removed.size === array.items.length) {
    edits.push(removeObjectMember(text, root, "permissions"));
    return;
  }

  edits.push(...removeArrayItems(text, array, [...removed]));
}

function planPlugins(
  text: string,
  root: JsoncObjectNode,
  manifest: InstallManifest,
  edits: JsoncEdit[],
  problems: string[],
): void {
  const additions = manifest.additions;
  if (additions.plugin === "kept") return;

  const array = findArray(root, "plugins", problems);
  if (array === undefined) return;

  if (additions.plugin === "added") {
    const matches = matchingIndexes(array, (node) => isInstalledPlugin(node, additions.packageRoot));
    if (matches.length !== 1) {
      problems.push(
        matches.length === 0
          ? "the plugin entry added by install is missing or changed"
          : "more than one installed plugin entry is present; cannot tell which one install added",
      );
      return;
    }

    if (additions.pluginsArray && array.items.length === 1) {
      edits.push(removeObjectMember(text, root, "plugins"));
    } else {
      edits.push(...removeArrayItems(text, array, [matches[0]!]));
    }
    return;
  }

  if (additions.plugin === "replaced-string") {
    const matches = matchingIndexes(array, (node) => isInstalledPlugin(node, additions.packageRoot));
    if (matches.length !== 1) {
      problems.push("the plugin object that replaced the original string is missing or changed");
      return;
    }
    const original = additions.pluginString ?? additions.packageRoot;
    edits.push(replaceNode(array.items[matches[0]!]!, JSON.stringify(original)));
    return;
  }

  const entries = array.items.flatMap((item, index) =>
    item.type === "object" && isPackageReference(readString(item, "package") ?? "", additions.packageRoot)
      ? [{ item, index }]
      : [],
  );
  if (entries.length !== 1) {
    problems.push(
      entries.length === 0
        ? "the plugin entry whose options install added is missing"
        : "more than one plugin entry references this package; cannot tell where install added options",
    );
    return;
  }

  const entry = entries[0]!.item;
  const options = lastMember(entry, "options");
  if (options === undefined || !jsonEquals(options.value, PLUGIN_OPTIONS)) {
    problems.push("the plugin options added by install are missing or changed");
    return;
  }

  edits.push(removeObjectMember(text, entry, "options"));
}

function findArray(root: JsoncObjectNode, key: string, problems: string[]): JsoncArrayNode | undefined {
  const member = lastMember(root, key);
  if (member === undefined) {
    problems.push(`the ${JSON.stringify(key)} member is missing`);
    return undefined;
  }
  if (member.value.type !== "array") {
    problems.push(`${JSON.stringify(key)} is not an array`);
    return undefined;
  }
  return member.value;
}

function matchingIndexes(
  array: JsoncArrayNode,
  predicate: (node: JsoncNode) => boolean,
): number[] {
  return array.items.flatMap((item, index) => (predicate(item) ? [index] : []));
}

function isRule(node: JsoncNode, action: string, resource: string, effect: string): boolean {
  return (
    node.type === "object" &&
    readString(node, "action") === action &&
    readString(node, "resource") === resource &&
    readString(node, "effect") === effect
  );
}

function isInstalledPlugin(node: JsoncNode, packageRoot: string): boolean {
  if (node.type !== "object") return false;
  if (readString(node, "package") !== packageRoot) return false;
  const options = lastMember(node, "options");
  return options !== undefined && jsonEquals(options.value, PLUGIN_OPTIONS);
}

function readString(object: JsoncObjectNode, key: string): string | null {
  const member = lastMember(object, key);
  if (member === undefined || member.value.type !== "string") return null;
  return member.value.value as string;
}

function jsonEquals(node: JsoncNode, expected: unknown): boolean {
  return sameValue(toValue(node), expected);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameValue(item, right[index]));
  }

  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) => Object.hasOwn(right, key) && sameValue((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
    );
  }

  return Object.is(left, right);
}

function labels(path: string): { readonly from: string; readonly to: string } {
  return { from: `${path} (current)`, to: `${path} (rolled back)` };
}

function nothing(path: string, message: string): RollbackResult {
  return { status: "nothing", path, message, diff: "" };
}

function conflict(path: string, message: string, diff: string): RollbackResult {
  return { status: "conflict", path, message, diff };
}

function invalid(path: string, reason: string): RollbackResult {
  return { status: "invalid", path, message: reason, diff: "" };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
