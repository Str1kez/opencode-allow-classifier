import assert from "node:assert/strict";
import { test } from "node:test";
import { unifiedDiff } from "../scripts/diff.ts";

test("unified diff shows an inserted line with surrounding context", () => {
  const diff = unifiedDiff("a\nb\n", "a\nx\nb\n", { from: "config", to: "config (proposed)" });

  assert.equal(
    diff,
    ["--- config", "+++ config (proposed)", "@@ -1,2 +1,3 @@", " a", "+x", " b", ""].join("\n"),
  );
});

test("unified diff shows a replaced line as a removal and an addition", () => {
  const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n");

  assert.equal(diff, ["--- before", "+++ after", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", ""].join("\n"));
});

test("unified diff is empty for identical text", () => {
  assert.equal(unifiedDiff("a\nb\n", "a\nb\n"), "");
});

test("unified diff splits distant changes into separate hunks", () => {
  const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"].join("\n") + "\n";
  const after = ["A", "b", "c", "d", "e", "f", "g", "h", "i", "j", "K"].join("\n") + "\n";

  const diff = unifiedDiff(before, after, { context: 1 });

  assert.equal(
    diff,
    [
      "--- before",
      "+++ after",
      "@@ -1,2 +1,2 @@",
      "-a",
      "+A",
      " b",
      "@@ -10,2 +10,2 @@",
      " j",
      "-k",
      "+K",
      "",
    ].join("\n"),
  );
});
