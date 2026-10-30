import { realpathSync } from "node:fs";
import { Plugin } from "@opencode/plugin/effect";
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission";
import { Effect } from "effect";
import { openAuditLog, toAuditEntry, type AuditLog } from "./audit.ts";
import { readOptions, type ClassifierOptions } from "./options.ts";
import { openCodeStateDirectory } from "./paths.ts";
import { decide } from "./policy.ts";
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
 * One evaluated call. Non-shell actions and events that already have a definite effect never reach the
 * classifier and never touch the audit log; `deny` does not even reach the hook.
 */
function evaluate(evaluation: PermissionEvaluation, cwd: string, audit: AuditLog): void {
  if (evaluation.action !== "shell" || evaluation.effect !== "ask") return;

  const decision = decide(evaluation.resources, cwd, realPath);
  if (decision.verdict === "allow") evaluation.effect = "allow";

  audit.write(toAuditEntry(decision, evaluation, cwd));
}

/**
 * Auto mode pipeline: hard-ask → allowlist with guard → default `ask`. The classifier and its cache
 * plug in between the allowlist and the default in the next slice, which is why `decide` already
 * returns a full decision record instead of a boolean.
 */
export const ServerPlugin = Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = readOptions(ctx.options);
      if (!options.enabled) return;

      const rawLog = startRawEventLog(options);
      const audit = openAuditLog(options.auditDirectory ?? openCodeStateDirectory());
      const cwd = ctx.location.directory;

      yield* ctx.permission.hook("evaluate", (evaluation) =>
        Effect.sync(() => {
          rawLog?.write(evaluation);
          evaluate(evaluation, cwd, audit);
        }),
      );
    }),
});

export default ServerPlugin;
