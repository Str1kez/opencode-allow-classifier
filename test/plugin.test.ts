import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission";
import type { Rpc } from "@opencode/plugin/rpc";
import { Cause, Effect, Exit, Option } from "effect";
import { DEFAULT_MODEL, FALLBACK_MODEL, SAFETY_THRESHOLD } from "../src/classifier.ts";
import ServerPlugin from "../src/index.ts";
import type { DecisionsOperation, DecisionsOutput } from "../src/model.ts";
import { ClassifierRpc, type ClassifierConfig } from "../src/rpc.ts";
import { MAX_MODEL_LENGTH, MODEL_OVERRIDE_KEY } from "../src/settings.ts";

const CWD = "/Users/test/project";
const AUDIT_FILE = /^evaluate-\d{4}-\d{2}\.jsonl$/;

/** A storage/RPC/catalog failure can surface either as a synchronous throw or as an Effect defect. */
type FailureMode = "throw" | "defect";

interface CatalogModel {
  readonly providerID: string;
  readonly modelID: string;
  readonly enabled?: boolean;
}

const CATALOG: ReadonlyArray<CatalogModel> = [
  { providerID: "opencode", modelID: "jev-1.13-free" },
  { providerID: "opencode", modelID: "jev-1.13" },
  { providerID: "acme", modelID: "classified" },
  { providerID: "acme", modelID: "pinned" },
  { providerID: "acme", modelID: "stored" },
  { providerID: "acme", modelID: "old" },
  { providerID: "acme", modelID: "configured" },
  { providerID: "acme", modelID: "disabled", enabled: false },
];

interface RpcFailure {
  readonly type: string;
  readonly message: string;
  readonly data?: unknown;
}

type RpcOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: RpcFailure };

interface RpcCallContext {
  error(type: string, message: string, data?: unknown): RpcFailure;
}

interface CapturedHandlers {
  readonly config: (
    input: Readonly<Record<string, never>>,
    call: RpcCallContext,
  ) => Effect.Effect<ClassifierConfig, unknown>;
  readonly setModel: (
    input: { readonly model: string },
    call: RpcCallContext,
  ) => Effect.Effect<ClassifierConfig, unknown>;
}

interface CapturedRpc {
  readonly definition: Rpc.PortableDefinition;
  readonly handlers: CapturedHandlers;
}

interface Harness {
  readonly root: string;
  readonly logFile: string;
  readonly auditDirectory: string;
  readonly hookRegistered: boolean;
  readonly rpcRegistered: boolean;
  readonly modelCalls: Array<{ model: string; prompt: string }>;
  readonly storage: Map<string, unknown>;
  evaluate(input: PermissionEvaluation): Promise<void>;
  config(): Promise<RpcOutcome<ClassifierConfig>>;
  setModel(model: string): Promise<RpcOutcome<ClassifierConfig>>;
  catalogCalls(): number;
  auditEntries(): Array<Record<string, unknown>>;
  dispose(): void;
}

interface World {
  readonly decisions?: DecisionsOperation;
  readonly probability?: number;
  readonly messages?: ReadonlyArray<unknown>;
  readonly contextError?: boolean;
  /** Shared across `start()` calls to model a server restart. */
  readonly storage?: Map<string, unknown>;
  readonly storageGetFailure?: FailureMode;
  readonly storageSetFailure?: FailureMode;
  readonly rpcRegisterFailure?: FailureMode;
  readonly catalog?: ReadonlyArray<CatalogModel>;
  readonly catalogFailure?: FailureMode;
}

function callContext(): RpcCallContext {
  return { error: (type, message, data) => ({ type, message, data }) };
}

/** Runs an RPC handler the way the host does and keeps failures distinguishable from defects. */
async function settle<A>(effect: Effect.Effect<A, unknown>): Promise<RpcOutcome<A>> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };

  const failure = Exit.findErrorOption(exit);
  if (Option.isSome(failure)) {
    const value: unknown = failure.value;
    if (typeof value === "object" && value !== null && "type" in value && "message" in value) {
      return { ok: false, error: value as RpcFailure };
    }
    return { ok: false, error: { type: "untyped-failure", message: String(value) } };
  }
  return { ok: false, error: { type: "defect", message: Cause.pretty(exit.cause) } };
}

function predicate(probability: number): DecisionsOutput {
  return { answers: [{ type: "predicate", name: "safe", probability }] };
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

/** The default fake model says "unsafe" so unrelated tests keep their old `ask` verdicts. */
function defaultDecisions(calls: Harness["modelCalls"], probability = 0.1): DecisionsOperation {
  return (input) => {
    const part = input.input[0];
    calls.push({
      model: `${input.model.providerID}/${input.model.id}`,
      prompt: part?.type === "text" ? part.text : "",
    });
    return Effect.succeed(predicate(probability));
  };
}

/** Runs the plugin effect against a fake context and returns the hook callback it registered. */
async function start(
  options: Record<string, unknown> = {},
  cwd: string = CWD,
  world: World = {},
): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "allow-classifier-"));
  const logDirectory = join(root, "state");
  const auditDirectory = join(root, "audit");
  const modelCalls: Harness["modelCalls"] = [];
  const storage = world.storage ?? new Map<string, unknown>();
  let registered: ((input: PermissionEvaluation) => Effect.Effect<void>) | undefined;
  let rpc: CapturedRpc | undefined;
  let catalogCalls = 0;

  const context = {
    options: { log_dir: logDirectory, audit_dir: auditDirectory, ...options },
    location: { directory: cwd },
    storage: {
      get: (key: string) => {
        if (world.storageGetFailure === "throw") throw new Error("storage get failed");
        if (world.storageGetFailure === "defect") return Effect.die(new Error("storage get failed"));
        return Effect.succeed(storage.get(key));
      },
      set: (key: string, value: unknown) => {
        if (world.storageSetFailure === "throw") throw new Error("storage set failed");
        if (world.storageSetFailure === "defect") return Effect.die(new Error("storage set failed"));
        storage.set(key, value);
        return Effect.succeed(undefined);
      },
      remove: (key: string) => {
        storage.delete(key);
        return Effect.succeed(undefined);
      },
      scan: (input: { readonly prefix: string; readonly after?: string; readonly limit?: number }) => {
        const entries = [...storage.entries()]
          .filter(([key]) => key.startsWith(input.prefix) && (input.after === undefined || key > input.after))
          .sort(([left], [right]) => left.localeCompare(right))
          .slice(0, input.limit ?? Number.POSITIVE_INFINITY)
          .map(([key, value]) => ({ key, value }));
        return Effect.succeed({ entries });
      },
    },
    rpc: {
      register: (definition: Rpc.PortableDefinition, handlers: CapturedHandlers) => {
        if (world.rpcRegisterFailure === "throw") throw new Error("rpc registration failed");
        if (world.rpcRegisterFailure === "defect") return Effect.die(new Error("rpc registration failed"));
        rpc = { definition, handlers };
        return Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.succeed(undefined) } });
      },
    },
    model: {
      list: (input?: { readonly types?: ReadonlyArray<string> }) => {
        catalogCalls += 1;
        // Chat models cannot answer `decisions`, so the picker must only validate against the
        // decision catalog the host exposes.
        assert.deepEqual(input, { types: ["decision"] });
        if (world.catalogFailure === "throw") throw new Error("catalog failed");
        if (world.catalogFailure === "defect") return Effect.die(new Error("catalog failed"));
        return Effect.succeed({ location: { directory: cwd }, data: world.catalog ?? CATALOG });
      },
    },
    permission: {
      hook: (name: string, callback: (input: PermissionEvaluation) => Effect.Effect<void>) => {
        assert.equal(name, "evaluate");
        registered = callback;
        return Effect.sync(() => ({ dispose: Effect.void }));
      },
    },
    experimental: {
      generate: { decisions: world.decisions ?? defaultDecisions(modelCalls, world.probability ?? 0.1) },
    },
    session: {
      context: () =>
        world.contextError === true ? Effect.die(new Error("session unavailable")) : Effect.succeed(world.messages ?? []),
    },
  } as unknown as PluginContext;

  await Effect.runPromise(Effect.scoped(ServerPlugin.effect(context)));

  return {
    root,
    logFile: join(logDirectory, "evaluate-raw.jsonl"),
    auditDirectory,
    hookRegistered: registered !== undefined,
    rpcRegistered: rpc !== undefined,
    storage,
    modelCalls,
    async evaluate(input) {
      assert.ok(registered, "plugin did not register the evaluate hook");
      await Effect.runPromise(registered(input));
    },
    async config() {
      assert.ok(rpc, "plugin did not register the RPC contract");
      return settle(rpc.handlers.config({}, callContext()));
    },
    async setModel(model) {
      assert.ok(rpc, "plugin did not register the RPC contract");
      return settle(rpc.handlers.setModel({ model }, callContext()));
    },
    catalogCalls() {
      return catalogCalls;
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
    "find . -exec cat .env \\;",
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

test("output-short-flag applies to git only", async () => {
  const harness = await start();
  // `find` uses `-o` as OR, `grep`/`rg` as "only matching"; none of them writes through it.
  const findPrune = [
    "find . -maxdepth 3 -name .git -prune -o",
    "\\( -name '*.tmp' -o -name '*.temp' -o -name '*.log' -o -name '*~' -o -name '*.bak'",
    "-o -name '*.swp' -o -name '.DS_Store' -o -name '__pycache__' -o -name '.pytest_cache'",
    "-o -name '.mypy_cache' -o -name '.ruff_cache' -o -name 'node_modules' -o -name '.ipynb_checkpoints'",
    "-o -name '*.pyc' -o -name '.coverage' -o -name 'dist' -o -name 'build'",
    "\\) -print",
  ].join(" ");
  const cases: ReadonlyArray<readonly [string, string]> = [
    [findPrune, "find"],
    ["grep -o TODO README.md", "grep"],
    ["rg -o TODO src", "rg"],
  ];

  try {
    for (const [command, rule] of cases) {
      assert.equal(await verdict(harness, [command]), "allow", `${command} must be allowed`);
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

test("rm inside cwd is not hard-ask, it falls through to the classifier", async () => {
  const harness = await start();
  try {
    const input = evaluation({ resources: ["rm src/old.ts"] });
    await harness.evaluate(input);

    assert.equal(input.effect, "ask");
    const entry = harness.auditEntries().at(-1);
    assert.deepEqual({ source: entry?.["source"], rule: entry?.["rule"] }, { source: "model", rule: "classifier" });
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
    // `find` is allowlisted, but only with a read-only `-exec`: the guard validates the spawned program.
    ["find . -exec grep -l x {} \\;", "allow"],
    ["find . -name '*.ts' -exec wc -l {} +", "allow"],
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

test("the classifier allows an unknown command at 0.9 and audits the model verdict", async () => {
  const harness = await start(
    {},
    CWD,
    {
      probability: 0.9,
      messages: [
        { type: "assistant", text: "ignored" },
        { type: "user", text: "  please run the linter  " },
      ],
    },
  );
  try {
    const input = evaluation({ resources: ["make lint"], agent: "build" as PermissionEvaluation["agent"] });
    await harness.evaluate(input);

    assert.equal(input.effect, "allow");
    const entry = harness.auditEntries().at(-1);
    assert.equal(entry?.["source"], "model");
    assert.equal(entry?.["rule"], "classifier");
    assert.equal(entry?.["verdict"], "allow");
    assert.equal(entry?.["probability"], 0.9);
    assert.equal(entry?.["model"], "opencode/jev-1.13-free");
    assert.equal(entry?.["task"], "please run the linter");
    assert.equal(typeof entry?.["latency"], "number");

    assert.equal(harness.modelCalls.length, 1);
    const prompt = harness.modelCalls[0]?.prompt ?? "";
    for (const expected of ["make lint", CWD, "build", "please run the linter"]) {
      assert.ok(prompt.includes(expected), `${expected} missing from the prompt`);
    }
  } finally {
    harness.dispose();
  }
});

test("options.threshold is applied to the live classifier verdict", async () => {
  const strict = await start({ threshold: 0.99 }, CWD, { probability: 0.95 });
  try {
    const input = evaluation({ resources: ["make lint"] });
    await strict.evaluate(input);

    assert.equal(input.effect, "ask");
    assert.equal(strict.auditEntries().at(-1)?.["source"], "model");
  } finally {
    strict.dispose();
  }

  const lenient = await start({ threshold: 0.9 }, CWD, { probability: 0.95 });
  try {
    const input = evaluation({ resources: ["make lint"] });
    await lenient.evaluate(input);

    assert.equal(input.effect, "allow");
    assert.equal(lenient.auditEntries().at(-1)?.["source"], "model");
  } finally {
    lenient.dispose();
  }
});

test("an unreadable session still gets a verdict, with a null task", async () => {
  const harness = await start({}, CWD, { probability: 0.95, contextError: true });
  try {
    const input = evaluation({ resources: ["make lint"] });
    await harness.evaluate(input);

    assert.equal(input.effect, "allow");
    const entry = harness.auditEntries().at(-1);
    assert.equal(entry?.["source"], "model");
    assert.equal(entry?.["task"], null);
  } finally {
    harness.dispose();
  }
});

test("a repeated identical shell call comes from the cache", async () => {
  const harness = await start({}, CWD, { probability: 0.95 });
  try {
    await harness.evaluate(evaluation({ resources: ["make lint"] }));
    await harness.evaluate(evaluation({ resources: ["make lint"] }));

    assert.equal(harness.modelCalls.length, 1);
    assert.deepEqual(
      harness.auditEntries().map((entry) => entry["source"]),
      ["model", "cache"],
    );
  } finally {
    harness.dispose();
  }
});

test("hard-ask never calls the model", async () => {
  const harness = await start({}, CWD, { probability: 0.99 });
  try {
    const input = evaluation({ resources: ["git push origin main"] });
    await harness.evaluate(input);

    assert.equal(input.effect, "ask");
    assert.equal(harness.modelCalls.length, 0);
    assert.equal(harness.auditEntries().at(-1)?.["source"], "hard-ask");
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
      ["allowlist", "hard-ask", "model"],
    );
    assert.equal(entries.at(-1)?.["verdict"], "ask");
    assert.equal(harness.modelCalls.length, 1);
  } finally {
    harness.dispose();
  }
});

test("shell metacharacters anywhere in a resource ask", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["cat x;git push --force", "guard:shell-metacharacter"],
    ["cat x\ngit push --force", "guard:shell-metacharacter"],
    ["cat README.md&", "guard:shell-metacharacter"],
    ["cat README.md < input.txt", "guard:shell-metacharacter"],
    ["cat {a,b}", "guard:shell-metacharacter"],
    ["cat .en?", "guard:shell-metacharacter"],
    ["cat .e*", "guard:shell-metacharacter"],
    ["cat .[e]nv", "guard:shell-metacharacter"],
    ["cat .\\env", "guard:secret-env"],
    ["cat $'\\x2eenv'", "guard:shell-metacharacter"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }
  } finally {
    harness.dispose();
  }
});

test("specific guard names win over the metacharacter catch-all", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["echo hello > /tmp/x", "guard:redirect"],
    ["ls && rm -rf /", "guard:shell-operator"],
    ["cat $(echo secret)", "guard:shell-substitution"],
    ["ls `rm -rf /tmp/x`", "guard:shell-backtick"],
    ["rg --pre 'rm -rf' TODO", "guard:rg-preprocessor"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }
  } finally {
    harness.dispose();
  }
});

test("guard matches the quote-stripped spelling the shell executes", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['cat ".en""v"', "guard:secret-env"],
    ["cat .e''nv", "guard:secret-env"],
    ['cat \'.en\'"v"', "guard:secret-env"],
    ["cat .np''mrc", "guard:secret-npmrc"],
    ["cat .en''v.local", "guard:secret-env"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }
  } finally {
    harness.dispose();
  }
});

test("guard covers the extended secret list", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["cat ~/.netrc", "guard:secret-netrc"],
    ["cat ~/.npmrc", "guard:secret-npmrc"],
    ["cat .yarnrc.yml", "guard:secret-yarnrc"],
    ["cat ~/.pgpass", "guard:secret-pgpass"],
    ["cat ~/.git-credentials", "guard:secret-credentials"],
    ["cat ~/.docker/config.json", "guard:secret-docker-config"],
    ["cat ~/.kube/config", "guard:secret-kube-config"],
    ["cat ~/.aws/config", "guard:secret-aws"],
    ["cat ~/.azure/profile.json", "guard:secret-azure"],
    ["cat ~/.config/gcloud/active_config", "guard:secret-gcloud"],
    ["cat ~/.config/gh/hosts.yml", "guard:secret-gh"],
    ["cat ~/.zsh_history", "guard:secret-zsh-history"],
    ["cat ~/.bash_history", "guard:secret-bash-history"],
    ["cat ~/.gitconfig", "guard:secret-gitconfig"],
    ["cat ./id_ed25519", "guard:secret-id-ed25519"],
    ["cat ./id_ecdsa", "guard:secret-id-ecdsa"],
    ["cat server.pem", "guard:secret-pem"],
    ["cat /proc/self/environ", "guard:system-proc"],
    ["cat secrets.yaml", "guard:secret-generic"],
    ["jq -n env", "guard:jq-environment"],
    ["jq -n 'env.HOME'", "guard:jq-environment"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }
  } finally {
    harness.dispose();
  }
});

test("guards that open files outside the positional operands ask", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["git blame --contents notes.txt src/index.ts", "guard:file-read-flag"],
    ["jq -n --slurpfile data x.json .", "guard:file-read-flag"],
    ["jq -n --rawfile body x.txt .", "guard:file-read-flag"],
    ["jq --from-file x.json .", "guard:file-read-flag"],
    ["jq -f prog.jq .", "guard:jq-program-file"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }

    // `grep -f` only loads patterns, so the decision stays with the allowlist.
    assert.equal(await verdict(harness, ["grep -f patterns.txt src"]), "allow");
  } finally {
    harness.dispose();
  }
});

test("git reads that execute a configured program ask", async () => {
  const harness = await start();
  const commands = ["git diff --ext-diff", "git log --textconv", "git show --ext-diff", "git diff --textconv"];

  try {
    for (const command of commands) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], "guard:git-external-command", command);
    }
  } finally {
    harness.dispose();
  }
});

test("hard-ask sees through env prefixes, wrappers and git global flags", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [ReadonlyArray<string>, string]> = [
    [["git -C /tmp push"], "git-push"],
    [["git --no-pager push"], "git-push"],
    [["git -c k=v push"], "git-push"],
    [["git --git-dir=/tmp/repo push"], "git-push"],
    [["env sudo"], "sudo"],
    [["FOO=1 sudo"], "sudo"],
    [["nohup sudo"], "sudo"],
    [["command sudo"], "sudo"],
    [["time sudo"], "sudo"],
    [["\\sudo ls"], "sudo"],
    [["doas ls"], "sudo"],
    [["sudoedit /etc/hosts"], "sudo"],
    [["npm ci"], "npm-install"],
    [["npm --prefix . install"], "npm-install"],
    [["yarn"], "npm-install"],
    [["pnpm"], "npm-install"],
    [["python -m pip install x"], "pip-install"],
    [["python3 -m pip install x"], "pip-install"],
    [["uv sync"], "uv-install"],
    [["cargo install ripgrep"], "cargo-install"],
    [["brew upgrade jq"], "brew-install"],
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

test("rm through an unexpanded variable still asks", async () => {
  const harness = await start();
  try {
    assert.equal(await verdict(harness, ["rm -rf $HOME/x"]), "ask");
  } finally {
    harness.dispose();
  }
});

test("enabled: false with log_raw writes neither raw nor audit files", async () => {
  const harness = await start({ enabled: false, log_raw: true });
  try {
    assert.equal(harness.hookRegistered, false);
    assert.equal(existsSync(join(harness.root, "state")), false);
    assert.equal(existsSync(join(harness.root, "audit")), false);
  } finally {
    harness.dispose();
  }
});

test("log_raw records non-shell and compound events verbatim", async () => {
  const harness = await start({ log_raw: true });
  try {
    await harness.evaluate(evaluation({ action: "read", resources: ["src/index.ts"] }));
    assert.deepEqual(harness.auditEntries(), []);

    await harness.evaluate(evaluation({ resources: ["git status", "cat .env"] }));

    const lines = readFileSync(harness.logFile, "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { sessionID: "ses_test", action: "read", resources: ["src/index.ts"], effect: "ask" });
    assert.equal(lines[1]?.["action"], "shell");
    assert.deepEqual(lines[1]?.["resources"], ["git status", "cat .env"]);
  } finally {
    harness.dispose();
  }
});

test("reads are allowed only inside the working directory", async () => {
  const harness = await start();
  const allowed = ["rg TODO", "grep -rn TODO src", "cat src/a.ts", "cat README.md", "du -sh .", "ls ."];
  const outside: ReadonlyArray<readonly [string, string]> = [
    ["cat ../x", "guard:outside-cwd"],
    ["cat ~/notes.txt", "guard:outside-cwd"],
    ["cat /Users/other/file", "guard:outside-cwd"],
    ["ls ../../..", "guard:outside-cwd"],
    ["du -a /", "guard:outside-cwd"],
    ["rg TODO ~", "guard:outside-cwd"],
    ["rg -uuu -a -N . ~", "guard:outside-cwd"],
    ["grep -r . /", "guard:outside-cwd"],
    ["rg --files --hidden /", "guard:outside-cwd"],
    // Flags that open a path the positional guard never sees: `--flag=value` and `-fvalue`.
    ["rg --ignore-file=../../x TODO", "guard:outside-cwd"],
    ["grep --file=../outside/patterns.txt src/a.ts", "guard:outside-cwd"],
    ["grep -f../outside/patterns.txt src/a.ts", "guard:outside-cwd"],
  ];

  try {
    for (const command of allowed) {
      assert.equal(await verdict(harness, [command]), "allow", `${command} must be allowed`);
    }
    for (const [command, rule] of outside) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }
  } finally {
    harness.dispose();
  }
});

test("recursive search cannot read secrets the path guard never sees", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["rg -uuu -a . .", "guard:rg-unrestricted"],
    ["rg --hidden TODO", "guard:rg-unrestricted"],
    ["rg -u TODO src", "guard:rg-unrestricted"],
    ["grep -r . .", "guard:recursive-search"],
    ["grep -R TODO .", "guard:recursive-search"],
    ["grep -d recurse TODO .", "guard:recursive-search"],
    // grep defaults the root to the working directory when no file operand is given.
    ["grep -r '^'", "guard:recursive-search"],
    ["grep -rn TODO", "guard:recursive-search"],
    // getopt_long accepts unambiguous prefixes: `--recurs` is `--recursive`.
    ["grep --recurs '^' .", "guard:recursive-search"],
    ["grep --direct=recurse TODO .", "guard:recursive-search"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }

    // Negative controls: plain rg skips hidden files and ignore files, a narrowed grep root is fine.
    assert.equal(await verdict(harness, ["rg TODO"]), "allow");
    assert.equal(await verdict(harness, ["grep -rn TODO src"]), "allow");
  } finally {
    harness.dispose();
  }
});

test("a program reached through an untrusted path asks", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["./cat README.md", "guard:untrusted-binary"],
    ["./ls", "guard:untrusted-binary"],
    ["/tmp/evil/ls", "guard:untrusted-binary"],
    ["/tmp/evil/git status", "guard:untrusted-binary"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }

    assert.equal(await verdict(harness, ["/bin/cat README.md"]), "allow");
    assert.equal(await verdict(harness, ["/usr/bin/git status"]), "allow");
  } finally {
    harness.dispose();
  }
});

test("a symlink pointing outside the project asks", async () => {
  // The lexical check cannot see this: `notes` is inside the project, its target is a private key.
  const outside = mkdtempSync(join(tmpdir(), "outside-"));
  const project = mkdtempSync(join(tmpdir(), "project-"));
  writeFileSync(join(outside, "id_rsa"), "secret");
  symlinkSync(join(outside, "id_rsa"), join(project, "notes"));
  const harness = await start({}, project);

  try {
    const input = evaluation({ resources: ["cat notes"] });
    await harness.evaluate(input);
    assert.equal(input.effect, "ask");
    assert.equal(harness.auditEntries().at(-1)?.["rule"], "guard:outside-cwd");
  } finally {
    harness.dispose();
    rmSync(project, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("state-changing look-alike flags ask", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["tail -1f README.md", "guard:tail-follow"],
    ["tail -10F README.md", "guard:tail-follow"],
    ["file -C", "guard:file-compile"],
    ["git log --show-signature", "guard:git-external-command"],
    ["ls `rm -rf /tmp/x`", "guard:shell-backtick"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }

    assert.equal(await verdict(harness, ["tail -n 5 README.md"]), "allow");
    assert.equal(await verdict(harness, ["file README.md"]), "allow");
  } finally {
    harness.dispose();
  }
});

test("guard covers agent and system secrets", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["cat ~/.vault-token", "guard:secret-vault-token"],
    ["cat ~/.gnupg/secring.gpg", "guard:secret-gnupg"],
    ["cat ~/.gnupg/private-keys-v1.d/x.key", "guard:secret-gnupg"],
    ["cat ~/.password-store/git.gpg", "guard:secret-password-store"],
    ["cat ~/.local/share/opencode/auth.json", "guard:secret-opencode-auth"],
    ["cat ~/.config/opencode/opencode.json", "guard:secret-opencode-config"],
    ["cat ~/Library/Keychains/login.keychain-db", "guard:secret-keychain"],
    ["cat ~/.config/solana/id.json", "guard:secret-solana"],
    ["cat server.key", "guard:secret-private-key"],
    ["cat server.p12", "guard:secret-p12"],
    ["cat .git/config", "guard:secret-git-config"],
    ["cat ~/.cargo/credentials", "guard:secret-credentials"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }
  } finally {
    harness.dispose();
  }
});

test("control bytes and unbounded reads ask", async () => {
  const harness = await start();
  const cases: ReadonlyArray<readonly [string, string]> = [
    ["git log --format=%x1b]52;c;x", "guard:shell-metacharacter"],
    ["echo \"\u001bhello\"", "guard:shell-metacharacter"],
    ["date -s 2020-01-01", "guard:set-clock"],
    ["date --set=2020-01-01", "guard:set-clock"],
    ["cat /dev/urandom", "guard:endless-read"],
    ["cat /dev/zero", "guard:endless-read"],
    ["cat /dev/stdin", "guard:endless-read"],
    ["cat -", "guard:stdin-read"],
    ["tail -f /dev/null", "guard:tail-follow"],
  ];

  try {
    for (const [command, rule] of cases) {
      const input = evaluation({ resources: [command] });
      await harness.evaluate(input);
      assert.equal(input.effect, "ask", `${command} must ask`);
      assert.equal(harness.auditEntries().at(-1)?.["rule"], rule, command);
    }

    assert.equal(await verdict(harness, ["git log --format=%h"]), "allow");
    assert.equal(await verdict(harness, ["date -u"]), "allow");
    // A trailing newline from the scanner is not an internal line break.
    assert.equal(await verdict(harness, ["cat a\n"]), "allow");
    assert.equal(await verdict(harness, ["cat README.md\n"]), "allow");
  } finally {
    harness.dispose();
  }
});

const DEFAULT_CONFIG: ClassifierConfig = {
  model: DEFAULT_MODEL,
  threshold: SAFETY_THRESHOLD,
  source: "default",
};

const portable: Rpc.PortableDefinition = ClassifierRpc;

test("the RPC contract is portable and carries config and setModel", () => {
  assert.equal(portable.id, "str1kez.allow-classifier");
  assert.deepEqual(Object.keys(portable.methods).sort(), ["config", "setModel"]);
  const setModel = portable.methods["setModel"];
  assert.ok(setModel);
  assert.deepEqual(Object.keys(setModel.errors ?? {}).sort(), ["Unavailable", "UnknownModel"]);
});

test("the portable schemas validate the wire shape at runtime", async () => {
  const standard = (schema: unknown) =>
    schema as {
      readonly "~standard": {
        readonly validate: (value: unknown) => Promise<{ readonly issues?: readonly unknown[] }>;
      };
    };
  const configMethod = portable.methods.config;
  const setModelMethod = portable.methods.setModel;
  assert.ok(configMethod);
  assert.ok(setModelMethod);
  const configOutput = standard(configMethod.output);
  const setModelInput = standard(setModelMethod.input);

  assert.equal((await configOutput["~standard"].validate(DEFAULT_CONFIG)).issues, undefined);
  const badSource = await configOutput["~standard"].validate({
    model: DEFAULT_MODEL,
    threshold: SAFETY_THRESHOLD,
    source: "bogus",
  });
  assert.ok(badSource.issues && badSource.issues.length > 0);

  const badModel = await setModelInput["~standard"].validate({ model: 42 });
  assert.ok(badModel.issues && badModel.issues.length > 0);
});

test("config defaults to the stock model, threshold and source", async () => {
  const harness = await start();
  try {
    assert.deepEqual(await harness.config(), { ok: true, value: DEFAULT_CONFIG });
  } finally {
    harness.dispose();
  }
});

test("config applies options.model over the stored override and returns the options threshold", async () => {
  const harness = await start(
    { model: "acme/configured", threshold: 0.75 },
    CWD,
    { storage: new Map([[MODEL_OVERRIDE_KEY, { model: "acme/stored" }]]) },
  );
  try {
    assert.deepEqual(await harness.config(), {
      ok: true,
      value: { model: "acme/configured", threshold: 0.75, source: "options" },
    });
  } finally {
    harness.dispose();
  }
});

test("config ignores an invalid options.model and options.threshold", async () => {
  const validModel = await start({ model: "acme/configured", threshold: 1.5 });
  try {
    assert.deepEqual(await validModel.config(), {
      ok: true,
      value: { model: "acme/configured", threshold: SAFETY_THRESHOLD, source: "options" },
    });
  } finally {
    validModel.dispose();
  }

  const validThreshold = await start({ model: "not-a-model", threshold: 0.75 });
  try {
    assert.deepEqual(await validThreshold.config(), {
      ok: true,
      value: { model: DEFAULT_MODEL, threshold: 0.75, source: "default" },
    });
  } finally {
    validThreshold.dispose();
  }
});

test("setModel persists the pick and a server restart reads it back", async () => {
  const storage = new Map<string, unknown>();
  const overrideConfig: ClassifierConfig = {
    model: "acme/classified",
    threshold: SAFETY_THRESHOLD,
    source: "override",
  };

  const first = await start({}, CWD, { storage });
  try {
    assert.deepEqual(await first.setModel("acme/classified"), { ok: true, value: overrideConfig });
    assert.deepEqual(storage.get(MODEL_OVERRIDE_KEY), { model: "acme/classified" });
    assert.deepEqual(await first.config(), { ok: true, value: overrideConfig });
  } finally {
    first.dispose();
  }

  const restarted = await start({}, CWD, { storage });
  try {
    assert.deepEqual(await restarted.config(), { ok: true, value: overrideConfig });
  } finally {
    restarted.dispose();
  }
});

test("setModel rejects a model outside the catalog without touching storage or config", async () => {
  const harness = await start();
  try {
    const before = await harness.config();
    const saved = await harness.setModel("acme/not-in-catalog");

    assert.equal(saved.ok, false);
    assert.equal(saved.ok ? "" : saved.error.type, "UnknownModel");
    assert.equal(harness.catalogCalls(), 1);
    assert.equal(harness.storage.has(MODEL_OVERRIDE_KEY), false);
    assert.deepEqual(await harness.config(), before);
  } finally {
    harness.dispose();
  }
});

test("setModel rejects a malformed model before it reads the catalog or writes storage", async () => {
  const harness = await start();
  try {
    const before = await harness.config();
    for (const model of ["", "   ", "no-slash", "/missing-provider", "provider/", "pro vider/model"]) {
      const saved = await harness.setModel(model);
      assert.equal(saved.ok, false, model);
      assert.equal(saved.ok ? "" : saved.error.type, "UnknownModel", model);
    }

    assert.equal(harness.catalogCalls(), 0);
    assert.equal(harness.storage.has(MODEL_OVERRIDE_KEY), false);
    assert.deepEqual(await harness.config(), before);
  } finally {
    harness.dispose();
  }
});

test("setModel fails Unavailable when the catalog fails, never as a defect", async () => {
  for (const mode of ["defect", "throw"] as const) {
    const harness = await start({}, CWD, { catalogFailure: mode });
    try {
      const before = await harness.config();
      const saved = await harness.setModel("acme/classified");

      assert.equal(saved.ok, false, mode);
      assert.equal(saved.ok ? "" : saved.error.type, "Unavailable", mode);
      assert.equal(harness.storage.has(MODEL_OVERRIDE_KEY), false, mode);
      assert.deepEqual(await harness.config(), before, mode);
    } finally {
      harness.dispose();
    }
  }
});

test("setModel fails Unavailable when storage rejects the write, never as a defect", async () => {
  for (const mode of ["defect", "throw"] as const) {
    const harness = await start({}, CWD, { storageSetFailure: mode });
    try {
      const before = await harness.config();
      const saved = await harness.setModel("acme/classified");

      assert.equal(saved.ok, false, mode);
      assert.equal(saved.ok ? "" : saved.error.type, "Unavailable", mode);
      assert.equal(harness.storage.has(MODEL_OVERRIDE_KEY), false, mode);
      assert.deepEqual(await harness.config(), before, mode);
    } finally {
      harness.dispose();
    }
  }
});

test("a corrupt stored override is ignored and the resolution order still holds", async () => {
  const corrupt: ReadonlyArray<unknown> = [{ model: 42 }, [], "...", { model: "" }, { other: "acme/stored" }];

  for (const value of corrupt) {
    const storage = new Map([[MODEL_OVERRIDE_KEY, value]]);

    const fallback = await start({}, CWD, { storage });
    try {
      assert.deepEqual(await fallback.config(), { ok: true, value: DEFAULT_CONFIG }, JSON.stringify(value));
    } finally {
      fallback.dispose();
    }

    const pinned = await start({ model: "acme/configured" }, CWD, { storage });
    try {
      assert.deepEqual(
        await pinned.config(),
        { ok: true, value: { model: "acme/configured", threshold: SAFETY_THRESHOLD, source: "options" } },
        JSON.stringify(value),
      );
    } finally {
      pinned.dispose();
    }
  }
});

test("a broken storage read degrades to no override instead of killing the plugin", async () => {
  for (const mode of ["throw", "defect"] as const) {
    const harness = await start({}, CWD, { storageGetFailure: mode });
    try {
      assert.equal(harness.hookRegistered, true, mode);
      assert.equal(harness.rpcRegistered, true, mode);
      assert.deepEqual(await harness.config(), { ok: true, value: DEFAULT_CONFIG }, mode);
      assert.equal(await verdict(harness, ["ls"]), "allow", mode);
    } finally {
      harness.dispose();
    }
  }
});

test("a stored override is the primary classifier model", async () => {
  const storage = new Map([[MODEL_OVERRIDE_KEY, { model: "acme/classified" }]]);
  const harness = await start({}, CWD, { storage, probability: 0.95 });

  try {
    const input = evaluation({ resources: ["make lint"] });
    await harness.evaluate(input);

    assert.equal(input.effect, "allow");
    assert.deepEqual(harness.modelCalls.map((call) => call.model), ["acme/classified"]);
    assert.equal(harness.auditEntries().at(-1)?.["model"], "acme/classified");
  } finally {
    harness.dispose();
  }
});

test("options.model wins over a stored override in the permission hook too", async () => {
  const storage = new Map([[MODEL_OVERRIDE_KEY, { model: "acme/stored" }]]);
  const harness = await start({ model: "acme/configured" }, CWD, {
    storage,
    probability: 0.95,
  });

  try {
    const input = evaluation({ resources: ["make lint"] });
    await harness.evaluate(input);

    assert.equal(input.effect, "allow");
    assert.deepEqual(harness.modelCalls.map((call) => call.model), ["acme/configured"]);
    assert.equal(harness.auditEntries().at(-1)?.["model"], "acme/configured");
  } finally {
    harness.dispose();
  }
});

test("a provider failure retries with the fallback model even when an override is stored", async () => {
  const storage = new Map([[MODEL_OVERRIDE_KEY, { model: "acme/classified" }]]);
  const calls: Array<{ model: string; prompt: string }> = [];
  const harness = await start({}, CWD, {
    storage,
    decisions: (input) => {
      const part = input.input[0];
      calls.push({
        model: `${input.model.providerID}/${input.model.id}`,
        prompt: part?.type === "text" ? part.text : "",
      });
      return calls.length === 1 ? Effect.die(new Error("provider down")) : Effect.succeed(predicate(0.95));
    },
  });

  try {
    const input = evaluation({ resources: ["make lint"] });
    await harness.evaluate(input);

    assert.equal(input.effect, "allow");
    assert.deepEqual(calls.map((call) => call.model), ["acme/classified", FALLBACK_MODEL]);
    assert.equal(harness.auditEntries().at(-1)?.["model"], FALLBACK_MODEL);
  } finally {
    harness.dispose();
  }
});

test("setModel persists under options.model while config keeps reporting the pinned model", async () => {
  const storage = new Map([[MODEL_OVERRIDE_KEY, { model: "acme/old" }]]);
  const pinnedConfig: ClassifierConfig = {
    model: "acme/pinned",
    threshold: SAFETY_THRESHOLD,
    source: "options",
  };

  const harness = await start({ model: "acme/pinned" }, CWD, { storage });
  try {
    assert.deepEqual(await harness.setModel("acme/classified"), { ok: true, value: pinnedConfig });
    assert.deepEqual(storage.get(MODEL_OVERRIDE_KEY), { model: "acme/classified" });
    assert.deepEqual(await harness.config(), { ok: true, value: pinnedConfig });
  } finally {
    harness.dispose();
  }

  const unpinned = await start({}, CWD, { storage });
  try {
    assert.deepEqual(await unpinned.config(), {
      ok: true,
      value: { model: "acme/classified", threshold: SAFETY_THRESHOLD, source: "override" },
    });
  } finally {
    unpinned.dispose();
  }
});

test("a broken RPC registration leaves the permission hook working", async () => {
  for (const mode of ["defect", "throw"] as const) {
    const harness = await start({}, CWD, { rpcRegisterFailure: mode });
    try {
      assert.equal(harness.rpcRegistered, false, mode);
      assert.equal(harness.hookRegistered, true, mode);
      assert.equal(await verdict(harness, ["ls"]), "allow", mode);
      assert.equal(await verdict(harness, ["make lint"]), "ask", mode);
    } finally {
      harness.dispose();
    }
  }
});

test("enabled: false registers neither the RPC contract nor the permission hook", async () => {
  const harness = await start({ enabled: false });
  try {
    assert.equal(harness.rpcRegistered, false);
    assert.equal(harness.hookRegistered, false);
  } finally {
    harness.dispose();
  }
});

test("setModel clears cached verdicts so the next call uses the new model", async () => {
  const storage = new Map<string, unknown>();
  const calls: Array<{ model: string; prompt: string }> = [];
  let probability = 0.1;

  const decisions: DecisionsOperation = (input) => {
    const part = input.input[0];
    calls.push({
      model: `${input.model.providerID}/${input.model.id}`,
      prompt: part?.type === "text" ? part.text : "",
    });
    return Effect.succeed(predicate(probability));
  };

  const harness = await start({}, CWD, { storage, decisions });
  try {
    assert.equal(await verdict(harness, ["make lint"]), "ask");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.model, DEFAULT_MODEL);
    assert.equal(harness.auditEntries().at(-1)?.["source"], "model");

    const saved = await harness.setModel("acme/classified");
    assert.equal(saved.ok, true);
    assert.deepEqual(storage.get(MODEL_OVERRIDE_KEY), { model: "acme/classified" });

    probability = 0.95;
    assert.equal(await verdict(harness, ["make lint"]), "allow");
    assert.equal(calls.length, 2, "the cached verdict from the old model must not be reused");
    assert.equal(calls[1]?.model, "acme/classified");
    assert.equal(harness.auditEntries().at(-1)?.["model"], "acme/classified");
  } finally {
    harness.dispose();
  }
});

test("setModel rejects a disabled catalog model without writing or changing config", async () => {
  const harness = await start();
  try {
    const before = await harness.config();
    const saved = await harness.setModel("acme/disabled");

    assert.equal(saved.ok, false);
    assert.equal(saved.ok ? "" : saved.error.type, "UnknownModel");
    assert.equal(harness.storage.has(MODEL_OVERRIDE_KEY), false);
    assert.deepEqual(await harness.config(), before);
  } finally {
    harness.dispose();
  }
});

test("a very long malformed model is rejected without being echoed in full", async () => {
  const harness = await start();
  try {
    const before = await harness.config();
    const hostile = "a".repeat(10_000) + "/b";
    const echoed = hostile.slice(0, MAX_MODEL_LENGTH);

    const saved = await harness.setModel(hostile);
    assert.equal(saved.ok, false);
    assert.equal(saved.ok ? "" : saved.error.type, "UnknownModel");
    if (saved.ok) assert.fail("expected the malformed model to be rejected");

    assert.equal(echoed.length, MAX_MODEL_LENGTH);
    assert.equal(saved.error.message.includes(hostile), false);
    assert.equal(saved.error.message.includes(echoed), true);

    const data: unknown = saved.error.data;
    assert.ok(typeof data === "object" && data !== null && "model" in data);
    assert.equal(data.model, echoed);

    assert.equal(harness.catalogCalls(), 0);
    assert.equal(harness.storage.has(MODEL_OVERRIDE_KEY), false);
    assert.deepEqual(await harness.config(), before);
  } finally {
    harness.dispose();
  }
});
