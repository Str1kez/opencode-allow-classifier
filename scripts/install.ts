import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { unifiedDiff } from "./diff.ts";
import { applyEdits, findDuplicateKeys, parseJsonc, toValue } from "./jsonc.ts";
import type { JsoncDocument } from "./jsonc.ts";
import { cleanConfigText, isCleanConfig } from "./layout.ts";
import { planMerge } from "./merge.ts";
import type { MergeAdditions } from "./merge.ts";

export type InstallStatus = "created" | "merged" | "unchanged" | "conflict" | "invalid";

export interface InstallResult {
  readonly status: InstallStatus;
  readonly path: string;
  readonly message: string;
  /** Unified diff of the change, empty when there is nothing to compare. */
  readonly diff: string;
}

export interface InstallOptions {
  /** Called with the diff right before the merged file is written. */
  readonly onDiff?: (diff: string) => void;
}

/**
 * Installs the classifier into a config file.
 *
 * A missing or empty file gets the clean layout. A configured file is merged: only the missing
 * catch-all, deny rules and plugin entry are added. Order violations and incompatible values stop
 * the install without touching the file.
 */
export function installConfig(path: string, packageRoot: string, options: InstallOptions = {}): InstallResult {
  if (!existsSync(path)) {
    create(path, packageRoot);
    return { status: "created", path, message: `created ${path}`, diff: "" };
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return invalid(path, `cannot read ${path}: ${errorMessage(error)}`);
  }

  if (text.trim() === "") {
    create(path, packageRoot);
    return { status: "created", path, message: `created ${path}`, diff: "" };
  }

  let document: JsoncDocument;
  try {
    document = parseJsonc(text);
  } catch (error) {
    return invalid(path, `cannot parse ${path}: ${errorMessage(error)}`);
  }

  const value = toValue(document.root);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(path, `refusing to rewrite ${path}: config root must be an object`);
  }

  const duplicates = findDuplicateKeys(document.root);
  if (duplicates.length > 0) {
    const keys = duplicates.map((duplicate) => `${duplicate.path}.${duplicate.key}`).join(", ");
    return invalid(path, `refusing to rewrite ${path}: duplicate keys (${keys})`);
  }

  if (isCleanConfig(value, packageRoot)) {
    return { status: "unchanged", path, message: `config already installed: ${path}\nno changes`, diff: "" };
  }

  const result = planMerge(document, packageRoot);
  if (result.kind === "conflict") {
    const diff =
      result.proposedText === undefined
        ? ""
        : unifiedDiff(text, result.proposedText, diffLabels(path));
    return { status: "conflict", path, message: `refusing to merge ${path}: ${result.message}`, diff };
  }

  if (result.plan.edits.length === 0) {
    return { status: "unchanged", path, message: `config already installed: ${path}\nno changes`, diff: "" };
  }

  const merged = applyEdits(text, result.plan.edits);
  try {
    parseJsonc(merged);
  } catch (error) {
    return invalid(path, `refusing to write ${path}: merge produced invalid JSONC (${errorMessage(error)})`);
  }

  const diff = unifiedDiff(text, merged, diffLabels(path));
  options.onDiff?.(diff);
  writeFileSync(path, merged);

  return {
    status: "merged",
    path,
    message: `merged ${path}\nadded: ${describeAdditions(result.plan.additions)}`,
    diff,
  };
}

function create(path: string, packageRoot: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, cleanConfigText(packageRoot));
}

function invalid(path: string, reason: string): InstallResult {
  return { status: "invalid", path, message: `${reason}\nfile left unchanged`, diff: "" };
}

function diffLabels(path: string): { readonly from: string; readonly to: string } {
  return { from: `${path} (current)`, to: `${path} (proposed)` };
}

function describeAdditions(additions: MergeAdditions): string {
  const parts: string[] = [];

  if (additions.permissionsArray) {
    parts.push(`permissions array with catch-all ask and ${additions.denyRules.length} deny rules`);
  } else {
    if (additions.catchAll) parts.push("catch-all ask");
    if (additions.denyRules.length > 0) {
      parts.push(`${additions.denyRules.length} deny rule${additions.denyRules.length === 1 ? "" : "s"}`);
    }
  }

  if (additions.plugin === "added") parts.push("plugin entry");
  if (additions.plugin === "added-options") parts.push("plugin options");
  if (additions.plugin === "replaced-string") parts.push("plugin entry replaced string with an object");

  return parts.length > 0 ? parts.join(", ") : "changes";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
