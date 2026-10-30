/** Options the plugin reads from `ctx.options`, i.e. the `options` object in `opencode.jsonc`. */
export interface ClassifierOptions {
  /** Write raw `evaluate` hook input to a JSONL file. Diagnostic only, off by default. */
  readonly logRaw: boolean;
  /** Overrides the log directory. Tests and manual runs point this away from the real state directory. */
  readonly logDirectory: string | undefined;
}

export function readOptions(raw: Readonly<Record<string, unknown>>): ClassifierOptions {
  const logDirectory = raw["log_dir"];

  return {
    logRaw: raw["log_raw"] === true,
    logDirectory: typeof logDirectory === "string" && logDirectory.length > 0 ? logDirectory : undefined,
  };
}
