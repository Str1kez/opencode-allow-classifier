/**
 * Dependency-free line-based unified diff.
 *
 * Used to show config changes before writing them and to illustrate a safe merge when the
 * installer refuses to touch a misordered file. The output follows the usual unified format:
 * `---`/`+++` headers, `@@` hunks and context lines.
 */

export interface DiffOptions {
  /** Header label for the original text. */
  readonly from?: string;
  /** Header label for the edited text. */
  readonly to?: string;
  /** Number of unchanged lines around each change. */
  readonly context?: number;
}

type Operation = " " | "-" | "+";

interface DiffLine {
  readonly operation: Operation;
  readonly text: string;
}

interface Hunk {
  readonly start: number;
  readonly end: number;
}

export function unifiedDiff(before: string, after: string, options: DiffOptions = {}): string {
  if (before === after) return "";

  const context = options.context ?? 3;
  const lines = diffLines(splitLines(before), splitLines(after));
  const hunks = groupHunks(lines, context);
  if (hunks.length === 0) return "";

  const output = [`--- ${options.from ?? "before"}`, `+++ ${options.to ?? "after"}`];
  for (const hunk of hunks) {
    output.push(hunkHeader(lines, hunk));
    for (let index = hunk.start; index < hunk.end; index += 1) {
      const line = lines[index]!;
      output.push(`${line.operation}${line.text}`);
    }
  }

  return `${output.join("\n")}\n`;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function diffLines(before: readonly string[], after: readonly string[]): DiffLine[] {
  const rows = before.length;
  const columns = after.length;

  // lcs[row][column] is the longest common subsequence length of the suffixes.
  const lcs: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      lcs[row]![column] =
        before[row] === after[column]
          ? lcs[row + 1]![column + 1]! + 1
          : Math.max(lcs[row + 1]![column]!, lcs[row]![column + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let row = 0;
  let column = 0;

  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      lines.push({ operation: " ", text: before[row]! });
      row += 1;
      column += 1;
    } else if (lcs[row + 1]![column]! >= lcs[row]![column + 1]!) {
      lines.push({ operation: "-", text: before[row]! });
      row += 1;
    } else {
      lines.push({ operation: "+", text: after[column]! });
      column += 1;
    }
  }

  while (row < rows) {
    lines.push({ operation: "-", text: before[row]! });
    row += 1;
  }
  while (column < columns) {
    lines.push({ operation: "+", text: after[column]! });
    column += 1;
  }

  return lines;
}

function groupHunks(lines: readonly DiffLine[], context: number): Hunk[] {
  const changed = lines.flatMap((line, index) => (line.operation === " " ? [] : [index]));
  if (changed.length === 0) return [];

  const hunks: Hunk[] = [];
  let start = Math.max(0, changed[0]! - context);
  let end = Math.min(lines.length, changed[0]! + context + 1);

  for (const index of changed.slice(1)) {
    if (index - context <= end) {
      end = Math.min(lines.length, index + context + 1);
      continue;
    }
    hunks.push({ start, end });
    start = Math.max(0, index - context);
    end = Math.min(lines.length, index + context + 1);
  }

  hunks.push({ start, end });
  return hunks;
}

function hunkHeader(lines: readonly DiffLine[], hunk: Hunk): string {
  let oldBefore = 0;
  let newBefore = 0;
  for (let index = 0; index < hunk.start; index += 1) {
    const operation = lines[index]!.operation;
    if (operation !== "+") oldBefore += 1;
    if (operation !== "-") newBefore += 1;
  }

  let oldCount = 0;
  let newCount = 0;
  for (let index = hunk.start; index < hunk.end; index += 1) {
    const operation = lines[index]!.operation;
    if (operation !== "+") oldCount += 1;
    if (operation !== "-") newCount += 1;
  }

  const oldStart = oldCount === 0 ? oldBefore : oldBefore + 1;
  const newStart = newCount === 0 ? newBefore : newBefore + 1;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}
