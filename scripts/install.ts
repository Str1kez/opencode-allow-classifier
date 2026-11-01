import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { unifiedDiff } from "./diff.ts";
import {
  contentHash,
  toManifestEdits,
  writeManifest,
} from "./install-manifest.ts";
import type { InstallManifest } from "./install-manifest.ts";
import { applyEdits, findDuplicateKeys, parseJsonc, toValue } from "./jsonc.ts";
import type { JsoncDocument } from "./jsonc.ts";
import { DENY_RULES, cleanConfigText, isCleanConfig } from "./layout.ts";
import { planMerge } from "./merge.ts";
import type { MergeAdditions } from "./merge.ts";

export type InstallStatus = "created" | "merged" | "unchanged" | "conflict" | "invalid";

export interface InstallResult {
  readonly status: InstallStatus;
  readonly path: string;
  readonly message: string;
  /** Unified diff of the change, empty when there is nothing to compare. */
  readonly diff: string;
  /** Non-fatal problems: the config is installed, but the rollback record is missing. */
  readonly warnings: readonly string[];
}

export interface InstallOptions {
  /** Called with the diff right before the merged file is written. */
  readonly onDiff?: (diff: string) => void;
  /** Overrides the state directory for the install manifest; tests use a temp dir. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Installs the classifier into a config file.
 *
 * A missing or empty file gets the clean layout. A configured file is merged: only the missing
 * catch-all, `external_directory` ask rule, deny rules and plugin entry are added. Order violations
 * and incompatible values stop the install without touching the file. A successful change records
 * what was added so `rollback` can reverse exactly that later.
 */
export function installConfig(path: string, packageRoot: string, options: InstallOptions = {}): InstallResult {
  const configPath = resolve(path);

  if (!existsSync(path)) {
    return create(path, configPath, packageRoot, "", false, options);
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return invalid(path, `cannot read ${path}: ${errorMessage(error)}`);
  }

  if (text.trim() === "") {
    return create(path, configPath, packageRoot, text, true, options);
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
    return unchanged(path);
  }

  const result = planMerge(document, packageRoot);
  if (result.kind === "conflict") {
    const diff =
      result.proposedText === undefined
        ? ""
        : unifiedDiff(text, result.proposedText, diffLabels(path));
    return { status: "conflict", path, message: `refusing to merge ${path}: ${result.message}`, diff, warnings: [] };
  }

  if (result.plan.edits.length === 0) {
    return unchanged(path);
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

  const manifest: InstallManifest = {
    version: 1,
    configPath,
    postInstallHash: contentHash(merged),
    original: { exists: true, text },
    edits: toManifestEdits(text, result.plan.edits),
    additions: { ...result.plan.additions, schema: false, packageRoot },
  };

  return {
    status: "merged",
    path,
    message: `merged ${path}\nadded: ${describeAdditions(result.plan.additions)}`,
    diff,
    warnings: recordManifest(manifest, options.env),
  };
}

function create(
  path: string,
  configPath: string,
  packageRoot: string,
  originalText: string,
  originalExists: boolean,
  options: InstallOptions,
): InstallResult {
  const text = cleanConfigText(packageRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);

  const manifest: InstallManifest = {
    version: 1,
    configPath,
    postInstallHash: contentHash(text),
    original: { exists: originalExists, text: originalText },
    edits: [{ start: 0, end: originalText.length, before: originalText, after: text }],
    additions: {
      permissionsArray: true,
      pluginsArray: true,
      catchAll: true,
      externalDirectory: true,
      denyRules: DENY_RULES.map((rule) => rule.resource),
      plugin: "added",
      schema: true,
      packageRoot,
    },
  };

  return {
    status: "created",
    path,
    message: `created ${path}`,
    diff: "",
    warnings: recordManifest(manifest, options.env),
  };
}

function recordManifest(manifest: InstallManifest, env: NodeJS.ProcessEnv | undefined): string[] {
  try {
    writeManifest(manifest, env);
    return [];
  } catch (error) {
    return [`install manifest could not be written; rollback will not be available: ${errorMessage(error)}`];
  }
}

function unchanged(path: string): InstallResult {
  return { status: "unchanged", path, message: `config already installed: ${path}\nno changes`, diff: "", warnings: [] };
}

function invalid(path: string, reason: string): InstallResult {
  return { status: "invalid", path, message: `${reason}\nfile left unchanged`, diff: "", warnings: [] };
}

function diffLabels(path: string): { readonly from: string; readonly to: string } {
  return { from: `${path} (current)`, to: `${path} (proposed)` };
}

function describeAdditions(additions: MergeAdditions): string {
  const parts: string[] = [];

  if (additions.permissionsArray) {
    parts.push(`permissions array with catch-all ask, external_directory ask and ${additions.denyRules.length} deny rules`);
  } else {
    if (additions.catchAll) parts.push("catch-all ask");
    if (additions.externalDirectory) parts.push("external_directory ask");
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
