import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installConfig } from "../../../../scripts/install.ts";
import { DENY_RULES } from "../../../../scripts/layout.ts";
import { formatInspectJson, formatInspectText, inspectConfig } from "../../../../scripts/inspect.ts";
import { JsoncSyntaxError } from "../../../../scripts/jsonc.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

interface CliOptions {
  readonly command: "install" | "inspect";
  readonly config: string | undefined;
  readonly project: boolean;
  readonly json: boolean;
}

class UsageError extends Error {}

function main(argv: readonly string[]): number {
  if (argv.length === 0) {
    process.stderr.write(`${usage()}\n`);
    return 1;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
    return 1;
  }

  const target = resolveTarget(options.config, options.project);
  return options.command === "install" ? install(target) : inspect(target, options.json);
}

function parseArgs(argv: readonly string[]): CliOptions {
  const command = argv[0];
  if (command !== "install" && command !== "inspect") {
    throw new UsageError(`unknown command: ${command ?? "(none)"}`);
  }

  let config: string | undefined;
  let project = false;
  let json = false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config") {
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("--config requires a path");
      config = value;
      index += 1;
    } else if (argument === "--project") {
      project = true;
    } else if (argument === "--json") {
      if (command !== "inspect") throw new UsageError("--json is only supported by inspect");
      json = true;
    } else if (argument === "--help" || argument === "-h") {
      throw new UsageError("use --help without a subcommand");
    } else {
      throw new UsageError(`unknown option: ${argument}`);
    }
  }

  return { command, config, project, json };
}

function resolveTarget(config: string | undefined, project: boolean): string {
  if (config !== undefined) return resolve(process.cwd(), config);
  if (project) return resolve(process.cwd(), "opencode.jsonc");

  const configHome = process.env.XDG_CONFIG_HOME;
  const base = configHome !== undefined && configHome.length > 0 ? configHome : join(homedir(), ".config");
  return join(base, "opencode", "opencode.jsonc");
}

function install(target: string): number {
  const result = installConfig(target, REPO_ROOT, {
    onDiff: (diff) => process.stdout.write(diff),
  });

  if (result.status === "conflict") {
    if (result.diff !== "") {
      process.stdout.write(`proposed diff (hypothetical, not written):\n${result.diff}`);
    }
    process.stderr.write(`${result.message}\n`);
    return 1;
  }

  if (result.status === "invalid") {
    process.stderr.write(`${result.message}\n`);
    return 1;
  }

  process.stdout.write(`${result.message}\n`);
  if (result.status === "created") {
    process.stdout.write(
      `installed: catch-all ask, ${DENY_RULES.length} deny rules, plugin ${REPO_ROOT}\n`,
    );
  }
  return 0;
}

function inspect(target: string, json: boolean): number {
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch (error) {
    return reportReadError(target, error, json);
  }

  try {
    const report = inspectConfig(text, target, REPO_ROOT);
    process.stdout.write(json ? formatInspectJson(report) : formatInspectText(report));
    return 0;
  } catch (error) {
    const message = error instanceof JsoncSyntaxError ? error.message : String(error);
    process.stderr.write(`cannot parse ${target}: ${message}\n`);
    return 1;
  }
}

function reportReadError(target: string, error: unknown, json: boolean): number {
  const code = (error as NodeJS.ErrnoException).code;
  const message = code === "ENOENT" ? "config not found" : `cannot read ${target}: ${errorMessage(error)}`;

  if (json) {
    process.stdout.write(`${JSON.stringify({ path: target, exists: false, error: message }, null, 2)}\n`);
  } else {
    process.stdout.write(`config: ${target}\nexists: no\nerror: ${message}\n`);
  }
  return 1;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usage(): string {
  return `Usage:
  node .opencode/skills/allow-classifier-install/scripts/cli.ts install [--project] [--config <path>]
  node .opencode/skills/allow-classifier-install/scripts/cli.ts inspect [--project] [--config <path>] [--json]

Target: $XDG_CONFIG_HOME/opencode/opencode.jsonc (or ~/.config/opencode/opencode.jsonc).
--project targets ./opencode.jsonc in the current directory.
--config targets an exact file and wins over --project.`;
}

process.exitCode = main(process.argv.slice(2));
