import { realpathSync } from "node:fs";
import { Plugin } from "@opencode/plugin/effect";
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission";
import { Cause, Effect, Exit, Option } from "effect";
import { openAuditLog, toAuditEntry, type AuditEntry, type AuditLog } from "./audit.ts";
import { createVerdictCache } from "./cache.ts";
import { UNUSED_SYSTEM_CONTEXT } from "./classifier.ts";
import { PLUGIN_ID } from "./id.ts";
import { createGenerateAsk, type DecisionsOperation } from "./model.ts";
import { readOptions, type ClassifierOptions } from "./options.ts";
import { openCodeStateDirectory } from "./paths.ts";
import {
  evaluate,
  type CachedVerdict,
  type EvaluationInput,
  type SessionFacts,
  type SessionSnapshot,
} from "./pipeline.ts";
import { ClassifierRpc, type ClassifierConfig } from "./rpc.ts";
import {
  MAX_MODEL_LENGTH,
  MODEL_OVERRIDE_KEY,
  normalizeModel,
  parseModelOverride,
  resolveSettings,
  type EffectiveSettings,
} from "./settings.ts";

export { PLUGIN_ID } from "./id.ts";

/**
 * Symlinks are the one escape a string comparison cannot see: `notes -> ~/.ssh/id_rsa` looks like a
 * file inside the project. This is the only place the classifier touches the disk, and a missing path
 * simply gets no answer — the lexical check already ran.
 */
function realPath(path: string): string | undefined {
  try {
    return realpathSync.native(path);
  } catch {
    return undefined;
  }
}

/**
 * The last user message is the task behind the shell call and the last system message carries the
 * project instructions. Both are untrusted input to the model and are read in one round-trip. A session
 * that cannot be read is not a reason to fail the permission decision: the classifier just gets no
 * task and no system context. The timeout matters because the read happens inside the permission hook:
 * a session store that never answers must not hold the hook open.
 */
const SESSION_READ_TIMEOUT_MS = 1500;

async function readSessionSnapshot(
  ctx: PluginContext,
  sessionID: PermissionEvaluation["sessionID"],
): Promise<SessionSnapshot> {
  try {
    const messages = await Effect.runPromise(
      Effect.timeoutOption(ctx.session.context({ sessionID }), SESSION_READ_TIMEOUT_MS),
    );
    if (Option.isNone(messages)) return { task: null, system: null };

    let task: string | null = null;
    let system: string | null = null;
    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const message = messages.value[index];
      if (message === undefined) continue;
      if (task === null && message.type === "user") task = message.text;
      if (system === null && message.type === "system") system = message.text;
      if (task !== null && system !== null) break;
    }
    return { task, system };
  } catch {
    return { task: null, system: null };
  }
}

/**
 * Audit writes go through one serial queue. Concurrent calls finish in any order, but a synchronous
 * append per entry inside a queue keeps lines intact and ordered the way decisions were recorded.
 */
function createAuditWriter(audit: AuditLog): (entry: AuditEntry) => Promise<void> {
  let queue: Promise<void> = Promise.resolve();

  return (entry) => {
    queue = queue
      .then(() => {
        audit.write(entry);
      })
      .catch(() => {
        // The log already swallows its own failures; this guards the chain itself.
      });
    return queue;
  };
}

function askModel(ctx: PluginContext): ReturnType<typeof createGenerateAsk> {
  const decisions: DecisionsOperation = ctx.experimental.generate.decisions;
  return createGenerateAsk(decisions);
}

/**
 * Storage has no typed error channel: a broken store surfaces as a defect. A defect here means "no
 * override", and the config/default still decide — the picker degrades, the plugin does not.
 */
function readModelOverride(ctx: PluginContext): Effect.Effect<string | undefined> {
  return Effect.map(
    Effect.exit(Effect.suspend(() => ctx.storage.get(MODEL_OVERRIDE_KEY))),
    (exit) => (Exit.isSuccess(exit) ? parseModelOverride(exit.value) : undefined),
  );
}

const MAX_REASON_LENGTH = 200;

/** Extracts a bounded message, not a stack trace, for the TUI toast. */
function failureReason<A, E>(exit: Exit.Exit<A, E>): string {
  if (Exit.isSuccess(exit)) return "unknown failure";
  const error: unknown = Cause.squash(exit.cause);
  const message =
    typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const reason = message.trim().slice(0, MAX_REASON_LENGTH);
  return reason.length > 0 ? reason : "unknown failure";
}

/** Explicit field-by-field mapping pins the wire shape to the domain shape; drift fails the typecheck. */
function toConfig(settings: EffectiveSettings): ClassifierConfig {
  return { model: settings.model, threshold: settings.threshold, source: settings.source };
}

/**
 * One evaluated call. Non-shell actions and events that already have a definite effect never reach the
 * classifier and never touch the audit log; `deny` does not even reach the hook.
 */
export const ServerPlugin = Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = readOptions(ctx.options);
      if (!options.enabled) return;

      // Read once at startup and keep the resolved value in memory: `setModel` rewrites it, and the
      // permission hook reads it per call, so a pick in the TUI applies from the next call on.
      let settings = resolveSettings(options, yield* readModelOverride(ctx));
      // Verdicts belong to the model that produced them and live for 30 minutes, so a model change
      // clears this cache; without that the pick would keep answering with the old model.
      const cache = createVerdictCache<CachedVerdict>();

      yield* Effect.exit(
        // `suspend` keeps a synchronous throw inside the effect, where `exit` catches it. RPC is a
        // convenience for the picker; without it every command still goes through the permission hook.
        Effect.suspend(() =>
          ctx.rpc.register(ClassifierRpc, {
            config: () => Effect.succeed(toConfig(settings)),
            setModel: ({ model }, call) =>
              Effect.gen(function* () {
                const candidate = normalizeModel(model);
                if (candidate === undefined) {
                  // The caller controls `model` and it may be arbitrarily long; cap the echo so a
                  // malformed pick cannot stuff a megabyte into the toast.
                  const echoed = model.slice(0, MAX_MODEL_LENGTH);
                  return yield* Effect.fail(
                    call.error("UnknownModel", `Not a provider/model reference: ${echoed}`, { model: echoed }),
                  );
                }

                // Chat models do not answer the `decisions` operation, so only a decision model is a
                // valid pick even though the host can list both kinds in one catalog.
                const catalog = yield* Effect.exit(
                  Effect.suspend(() => ctx.model.list({ types: ["decision"] })),
                );
                if (Exit.isFailure(catalog)) {
                  return yield* Effect.fail(
                    call.error("Unavailable", "Model catalog is unavailable", { reason: failureReason(catalog) }),
                  );
                }

                const entry = catalog.value.data.find(
                  (info) => `${info.providerID}/${info.modelID}` === candidate,
                );
                if (entry === undefined) {
                  return yield* Effect.fail(
                    call.error("UnknownModel", `No such model in the catalog: ${candidate}`, { model: candidate }),
                  );
                }
                if (entry.enabled === false) {
                  return yield* Effect.fail(
                    call.error("UnknownModel", `Model is unavailable in the catalog: ${candidate}`, {
                      model: candidate,
                    }),
                  );
                }

                // Persist only after the catalog has accepted the id: a rejected pick must not leave a
                // dead model behind that the next server start would try to use.
                const saved = yield* Effect.exit(
                  Effect.suspend(() => ctx.storage.set(MODEL_OVERRIDE_KEY, { model: candidate })),
                );
                if (Exit.isFailure(saved)) {
                  return yield* Effect.fail(
                    call.error("Unavailable", "Cannot save the model override", { reason: failureReason(saved) }),
                  );
                }

                // The override is stored even when `options.model` shadows it: the chosen semantics keep
                // the user's last pick for the moment the config stops pinning the model.
                settings = resolveSettings(options, candidate);
                cache.clear();
                return toConfig(settings);
              }),
          }),
        ),
      );

      const audit = openAuditLog(options.auditDirectory ?? openCodeStateDirectory());
      const writeAudit = createAuditWriter(audit);
      const cwd = ctx.location.directory;
      const ask = askModel(ctx);

      yield* ctx.permission.hook("evaluate", (evaluation) =>
        Effect.promise(async () => {
          if (evaluation.action !== "shell" || evaluation.effect !== "ask") return;

          let facts: SessionFacts = { task: null, system: UNUSED_SYSTEM_CONTEXT };
          const input: EvaluationInput = {
            resources: [...evaluation.resources],
            cwd,
            agent: evaluation.agent,
            readSession: () => readSessionSnapshot(ctx, evaluation.sessionID),
            onSessionFacts: (next) => {
              facts = next;
            },
          };
          const decision = await evaluate(input, {
            cache,
            ask,
            model: settings.model,
            threshold: settings.threshold,
            timeoutMs: options.timeoutMs,
            realpath: realPath,
            includeSystemContext: options.includeSystemContext,
          });

          if (decision.verdict === "allow") evaluation.effect = "allow";
          // The audit keeps the hash, length and usage flag, never the system text: it is untrusted
          // and may contain internal data. The pipeline already normalized the facts.
          await writeAudit(
            toAuditEntry(decision, evaluation, cwd, new Date(), facts.task, facts.system),
          );
        }),
      );
    }),
});

export default ServerPlugin;
