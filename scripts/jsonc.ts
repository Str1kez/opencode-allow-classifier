/**
 * Dependency-free JSONC reader with source offsets.
 *
 * The config is edited by offsets so comments, key order and whitespace survive. A full
 * serialize-back would destroy the parts of the file the owner reads by hand.
 */

export interface JsoncScalarNode {
  readonly type: "string" | "number" | "boolean" | "null";
  readonly start: number;
  readonly end: number;
  readonly value: string | number | boolean | null;
}

export interface JsoncMember {
  /** The key node; its range covers the quoted key including quotes. */
  readonly key: JsoncScalarNode;
  /** First character of the key. */
  readonly start: number;
  /** First character after the value. */
  readonly end: number;
  readonly value: JsoncNode;
}

export interface JsoncObjectNode {
  readonly type: "object";
  /** Offset of `{`. */
  readonly start: number;
  /** Offset after `}`. */
  readonly end: number;
  readonly members: readonly JsoncMember[];
}

export interface JsoncArrayNode {
  readonly type: "array";
  /** Offset of `[`. */
  readonly start: number;
  /** Offset after `]`. */
  readonly end: number;
  readonly items: readonly JsoncNode[];
}

export type JsoncNode = JsoncObjectNode | JsoncArrayNode | JsoncScalarNode;

export interface JsoncDocument {
  readonly text: string;
  readonly root: JsoncNode;
}

export interface JsoncEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface DuplicateKey {
  /** JSON path of the owning object, e.g. `$.plugins[0]`. */
  readonly path: string;
  readonly key: string;
}

export class JsoncSyntaxError extends Error {
  readonly offset: number;
  readonly line: number;
  readonly column: number;

  constructor(message: string, text: string, offset: number) {
    const before = text.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    super(`Invalid JSONC at line ${line}, column ${column}: ${message}`);
    this.name = "JsoncSyntaxError";
    this.offset = offset;
    this.line = line;
    this.column = column;
  }
}

class Parser {
  readonly #text: string;
  #index = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parse(): JsoncDocument {
    const root = this.#value();
    this.#trivia();
    if (this.#index < this.#text.length) {
      this.#fail(`unexpected character ${JSON.stringify(this.#text[this.#index])}`);
    }
    return { text: this.#text, root };
  }

  #peek(): string | undefined {
    return this.#text[this.#index];
  }

  #fail(message: string, offset = this.#index): never {
    throw new JsoncSyntaxError(message, this.#text, offset);
  }

  #trivia(): void {
    for (;;) {
      const ch = this.#peek();
      if (ch === undefined) return;
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\uFEFF") {
        this.#index += 1;
        continue;
      }
      if (ch === "/" && this.#text[this.#index + 1] === "/") {
        this.#index += 2;
        while (this.#index < this.#text.length && this.#text[this.#index] !== "\n") this.#index += 1;
        continue;
      }
      if (ch === "/" && this.#text[this.#index + 1] === "*") {
        const comment = this.#index;
        const end = this.#text.indexOf("*/", comment + 2);
        if (end === -1) this.#fail("unterminated block comment", comment);
        this.#index = end + 2;
        continue;
      }
      return;
    }
  }

  #value(): JsoncNode {
    this.#trivia();
    const start = this.#index;
    const ch = this.#peek();
    if (ch === undefined) this.#fail("unexpected end of input");

    if (ch === "{") return this.#object();
    if (ch === "[") return this.#array();
    if (ch === '"') return this.#string();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.#number();
    if (ch === "t") return this.#literal("true", true);
    if (ch === "f") return this.#literal("false", false);
    if (ch === "n") return this.#literal("null", null);
    this.#fail(`unexpected character ${JSON.stringify(ch)}`, start);
  }

  #literal(word: string, value: boolean | null): JsoncScalarNode {
    const start = this.#index;
    if (!this.#text.startsWith(word, start)) this.#fail(`invalid literal, expected ${word}`, start);
    this.#index += word.length;
    return { type: value === null ? "null" : "boolean", start, end: this.#index, value };
  }

  #number(): JsoncScalarNode {
    const start = this.#index;
    if (this.#peek() === "-") this.#index += 1;

    const first = this.#peek();
    if (first === "0") {
      this.#index += 1;
    } else if (first !== undefined && first >= "1" && first <= "9") {
      this.#index += 1;
      while (this.#isDigit(this.#peek())) this.#index += 1;
    } else {
      this.#fail("invalid number", start);
    }

    if (this.#peek() === ".") {
      this.#index += 1;
      if (!this.#isDigit(this.#peek())) this.#fail("invalid number: expected a digit after the decimal point");
      while (this.#isDigit(this.#peek())) this.#index += 1;
    }

    if (this.#peek() === "e" || this.#peek() === "E") {
      this.#index += 1;
      if (this.#peek() === "+" || this.#peek() === "-") this.#index += 1;
      if (!this.#isDigit(this.#peek())) this.#fail("invalid number: expected a digit in the exponent");
      while (this.#isDigit(this.#peek())) this.#index += 1;
    }

    return { type: "number", start, end: this.#index, value: Number(this.#text.slice(start, this.#index)) };
  }

  #isDigit(ch: string | undefined): boolean {
    return ch !== undefined && ch >= "0" && ch <= "9";
  }

  #string(): JsoncScalarNode {
    const start = this.#index;
    this.#index += 1;
    let value = "";

    for (;;) {
      const ch = this.#peek();
      if (ch === undefined) this.#fail("unterminated string", start);
      if (ch === '"') {
        this.#index += 1;
        return { type: "string", start, end: this.#index, value };
      }
      if (ch === "\\") {
        value += this.#escape();
        continue;
      }
      if (ch.charCodeAt(0) < 0x20) this.#fail("unescaped control character in string");
      value += ch;
      this.#index += 1;
    }
  }

  #escape(): string {
    const start = this.#index;
    this.#index += 1;
    const ch = this.#peek();
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    if (ch !== undefined && Object.hasOwn(simple, ch)) {
      this.#index += 1;
      return simple[ch]!;
    }
    if (ch !== "u") this.#fail("invalid escape sequence", start);

    const hex = this.#text.slice(this.#index + 1, this.#index + 5);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.#fail("invalid unicode escape", start);
    this.#index += 5;
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  #object(): JsoncObjectNode {
    const start = this.#index;
    this.#index += 1;
    const members: JsoncMember[] = [];
    this.#trivia();

    if (this.#peek() === "}") {
      this.#index += 1;
      return { type: "object", start, end: this.#index, members };
    }

    for (;;) {
      this.#trivia();
      if (this.#peek() === undefined) this.#fail("unexpected end of input");
      if (this.#peek() !== '"') this.#fail("expected a quoted object key");
      const key = this.#string();

      this.#trivia();
      if (this.#peek() !== ":") this.#fail("expected ':' after object key");
      this.#index += 1;

      const value = this.#value();
      members.push({ key, start: key.start, end: value.end, value });

      this.#trivia();
      const separator = this.#peek();
      if (separator === "}") {
        this.#index += 1;
        return { type: "object", start, end: this.#index, members };
      }
      if (separator === undefined) this.#fail("unexpected end of input");
      if (separator !== ",") this.#fail("expected ',' or '}' after object member");
      this.#index += 1;
      this.#trivia();
      if (this.#peek() === "}") {
        this.#index += 1;
        return { type: "object", start, end: this.#index, members };
      }
    }
  }

  #array(): JsoncArrayNode {
    const start = this.#index;
    this.#index += 1;
    const items: JsoncNode[] = [];
    this.#trivia();

    if (this.#peek() === "]") {
      this.#index += 1;
      return { type: "array", start, end: this.#index, items };
    }

    for (;;) {
      items.push(this.#value());
      this.#trivia();
      const separator = this.#peek();
      if (separator === "]") {
        this.#index += 1;
        return { type: "array", start, end: this.#index, items };
      }
      if (separator === undefined) this.#fail("unexpected end of input");
      if (separator !== ",") this.#fail("expected ',' or ']' after array item");
      this.#index += 1;
      this.#trivia();
      if (this.#peek() === "]") {
        this.#index += 1;
        return { type: "array", start, end: this.#index, items };
      }
    }
  }
}

export function parseJsonc(text: string): JsoncDocument {
  return new Parser(text).parse();
}

/** Plain JavaScript value. Duplicate keys resolve to the last one, as `JSON.parse` does. */
export function toValue(node: JsoncNode): unknown {
  if (node.type === "object") {
    const result: Record<string, unknown> = {};
    for (const member of node.members) {
      Object.defineProperty(result, member.key.value as string, {
        value: toValue(member.value),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  if (node.type === "array") return node.items.map(toValue);
  return node.value;
}

export function findDuplicateKeys(root: JsoncNode, path = "$"): DuplicateKey[] {
  const duplicates: DuplicateKey[] = [];

  if (root.type === "object") {
    const seen = new Set<string>();
    for (const member of root.members) {
      const key = member.key.value as string;
      if (seen.has(key)) duplicates.push({ path, key });
      seen.add(key);
      duplicates.push(...findDuplicateKeys(member.value, `${path}.${key}`));
    }
  } else if (root.type === "array") {
    root.items.forEach((item, index) => duplicates.push(...findDuplicateKeys(item, `${path}[${index}]`)));
  }

  return duplicates;
}

export function lastMember(object: JsoncObjectNode, key: string): JsoncMember | undefined {
  return object.members.findLast((member) => member.key.value === key);
}

export function replaceNode(node: JsoncNode, text: string): JsoncEdit {
  return { start: node.start, end: node.end, text };
}

/**
 * Applies non-overlapping edits to the original text. Edits are applied back to front so every
 * offset stays valid against the untouched source.
 */
export function applyEdits(text: string, edits: readonly JsoncEdit[]): string {
  const ordered = [...edits].sort((left, right) => left.start - right.start || left.end - right.end);
  let previousEnd = 0;

  for (const edit of ordered) {
    if (edit.start < previousEnd) throw new Error("overlapping JSONC edits");
    if (edit.start < 0 || edit.end < edit.start || edit.end > text.length) {
      throw new Error(`JSONC edit out of bounds: ${edit.start}..${edit.end}`);
    }
    previousEnd = edit.end;
  }

  let result = text;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const edit = ordered[index]!;
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

/** Appends a member before the closing brace. `memberText` is `"key": value`. */
export function insertObjectMember(document: JsoncDocument, object: JsoncObjectNode, memberText: string): JsoncEdit {
  return insertObjectMembers(document, object, [memberText]);
}

/** Appends several members in one edit, so an empty object stays valid. */
export function insertObjectMembers(
  document: JsoncDocument,
  object: JsoncObjectNode,
  memberTexts: readonly string[],
): JsoncEdit {
  requireElements(memberTexts);
  const multiline =
    document.text.slice(object.start, object.end).includes("\n") ||
    memberTexts.length > 1 ||
    memberTexts.some((memberText) => memberText.includes("\n"));
  const indent = containerChildIndent(document.text, object.start, object.members);
  const joined = memberTexts.join(multiline ? `,\n${indent}` : ", ");
  return insertIntoContainer(document.text, object, object.members, joined, object.end - 1);
}

/** Appends an item before the closing bracket. */
export function insertArrayItem(document: JsoncDocument, array: JsoncArrayNode, itemText: string): JsoncEdit {
  return insertArrayItems(document, array, array.items.length, [itemText]);
}

/**
 * Inserts items before the item at `index`. `index === array.items.length` appends, which also
 * covers an empty array.
 */
export function insertArrayItems(
  document: JsoncDocument,
  array: JsoncArrayNode,
  index: number,
  itemTexts: readonly string[],
): JsoncEdit {
  requireElements(itemTexts);
  if (!Number.isInteger(index) || index < 0 || index > array.items.length) {
    throw new RangeError(`array insert index out of bounds: ${index}`);
  }

  const target = array.items[index];
  if (target !== undefined) {
    const multiline = document.text.slice(array.start, target.start).includes("\n");
    if (!multiline) return { start: target.start, end: target.start, text: `${itemTexts.join(", ")}, ` };

    const indent = lineIndent(document.text, target.start);
    return { start: target.start, end: target.start, text: `${itemTexts.join(`,\n${indent}`)},\n${indent}` };
  }

  const multiline =
    array.items.length === 0 ||
    document.text.slice(array.start, array.end).includes("\n") ||
    itemTexts.some((itemText) => itemText.includes("\n"));
  const indent = containerChildIndent(document.text, array.start, array.items);
  const joined = itemTexts.join(multiline ? `,\n${indent}` : ", ");
  return insertIntoContainer(document.text, array, array.items, joined, array.end - 1);
}

function requireElements(texts: readonly string[]): void {
  if (texts.length === 0) throw new Error("nothing to insert");
}

function containerChildIndent(
  text: string,
  containerStart: number,
  elements: readonly ContainerElement[],
): string {
  const last = elements[elements.length - 1];
  return last === undefined ? `${lineIndent(text, containerStart)}  ` : lineIndent(text, last.start);
}

interface ContainerElement {
  readonly start: number;
  readonly end: number;
}

function insertIntoContainer(
  text: string,
  container: { readonly start: number; readonly end: number },
  elements: readonly ContainerElement[],
  elementText: string,
  close: number,
): JsoncEdit {
  const multiline = text.slice(container.start, container.end).includes("\n");
  const containerIndent = lineIndent(text, container.start);
  const childIndent = containerIndent + "  ";
  const last = elements[elements.length - 1];

  if (last === undefined) {
    const inner = text.slice(container.start + 1, close);
    if (inner.trim() === "") {
      return {
        start: container.start + 1,
        end: close,
        text:
          multiline || elementText.includes("\n")
            ? `\n${childIndent}${elementText}\n${containerIndent}`
            : ` ${elementText} `,
      };
    }
    return {
      start: container.start + 1,
      end: container.start + 1,
      text: multiline ? `\n${childIndent}${elementText}` : ` ${elementText} `,
    };
  }

  const elementIndent = lineIndent(text, last.start);
  const trailingComma = significantOffset(text, last.end, close);

  if (!multiline) {
    if (trailingComma !== null && text[trailingComma] === ",") {
      return { start: trailingComma + 1, end: trailingComma + 1, text: ` ${elementText}` };
    }
    return { start: last.end, end: last.end, text: `, ${elementText}` };
  }

  if (trailingComma !== null && text[trailingComma] === ",") {
    const newline = text.indexOf("\n", trailingComma);
    if (newline !== -1 && newline < close) {
      return { start: newline + 1, end: newline + 1, text: `${elementIndent}${elementText}\n` };
    }
    return { start: trailingComma + 1, end: trailingComma + 1, text: `\n${elementIndent}${elementText}` };
  }

  return { start: last.end, end: last.end, text: `,\n${elementIndent}${elementText}` };
}

export function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, offset))![0];
}

/** First non-trivia offset in `[from, to)`, or `null` when only trivia remains. */
function significantOffset(text: string, from: number, to: number): number | null {
  let index = from;
  while (index < to) {
    const ch = text[index];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\uFEFF") {
      index += 1;
      continue;
    }
    if (ch === "/" && text[index + 1] === "/") {
      index += 2;
      while (index < to && text[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && text[index + 1] === "*") {
      const comment = text.indexOf("*/", index + 2);
      if (comment === -1) return null;
      index = comment + 2;
      continue;
    }
    return index;
  }
  return null;
}
