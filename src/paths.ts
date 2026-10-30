import { homedir } from "node:os";
import { join } from "node:path";

/** Directory name OpenCode appends to the XDG state root; keep in sync with `opencode debug paths`. */
const APPLICATION_DIRECTORY = "opencode";

/**
 * Resolves OpenCode's state directory the same way the app does: `$XDG_STATE_HOME/opencode`,
 * falling back to `~/.local/state/opencode`.
 */
export function openCodeStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome = env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  return join(stateHome, APPLICATION_DIRECTORY);
}
