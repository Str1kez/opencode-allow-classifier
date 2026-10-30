import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission";
import { Effect } from "effect";
import ServerPlugin from "../src/index.ts";

interface Harness {
  readonly logDirectory: string;
  readonly logFile: string;
  evaluate(input: PermissionEvaluation): Promise<void>;
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
async function start(options: Record<string, unknown>): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "allow-classifier-"));
  const logDirectory = join(root, "state");
  let registered: ((input: PermissionEvaluation) => Effect.Effect<void>) | undefined;

  const context = {
    options: { log_dir: logDirectory, ...options },
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
    logDirectory,
    logFile: join(logDirectory, "evaluate-raw.jsonl"),
    async evaluate(input) {
      assert.ok(registered, "plugin did not register the evaluate hook");
      await Effect.runPromise(registered(input));
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
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

test("log_raw leaves the permission effect untouched", async () => {
  const harness = await start({ log_raw: true });
  try {
    const input = evaluation();
    await harness.evaluate(input);
    assert.equal(input.effect, "ask");
  } finally {
    harness.dispose();
  }
});

test("log_raw disabled creates no log file and writes no events", async () => {
  const harness = await start({ log_raw: false });
  try {
    await harness.evaluate(evaluation());
    assert.equal(existsSync(harness.logFile), false);
    assert.equal(existsSync(harness.logDirectory), false);
  } finally {
    harness.dispose();
  }
});
