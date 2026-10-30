import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission";
import { Effect } from "effect";
import ServerPlugin from "../src/index.ts";

const CWD = "/Users/test/project";
const AUDIT_FILE = /^evaluate-\d{4}-\d{2}\.jsonl$/;

interface Harness {
  readonly root: string;
  readonly logFile: string;
  readonly auditDirectory: string;
  readonly hookRegistered: boolean;
  evaluate(input: PermissionEvaluation): Promise<void>;
  auditEntries(): Array<Record<string, unknown>>;
  dispose(): void;
}

function evaluation(overrides: Partial<PermissionEvaluation> = {}): PermissionEvaluation {
  return {
    sessionID: "ses_test" as PermissionEvaluation["sessionID"],
    action: "shell",
    resources: ["ls -la"],
    effect: "ask",
    ...overrides,
  };
}

/** Runs the plugin effect against a fake context and returns the hook callback it registered. */
async function start(options: Record<string, unknown> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "allow-classifier-"));
  const logDirectory = join(root, "state");
  const auditDirectory = join(root, "audit");
  let registered: ((input: PermissionEvaluation) => Effect.Effect<void>) | undefined;

  const context = {
    options: { log_dir: logDirectory, audit_dir: auditDirectory, ...options },
    location: { directory: CWD },
    permission: {
      hook: (name: string, callback: (input: PermissionEvaluation) => Effect.Effect<void>) => {
        assert.equal(name, "evaluate");
        registered = callback;
        return Effect.sync(() => ({ dispose: Effect.void }));
      },
    },
  } as unknown as PluginContext;

  await Effect.runPromise(Effect.scoped(ServerPlugin.effect(context)));

  return {
    root,
    logFile: join(logDirectory, "evaluate-raw.jsonl"),
    auditDirectory,
    hookRegistered: registered !== undefined,
    async evaluate(input) {
      assert.ok(registered, "plugin did not register the evaluate hook");
      await Effect.runPromise(registered(input));
    },
    auditEntries() {
      if (!existsSync(auditDirectory)) return [];
      return readdirSync(auditDirectory)
        .filter((file) => AUDIT_FILE.test(file))
        .sort()
        .flatMap((file) =>
          readFileSync(join(auditDirectory, file), "utf8")
            .trimEnd()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>),
        );
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Evaluates one compound call and reports the effect the plugin left behind. */
async function verdict(harness: Harness, resources: ReadonlyArray<string>): Promise<"allow" | "ask"> {
  const input = evaluation({ resources });
  await harness.evaluate(input);
  return input.effect as "allow" | "ask";
}

test("plugin exports a server definition with an id and an effect", () => {
  assert.equal(ServerPlugin.id, "str1kez.allow-classifier");
  assert.equal(typeof ServerPlugin.effect, "function");
});

test("log_raw writes every evaluation as one JSONL line", async () => {
  const harness = await start({ log_raw: true });
  try {
    await harness.evaluate(evaluation({ resources: ["find . -exec grep -l x {} +"] }));

    const lines = readFileSync(harness.logFile, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]!), {
      sessionID: "ses_test",
      action: "shell",
      resources: ["find . -exec grep -l x {} +"],
      effect: "ask",
    });
  } finally {
    harness.dispose();
  }
});

test("log_raw disabled creates no log file and writes no events", async () => {
  const harness = await start({ log_raw: false });
  try {
    await harness.evaluate(evaluation());
    assert.equal(existsSync(harness.logFile), false);
    assert.equal(existsSync(join(harness.root, "state")), false);
  } finally {
    harness.dispose();
  }
});

test("allowlist allows every read-only command without touching its arguments", async () => {
  const harness = await start();
  const allowed = [
    "ls",
    "ls -la",
    "pwd",
    "cat README.md",
    "head -n 20 README.md",
    "tail -5 README.md",
    "wc -l README.md",
    "file package.json",
    "stat package.json",
    "du -sh .",
    "df -h",
    "which node",
    "echo hello",
    "date -u",
    "whoami",
    "uname -a",
    "rg TODO",
    "grep -rn TODO src",
    "jq .name package.json",
    "git status",
    "git status --porcelain",
    "git diff",
    "git diff --stat",
    "git log --oneline -5",
    "git show HEAD",
    "git branch -a",
    "git branch --show-current",
    "git remote -v",
    "git rev-parse HEAD",
    "git blame src/index.ts",
    "git stash list",
  ];

  try {
    for (const command of allowed) {
      assert.equal(await verdict(harness, [command]), "allow", `${command} must be allowed`);
    }
  } finally {
    harness.dispose();
  }
});

test("allowlist does not allow commands it cannot prove read-only", async () => {
  const harness = await start();
  const asked = [
    "git branch -D main",
    "git branch feature-x",
    "git remote add origin git@example.com:x.git",
    "git remote -v add origin x",
    "git stash",
    "git stash pop",
    "sed -i s/a/b/ file",
    "awk '{print $1}' file",
    "find . -name '*.ts'",
    "env",
  ];

  try {
    for (const command of asked) {
      assert.equal(await verdict(harness, [command]), "ask", `${command} must ask`);
    }
  } finally {
    harness.dispose();
  }
});

test("guard cancels the allowlist for secrets and writes", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
    [["cat .env"], "guard:secret-env"],
    [["cat .env.local"], "guard:secret-env"],
    [["cat ~/.ssh/id_rsa"], "guard:secret-ssh"],
    [["cat credentials.json"], "guard:secret-credentials"],
    [["cat /etc/hosts"], "guard:system-etc"],
    [["echo hello > /tmp/x"], "guard:redirect"],
    [["echo hello >> /tmp/x"], "guard:redirect"],
    [["ls 2> /tmp/err"], "guard:redirect"],
    [["echo tee"], "guard:tee"],
    [["git diff -o out.patch"], "guard:output-short-flag"],
    [["git log --output=out.txt"], "guard:output-long-flag"],
    [["rg --pre 'rm -rf' TODO"], "guard:rg-preprocessor"],
    [["ls && rm -rf /"], "guard:shell-operator"],
    [["cat $(echo secret)"], "guard:shell-substitution"],
    [["ls `rm -rf /tmp/x`"], "guard:shell-backtick"],
  ];

  try {
    for (const [resources, rule] of cases) {
      const input = evaluation({ resources });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${resources.join(" ")} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule);
    }
  } finally {
    harness.dispose();
  }
});

test("hard-ask sends privileged and irreversible commands to the human", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
    [["sudo ls"], "sudo"],
    [["npm install"], "npm-install"],
    [["npm i react"], "npm-install"],
    [["pnpm install"], "npm-install"],
    [["yarn add lodash"], "npm-install"],
    [["pip install requests"], "pip-install"],
    [["pip3 install requests"], "pip-install"],
    [["uv pip install requests"], "uv-install"],
    [["uv add requests"], "uv-install"],
    [["brew install jq"], "brew-install"],
    [["git push origin main"], "git-push"],
    [["rm ../x"], "rm-outside-cwd"],
    [["rm -rf /tmp/x"], "rm-outside-cwd"],
    [["alembic upgrade head"], "alembic-migration"],
    [["prisma migrate deploy"], "prisma-migration"],
    [["goose up"], "goose-migration"],
    [["flyway migrate"], "flyway-migration"],
  ];

  try {
    for (const [resources, rule] of cases) {
      const input = evaluation({ resources });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${resources.join(" ")} must ask`);
      const entry = harness.auditEntries().at(-1);
      assert.deepEqual({ source: entry?.["source"], rule: entry?.["rule"] }, { source: "hard-ask", rule });
    }
  } finally {
    harness.dispose();
  }
});

test("rm inside cwd is not hard-ask, it falls through to the default ask", async () => {
  const harness = await start();
  try {
    const input = evaluation({ resources: ["rm src/old.ts"] });
    await harness.evaluate(input);

    assert.equal(input.effect, "ask");
    const entry = harness.auditEntries().at(-1);
    assert.deepEqual({ source: entry?.["source"], rule: entry?.["rule"] }, { source: "default", rule: "no-allowlist-match" });
  } finally {
    harness.dispose();
  }
});

test("a compound call is allowed only when every resource is allowed", async () => {
  const harness = await start();
  try {
    assert.equal(await verdict(harness, ["git status", "git diff"]), "allow");
    assert.equal(harness.auditEntries().at(-1)?.["rule"], "git-status,git-diff");

    const guardBreak = evaluation({ resources: ["ls", "cat .env"] });
    await harness.evaluate(guardBreak);
    assert.equal(guardBreak.effect, "ask");
    assert.equal(harness.auditEntries().at(-1)?.["rule"], "guard:secret-env");

    const hardAskBreak = evaluation({ resources: ["ls", "rm ../x"] });
    await harness.evaluate(hardAskBreak);
    assert.equal(hardAskBreak.effect, "ask");
    assert.equal(harness.auditEntries().at(-1)?.["source"], "hard-ask");

    assert.equal(await verdict(harness, ["git status", "npm install"]), "ask");
  } finally {
    harness.dispose();
  }
});

test("the spec verdict table holds", async () => {
  const harness = await start();
  const table: ReadonlyArray<readonly [string, "allow" | "ask"]> = [
    ["find . -exec rm {} \\;", "ask"],
    ["find . -delete", "ask"],
    ["xargs rm", "ask"],
    ["find . -exec sh -c 'rm -rf x' \\;", "ask"],
    ["docker exec -it x sh", "ask"],
    ["cat .env", "ask"],
    ["git push origin main", "ask"],
    ["rg TODO", "allow"],
    ["git status", "allow"],
    ["ls", "allow"],
    ["rm ../x", "ask"],
    ["npm install", "ask"],
    // Find is not on the allowlist, so read-only `-exec` is not distinguished from a mutating one yet.
    ["find . -exec grep -l x {} \\;", "ask"],
  ];

  try {
    for (const [command, expected] of table) {
      assert.equal(await verdict(harness, [command]), expected, command);
    }
  } finally {
    harness.dispose();
  }
});

test("non-shell and already-decided events are untouched and unaudited", async () => {
  const harness = await start();
  try {
    const read = evaluation({ action: "read", resources: ["src/index.ts"] });
    await harness.evaluate(read);
    assert.equal(read.effect, "ask");

    const allowed = evaluation({ effect: "allow" });
    await harness.evaluate(allowed);
    assert.equal(allowed.effect, "allow");

    const denied = evaluation({ effect: "deny" });
    await harness.evaluate(denied);
    assert.equal(denied.effect, "deny");

    assert.deepEqual(harness.auditEntries(), []);
  } finally {
    harness.dispose();
  }
});

test("enabled: false registers no hook and writes no audit", async () => {
  const harness = await start({ enabled: false });
  try {
    assert.equal(harness.hookRegistered, false);
    assert.deepEqual(harness.auditEntries(), []);
  } finally {
    harness.dispose();
  }
});

test("audit records one monthly JSONL line per decision", async () => {
  const harness = await start();
  try {
    const input = evaluation({ resources: ["ls"], agent: "build" as PermissionEvaluation["agent"] });
    await harness.evaluate(input);

    const entry = harness.auditEntries()[0]!;
    assert.equal(entry["session"], "ses_test");
    assert.equal(entry["agent"], "build");
    assert.equal(entry["cwd"], CWD);
    assert.deepEqual(entry["resources"], ["ls"]);
    assert.equal(entry["rule"], "ls");
    assert.equal(entry["verdict"], "allow");
    assert.equal(entry["source"], "allowlist");
    assert.equal(entry["probability"], null);
    assert.equal(entry["model"], null);
    assert.equal(entry["task"], null);
    assert.equal(typeof entry["latency"], "number");
    assert.ok(!Number.isNaN(Date.parse(String(entry["time"]))));
  } finally {
    harness.dispose();
  }
});

test("audit write failure does not change the verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "allow-classifier-blocked-"));
  writeFileSync(join(root, "blocker"), "not a directory");
  const harness = await start({ audit_dir: join(root, "blocker", "audit") });
  try {
    assert.equal(await verdict(harness, ["ls"]), "allow");
  } finally {
    harness.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit is appended across calls", async () => {
  const harness = await start();
  try {
    await harness.evaluate(evaluation({ resources: ["ls"] }));
    await harness.evaluate(evaluation({ resources: ["git push origin main"] }));
    await harness.evaluate(evaluation({ resources: ["docker exec -it x sh"] }));

    const entries = harness.auditEntries();
    assert.deepEqual(
      entries.map((entry) => entry["source"]),
      ["allowlist", "hard-ask", "default"],
    );
    assert.equal(entries.at(-1)?.["verdict"], "ask");
  } finally {
    harness.dispose();
  }
});
