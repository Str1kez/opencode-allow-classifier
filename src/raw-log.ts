import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

const RAW_LOG_FILE = "evaluate-raw.jsonl";

export interface RawEventLog {
  readonly file: string;
  write(event: unknown): void;
}

/**
 * Opens the raw `evaluate` event log for appending. Touching the file here proves at a glance that the
 * plugin loaded with logging enabled, even before any shell command runs.
 */
export function openRawEventLog(directory: string): RawEventLog {
  const file = join(directory, RAW_LOG_FILE);
  mkdirSync(directory, { recursive: true });
  closeSync(openSync(file, "a"));

  return {
    file,
    write(event) {
      // Logging is diagnostic: a full disk or a read-only state directory must not turn into a failed
      // permission decision, so write errors are dropped on purpose.
      try {
        appendFileSync(file, `${JSON.stringify(event)}\n`);
      } catch {
        // ignore
      }
    },
  };
}
