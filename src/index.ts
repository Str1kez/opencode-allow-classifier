import { Plugin } from "@opencode/plugin/effect";
import { Effect } from "effect";
import { readOptions } from "./options.ts";
import { openCodeStateDirectory } from "./paths.ts";
import { openRawEventLog, type RawEventLog } from "./raw-log.ts";

export const PLUGIN_ID = "str1kez.allow-classifier";

function startRawEventLog(options: ReturnType<typeof readOptions>): RawEventLog | undefined {
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
 * Diagnostic slice: registers the `evaluate` hook and, behind `log_raw`, records every evaluation it receives.
 * It never touches `evaluation.effect`, so the permission policy stays exactly as configured.
 */
export const ServerPlugin = Plugin.define({
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const log = startRawEventLog(readOptions(ctx.options));

      yield* ctx.permission.hook("evaluate", (evaluation) =>
        log ? Effect.sync(() => log.write(evaluation)) : Effect.void,
      );
    }),
});

export default ServerPlugin;
