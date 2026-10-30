import { realpathSync } from "node:fs";
import { Plugin } from "@opencode/plugin/effect";
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin";
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission";
import { Effect, Option } from "effect";
import { openAuditLog, toAuditEntry, type AuditEntry, type AuditLog } from "./audit.ts";
import { createVerdictCache } from "./cache.ts";
import { normalizeTask } from "./classifier.ts";
import { createGenerateAsk, type DecisionsOperation } from "./model.ts";
import { readOptions, type ClassifierOptions } from "./options.ts";
import { openCodeStateDirectory } from "./paths.ts";
import { evaluate, type EvaluationInput } from "./pipeline.ts";
import { openRawEventLog, type RawEventLog } from "./raw-log.ts";

export const PLUGIN_ID = "str1kez.allow-classifier";

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

function startRawEventLog(options: ClassifierOptions): RawEventLog | undefined {
  if (!options.logRaw) return undefined;

  try {
    return openRawEventLog(options.logDirectory ?? openCodeStateDirectory());
  } catch {
    // Diagnostics must never cost the user a working plugin: if the directory is unwritable the hook simply
    // stays silent and permission handling continues untouched.
    return undefined;
  }
}

/**
 * The last user message is the task behind the shell call, and it is untrusted input to the model.
 * A session that cannot be read is not a reason to fail the permission decision: the classifier just
 * gets no task. The timeout matters because the read happens inside the permission hook: a session
 * store that never answers must not hold the hook open.
 */
const SESSION_READ_TIMEOUT_MS = 1500;

async function readLastUserMessage(
  ctx: PluginContext,
  sessionID: PermissionEvaluation["sessionID"],
): Promise<string | null> {
  try {
    const messages = await Effect.runPromise(
      Effect.timeoutOption(ctx.session.context({ sessionID }), SESSION_READ_TIMEOUT_MS),
    );
    if (Option.isNone(messages)) return null;

    for (let index = messages.value.length - 1; index >= 0; index -= 1) {
      const message = messages.value[index];
      if (message?.type === "user") return normalizeTask(message.text);
    }
    return null;
  } catch {
    return null;
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
 * One evaluated call. Non-shell actions and events that already have a definite effect never reach the
 * classifier and never touch the audit log; `deny` does not even reach the hook.
 */
export const ServerPlugin = Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = readOptions(ctx.options);
      if (!options.enabled) return;

      const rawLog = startRawEventLog(options);
      const audit = openAuditLog(options.auditDirectory ?? openCodeStateDirectory());
      const writeAudit = createAuditWriter(audit);
      const cwd = ctx.location.directory;
      const cache = createVerdictCache<{ probability: number; model: string }>();
      const ask = askModel(ctx);

      yield* ctx.permission.hook("evaluate", (evaluation) =>
        Effect.promise(async () => {
          rawLog?.write(evaluation);
          if (evaluation.action !== "shell" || evaluation.effect !== "ask") return;

          let task: string | null = null;
          const input: EvaluationInput = {
            resources: [...evaluation.resources],
            cwd,
            agent: evaluation.agent,
            readTask: async () => {
              task = await readLastUserMessage(ctx, evaluation.sessionID);
              return task;
            },
          };
          const decision = await evaluate(input, { cache, ask, realpath: realPath });

          if (decision.verdict === "allow") evaluation.effect = "allow";
          await writeAudit(toAuditEntry(decision, evaluation, cwd, new Date(), task));
        }),
      );
    }),
});

export default ServerPlugin;
