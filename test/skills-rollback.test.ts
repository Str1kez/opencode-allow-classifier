import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { manifestPathFor, readManifest } from "../scripts/install-manifest.ts";
import { cleanConfigText } from "../scripts/layout.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, ".opencode/skills/allow-classifier-install/scripts/cli.ts");

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
  const directory = mkdtempSync(join(tmpdir(), "ocac-rollback-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function manifestPath(config: string, directory: string): string {
  return manifestPathFor(config, { XDG_STATE_HOME: join(directory, "state") });
}

test("rollback without a manifest says there is nothing to remove and keeps the file", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = `{
  "model": "provider/model",
}
`;
  writeFileSync(config, original);

  const result = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing to remove/);
  assert.equal(readFileSync(config, "utf8"), original);
  assert.equal(existsSync(manifestPath(config, directory)), false);
});

test("rollback deletes a config file that install created", (t) => {
  const directory = scratch(t);
  const config = join(directory, "created", "opencode.jsonc");

  const installed = run(["install", "--config", config], { cwd: directory });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(existsSync(config), true);
  assert.equal(existsSync(manifestPath(config, directory)), true);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 0, rolled.stderr);
  assert.match(rolled.stdout, /^--- /m);
  assert.match(rolled.stdout, /^\+\+\+ /m);
  assert.match(rolled.stdout, /^@@ /m);
  assert.match(rolled.stdout, /rolled back/);
  assert.equal(existsSync(config), false);
  assert.equal(existsSync(manifestPath(config, directory)), false);
});

test("rollback restores an originally empty config byte for byte", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(config, "");

  const installed = run(["install", "--config", config], { cwd: directory });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(readFileSync(config, "utf8").includes('"permissions"'), true);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 0, rolled.stderr);
  assert.equal(readFileSync(config, "utf8"), "");
  assert.equal(existsSync(manifestPath(config, directory)), false);
});

test("rollback restores a whitespace-only config byte for byte", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = "\n \t\n";
  writeFileSync(config, original);

  assert.equal(run(["install", "--config", config], { cwd: directory }).status, 0);
  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 0, rolled.stderr);
  assert.equal(readFileSync(config, "utf8"), original);
});

test("rollback restores a partially configured config byte for byte", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = `{
  // hand-written config
  "$schema": "https://opencode.ai/config.json",
  "model": "provider/model",
  "permissions": [
    { "action": "shell", "resource": "git status", "effect": "allow" },
    { "action": "edit", "resource": "src/**", "effect": "allow" },
  ],
  "plugins": [
    { "package": "other-plugin", "options": { "x": 1 } },
  ],
}
`;
  writeFileSync(config, original);

  const installed = run(["install", "--config", config], { cwd: directory });
  assert.equal(installed.status, 0, installed.stderr);
  const installedText = readFileSync(config, "utf8");
  assert.notEqual(installedText, original);
  assert.match(installedText, /git reset --hard/);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 0, rolled.stderr);
  assert.match(rolled.stdout, /^--- /m);
  assert.match(rolled.stdout, /rolled back/);
  assert.equal(readFileSync(config, "utf8"), original);
  assert.equal(existsSync(manifestPath(config, directory)), false);
});

test("rollback restores a plugin string that install replaced", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = `{
  "model": "provider/model",
  "plugins": [
    "other-plugin",
    ${JSON.stringify(REPO_ROOT)}
  ]
}
`;
  writeFileSync(config, original);

  const installed = run(["install", "--config", config], { cwd: directory });
  assert.equal(installed.status, 0, installed.stderr);
  const installedText = readFileSync(config, "utf8");
  assert.match(installedText, /"options": \{ "enabled": true \}/);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 0, rolled.stderr);
  assert.equal(readFileSync(config, "utf8"), original);
});

test("rollback removes added plugin options but keeps a user options object", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = `{
  "plugins": [
    { "package": ${JSON.stringify(REPO_ROOT)}, "options": { "threshold": 0.8 } }
  ]
}
`;
  writeFileSync(config, original);

  const installed = run(["install", "--config", config], { cwd: directory });
  assert.equal(installed.status, 0, installed.stderr);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 0, rolled.stderr);
  assert.equal(readFileSync(config, "utf8"), original);
});

test("rollback removes an options member that install added", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = `{
  "plugins": [
    {
      "package": ${JSON.stringify(REPO_ROOT)}
    }
  ]
}
`;
  writeFileSync(config, original);

  const installed = run(["install", "--config", config], { cwd: directory });
  assert.equal(installed.status, 0, installed.stderr);
  assert.match(readFileSync(config, "utf8"), /"options": \{ "enabled": true \}/);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 0, rolled.stderr);
  assert.equal(readFileSync(config, "utf8"), original);
});

test("rollback removes installer arrays while keeping later user settings", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(config, `{\n  "model": "provider/model"\n}\n`);
  assert.equal(run(["install", "--config", config], { cwd: directory }).status, 0);

  const edited = readFileSync(config, "utf8").replace(
    `  "model": "provider/model"`,
    `  "model": "provider/model",\n  "theme": "dark"`,
  );
  writeFileSync(config, edited);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 0, rolled.stderr);
  const text = readFileSync(config, "utf8");
  assert.match(text, /"model": "provider\/model"/);
  assert.match(text, /"theme": "dark"/);
  assert.doesNotMatch(text, /"permissions"/);
  assert.doesNotMatch(text, /"plugins"/);
  assert.equal(existsSync(manifestPath(config, directory)), false);
});

test("a second rollback says there is nothing to remove and keeps the file", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = `{
  "model": "provider/model"
}
`;
  writeFileSync(config, original);
  assert.equal(run(["install", "--config", config], { cwd: directory }).status, 0);
  assert.equal(run(["rollback", "--config", config], { cwd: directory }).status, 0);

  const second = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /nothing to remove/);
  assert.equal(readFileSync(config, "utf8"), original);
});

test("rollback refuses when an added node was edited after install", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = `{
  "plugins": [
    {
      "package": ${JSON.stringify(REPO_ROOT)}
    }
  ]
}
`;
  writeFileSync(config, original);
  assert.equal(run(["install", "--config", config], { cwd: directory }).status, 0);

  const edited = readFileSync(config, "utf8").replace('"enabled": true', '"enabled": false');
  writeFileSync(config, edited);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 1);
  assert.match(rolled.stderr, /refusing to roll back/);
  assert.match(rolled.stderr, /changed after install/);
  assert.match(rolled.stderr, /file left unchanged/);
  assert.match(rolled.stdout, /^--- /m);
  assert.equal(readFileSync(config, "utf8"), edited);
  assert.equal(existsSync(manifestPath(config, directory)), true);
});

test("rollback removes only installer nodes when unrelated edits are present", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = `{
  "plugins": [
    {
      "package": ${JSON.stringify(REPO_ROOT)}
    }
  ]
}
`;
  writeFileSync(config, original);
  assert.equal(run(["install", "--config", config], { cwd: directory }).status, 0);

  const withUserEdit = readFileSync(config, "utf8").replace(
    '"plugins": [',
    '"theme": "dark",\n  "plugins": [',
  );
  writeFileSync(config, withUserEdit);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 0, rolled.stderr);
  const expected = original.replace('"plugins": [', '"theme": "dark",\n  "plugins": [');
  assert.equal(readFileSync(config, "utf8"), expected);
});

test("a no-op install keeps the existing rollback manifest", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");

  assert.equal(run(["install", "--config", config], { cwd: directory }).status, 0);
  const manifest = manifestPath(config, directory);
  const before = readFileSync(manifest, "utf8");

  const again = run(["install", "--config", config], { cwd: directory });

  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /no changes/);
  assert.equal(readFileSync(manifest, "utf8"), before);
});

test("install reports a manifest failure but leaves a valid config", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const blocker = join(directory, "state-is-a-file");
  writeFileSync(blocker, "not a directory");

  const installed = run(["install", "--config", config], {
    cwd: directory,
    env: { XDG_STATE_HOME: blocker },
  });

  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stderr, /warning: install manifest could not be written/);
  assert.match(readFileSync(config, "utf8"), /"permissions"/);
  assert.equal(existsSync(manifestPath(config, directory)), false);

  const rolled = run(["rollback", "--config", config], { cwd: directory });
  assert.equal(rolled.status, 0, rolled.stderr);
  assert.match(rolled.stdout, /nothing to remove/);
});

test("install-state stays under the temp state dir, never the real home", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");

  assert.equal(run(["install", "--config", config], { cwd: directory }).status, 0);
  assert.equal(existsSync(manifestPath(config, directory)), true);

  const realHomeManifest = manifestPathFor(config, { ...process.env, XDG_STATE_HOME: "" });
  assert.equal(existsSync(realHomeManifest), false);
});

test("install-state directory and manifest are private", (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions only");
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");

  assert.equal(run(["install", "--config", config], { cwd: directory }).status, 0);
  const manifest = manifestPath(config, directory);

  assert.equal(statSync(dirname(manifest)).mode & 0o777, 0o700);
  assert.equal(statSync(manifest).mode & 0o777, 0o600);
});

test("install tightens an existing loose install-state directory", (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions only");
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const manifest = manifestPath(config, directory);
  mkdirSync(dirname(manifest), { recursive: true, mode: 0o755 });
  chmodSync(dirname(manifest), 0o755);

  assert.equal(run(["install", "--config", config], { cwd: directory }).status, 0);

  chmodSync(dirname(manifest), 0o755);
  chmodSync(manifest, 0o644);
  assert.ok(readManifest(config, { XDG_STATE_HOME: join(directory, "state") }));

  assert.equal(statSync(dirname(manifest)).mode & 0o777, 0o700);
  assert.equal(statSync(manifest).mode & 0o777, 0o600);
});

test("a corrupt install manifest fails clearly without touching the config", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const original = `{\n  "model": "provider/model"\n}\n`;
  writeFileSync(config, original);
  const manifest = manifestPath(config, directory);
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(manifest, `{"version": 1,`);

  const rolled = run(["rollback", "--config", config], { cwd: directory });

  assert.equal(rolled.status, 1);
  assert.match(rolled.stderr, /cannot read install manifest/);
  assert.doesNotMatch(rolled.stderr, /^\s+at /m);
  assert.equal(readFileSync(config, "utf8"), original);
});

test("a manifest write failure leaves no temp file behind", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const manifest = manifestPath(config, directory);
  mkdirSync(dirname(manifest), { recursive: true });
  mkdirSync(manifest);

  const installed = run(["install", "--config", config], { cwd: directory });

  assert.equal(installed.status, 0, installed.stderr);
  assert.match(installed.stderr, /warning: install manifest could not be written/);
  const leftovers = readdirSync(dirname(manifest)).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, []);
  assert.equal(readdirSync(dirname(manifest)).includes(basename(manifest)), true);
});

test("inspect and verify never create an install manifest", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(config, cleanConfigText(REPO_ROOT));

  const inspected = run(["inspect", "--config", config], { cwd: directory });
  const verified = run(["verify", "--config", config], { cwd: directory });

  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(existsSync(manifestPath(config, directory)), false);
});
