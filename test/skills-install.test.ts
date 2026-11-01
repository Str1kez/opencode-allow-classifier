import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { contentHash, manifestPathFor } from "../scripts/install-manifest.ts";

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

function cleanConfig(packageRoot: string): string {
  const deny = DENY_RESOURCES.map(
    (resource) => `    { "action": "shell", "resource": ${JSON.stringify(resource)}, "effect": "deny" }`,
  ).join(",\n");

  return `{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "external_directory", "resource": "*", "effect": "ask" },
${deny}
  ],
  "plugins": [
    {
      "package": ${JSON.stringify(packageRoot)},
      "options": {
        "enabled": true
      }
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
  const directory = mkdtempSync(join(tmpdir(), "ocac-install-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("install creates the global config with the clean layout", (t) => {
  const directory = scratch(t);
  const result = run(["install"], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  const config = join(directory, "xdg/opencode/opencode.jsonc");
  assert.equal(readFileSync(config, "utf8"), cleanConfig(REPO_ROOT));
  assert.match(result.stdout, new RegExp(`created ${config.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("install records a rollback manifest under the state directory", (t) => {
  const directory = scratch(t);
  const result = run(["install"], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  const config = join(directory, "xdg/opencode/opencode.jsonc");
  const manifestPath = manifestPathFor(config, { XDG_STATE_HOME: join(directory, "state") });
  assert.equal(existsSync(manifestPath), true);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    configPath: string;
    postInstallHash: string;
    original: { exists: boolean };
  };
  assert.equal(manifest.configPath, config);
  assert.equal(manifest.postInstallHash, contentHash(readFileSync(config, "utf8")));
  assert.equal(manifest.original.exists, false);
});

test("install turns an empty config file into the clean layout", (t) => {
  const directory = scratch(t);
  const config = join(directory, "configs/opencode.jsonc");
  mkdirSync(join(directory, "configs"));
  writeFileSync(config, "\n \t\n");

  const result = run(["install", "--config", config], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(config, "utf8"), cleanConfig(REPO_ROOT));
});

test("install is an idempotent no-op on a commented config with trailing commas", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const decorated = cleanConfig(REPO_ROOT)
    .replace('{\n  "$schema"', '// kept by the owner\n{\n  "$schema"')
    .replace('  "permissions": [', '  // catch-all first\n  "permissions": [')
    .replace('  ],\n  "plugins"', '  ], // deny block ends here\n  "plugins"')
    .replace('        "enabled": true\n', '        "enabled": true,\n')
    .replace("    }\n  ]\n}", "    },\n  ],\n}");
  writeFileSync(config, decorated);
  const before = readFileSync(config, "utf8");

  const first = run(["install", "--config", config], { cwd: directory });
  const second = run(["install", "--config", config], { cwd: directory });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /no changes/);
  assert.match(second.stdout, /no changes/);
  assert.equal(readFileSync(config, "utf8"), before);
});

test("install merges a valid foreign config and keeps the owner's settings", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  const foreign = `{
  // my own settings
  "model": "provider/model",
  "permissions": [{ "action": "shell", "resource": "ls*", "effect": "allow" }],
}
`;
  writeFileSync(config, foreign);

  const result = run(["install", "--config", config], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /merged/);
  const text = readFileSync(config, "utf8");
  assert.match(text, /\/\/ my own settings/);
  assert.match(text, /"model": "provider\/model"/);
  assert.match(text, /\{ "action": "shell", "resource": "ls\*", "effect": "allow" \}/);
  assert.match(text, /"resource": "\*", "effect": "ask"/);
});

test("install refuses to rewrite invalid JSONC and leaves it byte-identical", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(config, '{ "permissions": [,] }');

  const result = run(["install", "--config", config], { cwd: directory });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot parse/);
  assert.equal(readFileSync(config, "utf8"), '{ "permissions": [,] }');
});

test("install --project targets the current project and never the global config", (t) => {
  const directory = scratch(t);
  const result = run(["install", "--project"], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(directory, "opencode.jsonc"), "utf8"), cleanConfig(REPO_ROOT));
  assert.equal(existsSync(join(directory, "xdg/opencode/opencode.jsonc")), false);
});

test("install falls back to ~/.config when XDG_CONFIG_HOME is empty", (t) => {
  const directory = scratch(t);
  const result = run(["install"], { cwd: directory, env: { XDG_CONFIG_HOME: "" } });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(directory, "home/.config/opencode/opencode.jsonc"), "utf8"), cleanConfig(REPO_ROOT));
});

test("inspect reports the kill switch off", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(
    config,
    `{
  "permissions": [],
  "plugins": [{ "package": ${JSON.stringify(REPO_ROOT)}, "options": { "enabled": false } }],
}
`,
  );

  const text = run(["inspect", "--config", config], { cwd: directory });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /kill switch: disabled/);

  const json = run(["inspect", "--config", config, "--json"], { cwd: directory });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout) as { plugin: { killSwitch: string; enabled: boolean } };
  assert.equal(report.plugin.killSwitch, "disabled");
  assert.equal(report.plugin.enabled, false);
});

test("inspect reports a clean installed config as text and JSON", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(config, cleanConfig(REPO_ROOT));

  const text = run(["inspect", "--config", config], { cwd: directory });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, new RegExp(`config: ${config.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(text.stdout, /exists: yes/);
  assert.match(text.stdout, /0: shell "\*" -> ask \(catch-all\)/);
  assert.match(text.stdout, /1: external_directory "\*" -> ask/);
  assert.match(text.stdout, /catch-all first among shell rules: yes/);
  assert.match(text.stdout, /external directory ask rule: yes/);
  assert.match(text.stdout, /deny rules after catch-all: yes/);
  assert.match(text.stdout, /plugin entry: object/);
  assert.match(text.stdout, /plugin options: object/);
  assert.match(text.stdout, /kill switch: enabled/);
  assert.match(text.stdout, /warnings: none/);

  const json = run(["inspect", "--config", config, "--json"], { cwd: directory });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout) as {
    path: string;
    exists: boolean;
    rules: Array<{ index: number; action: string; resource: string; effect: string; catchAll: boolean; valid: boolean }>;
    catchAll: { present: boolean; index: number; firstAmongShell: boolean };
    externalDirectory: { present: boolean; index: number | null; effect: string | null };
    denyAfterCatchAll: boolean;
    missingDenyRules: string[];
    plugin: {
      present: boolean;
      type: string;
      package: string;
      packageMatches: boolean;
      options: { present: boolean; type: string };
      killSwitch: string;
    };
    warnings: string[];
  };

  assert.equal(report.path, config);
  assert.equal(report.exists, true);
  assert.equal(report.rules.length, 8);
  assert.deepEqual(report.rules[0], {
    index: 0,
    action: "shell",
    resource: "*",
    effect: "ask",
    catchAll: true,
    valid: true,
  });
  assert.deepEqual(report.rules[1], {
    index: 1,
    action: "external_directory",
    resource: "*",
    effect: "ask",
    catchAll: false,
    valid: true,
  });
  assert.deepEqual(report.catchAll, { present: true, index: 0, firstAmongShell: true });
  assert.deepEqual(report.externalDirectory, { present: true, index: 1, effect: "ask" });
  assert.equal(report.denyAfterCatchAll, true);
  assert.deepEqual(report.missingDenyRules, []);
  assert.equal(report.plugin.present, true);
  assert.equal(report.plugin.type, "object");
  assert.equal(report.plugin.package, REPO_ROOT);
  assert.equal(report.plugin.packageMatches, true);
  assert.deepEqual(report.plugin.options, { present: true, type: "object" });
  assert.equal(report.plugin.killSwitch, "enabled");
  assert.deepEqual(report.warnings, []);

  const repeated = run(["inspect", "--config", config, "--json"], { cwd: directory });
  assert.equal(repeated.stdout, json.stdout);
});

test("inspect reads a commented user config with trailing commas and reports problems", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(
    config,
    `// owner config
{
  "permissions": [
    { "action": "shell", "resource": "rm -rf*", "effect": "deny" }, // before the catch-all
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git push --force*", "effect": "deny" },
  ],
  "plugins": [${JSON.stringify(REPO_ROOT)}],
}
`,
  );

  const json = run(["inspect", "--config", config, "--json"], { cwd: directory });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout) as {
    rules: Array<{ index: number; resource: string; effect: string; catchAll: boolean }>;
    catchAll: { present: boolean; index: number; firstAmongShell: boolean };
    denyAfterCatchAll: boolean;
    missingDenyRules: string[];
    plugin: {
      present: boolean;
      type: string;
      package: string | null;
      packageMatches: boolean;
      options: { present: boolean };
      killSwitch: string;
      enabled: boolean | null;
    };
    warnings: string[];
  };

  assert.deepEqual(
    report.rules.map((rule) => [rule.index, rule.resource, rule.effect, rule.catchAll]),
    [
      [0, "rm -rf*", "deny", false],
      [1, "*", "ask", true],
      [2, "git push --force*", "deny", false],
    ],
  );
  assert.deepEqual(report.catchAll, { present: true, index: 1, firstAmongShell: false });
  assert.equal(report.denyAfterCatchAll, false);
  assert.deepEqual(report.missingDenyRules, [
    "git push -f*",
    "git reset --hard*",
    "*--no-verify*",
    "*--dangerously-skip-permissions*",
  ]);
  assert.equal(report.plugin.present, true);
  assert.equal(report.plugin.type, "string");
  assert.equal(report.plugin.package, REPO_ROOT);
  assert.equal(report.plugin.packageMatches, true);
  assert.equal(report.plugin.options.present, false);
  assert.equal(report.plugin.killSwitch, "unknown");
  assert.equal(report.plugin.enabled, null);
  assert.ok(report.warnings.some((warning) => /catch-all is not the first shell rule/.test(warning)));
  assert.ok(report.warnings.some((warning) => /deny rule "rm -rf\*" at index 0 comes before the catch-all/.test(warning)));
  assert.ok(report.warnings.some((warning) => /plugin entry is a string/.test(warning)));

  const text = run(["inspect", "--config", config], { cwd: directory });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /catch-all first among shell rules: no/);
  assert.match(text.stdout, /deny rules after catch-all: no/);
  assert.match(text.stdout, /kill switch: unknown/);
  assert.match(text.stdout, /warnings:/);
});

test("inspect reports a missing external_directory ask rule", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(
    config,
    `{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
  ],
  "plugins": [{ "package": ${JSON.stringify(REPO_ROOT)}, "options": { "enabled": true } }],
}
`,
  );

  const json = run(["inspect", "--config", config, "--json"], { cwd: directory });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout) as {
    externalDirectory: { present: boolean; index: number | null; effect: string | null };
    warnings: string[];
  };
  assert.deepEqual(report.externalDirectory, { present: false, index: null, effect: null });
  assert.ok(report.warnings.some((warning) => /external_directory rule "\*" with effect "ask" is missing/.test(warning)));

  const text = run(["inspect", "--config", config], { cwd: directory });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /external directory ask rule: no/);
});

test("inspect reports an external_directory rule with a different effect", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(
    config,
    `{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "external_directory", "resource": "*", "effect": "allow" },
  ],
  "plugins": [{ "package": ${JSON.stringify(REPO_ROOT)}, "options": { "enabled": true } }],
}
`,
  );

  const result = run(["inspect", "--config", config, "--json"], { cwd: directory });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as {
    externalDirectory: { present: boolean; index: number | null; effect: string | null };
    warnings: string[];
  };
  assert.deepEqual(report.externalDirectory, { present: true, index: 1, effect: "allow" });
  assert.ok(
    report.warnings.some((warning) => /external_directory rule "\*" has effect "allow"; expected "ask"/.test(warning)),
  );
});

test("inspect does not read the kill switch from a foreign plugin entry", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(
    config,
    `{
  "permissions": [],
  "plugins": [{ "package": "some-other-plugin", "options": { "enabled": false } }],
}
`,
  );

  const text = run(["inspect", "--config", config], { cwd: directory });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /plugin entry: missing/);
  assert.match(text.stdout, /kill switch: unknown/);
  assert.doesNotMatch(text.stdout, /kill switch: disabled/);

  const json = run(["inspect", "--config", config, "--json"], { cwd: directory });
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout) as {
    plugin: { present: boolean; type: string; killSwitch: string; enabled: boolean | null };
    warnings: string[];
  };
  assert.equal(report.plugin.present, false);
  assert.equal(report.plugin.type, "missing");
  assert.equal(report.plugin.killSwitch, "unknown");
  assert.equal(report.plugin.enabled, null);
  assert.ok(report.warnings.includes(`plugin entry for ${REPO_ROOT} is not found`));
});

test("inspect reports duplicate keys without corrupting the report", (t) => {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(config, '{ "permissions": [], "permissions": [] }');

  const result = run(["inspect", "--config", config, "--json"], { cwd: directory });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout) as { warnings: string[] };
  assert.ok(report.warnings.some((warning) => /duplicate key "permissions" at \$/.test(warning)));
});

test("the install skill is discoverable through SKILL.md frontmatter", () => {
  const skill = readFileSync(join(REPO_ROOT, ".opencode/skills/allow-classifier-install/SKILL.md"), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill);

  assert.ok(frontmatter, "SKILL.md starts with frontmatter");
  assert.match(frontmatter[1]!, /^name: allow-classifier-install$/m);
  assert.match(frontmatter[1]!, /^description: .+$/m);
});

test("inspect reports a missing config and parse errors with a nonzero exit", (t) => {
  const directory = scratch(t);
  const missing = join(directory, "missing.jsonc");

  const absent = run(["inspect", "--config", missing], { cwd: directory });
  assert.notEqual(absent.status, 0);
  assert.match(absent.stdout, /exists: no/);

  const invalid = join(directory, "invalid.jsonc");
  writeFileSync(invalid, '{ "permissions": [ }');
  const broken = run(["inspect", "--config", invalid], { cwd: directory });
  assert.notEqual(broken.status, 0);
  assert.match(broken.stderr, /Invalid JSONC/);
});
