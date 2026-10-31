/**
 * Durable record of what an install added.
 *
 * #10 intentionally kept no record: the config itself was the evidence. Rollback needs the exact
 * pre-install state, so every successful write leaves one manifest outside the repo, keyed by the
 * absolute config path. The manifest stores the target config text (the file the owner already has)
 * plus the applied edits, never unrelated secrets.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { JsoncEdit } from "./jsonc.ts";
import type { MergeAdditions } from "./merge.ts";

export interface ManifestEdit {
  /** Start offset in the pre-install text. */
  readonly start: number;
  /** End offset in the pre-install text. */
  readonly end: number;
  /** Text that was at `[start, end)` before the install. */
  readonly before: string;
  /** Text install wrote at `start`. */
  readonly after: string;
}

export interface ManifestOriginal {
  readonly exists: boolean;
  /** Exact pre-install text; empty when the config did not exist. */
  readonly text: string;
}

export interface ManifestAdditions extends MergeAdditions {
  /** The clean layout's `$schema` member was added. */
  readonly schema: boolean;
  readonly packageRoot: string;
  /** Original string entry when install replaced it with an object. */
  readonly pluginString?: string;
}

export interface InstallManifest {
  readonly version: 1;
  readonly configPath: string;
  readonly postInstallHash: string;
  readonly original: ManifestOriginal;
  readonly edits: readonly ManifestEdit[];
  readonly additions: ManifestAdditions;
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function manifestPathFor(configPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = createHash("sha256").update(resolve(configPath), "utf8").digest("hex");
  return join(stateHome(env), "opencode-allow-classifier", "install-state", `${key}.json`);
}

export function toManifestEdits(text: string, edits: readonly JsoncEdit[]): ManifestEdit[] {
  return edits.map((edit) => ({
    start: edit.start,
    end: edit.end,
    before: text.slice(edit.start, edit.end),
    after: edit.text,
  }));
}

export function readManifest(
  configPath: string,
  env: NodeJS.ProcessEnv = process.env,
): InstallManifest | undefined {
  const path = manifestPathFor(configPath, env);
  if (!existsSync(path)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`cannot read install manifest ${path}: ${errorMessage(error)}`);
  }
  return validateManifest(parsed, configPath, path);
}

export function writeManifest(manifest: InstallManifest, env: NodeJS.ProcessEnv = process.env): void {
  const path = manifestPathFor(manifest.configPath, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function removeManifest(configPath: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(manifestPathFor(configPath, env), { force: true });
}

function stateHome(env: NodeJS.ProcessEnv): string {
  const configured = env.XDG_STATE_HOME;
  if (configured !== undefined && configured.length > 0) return resolve(configured);
  return join(env.HOME ?? homedir(), ".local", "state");
}

function validateManifest(value: unknown, configPath: string, path: string): InstallManifest {
  const manifest = value as Partial<InstallManifest> | null;
  if (manifest === null || typeof manifest !== "object") {
    throw new Error(`invalid install manifest ${path}: expected an object`);
  }
  if (manifest.version !== 1) {
    throw new Error(`invalid install manifest ${path}: unsupported version ${String(manifest.version)}`);
  }
  if (typeof manifest.configPath !== "string" || resolve(manifest.configPath) !== resolve(configPath)) {
    throw new Error(`invalid install manifest ${path}: config path does not match ${resolve(configPath)}`);
  }
  if (typeof manifest.postInstallHash !== "string") {
    throw new Error(`invalid install manifest ${path}: missing post-install hash`);
  }
  if (manifest.original === undefined || typeof manifest.original.exists !== "boolean") {
    throw new Error(`invalid install manifest ${path}: missing original state`);
  }
  if (typeof manifest.original.text !== "string") {
    throw new Error(`invalid install manifest ${path}: missing original text`);
  }
  if (!Array.isArray(manifest.edits)) {
    throw new Error(`invalid install manifest ${path}: missing edits`);
  }
  for (const edit of manifest.edits as unknown[]) {
    if (!isManifestEdit(edit)) {
      throw new Error(`invalid install manifest ${path}: malformed edit`);
    }
  }
  if (manifest.additions === undefined || typeof manifest.additions !== "object" || !isAdditions(manifest.additions)) {
    throw new Error(`invalid install manifest ${path}: missing additions`);
  }
  return manifest as InstallManifest;
}

function isManifestEdit(value: unknown): value is ManifestEdit {
  if (value === null || typeof value !== "object") return false;
  const edit = value as Partial<ManifestEdit>;
  return (
    Number.isInteger(edit.start) &&
    Number.isInteger(edit.end) &&
    typeof edit.before === "string" &&
    typeof edit.after === "string"
  );
}

function isAdditions(value: object): value is ManifestAdditions {
  const additions = value as Partial<ManifestAdditions>;
  return (
    typeof additions.permissionsArray === "boolean" &&
    typeof additions.pluginsArray === "boolean" &&
    typeof additions.catchAll === "boolean" &&
    Array.isArray(additions.denyRules) &&
    additions.denyRules.every((resource) => typeof resource === "string") &&
    (additions.plugin === "kept" ||
      additions.plugin === "added" ||
      additions.plugin === "added-options" ||
      additions.plugin === "replaced-string") &&
    typeof additions.schema === "boolean" &&
    typeof additions.packageRoot === "string" &&
    (additions.pluginString === undefined || typeof additions.pluginString === "string")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
