/**
 * `find -exec` is the one shape where a read-only command hides inside another program's arguments:
 * the front of the resource is `find`, and the command that actually reads files comes after `-exec`.
 *
 * The allowlist therefore has to open two doors at once — `find` itself and the programs it spawns —
 * and the guard has to shut the second one when the spawned program can write or run something else.
 */
import { isTrustedProgramPath, programOf, TRUSTED_PROGRAM_DIRECTORIES } from "./shell.ts";

/** Programs whose `-exec` use only reads files. `find`, shells, `xargs` and `rm` are deliberately absent. */
export const FIND_READ_ONLY_EXEC_PROGRAMS: readonly string[] = [
  "cat",
  "df",
  "du",
  "file",
  "grep",
  "head",
  "jq",
  "ls",
  "rg",
  "stat",
  "tail",
  "wc",
  "which",
];

/** Predicates that write to disk or run a program without going through `-exec` validation. */
export const FIND_WRITE_PREDICATES: readonly string[] = [
  "-delete",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
];

/** `-exec PROG ... \;` and `-exec PROG ... +` end here; both spellings of the escaped semicolon count. */
const EXEC_TERMINATORS: readonly string[] = [";", "\\;", "+"];

/**
 * Splits a `find` expression into the argv of every `-exec` it runs, or `undefined` when any of them
 * is malformed or names a program that is not read-only. The `{}` placeholder is dropped: it stands
 * for a file the search already selected, so the spawned command is checked as if it had no operand.
 *
 * The program is checked both by name and by path: `-exec /tmp/evil/grep {} \;` is a local shim with
 * a trusted name, exactly like the top-level `./grep` case.
 */
export function findExecCommands(tokens: ReadonlyArray<string>): string[][] | undefined {
  const commands: string[][] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== "-exec") continue;

    const program = tokens[index + 1];
    if (program === undefined) return undefined;
    if (!isTrustedProgramPath(program, TRUSTED_PROGRAM_DIRECTORIES)) return undefined;
    if (!FIND_READ_ONLY_EXEC_PROGRAMS.includes(programOf(program))) return undefined;

    let terminator = index + 2;
    while (terminator < tokens.length && !EXEC_TERMINATORS.includes(tokens[terminator]!)) terminator += 1;
    if (terminator === tokens.length) return undefined;

    const args = tokens.slice(index + 2, terminator).filter((token) => token !== "{}" && token !== "{}+");
    commands.push([program, ...args]);
    index = terminator;
  }

  return commands;
}

/** True when every `-exec` in a `find` expression is well formed and spawns a read-only program. */
export function findExecIsReadOnly(tokens: ReadonlyArray<string>): boolean {
  return findExecCommands(tokens) !== undefined;
}
