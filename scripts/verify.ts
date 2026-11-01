import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeStateDirectory } from "../src/paths.ts";
import { decide, type Decision } from "../src/policy.ts";
import { inspectConfig, type InspectReport, type PluginReport } from "./inspect.ts";
import { JsoncSyntaxError } from "./jsonc.ts";

/** The dependency set the plugin cannot start without. */
const REQUIRED_DEPENDENCIES = ["@opencode/plugin", "effect"] as const;

/** The harness line the plugin is tested against; anything else only warns. */
const SUPPORTED_MAJOR = 2;
const SUPPORTED_MINOR = 2;

/** `2.2.5`, `v2.2.5` and `opencode 2.2.5` all parse the same way. */
const VERSION = /(\d+)\.(\d+)\.(\d+)/;

interface DryRunCase {
  readonly command: string;
  readonly verdict: Decision["verdict"];
  readonly source: Decision["source"];
  readonly rule: string;
}

/**
 * One representative per lever: hard-ask, the secret guard, the outside-cwd guard and a plain
 * read-only command. `decide()` is pure, so the dry run proves the rule tables without running
 * anything.
 */
const DRY_RUN_CASES: readonly DryRunCase[] = [
  { command: "sudo -n true", verdict: "ask", source: "hard-ask", rule: "sudo" },
  { command: "cat .env", verdict: "ask", source: "guard", rule: "guard:secret-env" },
  { command: "cat ../secret.txt", verdict: "ask", source: "guard", rule: "guard:outside-cwd" },
  { command: "ls", verdict: "allow", source: "allowlist", rule: "ls" },
];

export type VerifyStatus = "pass" | "warn" | "fail";

export interface VerifyCheck {
  readonly name: string;
  readonly status: VerifyStatus;
  readonly message: string;
}

export interface DryRunResult {
  readonly command: string;
  readonly expected: string;
  readonly actual: string;
  readonly matches: boolean;
}

export interface AuditLocation {
  readonly directory: string;
  readonly fromConfig: boolean;
}

export interface VerifyReport {
  readonly configPath: string;
  readonly checks: readonly VerifyCheck[];
  readonly dryRun: readonly DryRunResult[];
  /** `null` when the config could not be read: there is nothing to verify against. */
  readonly audit: AuditLocation | null;
  readonly ok: boolean;
}

export interface VerifyOptions {
  /** Absolute package root the config must reference. */
  readonly packageRoot: string;
  /** Root that holds `node_modules`; a test seam so verification does not need an installed package. */
  readonly depsRoot: string;
  /** Substituted harness version; when absent, `opencode --version` is probed once. */
  readonly harnessVersion?: string | undefined;
}

/**
 * Post-install verification. Reads the config, probes the harness version and the package
 * dependencies and dry-runs the solver. It never launches OpenCode and never executes a command from
 * the dry-run table: the live part is a checklist printed for a human.
 */
export function runVerify(path: string, options: VerifyOptions): VerifyReport {
  const config = readConfig(path, options.packageRoot);
  if (config.report === undefined) {
    return { configPath: path, checks: [config.check], dryRun: [], audit: null, ok: false };
  }

  const checks: VerifyCheck[] = [
    config.check,
    ...pluginChecks(config.report.plugin),
    checkHarnessVersion(options.harnessVersion),
    checkDependencies(options.depsRoot),
  ];
  const dryRun = runDryRun();
  const ok = checks.every((check) => check.status !== "fail") && dryRun.every((result) => result.matches);

  return {
    configPath: path,
    checks,
    dryRun,
    audit: {
      directory: config.report.plugin.auditDir ?? openCodeStateDirectory(),
      fromConfig: config.report.plugin.auditDir !== null,
    },
    ok,
  };
}

export function formatVerifyText(report: VerifyReport): string {
  const lines = [`config: ${report.configPath}`, "checks:"];
  for (const check of report.checks) lines.push(`  ${check.status.toUpperCase()} ${check.name}: ${check.message}`);

  if (report.dryRun.length > 0) {
    lines.push("dry run (no command executed):");
    for (const result of report.dryRun) {
      lines.push(
        result.matches
          ? `  PASS ${result.command} -> ${result.expected}`
          : `  FAIL ${result.command} -> expected ${result.expected}, got ${result.actual}`,
      );
    }
  }

  if (report.audit !== null) {
    const source = report.audit.fromConfig ? "plugin option audit_dir" : "default state directory";
    lines.push("audit:");
    lines.push(`  directory: ${report.audit.directory} (${source})`);
    lines.push(`  look for a fresh entry with verdict "allow" and source "allowlist" in evaluate-*.jsonl`);
    lines.push("live proof (manual checklist, this script does not run OpenCode):");
    lines.push("  1. open this repository in OpenCode");
    lines.push("  2. run a safe read-only command, for example: ls");
    lines.push(`  3. find the new entry in ${report.audit.directory}/evaluate-*.jsonl`);
    lines.push("  V2 reloads config, plugins and skills itself; no restart is required, /reload forces a reload");
  }

  lines.push(report.ok ? "verify: ok" : "verify: failed");
  return `${lines.join("\n")}\n`;
}

function readConfig(
  path: string,
  packageRoot: string,
): { readonly check: VerifyCheck; readonly report?: InspectReport } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = code === "ENOENT" ? `not found: ${path}` : `cannot read ${path}: ${errorMessage(error)}`;
    return { check: { name: "config", status: "fail", message } };
  }

  try {
    return { check: { name: "config", status: "pass", message: path }, report: inspectConfig(text, path, packageRoot) };
  } catch (error) {
    const message = error instanceof JsoncSyntaxError ? error.message : errorMessage(error);
    return { check: { name: "config", status: "fail", message: `cannot parse ${path}: ${message}` } };
  }
}

function pluginChecks(plugin: PluginReport): VerifyCheck[] {
  const entry: VerifyCheck =
    plugin.type === "missing"
      ? { name: "plugin entry", status: "fail", message: "missing; install adds the plugin object" }
      : plugin.type === "string"
        ? { name: "plugin entry", status: "fail", message: "string; options cannot be passed, replace it with an object" }
        : { name: "plugin entry", status: "pass", message: "object" };

  // `readOptions` treats anything but `enabled: false` as enabled, so an unknown value is a warning.
  const killSwitch: VerifyCheck =
    plugin.killSwitch === "disabled"
      ? { name: "kill switch", status: "fail", message: "disabled (enabled: false); nothing is downgraded" }
      : plugin.killSwitch === "enabled"
        ? { name: "kill switch", status: "pass", message: "enabled" }
        : { name: "kill switch", status: "warn", message: "unknown (options or enabled missing); defaults to enabled" };

  return [entry, killSwitch];
}

function checkHarnessVersion(override: string | undefined): VerifyCheck {
  if (override !== undefined) return judgeHarnessVersion(override);

  // A version probe only: no session, no plugin, no config read.
  const probe = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5000 });
  if (probe.error !== undefined) {
    return { name: "harness version", status: "warn", message: `not detected (${errorMessage(probe.error)}); continuing` };
  }
  if (probe.status !== 0) {
    return {
      name: "harness version",
      status: "warn",
      message: `not detected (opencode --version exited ${probe.status ?? "without a status"}); continuing`,
    };
  }

  const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  if (output.length === 0) {
    return { name: "harness version", status: "warn", message: "not detected (opencode --version printed nothing); continuing" };
  }

  return judgeHarnessVersion(output);
}

function judgeHarnessVersion(raw: string): VerifyCheck {
  const match = VERSION.exec(raw);
  if (match === null) {
    return { name: "harness version", status: "warn", message: `unparseable version ${JSON.stringify(raw)}; continuing` };
  }

  const version = `${match[1]}.${match[2]}.${match[3]}`;
  if (Number(match[1]) === SUPPORTED_MAJOR && Number(match[2]) === SUPPORTED_MINOR) {
    return { name: "harness version", status: "pass", message: version };
  }

  return {
    name: "harness version",
    status: "warn",
    message: `${version} (expected ${SUPPORTED_MAJOR}.${SUPPORTED_MINOR}.x, continuing)`,
  };
}

function checkDependencies(depsRoot: string): VerifyCheck {
  const missing = REQUIRED_DEPENDENCIES.filter(
    (name) => !existsSync(join(depsRoot, "node_modules", name, "package.json")),
  );
  if (missing.length === 0) {
    return { name: "dependencies", status: "pass", message: REQUIRED_DEPENDENCIES.join(", ") };
  }
  return {
    name: "dependencies",
    status: "fail",
    message: `missing under ${depsRoot}: ${missing.join(", ")}; run npm install in the repository`,
  };
}

function runDryRun(): DryRunResult[] {
  // A throwaway cwd makes the outside-cwd guard deterministic without touching the caller's tree.
  const cwd = mkdtempSync(join(tmpdir(), "ocac-verify-"));
  try {
    return DRY_RUN_CASES.map((testCase) => {
      const decision = decide([testCase.command], cwd);
      const expected = `${testCase.verdict} / ${testCase.source} / ${testCase.rule}`;
      const actual = `${decision.verdict} / ${decision.source} / ${decision.rule}`;
      return { command: testCase.command, expected, actual, matches: actual === expected };
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
