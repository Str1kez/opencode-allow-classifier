import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { isSandboxPath } from "../scripts/report.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, ".opencode/skills/allow-classifier-analyze/scripts/cli.ts");
const DAY_MS = 86_400_000;

interface RunOptions {
  readonly cwd: string;
  readonly env?: Record<string, string>;
}

function run(args: readonly string[], options: RunOptions) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(options.cwd, "home"),
      XDG_CONFIG_HOME: join(options.cwd, "xdg"),
      XDG_STATE_HOME: join(options.cwd, "state"),
      ...options.env,
    },
  });
}

function scratch(t: { after: (fn: () => void) => void }): string {
  // Resolve the /var -> /private/var symlink so process.cwd() inside the child matches the fixture.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ocac-analyze-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function auditEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: "2026-10-15T10:00:00.000Z",
    session: "ses_test",
    agent: "build",
    cwd: "/work/project-a",
    resources: ["gh issue view 42"],
    rule: "guard:outside-cwd",
    verdict: "ask",
    source: "model",
    probability: 0.4,
    model: "opencode/jev-1.13-free",
    latency: 12.5,
    task: "private user text",
    systemContext: { used: false, length: null, hash: null },
    ...overrides,
  };
}

/** Raw strings are written as-is, which is how malformed lines get into the fixture. */
function writeLines(directory: string, file: string, values: readonly unknown[]): void {
  mkdirSync(directory, { recursive: true });
  const lines = values.map((value) => (typeof value === "string" ? value : JSON.stringify(value)));
  writeFileSync(join(directory, file), `${lines.join("\n")}\n`);
}

interface Cluster {
  signature: string;
  occurrences: number;
  probability: { median: number; min: number; max: number } | null;
  sources: Record<string, number>;
  rules: Record<string, number>;
  projects: number;
  agents: number;
  example: string;
}

interface Report {
  auditDir: string;
  configPath: string | null;
  window: { since: string; days: number | null };
  sandboxExcluded: boolean;
  files: string[];
  skippedLines: number;
  filters: { sources: string[]; rules: string[] };
  totals: { entries: number; clusters: number };
  clusters: Cluster[];
}

function parseReport(result: { stdout: string }): Report {
  return JSON.parse(result.stdout) as Report;
}

test("report clusters ask entries across monthly files by normalized signature", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-09.jsonl", [
    auditEntry({
      time: "2026-09-20T10:00:00.000Z",
      resources: ["gh issue view 42"],
      probability: 0.2,
      cwd: "/work/a",
      agent: "build",
    }),
    auditEntry({
      time: "2026-09-21T10:00:00.000Z",
      resources: ["ls -la"],
      source: "allowlist",
      rule: "guard:secret-env",
      probability: null,
      cwd: "/work/b",
      agent: null,
    }),
  ]);
  writeLines(audit, "evaluate-2026-10.jsonl", [
    auditEntry({
      time: "2026-10-01T10:00:00.000Z",
      resources: ["gh issue view 43"],
      probability: 0.6,
      cwd: "/work/b",
      agent: "plan",
    }),
    auditEntry({
      time: "2026-10-02T10:00:00.000Z",
      resources: ["gh issue view 44"],
      probability: 0.4,
      cwd: "/work/a",
      agent: "build",
    }),
    auditEntry({ time: "2026-10-03T10:00:00.000Z", resources: ["git show abc12345"], probability: 0.7 }),
    auditEntry({ time: "2026-10-04T10:00:00.000Z", resources: ["git show deadbeef"], probability: 0.9 }),
    auditEntry({ time: "2026-10-05T10:00:00.000Z", resources: ["cat README.md"], verdict: "allow" }),
  ]);

  const result = run(["--audit-dir", audit, "--since", "2000-01-01", "--json"], { cwd: directory });
  assert.equal(result.status, 0, result.stderr);

  const report = parseReport(result);
  assert.equal(report.auditDir, audit);
  assert.equal(report.configPath, null);
  assert.deepEqual(report.files, ["evaluate-2026-09.jsonl", "evaluate-2026-10.jsonl"]);
  assert.equal(report.skippedLines, 0);
  assert.deepEqual(report.totals, { entries: 6, clusters: 3 });

  assert.deepEqual(report.clusters[0], {
    signature: "gh issue view <n>",
    occurrences: 3,
    probability: { median: 0.4, min: 0.2, max: 0.6 },
    sources: { model: 3 },
    rules: { "guard:outside-cwd": 3 },
    projects: 2,
    agents: 2,
    example: "gh issue view 42",
  });

  assert.deepEqual(report.clusters[1], {
    signature: "git show <hex>",
    occurrences: 2,
    probability: { median: 0.8, min: 0.7, max: 0.9 },
    sources: { model: 2 },
    rules: { "guard:outside-cwd": 2 },
    projects: 1,
    agents: 1,
    example: "git show abc12345",
  });

  assert.deepEqual(report.clusters[2], {
    signature: "ls -la",
    occurrences: 1,
    probability: null,
    sources: { allowlist: 1 },
    rules: { "guard:secret-env": 1 },
    projects: 1,
    agents: 0,
    example: "ls -la",
  });
});

test("report defaults to the last 30 days and accepts a date window", (t) => {
  const directory = scratch(t);
  const recentAudit = join(directory, "recent");
  const now = Date.now();
  writeLines(recentAudit, "evaluate-2026-01.jsonl", [
    auditEntry({ time: new Date(now - DAY_MS).toISOString(), resources: ["npm test"] }),
    auditEntry({ time: new Date(now - 45 * DAY_MS).toISOString(), resources: ["docker ps"] }),
  ]);

  const recent = run(["--audit-dir", recentAudit, "--json"], { cwd: directory });
  assert.equal(recent.status, 0, recent.stderr);
  const recentReport = parseReport(recent);
  assert.equal(recentReport.window.days, 30);
  assert.match(recentReport.window.since, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(
    recentReport.clusters.map((cluster) => cluster.signature),
    ["npm test"],
  );

  const datedAudit = join(directory, "dated");
  writeLines(datedAudit, "evaluate-2026-08.jsonl", [
    auditEntry({ time: "2026-08-01T10:00:00.000Z", resources: ["kubectl get pods"] }),
    auditEntry({ time: "2026-09-20T10:00:00.000Z", resources: ["gh issue view 7"] }),
    auditEntry({ time: "2026-10-15T10:00:00.000Z", resources: ["npm test"] }),
  ]);

  const dated = run(["--audit-dir", datedAudit, "--since", "2026-09-15", "--json"], { cwd: directory });
  assert.equal(dated.status, 0, dated.stderr);
  const datedReport = parseReport(dated);
  assert.deepEqual(datedReport.window, { since: "2026-09-15", days: null });
  assert.deepEqual(
    datedReport.clusters.map((cluster) => cluster.signature),
    ["gh issue view <n>", "npm test"],
  );

  const invalid = run(["--audit-dir", datedAudit, "--since", "2026-02-31"], { cwd: directory });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /invalid --since/);
});

test("report filters by exact source and by rule globs", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    auditEntry({ resources: ["gh issue view 1"], source: "model", rule: "guard:outside-cwd" }),
    auditEntry({ resources: ["git status"], source: "allowlist", rule: "git-status,git-diff" }),
    auditEntry({ resources: ["sudo systemctl restart nginx"], source: "hard-ask", rule: "sudo", probability: null }),
    auditEntry({ resources: ["docker ps"], source: "default", rule: "default", probability: null }),
  ]);

  const model = run(["--audit-dir", audit, "--source=model", "--json"], { cwd: directory });
  assert.equal(model.status, 0, model.stderr);
  assert.deepEqual(parseReport(model).clusters.map((cluster) => cluster.signature), ["gh issue view <n>"]);
  assert.deepEqual(parseReport(model).filters, { sources: ["model"], rules: [] });

  const exact = run(["--audit-dir", audit, "--source=mod", "--json"], { cwd: directory });
  assert.equal(exact.status, 0, exact.stderr);
  assert.deepEqual(parseReport(exact).clusters, []);

  const twoSources = run(["--audit-dir", audit, "--source", "model,allowlist", "--json"], { cwd: directory });
  assert.equal(twoSources.status, 0, twoSources.stderr);
  assert.deepEqual(
    parseReport(twoSources).clusters.map((cluster) => cluster.signature),
    ["gh issue view <n>", "git status"],
  );

  const guard = run(["--audit-dir", audit, "--rule=guard:*", "--json"], { cwd: directory });
  assert.equal(guard.status, 0, guard.stderr);
  assert.deepEqual(parseReport(guard).clusters.map((cluster) => cluster.signature), ["gh issue view <n>"]);

  // The allowlist writes `git-status,git-diff` into one rule field; a glob may match either member.
  const git = run(["--audit-dir", audit, "--rule", "git-*", "--json"], { cwd: directory });
  assert.equal(git.status, 0, git.stderr);
  assert.deepEqual(parseReport(git).clusters.map((cluster) => cluster.signature), ["git status"]);

  const text = run(["--audit-dir", audit, "--source=model"], { cwd: directory });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^audit: /);
  assert.match(text.stdout, /filters: sources=model rules=-/);
  assert.match(text.stdout, /signature: gh issue view <n>/);
  assert.doesNotMatch(text.stdout, /signature: git status/);
});

test("report takes audit_dir from --config, project discovery, global config, or state", (t) => {
  const directory = scratch(t);
  const explicitAudit = join(directory, "explicit-audit");
  const projectAudit = join(directory, "project", "logs");
  const globalAudit = join(directory, "global-audit");
  const flagAudit = join(directory, "flag-audit");
  writeLines(explicitAudit, "evaluate-2026-10.jsonl", [auditEntry()]);
  writeLines(projectAudit, "evaluate-2026-10.jsonl", [auditEntry()]);
  writeLines(globalAudit, "evaluate-2026-10.jsonl", [auditEntry()]);
  writeLines(flagAudit, "evaluate-2026-10.jsonl", [auditEntry({ resources: ["flag command"] })]);

  const config = join(directory, "config.jsonc");
  writeFileSync(
    config,
    `// commented JSONC
{
  "plugins": [
    {
      "package": "/checkouts/opencode-allow-classifier",
      "options": { "audit_dir": ${JSON.stringify(explicitAudit)} },
    },
  ],
}
`,
  );

  const fromConfig = run(["--config", config, "--json"], { cwd: directory });
  assert.equal(fromConfig.status, 0, fromConfig.stderr);
  assert.equal(parseReport(fromConfig).auditDir, explicitAudit);
  assert.equal(parseReport(fromConfig).configPath, config);

  const projectRoot = join(directory, "project");
  writeFileSync(
    join(projectRoot, "opencode.jsonc"),
    `{ "plugins": [{ "package": ${JSON.stringify(REPO_ROOT)}, "options": { "audit_dir": "logs" } }] }`,
  );
  const fromProject = run(["--json"], { cwd: projectRoot });
  assert.equal(fromProject.status, 0, fromProject.stderr);
  assert.equal(parseReport(fromProject).auditDir, projectAudit);
  assert.equal(parseReport(fromProject).configPath, join(projectRoot, "opencode.jsonc"));

  const flagWins = run(["--config", config, "--audit-dir", flagAudit, "--json"], { cwd: directory });
  assert.equal(flagWins.status, 0, flagWins.stderr);
  assert.equal(parseReport(flagWins).auditDir, flagAudit);
  assert.equal(parseReport(flagWins).configPath, null);
  assert.deepEqual(parseReport(flagWins).clusters.map((cluster) => cluster.signature), ["flag command"]);

  const globalConfig = join(directory, "xdg", "opencode", "opencode.jsonc");
  mkdirSync(join(directory, "xdg", "opencode"), { recursive: true });
  writeFileSync(
    globalConfig,
    `{ "plugins": [{ "package": ${JSON.stringify(REPO_ROOT)}, "options": { "audit_dir": ${JSON.stringify(globalAudit)} } }] }`,
  );
  const work = join(directory, "work");
  mkdirSync(work);
  const fromGlobal = run(["--json"], { cwd: work, env: { XDG_CONFIG_HOME: join(directory, "xdg") } });
  assert.equal(fromGlobal.status, 0, fromGlobal.stderr);
  assert.equal(parseReport(fromGlobal).auditDir, globalAudit);

  const plain = join(directory, "plain");
  mkdirSync(plain);
  const fromState = run(["--json"], { cwd: plain, env: { XDG_STATE_HOME: join(directory, "state") } });
  assert.equal(fromState.status, 0, fromState.stderr);
  assert.equal(parseReport(fromState).auditDir, join(directory, "state", "opencode"));
  assert.match(fromState.stderr, /audit directory not found/);
});

test("report text and JSON are stable and keep the documented field order", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    auditEntry({ resources: ["gh issue view 1"], probability: 0.3 }),
    auditEntry({ resources: ["gh issue view 2"], probability: 0.5, time: "2026-10-16T10:00:00.000Z" }),
    auditEntry({ resources: ["sudo ls"], rule: "sudo", source: "hard-ask", probability: null }),
  ]);

  const args = ["--audit-dir", audit, "--since", "2000-01-01", "--json"];
  const first = run(args, { cwd: directory });
  const second = run(args, { cwd: directory });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, first.stdout);

  const report = parseReport(first);
  assert.deepEqual(Object.keys(report), [
    "auditDir",
    "configPath",
    "window",
    "sandboxExcluded",
    "files",
    "skippedLines",
    "filters",
    "totals",
    "clusters",
  ]);
  assert.deepEqual(Object.keys(report.clusters[0]!), [
    "signature",
    "occurrences",
    "probability",
    "sources",
    "rules",
    "projects",
    "agents",
    "example",
  ]);

  const textArgs = ["--audit-dir", audit, "--since", "2000-01-01"];
  const firstText = run(textArgs, { cwd: directory });
  const secondText = run(textArgs, { cwd: directory });
  assert.equal(firstText.status, 0, firstText.stderr);
  assert.equal(secondText.stdout, firstText.stdout);
  assert.match(firstText.stdout, /^audit: /m);
  assert.match(firstText.stdout, /^config: \(none\)$/m);
  assert.match(firstText.stdout, /^window: since 2000-01-01$/m);
  assert.match(firstText.stdout, /^sandbox: included$/m);
  assert.match(firstText.stdout, /^files: 1$/m);
  assert.match(firstText.stdout, /^entries: 3$/m);
  assert.match(firstText.stdout, /^skipped lines: 0$/m);
  assert.match(firstText.stdout, /^filters: sources=- rules=-$/m);
  assert.match(firstText.stdout, /^clusters: 2$/m);
  assert.match(firstText.stdout, /^signature: gh issue view <n>$/m);
  assert.match(firstText.stdout, /^occurrences: 2$/m);
  assert.match(firstText.stdout, /^probability: median=0.4 min=0.3 max=0.5$/m);
  assert.match(firstText.stdout, /^sources: model=2$/m);
  assert.match(firstText.stdout, /^rules: guard:outside-cwd=2$/m);
  assert.match(firstText.stdout, /^projects: 1$/m);
  assert.match(firstText.stdout, /^agents: 1$/m);
  assert.match(firstText.stdout, /^example: gh issue view 1$/m);
});

test("report skips malformed lines with a warning and a count", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    auditEntry({ resources: ["git status"] }),
    "{not json",
    JSON.stringify({ time: "not-a-date", resources: [], cwd: "/work", verdict: "ask", source: "model", rule: "x" }),
    "",
    auditEntry({ resources: ["git diff"], time: "2026-10-16T10:00:00.000Z" }),
  ]);

  const result = run(["--audit-dir", audit, "--json"], { cwd: directory });
  assert.equal(result.status, 0, result.stderr);

  const report = parseReport(result);
  assert.equal(report.skippedLines, 2);
  assert.deepEqual(report.totals, { entries: 2, clusters: 2 });
  assert.match(result.stderr, /evaluate-2026-10\.jsonl:2: malformed audit line/);
  assert.match(result.stderr, /evaluate-2026-10\.jsonl:3: malformed audit line/);
});

test("report excludes sandbox audit unless --include-sandbox is explicit", (t) => {
  const directory = scratch(t);
  const sandboxAudit = join(REPO_ROOT, "sandbox", "ocac-analyze-nonexistent");

  assert.equal(isSandboxPath(join(REPO_ROOT, "sandbox"), REPO_ROOT), true);
  assert.equal(isSandboxPath(join(REPO_ROOT, "sandbox", "audit"), REPO_ROOT), true);
  assert.equal(isSandboxPath(join(REPO_ROOT, "sandbox-other"), REPO_ROOT), false);
  assert.equal(isSandboxPath(join(REPO_ROOT, "src"), REPO_ROOT), false);

  const skipped = run(["--audit-dir", sandboxAudit, "--json"], { cwd: directory });
  assert.equal(skipped.status, 0, skipped.stderr);
  const skippedReport = parseReport(skipped);
  assert.equal(skippedReport.sandboxExcluded, true);
  assert.deepEqual(skippedReport.files, []);
  assert.deepEqual(skippedReport.totals, { entries: 0, clusters: 0 });
  assert.match(skipped.stderr, /inside the sandbox/);

  const included = run(["--audit-dir", sandboxAudit, "--include-sandbox", "--json"], { cwd: directory });
  assert.equal(included.status, 0, included.stderr);
  assert.equal(parseReport(included).sandboxExcluded, false);
  assert.match(included.stderr, /audit directory not found/);
});

test("report --help lists the options without reading any audit", (t) => {
  const directory = scratch(t);
  const result = run(["--help"], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /npm run report -- \[options\]/);
  for (const option of ["--since", "--config", "--audit-dir", "--source", "--rule", "--json", "--include-sandbox"]) {
    assert.match(result.stdout, new RegExp(option));
  }
  assert.equal(result.stderr, "");
});
