import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { UNUSED_SYSTEM_CONTEXT, type SystemContextInfo } from "./classifier.ts";
import type { Decision } from "./policy.ts";

/** One line of the audit log: enough to explain later why the agent did or did not ask. */
export interface AuditEntry {
  readonly time: string;
  readonly session: string;
  readonly agent: string | null;
  readonly cwd: string;
  readonly resources: ReadonlyArray<string>;
  readonly rule: string;
  readonly verdict: Decision["verdict"];
  readonly source: Decision["source"];
  readonly probability: number | null;
  readonly model: string | null;
  readonly latency: number;
  /** The user's last message, truncated to 2000 characters. `null` when it could not be read. */
  readonly task: string | null;
  /** Hash, length and usage flag of the system context; never the text. */
  readonly systemContext: SystemContextInfo;
}

export interface AuditLog {
  readonly directory: string;
  write(entry: AuditEntry): void;
}

/** Monthly rotation keeps one file from growing forever: `evaluate-2026-10.jsonl`. */
export function auditFileName(time: string): string {
  return `evaluate-${time.slice(0, 7)}.jsonl`;
}

export function toAuditEntry(
  decision: Decision,
  evaluation: { readonly sessionID: string; readonly agent?: string; readonly resources: ReadonlyArray<string> },
  cwd: string,
  now: Date = new Date(),
  task: string | null = null,
  systemContext: SystemContextInfo = UNUSED_SYSTEM_CONTEXT,
): AuditEntry {
  return {
    time: now.toISOString(),
    session: evaluation.sessionID,
    agent: evaluation.agent ?? null,
    cwd,
    resources: [...evaluation.resources],
    rule: decision.rule,
    verdict: decision.verdict,
    source: decision.source,
    probability: decision.probability,
    model: decision.model,
    latency: decision.latency,
    task,
    systemContext,
  };
}

/**
 * Opens the audit log lazily: the file appears on the first decision, so a plugin that never sees a
 * shell-ask event leaves no trace. The directory is injected by the caller, which keeps tests out of
 * the real state directory.
 */
export function openAuditLog(directory: string): AuditLog {
  return {
    directory,
    write(entry) {
      try {
        mkdirSync(directory, { recursive: true });
        appendFileSync(join(directory, auditFileName(entry.time)), `${JSON.stringify(entry)}\n`);
      } catch {
        // A read-only state directory must not turn into a failed permission decision.
      }
    },
  };
}
