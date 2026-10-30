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
 * A program invoked through a path (`./cat`, `/tmp/evil/git`) is only provably the program it claims
 * to be when it lives in a system directory. Bare names are left to `PATH` without an I/O lookup.
 */
export function isTrustedProgramPath(token: string, trustedDirectories: ReadonlyArray<string>): boolean {
  if (!token.includes("/")) return true;
  return trustedDirectories.includes(dirname(token));
}
