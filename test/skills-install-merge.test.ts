import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { manifestPathFor } from "../scripts/install-manifest.ts";
import { parseJsonc, toValue } from "../scripts/jsonc.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const CLI = join(REPO_ROOT, ".opencode/skills/allow-classifier-install/scripts/cli.ts");
const CATCH_ALL = "*";
const DENY_RESOURCES = [
  "git push --force*",
  "git push -f*",
  "git reset --hard*",
  "rm -rf*",
  "*--no-verify*",
  "*--dangerously-skip-permissions*",
];

interface Rule {
  readonly action: string;
  readonly resource: string;
  readonly effect: string;
}

interface ParsedConfig {
  readonly permissions: Rule[];
  readonly plugins: Array<Record<string, unknown> | string>;
  readonly [key: string]: unknown;
}

function permissionLines(): string {
  const rules = [
    { effect: "ask", resource: CATCH_ALL },
    ...DENY_RESOURCES.map((resource) => ({ effect: "deny", resource })),
  ];
  return rules
    .map(
      (rule) =>
        `    { "action": "shell", "resource": ${JSON.stringify(rule.resource)}, "effect": ${JSON.stringify(rule.effect)} }`,
    )
    .join(",\n");
}

function parse(text: string): ParsedConfig {
  return toValue(parseJsonc(text).root) as unknown as ParsedConfig;
}

function shellRules(config: ParsedConfig): Rule[] {
  return config.permissions.filter((rule) => rule.action === "shell");
}

function denyResources(config: ParsedConfig): string[] {
  return shellRules(config)
    .filter((rule) => rule.effect === "deny")
    .map((rule) => rule.resource);
}

function run(directory: string, args: readonly string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: join(directory, "home"),
      XDG_CONFIG_HOME: join(directory, "xdg"),
      XDG_STATE_HOME: join(directory, "state"),
    },
  });
}

function scratch(t: { after: (fn: () => void) => void }): string {
  const directory = mkdtempSync(join(tmpdir(), "ocac-merge-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function install(t: { after: (fn: () => void) => void }, text: string) {
  const directory = scratch(t);
  const config = join(directory, "opencode.jsonc");
  writeFileSync(config, text);
  const result = run(directory, ["install", "--config", config]);
  return { directory, config, result, read: () => readFileSync(config, "utf8") };
}

test("install adds only missing deny rules to a partially configured config", (t) => {
  const original = `// owner config
{
  "model": "provider/model",
  "permissions": [
    { "action": "edit", "resource": "src/**", "effect": "allow" }, // foreign rule
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "git push --force*", "effect": "deny" }, // already denied
    { "action": "shell", "resource": "ls*", "effect": "allow" }, // user allow
  ],
  "plugins": [
    { "package": "other-plugin", "options": { "x": 1 } },
    {
      "package": ${JSON.stringify(REPO_ROOT)},
      "options": { "enabled": false, "threshold": 0.8 },
    },
  ],
}
`;
  const { config, directory, result, read } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^--- /m);
  assert.match(result.stdout, /^\+\+\+ /m);
  assert.match(result.stdout, /^@@ /m);
  assert.match(result.stdout, /merged/);

  const text = read();
  const parsed = parse(text);

  assert.match(text, /\/\/ owner config/);
  assert.match(text, /\/\/ foreign rule/);
  assert.match(text, /\/\/ already denied/);
  assert.match(text, /\/\/ user allow/);
  assert.match(text, /\{ "action": "edit", "resource": "src\/\*\*", "effect": "allow" \}/);
  assert.match(text, /\{ "action": "shell", "resource": "ls\*", "effect": "allow" \}/);

  const shell = shellRules(parsed);
  assert.equal(shell[0]!.resource, CATCH_ALL);
  assert.equal(shell[0]!.effect, "ask");
  assert.equal(shell.filter((rule) => rule.resource === CATCH_ALL && rule.effect === "ask").length, 1);
  assert.deepEqual(new Set(denyResources(parsed)), new Set(DENY_RESOURCES));
  assert.equal(denyResources(parsed).length, DENY_RESOURCES.length);
  assert.equal(denyResources(parsed).filter((resource) => resource === "git push --force*").length, 1);

  const catchAllIndex = parsed.permissions.findIndex((rule) => rule.resource === CATCH_ALL && rule.effect === "ask");
  for (const rule of parsed.permissions.filter((entry) => entry.effect === "deny")) {
    assert.ok(parsed.permissions.indexOf(rule) > catchAllIndex);
  }

  assert.deepEqual(parsed.plugins[0], { package: "other-plugin", options: { x: 1 } });
  assert.deepEqual((parsed.plugins[1] as { options: unknown }).options, { enabled: false, threshold: 0.8 });

  const manifest = JSON.parse(
    readFileSync(manifestPathFor(config, { XDG_STATE_HOME: join(directory, "state") }), "utf8"),
  ) as {
    original: { exists: boolean; text: string };
    additions: { catchAll: boolean; denyRules: string[]; plugin: string; pluginsArray: boolean };
  };
  assert.equal(manifest.original.exists, true);
  assert.equal(manifest.original.text, original);
  assert.deepEqual(manifest.additions.denyRules, [
    "git push -f*",
    "git reset --hard*",
    "rm -rf*",
    "*--no-verify*",
    "*--dangerously-skip-permissions*",
  ]);
  assert.equal(manifest.additions.catchAll, false);
  assert.equal(manifest.additions.pluginsArray, false);
  assert.equal(manifest.additions.plugin, "kept");

  const afterFirstRun = read();
  const rerun = run(directory, ["install", "--config", config]);

  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /no changes/);
  assert.equal(read(), afterFirstRun);
});

test("install stops with a proposed diff when the catch-all is not the first shell rule", (t) => {
  const original = `{
  "permissions": [
    { "action": "shell", "resource": "rm -rf*", "effect": "deny" },
    { "action": "shell", "resource": "*", "effect": "ask" }
  ],
}
`;
  const { read, result } = install(t, original);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /catch-all must be the first shell rule/);
  assert.match(result.stderr, /file left unchanged/);
  assert.match(result.stdout, /proposed diff/);
  assert.match(result.stdout, /^--- /m);
  assert.match(result.stdout, /^\+\+\+ /m);
  assert.match(result.stdout, /^@@ /m);
  assert.match(result.stdout, /^\+.*"resource": "\*", "effect": "ask"/m);
  assert.match(result.stdout, /^-.*"resource": "\*", "effect": "ask"/m);
  assert.equal(read(), original);
});

test("install keeps foreign permission rules and appends the missing shell rules", (t) => {
  const original = `{
  // keep me
  "permissions": [
    { "action": "read", "resource": "**", "effect": "allow" }, // read allow
  ],
}
`;
  const { read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  const text = read();
  assert.match(text, /\/\/ keep me/);
  assert.match(text, /\/\/ read allow/);

  const parsed = parse(text);
  assert.deepEqual(parsed.permissions[0], { action: "read", resource: "**", effect: "allow" });
  assert.equal(parsed.permissions[1]!.resource, CATCH_ALL);
  assert.equal(parsed.permissions[1]!.effect, "ask");
  assert.deepEqual(new Set(denyResources(parsed)), new Set(DENY_RESOURCES));
  assert.equal(parsed.plugins.length, 1);
});

test("install replaces a plugin string with an object and shows the replacement", (t) => {
  const original = `{
  "permissions": [
${permissionLines()}
  ],
  "plugins": [
    ${JSON.stringify(REPO_ROOT)},
    { "package": "other-plugin", "options": {} },
  ],
}
`;
  const { directory, config, read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^-\\s+${escapeRegExp(JSON.stringify(REPO_ROOT))},$`, "m"));
  assert.match(result.stdout, /^\+.*\{ "package": .* "options": \{ "enabled": true \} \},$/m);

  const parsed = parse(read());
  assert.deepEqual(parsed.plugins[0], { package: REPO_ROOT, options: { enabled: true } });
  assert.deepEqual(parsed.plugins[1], { package: "other-plugin", options: {} });

  const afterFirstRun = read();
  const rerun = run(directory, ["install", "--config", config]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /no changes/);
  assert.equal(read(), afterFirstRun);
});

test("install preserves existing plugin options", (t) => {
  const original = `{
  "permissions": [
${permissionLines()}
  ],
  "plugins": [
    { "package": ${JSON.stringify(REPO_ROOT)}, "options": { "threshold": 0.5 } },
  ],
}
`;
  const { read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  const parsed = parse(read());

  assert.deepEqual((parsed.plugins[0] as { options: unknown }).options, { threshold: 0.5 });
});

test("install adds options to a plugin object that has none", (t) => {
  const original = `{
  "permissions": [
${permissionLines()}
  ],
  "plugins": [
    { "package": ${JSON.stringify(REPO_ROOT)} },
  ],
}
`;
  const { read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  const text = read();
  const parsed = parse(text);

  assert.deepEqual(parsed.plugins[0], { package: REPO_ROOT, options: { enabled: true } });
  assert.match(result.stdout, /^\+.*"options": \{ "enabled": true \}/m);
});

test("install preserves comments and trailing commas while merging", (t) => {
  const original = `// leading comment
{
  // policy starts here
  "permissions": [
    // catch-all first
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "rm -rf*", "effect": "deny" }, // already there
  ],
  // plugins below
}
`;
  const { config, directory, read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  const text = read();

  assert.match(text, /^\/\/ leading comment/m);
  assert.match(text, /\/\/ policy starts here/);
  assert.match(text, /\/\/ catch-all first/);
  assert.match(text, /\/\/ already there/);
  assert.match(text, /\/\/ plugins below/);
  assert.match(text, /\{ "action": "shell", "resource": "rm -rf\*", "effect": "deny" \}, \/\/ already there/);

  const parsed = parse(text);
  assert.equal(denyResources(parsed).filter((resource) => resource === "rm -rf*").length, 1);
  assert.deepEqual(new Set(denyResources(parsed)), new Set(DENY_RESOURCES));

  const afterFirstRun = read();
  const rerun = run(directory, ["install", "--config", config]);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /no changes/);
  assert.equal(read(), afterFirstRun);
});

test("install adds a missing permissions array and appends the plugin entry", (t) => {
  const original = `{
  "model": "provider/model",
  "plugins": [
    { "package": "other-plugin", "options": { "x": 1 } },
  ],
}
`;
  const { read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  const parsed = parse(read());

  assert.equal(parsed.model, "provider/model");
  assert.equal(parsed.permissions.length, 1 + DENY_RESOURCES.length);
  assert.equal(shellRules(parsed)[0]!.resource, CATCH_ALL);
  assert.deepEqual(new Set(denyResources(parsed)), new Set(DENY_RESOURCES));
  assert.deepEqual(parsed.plugins[0], { package: "other-plugin", options: { x: 1 } });
  assert.deepEqual(parsed.plugins[1], { package: REPO_ROOT, options: { enabled: true } });
});

test("install adds a missing plugins array", (t) => {
  const original = `{
  "permissions": [
${permissionLines()}
  ],
}
`;
  const { read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  const parsed = parse(read());

  assert.deepEqual(parsed.plugins, [{ package: REPO_ROOT, options: { enabled: true } }]);
});

test("install inserts a missing catch-all before the first shell rule", (t) => {
  const original = `{
  "permissions": [
    { "action": "edit", "resource": "docs/**", "effect": "deny" },
    { "action": "shell", "resource": "ls*", "effect": "allow" },
    { "action": "shell", "resource": "rm -rf*", "effect": "deny" },
  ],
}
`;
  const { read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  const parsed = parse(read());

  assert.deepEqual(
    parsed.permissions.map((rule) => [rule.action, rule.resource, rule.effect]),
    [
      ["edit", "docs/**", "deny"],
      ["shell", CATCH_ALL, "ask"],
      ["shell", "ls*", "allow"],
      ["shell", "rm -rf*", "deny"],
      ...DENY_RESOURCES.filter((resource) => resource !== "rm -rf*").map((resource) => [
        "shell",
        resource,
        "deny",
      ]),
    ],
  );
});

test("install fills empty permissions and plugins arrays", (t) => {
  const original = `{
  "permissions": [],
  "plugins": []
}
`;
  const { read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  const text = read();
  const parsed = parse(text);

  assert.equal(parsed.permissions.length, 1 + DENY_RESOURCES.length);
  assert.equal(shellRules(parsed)[0]!.resource, CATCH_ALL);
  assert.deepEqual(new Set(denyResources(parsed)), new Set(DENY_RESOURCES));
  assert.deepEqual(parsed.plugins, [{ package: REPO_ROOT, options: { enabled: true } }]);
  assert.ok(!text.includes("permissions\": []"));
  assert.ok(!text.includes("plugins\": []"));
});

test("install fills an empty object config with both arrays", (t) => {
  const original = "{}\n";
  const { read, result } = install(t, original);

  assert.equal(result.status, 0, result.stderr);
  const parsed = parse(read());

  assert.equal(parsed.permissions.length, 1 + DENY_RESOURCES.length);
  assert.equal(shellRules(parsed)[0]!.resource, CATCH_ALL);
  assert.deepEqual(parsed.plugins, [{ package: REPO_ROOT, options: { enabled: true } }]);
});

test("install refuses a duplicate-key config without touching it", (t) => {
  const original = '{ "permissions": [], "permissions": [] }\n';
  const { read, result } = install(t, original);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /duplicate keys/);
  assert.match(result.stderr, /file left unchanged/);
  assert.doesNotMatch(result.stdout, /@@/);
  assert.equal(read(), original);
});

test("install refuses a non-object root without touching it", (t) => {
  const original = "[]\n";
  const { read, result } = install(t, original);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /root must be an object/);
  assert.equal(read(), original);
});

test("install refuses invalid JSONC without touching it", (t) => {
  const original = '{ "permissions": [,] }\n';
  const { read, result } = install(t, original);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot parse/);
  assert.equal(read(), original);
});

test("install refuses a permissions value that is not an array", (t) => {
  const original = '{ "permissions": {} }\n';
  const { read, result } = install(t, original);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"permissions" is not an array/);
  assert.match(result.stderr, /file left unchanged/);
  assert.equal(read(), original);
});

test("install refuses a plugins value that is not an array", (t) => {
  const original = `{
  "permissions": [
${permissionLines()}
  ],
  "plugins": {}
}
`;
  const { read, result } = install(t, original);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"plugins" is not an array/);
  assert.equal(read(), original);
});

test("install refuses more than one catch-all rule", (t) => {
  const original = `{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "*", "effect": "ask" },
  ],
}
`;
  const { read, result } = install(t, original);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /multiple catch-all rules/);
  assert.equal(read(), original);
});

test("install refuses a required deny resource with a different effect", (t) => {
  const original = `{
  "permissions": [
    { "action": "shell", "resource": "*", "effect": "ask" },
    { "action": "shell", "resource": "rm -rf*", "effect": "allow" },
  ],
}
`;
  const { read, result } = install(t, original);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /required deny rule "rm -rf\*" exists with effect "allow"/);
  assert.equal(read(), original);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
