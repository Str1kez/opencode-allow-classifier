/**
 * Resolves the audit directory for the report.
 *
 * Order: an explicit `--audit-dir`, then `audit_dir` from the classifier plugin entry in the
 * effective config, then OpenCode's state directory. The audit reader must look where the plugin
 * writes, not where the reader guesses.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readOptions } from "../src/options.ts";
import { openCodeStateDirectory } from "../src/paths.ts";
import { parseJsonc, toValue } from "./jsonc.ts";

/** Both names OpenCode accepts; the commented one wins when a directory has both. */
const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"] as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface AuditDirectoryResolution {
  readonly directory: string;
  readonly configPath: string | null;
  readonly warnings: readonly string[];
}

export interface ResolveAuditDirectoryOptions {
  readonly explicitConfig: string | undefined;
  readonly explicitAuditDir: string | undefined;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export function resolveAuditDirectory(options: ResolveAuditDirectoryOptions): AuditDirectoryResolution {
  if (options.explicitAuditDir !== undefined) {
    return {
      directory: resolve(options.cwd, options.explicitAuditDir),
      configPath: null,
      warnings: [],
    };
  }

  if (options.explicitConfig !== undefined) {
    const path = resolve(options.cwd, options.explicitConfig);
    if (!existsSync(path)) throw new ConfigError(`config not found: ${path}`);

    const auditDirectory = readAuditDirectory(path);
    return {
      directory:
        auditDirectory === undefined ? openCodeStateDirectory(options.env) : resolve(options.cwd, auditDirectory),
      configPath: path,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const projectConfig = projectConfigPath(options.cwd);

  if (projectConfig !== undefined) {
    const auditDirectory = tryReadAuditDirectory(projectConfig, warnings);
    if (auditDirectory !== undefined) {
      return { directory: resolve(options.cwd, auditDirectory), configPath: projectConfig, warnings };
    }
  }

  const globalConfig = globalConfigPath(options.env);
  if (globalConfig !== undefined && globalConfig !== projectConfig) {
    const auditDirectory = tryReadAuditDirectory(globalConfig, warnings);
    if (auditDirectory !== undefined) {
      return { directory: resolve(options.cwd, auditDirectory), configPath: globalConfig, warnings };
    }
  }

  return { directory: openCodeStateDirectory(options.env), configPath: null, warnings };
}

/**
 * Reads `audit_dir` from the plugin entry. The plugin's own option reader validates the value, so a
 * non-string or empty value falls back to the default exactly as it does at runtime.
 */
export function readAuditDirectory(path: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new ConfigError(`cannot read ${path}: ${errorMessage(error)}`);
  }

  let value: unknown;
  try {
    value = toValue(parseJsonc(text).root);
  } catch (error) {
    throw new ConfigError(`cannot parse ${path}: ${errorMessage(error)}`);
  }

  return auditDirectoryOf(value);
}

/** Nearest config from the working directory up to the filesystem root. */
function projectConfigPath(cwd: string): string | undefined {
  let directory = resolve(cwd);

  for (;;) {
    for (const name of CONFIG_NAMES) {
      const path = join(directory, name);
      if (existsSync(path)) return path;
    }

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function globalConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  const configHome = env["XDG_CONFIG_HOME"];
  const base = configHome !== undefined && configHome.length > 0 ? configHome : join(homedir(), ".config");

  for (const name of CONFIG_NAMES) {
    const path = join(base, "opencode", name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

function tryReadAuditDirectory(path: string, warnings: string[]): string | undefined {
  try {
    return readAuditDirectory(path);
  } catch (error) {
    // A broken config earlier in the chain must not hide a working one later.
    warnings.push(errorMessage(error));
    return undefined;
  }
}

function auditDirectoryOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const plugins = value["plugins"];
  if (!Array.isArray(plugins)) return undefined;

  let fallback: string | undefined;
  for (const entry of plugins) {
    if (!isRecord(entry)) continue;
    const options = entry["options"];
    if (!isRecord(options)) continue;

    const auditDirectory = readOptions(options).auditDirectory;
    if (auditDirectory === undefined) continue;

    // The package path is the install skill's absolute repository path; a renamed checkout still
    // works through the option name, which only this plugin defines.
    const packageName = typeof entry["package"] === "string" ? entry["package"] : "";
    if (packageName.includes("opencode-allow-classifier")) return auditDirectory;
    fallback ??= auditDirectory;
  }

  return fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
