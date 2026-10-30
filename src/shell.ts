import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Splits one resource — a command segment the permission scanner already cut on `&&` and `|` — into
 * shell words. Quotes are removed the same way a shell would, so `rg "a > b"` stays one token and the
 * guard sees the literal text rather than a fake redirection.
 */
export function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;

  for (const character of segment) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += character;
    started = true;
  }

  if (started) tokens.push(current);
  return tokens;
}

/** `ls`, `/bin/ls` and `./ls` all name the same program for rule matching. */
export function programOf(token: string | undefined): string {
  if (token === undefined) return "";
  const parts = token.split("/");
  return parts[parts.length - 1] ?? "";
}

/** Resolves a filesystem path to its real location, or `undefined` when it does not exist. */
export type RealPathResolver = (path: string) => string | undefined;

/** Absolute form of a token: `~` expanded, relative paths anchored at `cwd`. */
export function expandPath(target: string, cwd: string): string {
  const expanded = target === "~" ? homedir() : target.startsWith("~/") ? join(homedir(), target.slice(2)) : target;
  return resolve(cwd, expanded);
}

function isOutside(resolved: string, cwd: string): boolean {
  const base = resolve(cwd);
  return resolved !== base && !resolved.startsWith(base + sep);
}

/**
 * True when `target` resolves outside `cwd`. Comparison is on resolved paths, not on string prefixes:
 * `rm ./project/../x` is outside even though the raw text starts with the directory name.
 *
 * `realpath` closes the symlink hole: `notes -> ~/.ssh/id_rsa` is lexically inside the project, so the
 * string comparison alone would allow reading a private key. The resolver is injected because `decide`
 * stays pure and the tests must not depend on the real disk.
 */
export function resolvesOutsideCwd(target: string, cwd: string, realpath?: RealPathResolver): boolean {
  // `~user` names another account's home, which this process cannot expand; treat it as outside.
  if (target.startsWith("~") && target !== "~" && !target.startsWith("~/")) return true;
  return escapesCwd(target, cwd, realpath);
}

/**
 * Same check without the `~user` shortcut, for tokens that are not path-shaped: a bare `notes` cannot
 * escape lexically but can be a symlink to a private key.
 */
export function escapesCwd(target: string, cwd: string, realpath?: RealPathResolver): boolean {
  const resolved = expandPath(target, cwd);
  if (isOutside(resolved, cwd)) return true;
  if (realpath === undefined) return false;

  // The cwd is resolved too: a symlinked `/tmp` checkout would otherwise read every real path as outside.
  const real = realpath(resolved);
  return real !== undefined && isOutside(real, realpath(resolve(cwd)) ?? resolve(cwd));
}

/**
 * Arguments that name a filesystem location rather than a flag, pattern or ref. A bare relative
 * filename cannot escape `cwd`, so only absolute paths, `..` chains and home references qualify.
 */
export function isPathLike(token: string): boolean {
  return token === "." || token === ".." || token.startsWith("~") || token.includes("/");
}

/** `~` and `.` aliases of the working directory itself, used to spot a recursive search of everything. */
export function resolvesToCwd(target: string, cwd: string): boolean {
  return resolve(cwd, target) === resolve(cwd);
}

/**
 * The characters a shell would still act on, with quoted and escaped text blanked out.
 *
 * The guard checks raw text because tokenizing glues `;` to the previous word. That is also why the
 * raw text cannot be trusted blindly in the other direction: `rg "a|b"` is one literal argument, and
 * `find -name '*.ts'` is a pattern the shell never expands. Inside single quotes nothing is active;
 * inside double quotes only `$`, a backtick, a backslash and `!` still are.
 */
export function shellActiveText(raw: string): string {
  let active = "";
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;

    if (quote === "'") {
      if (character === "'") quote = undefined;
      active += " ";
      continue;
    }

    if (quote === '"') {
      if (character === '"') {
        quote = undefined;
        active += " ";
        continue;
      }
      if (character === "\\") {
        // Inside double quotes a backslash only escapes `"`, `\`, `$` and a backtick; anything else
        // is the literal backslash the program receives, so only the pair is blanked.
        const next = raw[index + 1];
        active += " ";
        if (next !== undefined && '"$`\\'.includes(next)) {
          active += " ";
          index += 1;
        }
        continue;
      }
      active += "$()`!".includes(character) || character === "\u001b" ? character : " ";
      continue;
    }

    if (character === "\\") {
      active += " ";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      active += " ";
      continue;
    }
    active += character;
  }

  return active;
}

/**
 * A program invoked through a path (`./cat`, `/tmp/evil/git`) is only provably the program it claims
 * to be when it lives in a system directory. Bare names are left to `PATH` without an I/O lookup.
 */
export function isTrustedProgramPath(token: string, trustedDirectories: ReadonlyArray<string>): boolean {
  if (!token.includes("/")) return true;
  return trustedDirectories.includes(dirname(token));
}

/**
 * Directories whose contents are installed by the system or the package manager. A program reached
 * through any other path may be a local shim that happens to share a read-only command's name.
 */
export const TRUSTED_PROGRAM_DIRECTORIES: readonly string[] = [
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/sbin",
  "/sbin",
];
