import { isThreshold, normalizeModel } from "./settings.ts";

/** Options the plugin reads from `ctx.options`, i.e. the `options` object in `opencode.jsonc`. */
export interface ClassifierOptions {
  /** Kill switch. `false` turns the plugin into a no-op: neither the hook nor the RPC contract is registered. */
  readonly enabled: boolean;
  /** Write raw `evaluate` hook input to a JSONL file. Diagnostic only, off by default. */
  readonly logRaw: boolean;
  /** Overrides the raw log directory. Tests and manual runs point this away from the real state directory. */
  readonly logDirectory: string | undefined;
  /** Overrides the audit directory. Tests inject a temporary directory here. */
  readonly auditDirectory: string | undefined;
  /** Classifier model. Wins over the TUI override; an invalid value is ignored, not an error. */
  readonly model: string | undefined;
  /** Safety threshold in `(0, 1]`. An invalid value is ignored and the default applies. */
  readonly threshold: number | undefined;
}

function directory(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A config typo must not take the plugin down: a bad model falls back to the resolution order and a
 * bad threshold to the default, so the worst case is the stock behaviour rather than a crash loop.
 */
export function readOptions(raw: Readonly<Record<string, unknown>>): ClassifierOptions {
  return {
    enabled: raw["enabled"] !== false,
    logRaw: raw["log_raw"] === true,
    logDirectory: directory(raw["log_dir"]),
    auditDirectory: directory(raw["audit_dir"]),
    model: normalizeModel(raw["model"]),
    threshold: isThreshold(raw["threshold"]) ? raw["threshold"] : undefined,
  };
}
