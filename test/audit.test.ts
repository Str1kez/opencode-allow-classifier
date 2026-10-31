import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { auditFileName, openAuditLog, toAuditEntry } from "../src/audit.ts";
import type { Decision } from "../src/policy.ts";

const CWD = "/Users/test/project";
const DECISION: Decision = {
  verdict: "allow",
  source: "allowlist",
  rule: "ls",
  probability: null,
  model: null,
  latency: 0.5,
};

test("audit file name is derived from the month", () => {
  assert.equal(auditFileName("2026-01-15T10:00:00.000Z"), "evaluate-2026-01.jsonl");
  assert.equal(auditFileName("2026-12-31T23:59:59.999Z"), "evaluate-2026-12.jsonl");
});

test("audit records system-context facts, never the text", () => {
  const directory = mkdtempSync(join(tmpdir(), "allow-classifier-audit-system-"));

  try {
    const log = openAuditLog(directory);
    log.write(
      toAuditEntry(
        DECISION,
        { sessionID: "s1", resources: ["ls"] },
        CWD,
        new Date("2026-01-15T10:00:00.000Z"),
        null,
        { used: true, length: 42, hash: "a".repeat(64) },
      ),
    );

    const line = readFileSync(join(directory, "evaluate-2026-01.jsonl"), "utf8");
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.deepEqual(entry["systemContext"], { used: true, length: 42, hash: "a".repeat(64) });
    assert.ok(!line.includes("project rules"), "the system text must never reach the audit");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("audit marks system context unused when it did not reach the classifier", () => {
  const entry = toAuditEntry(DECISION, { sessionID: "s1", resources: ["ls"] }, CWD);

  assert.deepEqual(entry["systemContext"], { used: false, length: null, hash: null });
});

test("audit rotates by month on the injected timestamp", () => {
  const directory = mkdtempSync(join(tmpdir(), "allow-classifier-audit-"));

  try {
    const log = openAuditLog(directory);
    log.write(toAuditEntry(DECISION, { sessionID: "s1", resources: ["ls"] }, CWD, new Date("2026-01-15T10:00:00.000Z")));
    log.write(toAuditEntry(DECISION, { sessionID: "s2", resources: ["ls"] }, CWD, new Date("2026-01-20T10:00:00.000Z")));
    log.write(toAuditEntry(DECISION, { sessionID: "s3", resources: ["ls"] }, CWD, new Date("2026-02-01T00:00:00.000Z")));

    assert.deepEqual(readdirSync(directory).sort(), ["evaluate-2026-01.jsonl", "evaluate-2026-02.jsonl"]);

    const january = readFileSync(join(directory, "evaluate-2026-01.jsonl"), "utf8").trimEnd().split("\n");
    assert.equal(january.length, 2);
    assert.equal((JSON.parse(january[0]!) as Record<string, unknown>)["time"], "2026-01-15T10:00:00.000Z");

    const february = readFileSync(join(directory, "evaluate-2026-02.jsonl"), "utf8").trimEnd().split("\n");
    assert.equal(february.length, 1);
    assert.equal((JSON.parse(february[0]!) as Record<string, unknown>)["session"], "s3");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
