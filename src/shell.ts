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

/**
 * True when `target` resolves outside `cwd`. Comparison is on resolved paths, not on string prefixes:
 * `rm ./project/../x` is outside even though the raw text starts with the directory name.
 */
export function resolvesOutsideCwd(target: string, cwd: string): boolean {
  // `~user` names another account's home, which this process cannot expand; treat it as outside.
  if (target.startsWith("~") && target !== "~" && !target.startsWith("~/")) return true;

  const expanded = target === "~" ? homedir() : target.startsWith("~/") ? join(homedir(), target.slice(2)) : target;
  const resolved = resolve(cwd, expanded);
  const base = resolve(cwd);

  return resolved !== base && !resolved.startsWith(base + sep);
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
