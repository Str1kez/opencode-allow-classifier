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

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= "0" && character <= "9";
}

/**
 * Bash ends a word at space, tab or newline. The other `\s` characters (NBSP, `\r`, `\f`, U+2028)
 * stay inside the argument, so `>/dev/null\r` names the file `/dev/null\r`, not the null device.
 */
function isTokenBoundary(character: string | undefined): boolean {
  return character === undefined || character === " " || character === "\t" || character === "\n";
}

/**
 * End offset of the stream redirect that starts at the `>` at `index`, or `undefined` when
 * normalization cannot prove the redirect is harmless. Only two literal shapes qualify: duplicating
 * a descriptor (`2>&1`, `>&2`) and sending a stream to a bare `/dev/null`.
 */
function streamRedirectEnd(characters: ReadonlyArray<string>, index: number): number | undefined {
  let position = index + 1;

  if (characters[position] === "&") {
    position += 1;
    const digitsStart = position;
    while (isDigit(characters[position])) position += 1;
    if (position === digitsStart) return undefined;
    return isTokenBoundary(characters[position]) ? position : undefined;
  }

  while (position < characters.length && isTokenBoundary(characters[position])) position += 1;

  const target = "/dev/null";
  if (characters.slice(position, position + target.length).join("") !== target) return undefined;

  const end = position + target.length;
  return isTokenBoundary(characters[end]) ? end : undefined;
}

/**
 * Blanks stream redirections so the guards do not read them as writes: `2>&1`, `>&2`, `2>/dev/null`,
 * `1>/dev/null` and `>/dev/null` create no file and must not cancel a read-only rule. A redirect to a
 * real file, including the append form `>>`, stays in the text.
 *
 * Quoted and escaped text is left alone, because the shell passes it as a literal argument. So is a
 * quoted target (`2>"/dev/null"`) and a target followed by shell punctuation: the normalizer does not
 * parse quoting, so the conservative ask stays. The replacement has the same length, so the rest of
 * the command keeps its positions.
 */
export function stripStreamRedirects(raw: string): string {
  const characters = [...raw];
  let quote: '"' | "'" | undefined;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index]!;

    if (quote === "'") {
      if (character === "'") quote = undefined;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") index += 1;
      else if (character === '"') quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    // `&>` (both streams at once) and `>>` (append) are not among the recognized shapes; leave the
    // whole operator to the redirect guard instead of blanking half of it.
    if (character !== ">" || characters[index - 1] === "&" || characters[index - 1] === ">") continue;

    const end = streamRedirectEnd(characters, index);
    if (end === undefined) continue;

    // The fd digits belong to the redirect only when they form a word of their own; in `x2>` the
    // redirect has no fd and `x2` is the argument.
    let start = index;
    while (start > 0 && isDigit(characters[start - 1])) start -= 1;
    if (start > 0 && !isTokenBoundary(characters[start - 1])) start = index;

    for (let position = start; position < end; position += 1) characters[position] = " ";
    index = end - 1;
  }

  return characters.join("");
}

/**
 * Characters a shell would act on after quotes and escapes are blanked, plus the pattern syntax that
 * makes an allowlist prefix unsafe. A quoted metacharacter is literal and does not count.
 */
const ACTIVE_SHELL_CHARACTERS = /[;&|`$(){}<>\\!*?\[\]\n]/;

/** True when the raw text still contains shell syntax a read-only rule must not accept. */
export function hasActiveShellSyntax(raw: string): boolean {
  return ACTIVE_SHELL_CHARACTERS.test(shellActiveText(raw));
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
