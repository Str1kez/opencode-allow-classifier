import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findDuplicateKeys, parseJsonc, toValue } from "./jsonc.ts";
import { cleanConfigText, isCleanConfig } from "./layout.ts";

export type InstallStatus = "created" | "unchanged" | "foreign" | "invalid";

export interface InstallResult {
  readonly status: InstallStatus;
  readonly path: string;
  readonly message: string;
}

/**
 * Installs the clean layout when the file is missing, empty or already clean.
 *
 * Merging into an existing config is a separate step: a foreign config is never rewritten silently.
 */
export function installConfig(path: string, packageRoot: string): InstallResult {
  if (!existsSync(path)) {
    create(path, packageRoot);
    return { status: "created", path, message: `created ${path}` };
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { status: "invalid", path, message: `cannot read ${path}: ${errorMessage(error)}\nfile left unchanged` };
  }

  if (text.trim() === "") {
    create(path, packageRoot);
    return { status: "created", path, message: `created ${path}` };
  }

  let document;
  try {
    document = parseJsonc(text);
  } catch (error) {
    return {
      status: "invalid",
      path,
      message: `cannot parse ${path}: ${errorMessage(error)}\nfile left unchanged`,
    };
  }

  const value = toValue(document.root);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      status: "foreign",
      path,
      message: `refusing to rewrite ${path}: config root must be an object\nfile left unchanged`,
    };
  }

  const duplicates = findDuplicateKeys(document.root);
  if (duplicates.length > 0) {
    const keys = duplicates.map((duplicate) => `${duplicate.path}.${duplicate.key}`).join(", ");
    return {
      status: "foreign",
      path,
      message: `refusing to rewrite ${path}: duplicate keys (${keys})\nfile left unchanged`,
    };
  }

  if (isCleanConfig(value, packageRoot)) {
    return { status: "unchanged", path, message: `config already installed: ${path}\nno changes` };
  }

  return {
    status: "foreign",
    path,
    message: `refusing to rewrite ${path}: the config is valid JSONC but not the clean classifier layout\nfile left unchanged`,
  };
}

function create(path: string, packageRoot: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, cleanConfigText(packageRoot));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
