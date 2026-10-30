/** Options the plugin reads from `ctx.options`, i.e. the `options` object in `opencode.jsonc`. */
export interface ClassifierOptions {
  /** Kill switch. `false` turns the plugin into a no-op: the hook is not registered at all. */
  readonly enabled: boolean;
  /** Write raw `evaluate` hook input to a JSONL file. Diagnostic only, off by default. */
  readonly logRaw: boolean;
  /** Overrides the raw log directory. Tests and manual runs point this away from the real state directory. */
  readonly logDirectory: string | undefined;
  /** Overrides the audit directory. Tests inject a temporary directory here. */
  readonly auditDirectory: string | undefined;
}

function directory(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function readOptions(raw: Readonly<Record<string, unknown>>): ClassifierOptions {
  return {
    enabled: raw["enabled"] !== false,
    logRaw: raw["log_raw"] === true,
    logDirectory: directory(raw["log_dir"]),
    auditDirectory: directory(raw["audit_dir"]),
  };
}
