import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";

const FORMAT = "json-word-counts";

/** The byte order mark some exporters put at the start of a text file. */
const BYTE_ORDER_MARK = "﻿";

/** The opening brace of the object, with the whitespace around it. The expression is sticky, so it matches only at the position the scan has reached. */
const OPEN = /\s*\{\s*/y;

/** The whitespace at the scan's position, so an error names the line of the member and not the line of the comma before it. Sticky, as above. */
const BLANK = /\s*/y;

/** One member of the object: a string key (any character but a quote or a backslash, or a backslash and the character it escapes), a colon, a count written as a non-negative integer, and the comma or closing brace after it. Sticky, as above. */
const MEMBER = /\s*"((?:[^"\\]|\\[\s\S])*)"\s*:\s*(0|[1-9]\d*)\s*([,}])/y;

/**
 * The 1-based line of a position in the text.
 * @param text - The text.
 * @param offset - A position in it.
 * @returns The number of line feeds before the position, plus one.
 */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let at = text.indexOf("\n"); at !== -1 && at < offset; at = text.indexOf("\n", at + 1)) {
    line += 1;
  }

  return line;
}

/**
 * Decodes the text between a JSON string's quotes.
 * @param raw - The text, in which a backslash starts an escape.
 * @param line - The 1-based line of the member, called only for the error.
 * @returns The string it writes.
 * @throws NativeParseError when the text is not the content of a JSON string.
 */
function keyOf(raw: string, line: () => number): string {
  if (!raw.includes("\\")) {
    return raw;
  }
  try {
    const decoded: unknown = JSON.parse(`"${raw}"`);
    if (typeof decoded === "string") {
      return decoded;
    }
  } catch {
    // The failure is reported below with its line.
  }
  throw new NativeParseError(FORMAT, line(), `the key "${raw}" is not a JSON string`);
}

/**
 * Reads a word list written as one JSON object whose keys are the words and whose values are their counts. The object is read member by member in the order the file writes them (unlike `JSON.parse`, which lists integer-like keys first and keeps only the last of a repeated key), so a word listed twice is an error and not a silent loss. Each row has the word as its id and as `word`, and its count as `count`.
 * @param text - The file text.
 * @returns The rows, in file order.
 * @throws NativeParseError naming the line of the first problem: a document that is not an object, a member that is not a string key with a non-negative integer count, an empty key, a count past the safe integers, a word listed twice, or text after the object.
 */
export function parseJsonWordCounts(text: string): NativeTable {
  const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
  OPEN.lastIndex = 0;
  if (OPEN.exec(source) === null) {
    throw new NativeParseError(FORMAT, 1, "the document is not a JSON object");
  }
  const nodes: NativeRow[] = [];
  const seen = new Set<string>();
  let position = OPEN.lastIndex;
  // The line is worked out only for an error, since counting line feeds from the start for every member would make the scan quadratic.
  const line = (): number => {
    BLANK.lastIndex = position;
    BLANK.exec(source);

    return lineAt(source, BLANK.lastIndex);
  };
  if (source[position] === "}") {
    position += 1;
  } else {
    for (let closed = false; !closed; ) {
      MEMBER.lastIndex = position;
      const member = MEMBER.exec(source);
      if (member === null) {
        throw new NativeParseError(FORMAT, line(), "expected a string key and a non-negative integer count");
      }
      const [, raw = "", digits = "", terminator = ""] = member;
      const word = keyOf(raw, line);
      const count = Number(digits);
      if (word === "") {
        throw new NativeParseError(FORMAT, line(), "a key is empty");
      }
      if (!Number.isSafeInteger(count)) {
        throw new NativeParseError(FORMAT, line(), `the count of ${JSON.stringify(word)} is not a safe integer`);
      }
      if (seen.has(word)) {
        throw new NativeParseError(FORMAT, line(), `the word ${JSON.stringify(word)} is listed twice`);
      }
      seen.add(word);
      nodes.push({ id: word, word, count });
      position = MEMBER.lastIndex;
      closed = terminator === "}";
    }
  }
  if (source.slice(position).trim() !== "") {
    throw new NativeParseError(FORMAT, line(), "text follows the object");
  }

  return { nodes };
}
