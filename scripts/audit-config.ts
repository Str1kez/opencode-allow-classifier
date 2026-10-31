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
import { fileURLToPath } from "node:url";
import { readOptions } from "../src/options.ts";
import { openCodeStateDirectory } from "../src/paths.ts";
import { parseJsonc, toValue } from "./jsonc.ts";

/** Both names OpenCode accepts; the commented one wins when a directory has both. */
const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"] as const;

/** Root of this checkout, independent of the directory it was cloned into. */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Stable fragment of the package name; a published or renamed reference still carries it. */
const PACKAGE_NAME_FRAGMENT = "opencode-allow-classifier";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface AuditDirectoryResolution {
  readonly directory: string;
  readonly configPath: string | null;
  /**
   * Effective threshold from the classifier plugin entry, when one was read. Independent of
   * `audit_dir`: a config may tune the threshold without moving the audit directory.
   */
  readonly threshold: number | undefined;
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
    const directory = resolve(options.cwd, options.explicitAuditDir);

    // The flag overrides where the audit lives, not which threshold the plugin runs with.
    if (options.explicitConfig !== undefined) {
      const path = resolve(options.cwd, options.explicitConfig);
      if (!existsSync(path)) throw new ConfigError(`config not found: ${path}`);
      return { directory, configPath: null, threshold: readClassifierConfig(path)?.threshold, warnings: [] };
    }

    const discovered = discoverThreshold(options);
    return { directory, configPath: null, threshold: discovered.threshold, warnings: discovered.warnings };
  }

  if (options.explicitConfig !== undefined) {
    const path = resolve(options.cwd, options.explicitConfig);
    if (!existsSync(path)) throw new ConfigError(`config not found: ${path}`);

    const config = readClassifierConfig(path);
    const auditDirectory = config?.auditDirectory;
    return {
      directory:
        auditDirectory === undefined ? openCodeStateDirectory(options.env) : resolve(options.cwd, auditDirectory),
      configPath: path,
      threshold: config?.threshold,
      warnings: [],
    };
  }

  const warnings: string[] = [];
  const projectConfig = projectConfigPath(options.cwd);
  const project = projectConfig === undefined ? undefined : tryReadClassifierConfig(projectConfig, warnings);

  if (projectConfig !== undefined && project?.auditDirectory !== undefined) {
    return {
      directory: resolve(options.cwd, project.auditDirectory),
      configPath: projectConfig,
      threshold: project.threshold,
      warnings,
    };
  }

  const globalConfig = globalConfigPath(options.env);
  const global =
    globalConfig !== undefined && globalConfig !== projectConfig
      ? tryReadClassifierConfig(globalConfig, warnings)
      : undefined;

  if (globalConfig !== undefined && global?.auditDirectory !== undefined) {
    return {
      directory: resolve(options.cwd, global.auditDirectory),
      configPath: globalConfig,
      // A project entry without `audit_dir` still wins on the threshold: it is the effective config.
      threshold: project?.threshold ?? global.threshold,
      warnings,
    };
  }

  return {
    directory: openCodeStateDirectory(options.env),
    configPath: null,
    threshold: project?.threshold ?? global?.threshold,
    warnings,
  };
}

interface DiscoveredThreshold {
  readonly threshold: number | undefined;
  readonly warnings: string[];
}

/**
 * Finds the effective threshold on its own. `--audit-dir` only overrides the directory, so the
 * threshold still comes from the project or global config; an explicit `--config` is read by the caller.
 */
function discoverThreshold(options: ResolveAuditDirectoryOptions): DiscoveredThreshold {
  const warnings: string[] = [];
  const projectConfig = projectConfigPath(options.cwd);

  if (projectConfig !== undefined) {
    const config = tryReadClassifierConfig(projectConfig, warnings);
    if (config?.threshold !== undefined) return { threshold: config.threshold, warnings };
  }

  const globalConfig = globalConfigPath(options.env);
  if (globalConfig !== undefined && globalConfig !== projectConfig) {
    const config = tryReadClassifierConfig(globalConfig, warnings);
    if (config?.threshold !== undefined) return { threshold: config.threshold, warnings };
  }

  return { threshold: undefined, warnings };
}

export interface ClassifierConfig {
  readonly auditDirectory: string | undefined;
  readonly threshold: number | undefined;
}

/**
 * Reads the plugin entry once so `audit_dir` and `threshold` come from the same options object.
 * The plugin's own option reader validates both values, so an invalid one falls back to the default
 * exactly as it does at runtime. The two options are independent: an entry without `audit_dir` still
 * defines the effective threshold.
 */
export function readClassifierConfig(path: string): ClassifierConfig | undefined {
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

  return classifierConfigOf(value);
}

/** Nearest config from the working directory up to the filesystem root. */
function projectConfigPath(cwd: string): string | undefined {
  let directory = resolve(cwd);

  for (;;) {
    const path = configInDirectory(directory);
    if (path !== undefined) return path;

    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * OpenCode looks for a project config next to the project and inside its `.opencode` directory.
 * The direct file wins when both exist, matching the same precedence for the two file names.
 */
function configInDirectory(directory: string): string | undefined {
  for (const location of ["", ".opencode"]) {
    for (const name of CONFIG_NAMES) {
      const path = join(directory, location, name);
      if (existsSync(path)) return path;
    }
  }
  return undefined;
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

function tryReadClassifierConfig(path: string, warnings: string[]): ClassifierConfig | undefined {
  try {
    return readClassifierConfig(path);
  } catch (error) {
    // A broken config earlier in the chain must not hide a working one later.
    warnings.push(errorMessage(error));
    return undefined;
  }
}

function classifierConfigOf(value: unknown): ClassifierConfig | undefined {
  if (!isRecord(value)) return undefined;
  const plugins = value["plugins"];
  if (!Array.isArray(plugins)) return undefined;

  for (const entry of plugins) {
    if (!isRecord(entry) || !isClassifierEntry(entry)) continue;
    const options = entry["options"];
    if (!isRecord(options)) continue;

    const parsed = readOptions(options);
    if (parsed.auditDirectory === undefined && parsed.threshold === undefined) continue;
    return {
      auditDirectory: parsed.auditDirectory,
      threshold: parsed.threshold,
    };
  }

  return undefined;
}

/**
 * Only this plugin may choose where the audit lives or which threshold it runs with. A foreign
 * entry that happens to carry the same option names must not redirect the reader; the install
 * skill writes either the package name or the absolute checkout path.
 */
function isClassifierEntry(entry: Record<string, unknown>): boolean {
  const reference = entry["package"];
  if (typeof reference !== "string" || reference.length === 0) return false;
  if (reference.includes(PACKAGE_NAME_FRAGMENT)) return true;
  return resolve(reference) === PACKAGE_ROOT;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
