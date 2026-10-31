import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAuditDirectory } from "../../../../scripts/audit-config.ts";
import {
  collectReport,
  formatReportJson,
  formatReportText,
  ReportUsageError,
} from "../../../../scripts/report.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

interface CliOptions {
  readonly since: string;
  readonly config: string | undefined;
  readonly auditDir: string | undefined;
  readonly sources: readonly string[];
  readonly rules: readonly string[];
  readonly json: boolean;
  readonly includeSandbox: boolean;
  readonly help: boolean;
}

class UsageError extends Error {}

function main(argv: readonly string[]): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n\n${usage()}\n`);
    return 1;
  }

  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  try {
    const resolution = resolveAuditDirectory({
      explicitConfig: options.config,
      explicitAuditDir: options.auditDir,
      cwd: process.cwd(),
      env: process.env,
    });
    for (const warning of resolution.warnings) process.stderr.write(`warning: ${warning}\n`);

    const { report, warnings } = collectReport({
      auditDir: resolution.directory,
      configPath: resolution.configPath,
      since: options.since,
      filters: { sources: options.sources, rules: options.rules },
      now: new Date(),
      repoRoot: REPO_ROOT,
      includeSandbox: options.includeSandbox,
      threshold: resolution.threshold,
    });
    for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`);

    process.stdout.write(options.json ? formatReportJson(report) : formatReportText(report));
    return 0;
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    if (error instanceof ReportUsageError) process.stderr.write(`\n${usage()}\n`);
    return 1;
  }
}

function parseArgs(argv: readonly string[]): CliOptions {
  let since = "30d";
  let config: string | undefined;
  let auditDir: string | undefined;
  const sources: string[] = [];
  const rules: string[] = [];
  let json = false;
  let includeSandbox = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;

    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--include-sandbox") {
      includeSandbox = true;
      continue;
    }

    const [name, inlineValue] = splitOption(argument);
    if (name !== "--since" && name !== "--config" && name !== "--audit-dir" && name !== "--source" && name !== "--rule") {
      throw new UsageError(`unknown option: ${argument}`);
    }

    const value = inlineValue ?? argv[++index];
    if (value === undefined || value.length === 0) throw new UsageError(`${name} requires a value`);

    switch (name) {
      case "--since":
        since = value;
        break;
      case "--config":
        config = value;
        break;
      case "--audit-dir":
        auditDir = value;
        break;
      case "--source":
        sources.push(...splitSources(value));
        break;
      case "--rule":
        rules.push(value);
        break;
    }
  }

  return { since, config, auditDir, sources, rules, json, includeSandbox, help };
}

/** Splits `--name=value`; a bare flag keeps `undefined` and reads the next argument. */
function splitOption(argument: string): [string, string | undefined] {
  if (!argument.startsWith("--")) return [argument, undefined];
  const equals = argument.indexOf("=");
  if (equals === -1) return [argument, undefined];
  return [argument.slice(0, equals), argument.slice(equals + 1)];
}

function splitSources(value: string): string[] {
  const sources = value
    .split(",")
    .map((source) => source.trim())
    .filter((source) => source.length > 0);
  if (sources.length === 0) throw new UsageError("--source requires at least one name");
  return sources;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usage(): string {
  return `Usage:
  npm run report -- [options]
  node .opencode/skills/allow-classifier-analyze/scripts/cli.ts [options]

Reports ask clusters from the classifier audit log. Read-only: prints to stdout.

Options:
  --since <YYYY-MM-DD|Nd>  Window start; default 30d (last 30 days).
  --config <path>          Config to read the classifier audit_dir from.
  --audit-dir <path>       Audit directory; wins over --config.
  --source <name>          Audit source filter; repeatable or comma-separated.
  --rule <glob>            Rule filter with * wildcards; repeatable.
  --json                   Print the report as JSON.
  --include-sandbox        Read audit under <repo>/sandbox; skipped by default.
  --help, -h               Show this help.

Audit directory: --audit-dir, else audit_dir from --config or the discovered
project/global config, else the OpenCode state directory.`;
}

process.exitCode = main(process.argv.slice(2));
