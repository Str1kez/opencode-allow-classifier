import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, ".opencode/skills/allow-classifier-install/scripts/cli.ts");
const DENY_RESOURCES = [
  "git push --force*",
  "git push -f*",
  "git reset --hard*",
  "rm -rf*",
  "*--no-verify*",
  "*--dangerously-skip-permissions*",
];

function configWith(packageRoot: string, options: Record<string, unknown> = { enabled: true }): string {
  const deny = DENY_RESOURCES.map(
    (resource) => `    { "action": "shell", "resource": ${JSON.stringify(resource)}, "effect": "deny" }`,
  ).join(",\n");

  return `{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
${deny}
  ],
  "plugins": [
    {
      "package": ${JSON.stringify(packageRoot)},
      "options": ${JSON.stringify(options, null, 2).replaceAll("\n", "\n      ")}
    }
  ]
}
`;
}

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
  const directory = mkdtempSync(join(tmpdir(), "ocac-verify-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeConfig(directory: string, content: string): string {
  const config = join(directory, "opencode.jsonc");
  writeFileSync(config, content);
  return config;
}

/** `opencode` is never installed for the tests: the version is always substituted. */
const HARNESS = ["--harness-version", "2.2.5"] as const;

test("verify passes a clean config, the supported harness and the package dependencies", (t) => {
  const directory = scratch(t);
  const config = writeConfig(directory, configWith(REPO_ROOT));

  const result = run(["verify", "--config", config, ...HARNESS, "--deps-root", REPO_ROOT], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS config/);
  assert.match(result.stdout, /PASS plugin entry: object/);
  assert.match(result.stdout, /PASS kill switch: enabled/);
  assert.match(result.stdout, /PASS harness version: 2\.2\.5/);
  assert.match(result.stdout, new RegExp(`PASS dependencies: @opencode/plugin, effect`));
  assert.match(result.stdout, /verify: ok/);
  assert.doesNotMatch(result.stdout, /FAIL/);

  assert.match(result.stdout, /PASS sudo -n true -> ask \/ hard-ask \/ sudo/);
  assert.match(result.stdout, /PASS cat \.env -> ask \/ guard \/ guard:secret-env/);
  assert.match(result.stdout, /PASS cat \.\.\/secret\.txt -> ask \/ guard \/ guard:outside-cwd/);
  assert.match(result.stdout, /PASS ls -> allow \/ allowlist \/ ls/);
});

test("verify warns but stays green on a harness outside 2.2.x", (t) => {
  const directory = scratch(t);
  const config = writeConfig(directory, configWith(REPO_ROOT));

  const result = run(["verify", "--config", config, "--harness-version", "2.1.0", "--deps-root", REPO_ROOT], {
    cwd: directory,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARN harness version: 2\.1\.0/);
  assert.match(result.stdout, /verify: ok/);
});

test("verify warns instead of crashing when the harness binary is missing", (t) => {
  const directory = scratch(t);
  const config = writeConfig(directory, configWith(REPO_ROOT));

  const result = run(["verify", "--config", config, "--deps-root", REPO_ROOT], {
    cwd: directory,
    env: { PATH: "" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARN harness version: not detected/);
  assert.match(result.stdout, /verify: ok/);
  assert.doesNotMatch(result.stderr, /at .*\.ts:\d+/);
});

test("verify fails with a clear message when the package dependencies are missing", (t) => {
  const directory = scratch(t);
  const config = writeConfig(directory, configWith(REPO_ROOT));
  const emptyRoot = join(directory, "empty-root");
  mkdirSync(emptyRoot);

  const result = run(["verify", "--config", config, ...HARNESS, "--deps-root", emptyRoot], { cwd: directory });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL dependencies: missing under/);
  assert.match(result.stdout, /@opencode\/plugin/);
  assert.match(result.stdout, /effect/);
  assert.match(result.stdout, /verify: failed/);
  assert.doesNotMatch(result.stderr, /at .*\.ts:\d+/);
});

test("verify fails when the kill switch is off", (t) => {
  const directory = scratch(t);
  const config = writeConfig(directory, configWith(REPO_ROOT, { enabled: false }));

  const result = run(["verify", "--config", config, ...HARNESS, "--deps-root", REPO_ROOT], { cwd: directory });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL kill switch: disabled/);
  assert.match(result.stdout, /verify: failed/);
});

test("verify warns when the kill switch is unknown", (t) => {
  const directory = scratch(t);
  const config = writeConfig(directory, configWith(REPO_ROOT, {}));

  const result = run(["verify", "--config", config, ...HARNESS, "--deps-root", REPO_ROOT], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /WARN kill switch: unknown/);
  assert.match(result.stdout, /verify: ok/);
});

test("verify fails when the plugin is configured as a string", (t) => {
  const directory = scratch(t);
  const config = writeConfig(
    directory,
    `{
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }],
  "plugins": [${JSON.stringify(REPO_ROOT)}],
}
`,
  );

  const result = run(["verify", "--config", config, ...HARNESS, "--deps-root", REPO_ROOT], { cwd: directory });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /FAIL plugin entry: string/);
  assert.match(result.stdout, /verify: failed/);
});

test("verify fails cleanly on a missing or unreadable config", (t) => {
  const directory = scratch(t);
  const missing = join(directory, "missing.jsonc");

  const absent = run(["verify", "--config", missing, ...HARNESS, "--deps-root", REPO_ROOT], { cwd: directory });
  assert.equal(absent.status, 1);
  assert.match(absent.stdout, /FAIL config: not found/);
  assert.match(absent.stdout, /verify: failed/);
  assert.doesNotMatch(absent.stderr, /at .*\.ts:\d+/);

  const invalid = join(directory, "invalid.jsonc");
  writeFileSync(invalid, '{ "permissions": [ }');
  const broken = run(["verify", "--config", invalid, ...HARNESS, "--deps-root", REPO_ROOT], { cwd: directory });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /FAIL config: cannot parse/);
  assert.match(broken.stdout, /verify: failed/);
  assert.doesNotMatch(broken.stderr, /at .*\.ts:\d+/);
});

test("verify uses the config audit_dir in the live checklist", (t) => {
  const directory = scratch(t);
  const auditDirectory = join(directory, "custom-audit");
  const config = writeConfig(
    directory,
    configWith(REPO_ROOT, { enabled: true, audit_dir: auditDirectory }),
  );

  const result = run(["verify", "--config", config, ...HARNESS, "--deps-root", REPO_ROOT], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`directory: ${auditDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(plugin option audit_dir\\)`));
  assert.match(result.stdout, /evaluate-\*\.jsonl/);
  assert.match(result.stdout, /verdict "allow" and source "allowlist"/);
});

test("verify defaults the audit directory to the OpenCode state directory", (t) => {
  const directory = scratch(t);
  const config = writeConfig(directory, configWith(REPO_ROOT));

  const result = run(["verify", "--config", config, ...HARNESS, "--deps-root", REPO_ROOT], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  const stateDirectory = join(directory, "state/opencode");
  assert.match(
    result.stdout,
    new RegExp(`directory: ${stateDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(default state directory\\)`),
  );
});

test("verify prints the live checklist without running OpenCode", (t) => {
  const directory = scratch(t);
  const config = writeConfig(directory, configWith(REPO_ROOT));

  const result = run(["verify", "--config", config, ...HARNESS, "--deps-root", REPO_ROOT], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /live proof \(manual checklist, this script does not run OpenCode\)/);
  assert.match(result.stdout, /open this repository in OpenCode/);
  assert.match(result.stdout, /run a safe read-only command, for example: ls/);
  assert.match(result.stdout, /no restart is required, \/reload forces a reload/);
});
