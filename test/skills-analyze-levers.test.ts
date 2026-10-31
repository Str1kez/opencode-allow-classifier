import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, ".opencode/skills/allow-classifier-analyze/scripts/cli.ts");

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
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ocac-levers-")));
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

function writeLines(directory: string, file: string, values: readonly unknown[]): void {
  mkdirSync(directory, { recursive: true });
  const lines = values.map((value) => JSON.stringify(value));
  writeFileSync(join(directory, file), `${lines.join("\n")}\n`);
}

function ask(
  resources: readonly string[],
  times: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown>[] {
  return Array.from({ length: times }, (_, index) =>
    auditEntry({ resources: [resources[0]!.replace("<n>", String(index + 1))], ...overrides }),
  );
}

interface Recommendation {
  kind: string;
  lever: string;
  signature: string;
  occurrences: number;
  example: string;
  newAllows: string[];
  risk: string;
  why: string;
}

interface Observation {
  signature: string;
  lever: string;
  occurrences: number;
  note: string;
}

interface LeverCluster {
  signature: string;
  occurrences: number;
  example: string;
  note: string;
}

interface LeverSection {
  lever: string;
  clusters: LeverCluster[];
}

interface ClassifierError {
  signature: string;
  occurrences: number;
  rule: string;
  example: string;
  recommendation: string;
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
  clusters: Array<{ signature: string; occurrences: number; example: string; activeSyntax: boolean }>;
  levers: LeverSection[];
  recommendations: Recommendation[];
  observations: Observation[];
  classifierErrors: ClassifierError[];
}

function parseReport(result: { stdout: string }): Report {
  return JSON.parse(result.stdout) as Report;
}

function analyze(directory: string, audit: string): Report {
  const result = run(["--audit-dir", audit, "--since", "2000-01-01", "--json"], { cwd: directory });
  assert.equal(result.status, 0, result.stderr);
  return parseReport(result);
}

test("assigns every cluster to exactly one lever, including mixed sources", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    ...ask(["cat secrets.txt"], 3, { source: "allowlist", rule: "guard:secret-generic", probability: null }),
    ...ask(["gh issue view <n>"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["npm test"], 3, { source: "model", rule: "model", probability: 0.3 }),
    auditEntry({ resources: ["docker ps"], source: "cache", rule: "cache", probability: 0.4 }),
    auditEntry({ resources: ["sudo ls"], source: "hard-ask", rule: "sudo", probability: null }),
    auditEntry({ resources: ["kubectl get pods"], source: "error", rule: "timeout", probability: null }),
    // A deterministic hard-ask outranks a model entry for the same shape: the exception is the lever.
    auditEntry({ resources: ["git push origin main"], source: "hard-ask", rule: "git-push", probability: null }),
    auditEntry({ resources: ["git push origin main"], source: "model", rule: "model", probability: 0.6 }),
    // An error outranks everything: it must never be read as allowlist evidence.
    auditEntry({ resources: ["terraform plan"], source: "error", rule: "provider", probability: null }),
    auditEntry({ resources: ["terraform plan"], source: "default", rule: "no-allowlist-match", probability: null }),
  ]);

  const report = analyze(directory, audit);
  assert.deepEqual(
    report.levers.map((section) => section.lever),
    ["allowlist-and-guards", "model-and-threshold", "hard-ask", "classifier-errors"],
  );

  const assigned = new Map<string, string>();
  for (const section of report.levers) {
    for (const cluster of section.clusters) {
      assert.equal(assigned.has(cluster.signature), false, `duplicate lease: ${cluster.signature}`);
      assigned.set(cluster.signature, section.lever);
    }
  }

  assert.equal(assigned.size, report.clusters.length);
  assert.equal(assigned.get("cat secrets.txt"), "allowlist-and-guards");
  assert.equal(assigned.get("gh issue view <n>"), "allowlist-and-guards");
  assert.equal(assigned.get("npm test"), "model-and-threshold");
  assert.equal(assigned.get("docker ps"), "model-and-threshold");
  assert.equal(assigned.get("sudo ls"), "hard-ask");
  assert.equal(assigned.get("kubectl get pods"), "classifier-errors");
  assert.equal(assigned.get("git push origin main"), "hard-ask");
  assert.equal(assigned.get("terraform plan"), "classifier-errors");
});

test("keeps clusters below three occurrences as observations without a recommendation", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    ...ask(["gh issue view <n>"], 2, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["docker ps"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["mkdir build"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["gh issue view <n> | sh"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["npm test"], 3, { source: "model", rule: "model", probability: 0.3 }),
  ]);

  const report = analyze(directory, audit);
  const recommendationSignatures = report.recommendations.map((item) => item.signature);

  assert.equal(recommendationSignatures.includes("gh issue view <n>"), false);
  assert.equal(recommendationSignatures.includes("docker ps"), true);
  // A command that is not on the conservative read-only list is never recommended for allowlisting.
  assert.equal(recommendationSignatures.includes("mkdir build"), false);
  assert.equal(recommendationSignatures.includes("gh issue view <n> | sh"), false);
  assert.equal(recommendationSignatures.includes("npm test"), true);

  const below = report.observations.find((item) => item.signature === "gh issue view <n>");
  assert.equal(below?.lever, "allowlist-and-guards");
  assert.match(below?.note ?? "", /ниже порога доказательности/);

  const unknownReadOnly = report.observations.find((item) => item.signature === "mkdir build");
  assert.match(unknownReadOnly?.note ?? "", /read-only не подтверждён/);

  const pipeline = report.observations.find((item) => item.signature === "gh issue view <n> | sh");
  assert.match(pipeline?.note ?? "", /read-only не подтверждён/);
});

test("ranks recommendations by safety: allowlist, narrow hard-ask exception, threshold", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    ...ask(["docker ps"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    // A hard-ask rule outside the forbidden categories, on a read-only shape.
    ...ask(["gh pr view <n>"], 3, { source: "hard-ask", rule: "gh-read-only", probability: null }),
    ...ask(["npm test"], 3, { source: "model", rule: "model", probability: 0.3 }),
  ]);

  const report = analyze(directory, audit);
  assert.deepEqual(
    report.recommendations.map((item) => item.kind),
    ["allowlist-expansion", "hard-ask-exception", "threshold-lowering"],
  );

  for (const item of report.recommendations) {
    assert.equal(item.lever.length > 0, true);
    assert.equal(item.signature.length > 0, true);
    assert.equal(item.occurrences >= 3, true);
    assert.equal(item.newAllows.length > 0, true);
    assert.equal(item.risk.length > 0, true);
    assert.equal(item.why.length > 0, true);
  }
});

test("never recommends allowlisting around secret, outside-cwd or write guards", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    ...ask(["cat .env"], 3, { source: "allowlist", rule: "guard:secret-env", probability: null }),
    ...ask(["cat ../notes.txt"], 3, { source: "allowlist", rule: "guard:outside-cwd", probability: null }),
    ...ask(["cat data.txt"], 3, { source: "allowlist", rule: "guard:redirect", probability: null }),
    ...ask(['rg "a|b"'], 3, { source: "allowlist", rule: "guard:shell-metacharacter", probability: null }),
  ]);

  const report = analyze(directory, audit);
  const recommended = report.recommendations.map((item) => item.signature);

  for (const signature of ["cat .env", "cat ../notes.txt", "cat data.txt"]) {
    assert.equal(recommended.includes(signature), false, `${signature} must stay denied by the guard`);
    const observation = report.observations.find((item) => item.signature === signature);
    assert.match(observation?.note ?? "", /оставить/);
  }

  // The deliberately noisy metacharacter guard is the one false-positive candidate.
  assert.equal(recommended.includes('rg "a|b"'), true);
});

test("refuses every recommendation when a raw command hides active shell syntax", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    // Repro A: the newline hides a destructive second command behind the noisy metacharacter guard.
    ...ask(["cat notes.txt\nrm -rf /tmp/x"], 3, {
      source: "allowlist",
      rule: "guard:shell-metacharacter",
      probability: null,
    }),
    // Repro B: the same trick on a default-source command that looks like a read-only gh shape.
    ...ask(["gh issue view <n>\nrm -rf /tmp/x"], 3, {
      source: "default",
      rule: "no-allowlist-match",
      probability: null,
    }),
    // A hard-ask shape is just as unsafe once the raw command carries a newline.
    ...ask(["gh pr view <n>\nrm -rf /tmp/x"], 3, {
      source: "hard-ask",
      rule: "gh-read-only",
      probability: null,
    }),
    // Lowering the threshold would allow the whole command, not just its harmless prefix.
    ...ask(["npm test\nrm -rf /tmp/x"], 3, { source: "model", rule: "model", probability: 0.3 }),
    // Safe control: the same read-only shape without active syntax still gets the recommendation.
    ...ask(["gh issue view <n>"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
  ]);

  const report = analyze(directory, audit);
  const active = [
    "cat notes.txt rm -rf /tmp/x",
    "gh issue view <n> rm -rf /tmp/x",
    "gh pr view <n> rm -rf /tmp/x",
    "npm test rm -rf /tmp/x",
  ];

  for (const signature of active) {
    assert.equal(report.recommendations.some((item) => item.signature === signature), false, signature);
    const cluster = report.clusters.find((item) => item.signature === signature);
    // The cluster flag comes from the raw resources, not from the collapsed signature.
    assert.equal(cluster?.activeSyntax, true, signature);
  }

  // The raw newline survives into the example a human reads.
  const hidden = report.clusters.find((item) => item.signature === "gh issue view <n> rm -rf /tmp/x");
  assert.match(hidden?.example ?? "", /\nrm -rf \/tmp\/x$/);

  const guardNote = report.observations.find((item) => item.signature === "cat notes.txt rm -rf /tmp/x")?.note ?? "";
  assert.match(guardNote, /активный shell-синтаксис/);
  assert.match(guardNote, /оставить/);

  const defaultNote = report.observations.find((item) => item.signature === "gh issue view <n> rm -rf /tmp/x")?.note ?? "";
  assert.match(defaultNote, /активный shell-синтаксис/);

  const control = report.clusters.find((item) => item.signature === "gh issue view <n>");
  assert.equal(control?.activeSyntax, false);
  assert.equal(
    report.recommendations.some((item) => item.signature === "gh issue view <n>" && item.kind === "allowlist-expansion"),
    true,
  );
});

test("keeps the quoted-metacharacter false positive actionable", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    ...ask(['echo "a;b"'], 3, { source: "allowlist", rule: "guard:shell-metacharacter", probability: null }),
  ]);

  const report = analyze(directory, audit);
  const cluster = report.clusters.find((item) => item.signature === 'echo "a;b"');
  assert.equal(cluster?.activeSyntax, false);

  const recommendation = report.recommendations.find((item) => item.signature === 'echo "a;b"');
  assert.equal(recommendation?.kind, "allowlist-expansion");
});

test("never recommends allowlisting a read-only shape that can print secrets", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    ...ask(["kubectl get secrets -o yaml"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["docker inspect app"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["kubectl logs app"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    // Shapes that cannot dump credentials still get the allowlist recommendation.
    ...ask(["gh issue view <n>"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["docker ps"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
  ]);

  const report = analyze(directory, audit);
  const recommended = report.recommendations.map((item) => item.signature);

  for (const signature of ["kubectl get secrets -o yaml", "docker inspect app", "kubectl logs app"]) {
    assert.equal(recommended.includes(signature), false, `${signature} can print secrets`);
    const observation = report.observations.find((item) => item.signature === signature);
    assert.match(observation?.note ?? "", /read-only не подтверждён/);
  }

  assert.equal(recommended.includes("gh issue view <n>"), true);
  assert.equal(recommended.includes("docker ps"), true);
});

test("reads the configured threshold even when the entry has no audit_dir", (t) => {
  const directory = scratch(t);
  const config = join(directory, "config.jsonc");
  writeFileSync(
    config,
    `{ "plugins": [{ "package": "/checkouts/opencode-allow-classifier", "options": { "threshold": 0.5 } }] }`,
  );

  const high = join(directory, "high");
  writeLines(high, "evaluate-2026-10.jsonl", ask(["npm test"], 3, { source: "model", rule: "model", probability: 0.6 }));
  const low = join(directory, "low");
  writeLines(low, "evaluate-2026-10.jsonl", ask(["npm test"], 3, { source: "model", rule: "model", probability: 0.4 }));

  const highJson = run(["--config", config, "--audit-dir", high, "--since", "2000-01-01", "--json"], {
    cwd: directory,
  });
  assert.equal(highJson.status, 0, highJson.stderr);
  // Max 0.6 is above the effective 0.5 threshold: lowering it would change nothing.
  assert.deepEqual(parseReport(highJson).recommendations, []);

  const highText = run(["--config", config, "--audit-dir", high, "--since", "2000-01-01"], { cwd: directory });
  assert.equal(highText.status, 0, highText.stderr);
  assert.match(highText.stdout, /порог[а-я]* 0\.5/);

  const lowJson = run(["--config", config, "--audit-dir", low, "--since", "2000-01-01", "--json"], {
    cwd: directory,
  });
  assert.equal(lowJson.status, 0, lowJson.stderr);
  assert.deepEqual(
    parseReport(lowJson).recommendations.map((item) => item.kind),
    ["threshold-lowering"],
  );

  const lowText = run(["--config", config, "--audit-dir", low, "--since", "2000-01-01"], { cwd: directory });
  assert.equal(lowText.status, 0, lowText.stderr);
  assert.match(lowText.stdout, /порог[а-я]* 0\.5/);

  // The same threshold is found through project discovery when only --audit-dir is passed.
  const project = join(directory, "project");
  mkdirSync(project);
  writeFileSync(
    join(project, "opencode.jsonc"),
    `{ "plugins": [{ "package": "/checkouts/opencode-allow-classifier", "options": { "threshold": 0.5 } }] }`,
  );
  const discovered = run(["--audit-dir", high, "--since", "2000-01-01", "--json"], { cwd: project });
  assert.equal(discovered.status, 0, discovered.stderr);
  assert.deepEqual(parseReport(discovered).recommendations, []);
});

test("puts classifier errors in their own lever and never turns them into allowlist advice", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    ...ask(["kubectl get pods"], 3, { source: "error", rule: "timeout", probability: null }),
    ...ask(["terraform plan"], 3, { source: "error", rule: "provider", probability: null }),
  ]);

  const report = analyze(directory, audit);
  assert.deepEqual(
    report.classifierErrors.map((item) => item.signature),
    ["kubectl get pods", "terraform plan"],
  );
  assert.deepEqual(
    report.levers.map((section) => section.lever),
    ["allowlist-and-guards", "model-and-threshold", "hard-ask", "classifier-errors"],
  );
  assert.equal(report.levers[3]?.clusters.length, 2);
  assert.deepEqual(report.recommendations, []);
  assert.deepEqual(report.observations, []);

  for (const item of report.classifierErrors) {
    assert.match(item.recommendation, /провайдер|модель|таймаут/);
    assert.match(item.recommendation, /политику разрешений не менять/);
  }
});

test("keeps the report JSON stable, ordered and read-only", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    ...ask(["gh issue view <n>"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["npm test"], 3, { source: "model", rule: "model", probability: 0.3 }),
    ...ask(["sudo ls"], 3, { source: "hard-ask", rule: "sudo", probability: null }),
    ...ask(["kubectl get pods"], 3, { source: "error", rule: "timeout", probability: null }),
    ...ask(["git log <n>"], 2, { source: "allowlist", rule: "guard:outside-cwd", probability: null }),
  ]);

  const before = snapshot(directory);
  const jsonArgs = ["--audit-dir", audit, "--since", "2000-01-01", "--json"];
  const firstJson = run(jsonArgs, { cwd: directory });
  const secondJson = run(jsonArgs, { cwd: directory });
  assert.equal(firstJson.status, 0, firstJson.stderr);
  assert.equal(secondJson.status, 0, secondJson.stderr);
  assert.equal(secondJson.stdout, firstJson.stdout);

  const textArgs = ["--audit-dir", audit, "--since", "2000-01-01"];
  const firstText = run(textArgs, { cwd: directory });
  const secondText = run(textArgs, { cwd: directory });
  assert.equal(firstText.status, 0, firstText.stderr);
  assert.equal(secondText.stdout, firstText.stdout);

  assert.deepEqual(snapshot(directory), before);

  const report = parseReport(firstJson);
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
    "levers",
    "recommendations",
    "observations",
    "classifierErrors",
  ]);
  assert.deepEqual(Object.keys(report.recommendations[0]!), [
    "kind",
    "lever",
    "signature",
    "occurrences",
    "example",
    "newAllows",
    "risk",
    "why",
  ]);

  for (const marker of [
    "lever: allowlist-and-guards",
    "lever: model-and-threshold",
    "lever: hard-ask",
    "recommendations:",
    "observations:",
    "lever: classifier-errors",
  ]) {
    assert.match(firstText.stdout, new RegExp(`^${marker}$`, "m"));
  }
  assert.match(firstText.stdout, /^deny rules are out of scope: /m);

  const emptyAudit = join(directory, "empty-audit");
  writeLines(emptyAudit, "evaluate-2026-10.jsonl", [
    ...ask(["cat .env"], 3, { source: "allowlist", rule: "guard:secret-env", probability: null }),
  ]);
  const emptyText = run(["--audit-dir", emptyAudit, "--since", "2000-01-01"], { cwd: directory });
  assert.equal(emptyText.status, 0, emptyText.stderr);
  assert.match(emptyText.stdout, /^lever: model-and-threshold\n  none$/m);
  assert.match(emptyText.stdout, /^recommendations:\n  none$/m);
  assert.match(emptyText.stdout, /^lever: classifier-errors\n  none$/m);
});

test("never mentions a deny change inside a recommendation", (t) => {
  const directory = scratch(t);
  const audit = join(directory, "audit");
  writeLines(audit, "evaluate-2026-10.jsonl", [
    ...ask(["docker ps"], 3, { source: "default", rule: "no-allowlist-match", probability: null }),
    ...ask(["gh pr view <n>"], 3, { source: "hard-ask", rule: "gh-read-only", probability: null }),
    ...ask(["npm test"], 3, { source: "model", rule: "model", probability: 0.3 }),
    ...ask(["cat .env"], 3, { source: "allowlist", rule: "guard:secret-env", probability: null }),
  ]);

  const report = analyze(directory, audit);
  assert.equal(report.recommendations.length > 0, true);

  for (const item of report.recommendations) {
    for (const value of [item.kind, item.signature, item.example, ...item.newAllows, item.risk, item.why]) {
      assert.doesNotMatch(value, /deny|forbid|tighten|loosen|add deny|remove deny/i);
    }
  }

  const text = run(["--audit-dir", audit, "--since", "2000-01-01"], { cwd: directory });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /deny rules are out of scope/);
});

function snapshot(directory: string, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
    if (statSync(path).isDirectory()) {
      Object.assign(result, snapshot(path, relative));
    } else {
      result[relative] = `${statSync(path).mtimeMs}:${readFileSync(path, "utf8")}`;
    }
  }
  return result;
}
