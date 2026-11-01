import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCodeStateDirectory } from "../src/paths.ts";
import { decide, type Decision } from "../src/policy.ts";
import { inspectConfig, type InspectReport, type PluginReport, type WarningCode } from "./inspect.ts";
import { JsoncSyntaxError } from "./jsonc.ts";
import { tokenize } from "../src/shell.ts";

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
 * One representative per lever: hard-ask, the secret guard, the write guard, the outside-cwd guard and
 * a plain read-only command. `decide()` is pure, so the dry run proves the rule tables without running
 * anything.
 */
const DRY_RUN_CASES: readonly DryRunCase[] = [
  { command: "sudo -n true", verdict: "ask", source: "hard-ask", rule: "sudo" },
  { command: "cat .env", verdict: "ask", source: "guard", rule: "guard:secret-env" },
  { command: "cat ../secret.txt", verdict: "ask", source: "guard", rule: "guard:outside-cwd" },
  { command: "sed -n '1,120p' README.md", verdict: "allow", source: "allowlist", rule: "sed" },
  { command: "sort -o out.txt", verdict: "ask", source: "guard", rule: "guard:sort-output" },
  { command: "git -C /tmp log", verdict: "ask", source: "guard", rule: "guard:outside-cwd" },
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
    ...warningChecks(config.report),
    checkHarnessVersion(options.harnessVersion),
    checkDependencies(options.depsRoot),
  ];
  const dryRun = runDryRun(config.report.plugin.trustedCommands);
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

/** Plugin problems already have structural checks above; repeating them as raw warnings is noise. */
const PLUGIN_WARNING_CODE: WarningCode = "plugin";

/**
 * Codes that mean the installed policy is weaker than the mandatory layout: a missing or misplaced
 * catch-all, the external_directory rule, or a required deny. `verify` must not stay green on them.
 *
 * Everything else only warns. A stricter-than-asked rule (`external-directory-stricter`) or a dead
 * narrower exception closes the policy further: the mandatory rule is present and nothing is exposed.
 */
const FAILING_WARNING_CODES: ReadonlySet<WarningCode> = new Set<WarningCode>([
  "duplicate-key",
  "permissions",
  "catch-all-missing",
  "catch-all-multiple",
  "catch-all-order",
  "external-directory-missing",
  "external-directory-effect",
  "external-directory-multiple",
  "deny-missing",
  "deny-order",
]);

function warningChecks(report: InspectReport): VerifyCheck[] {
  return report.warnings.flatMap((warning, index) => {
    const code = report.warningCodes[index];
    if (code === undefined || code === PLUGIN_WARNING_CODE) return [];
    return [{ name: "policy", status: warningStatus(code), message: warning }];
  });
}

function warningStatus(code: WarningCode): VerifyStatus {
  return FAILING_WARNING_CODES.has(code) ? "fail" : "warn";
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

function runDryRun(trustedCommands: readonly (readonly string[])[]): DryRunResult[] {
  // A throwaway cwd makes the outside-cwd guard deterministic without touching the caller's tree.
  const cwd = mkdtempSync(join(tmpdir(), "ocac-verify-"));
  try {
    return [...DRY_RUN_CASES, ...trustedDryRunCase(trustedCommands)].map((testCase) => {
      const decision = decide([testCase.command], cwd, { trustedCommands });
      const expected = `${testCase.verdict} / ${testCase.source} / ${testCase.rule}`;
      const actual = `${decision.verdict} / ${decision.source} / ${decision.rule}`;
      return { command: testCase.command, expected, actual, matches: actual === expected };
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/**
 * One declared prefix proves `trusted_commands` reaches `decide`. `inspect` reports the list already
 * tokenized, so the command is rebuilt only when joining the tokens reproduces the same words. A
 * quoted argument with a space (`node -e "a b"`) does not survive the round trip; skipping the case is
 * better than failing the dry run on a config that the plugin accepts.
 */
function trustedDryRunCase(trustedCommands: readonly (readonly string[])[]): DryRunCase[] {
  const prefix = trustedCommands[0];
  if (prefix === undefined) return [];

  const command = prefix.join(" ");
  if (tokenize(command).join("\u0000") !== prefix.join("\u0000")) return [];
  return [{ command, verdict: "allow", source: "allowlist", rule: "trust" }];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
