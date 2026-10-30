import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openCodeStateDirectory } from "../src/paths.ts";

test("state directory honours an injected XDG_STATE_HOME", () => {
  assert.equal(openCodeStateDirectory({ XDG_STATE_HOME: "/tmp/xdg-state" }), join("/tmp/xdg-state", "opencode"));
});

test("state directory falls back to ~/.local/state when XDG_STATE_HOME is unset or empty", () => {
  const fallback = join(homedir(), ".local", "state", "opencode");
  assert.equal(openCodeStateDirectory({}), fallback);
  assert.equal(openCodeStateDirectory({ XDG_STATE_HOME: "" }), fallback);
});
