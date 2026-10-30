import assert from "node:assert/strict";
import { test } from "node:test";
import { findExecIsReadOnly } from "../src/find.ts";
import { decide } from "../src/policy.ts";
import { tokenize } from "../src/shell.ts";

const CWD = "/Users/test/project";

function verdict(command: string): { verdict: string; rule: string } {
  const decision = decide([command], CWD);
  return { verdict: decision.verdict, rule: decision.rule };
}

test("find -exec with a read-only program is allowlisted", () => {
  for (const command of [
    "find . -exec grep -l alpha {} \\;",
    "find . -name '*.ts' -exec wc -l {} +",
    "find src -type f -exec cat {} \\;",
    "find . -maxdepth 2 -type f",
  ]) {
    assert.equal(verdict(command).verdict, "allow", command);
  }
});

test("find writes and runs programs only through the exec guard", () => {
  assert.deepEqual(verdict("find . -delete"), { verdict: "ask", rule: "guard:find-write" });
  assert.deepEqual(verdict("find . -fprint out.txt"), { verdict: "ask", rule: "guard:find-write" });
  assert.deepEqual(verdict("find . -exec rm {} \\;"), { verdict: "ask", rule: "guard:find-exec" });
  assert.deepEqual(verdict("find . -exec sh -c 'rm -rf /' \\;"), { verdict: "ask", rule: "guard:find-exec" });
  assert.deepEqual(verdict("find . -exec xargs rm \\;"), { verdict: "ask", rule: "guard:find-exec" });
  assert.match(verdict("find . -exec /tmp/evil/grep x {} \\;").rule, /^guard:(find-exec|outside-cwd)$/);
});

test("a spawned program keeps its own guards", () => {
  assert.deepEqual(verdict("find . -exec grep -r secret {} \\;"), { verdict: "ask", rule: "guard:find-exec" });
  assert.deepEqual(verdict("find . -exec tail -1f {} \\;"), { verdict: "ask", rule: "guard:find-exec" });
});

test("find without an exec terminator is not trusted", () => {
  assert.equal(findExecIsReadOnly(tokenize("find . -exec grep x")), false);
  assert.equal(findExecIsReadOnly(tokenize("find . -exec grep x {} \\;")), true);
  assert.equal(findExecIsReadOnly(tokenize("find . -name '*.ts'")), true);
});

test("find still obeys the path and secret guards", () => {
  assert.equal(verdict("find / -name x").rule, "guard:outside-cwd");
  assert.equal(verdict("find . -name .env -exec cat {} \\;").rule, "guard:secret-env");
});

test("a separator outside find keeps asking", () => {
  assert.equal(verdict("find . -exec grep x {} \\; && ls").verdict, "ask");
  assert.equal(verdict("echo hi; find . -exec grep x {} \\;").verdict, "ask");
});

test("quoted metacharacters are literal text", () => {
  assert.equal(verdict("rg 'a|b'").verdict, "allow");
  assert.equal(verdict("rg 'price > 10'").verdict, "allow");
  assert.equal(verdict("rg \"a|b\"").verdict, "allow");
  assert.equal(verdict("grep 'a;b' file").verdict, "allow");
  // A substitution stays active inside double quotes.
  assert.equal(verdict("rg \"$(whoami)\"").verdict, "ask");
  assert.equal(verdict("rg 'a|b' && ls").verdict, "ask");
  // A backslash-escaped quote inside double quotes is literal text, not an active escape.
  assert.equal(verdict("rg \"a\\\"b\" README.md").verdict, "allow");
  assert.equal(verdict("find . -name \"package.json\" -exec grep -l \"\\\"name\\\"\" {} \\;").verdict, "allow");
});
