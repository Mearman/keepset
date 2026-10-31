import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";
import { memberId } from "./member-id";
import { decode } from "./parse-native";

type MemberTextParser = Extract<Parser, { format: "member-text" }>;

const FORMAT = "member-text";

/** The byte order mark some editors put at the start of a text file. */
const BYTE_ORDER_MARK = "﻿";

/**
 * Reads a corpus whose texts are one text file each, such as the transcripts of one recording each or the books of a library: each file is a row, its id taken from the file's path and its text from the file's contents. The id is the capture group of the recipe's `idPattern`, which must match the file's whole path, so the same pattern that names the recording (`.../F01_a1_s001_v01.txt`) says which part of the path is its id. The text is the file's contents without a byte order mark and without surrounding whitespace, or when the recipe names a `line` only that line (a file that holds the words, then their pinyin, then their phones, one per line). Line endings of any kind separate lines, and a file with no text is a row with a null text. A `verbatim` recipe keeps the contents exactly as decoded instead, without only the byte order mark, so an empty file is an empty text.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser.
 * @returns One row per file, in path order.
 * @throws NativeParseError when a file's path does not match the pattern, two files give the same id, a file is not valid in the stated encoding, or the recipe's `line` is beyond the end of a file.
 */
export function parseMemberText(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<MemberTextParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const id = memberId(FORMAT, file.path, parser.idPattern, index + 1);
    if (seen.has(id)) {
      throw new NativeParseError(FORMAT, index + 1, `the id ${id} is given by two files`);
    }
    seen.add(id);
    const decoded = decode(file.bytes, parser);
    const unmarked = decoded.startsWith(BYTE_ORDER_MARK) ? decoded.slice(BYTE_ORDER_MARK.length) : decoded;
    if (parser.verbatim === true) {
      nodes.push({ id, text: unmarked });
      continue;
    }
    const content = unmarked.trim();
    let text = content;
    if (parser.line !== undefined) {
      const lines = content.split(/\r\n|\n|\r/);
      const chosen = lines[parser.line];
      if (chosen === undefined) {
        throw new NativeParseError(FORMAT, index + 1, `the file ${file.path} has ${String(lines.length)} lines, so there is no line ${String(parser.line + 1)}`);
      }
      text = chosen.trim();
    }
    nodes.push({ id, text: text === "" ? null : text });
  }

  return { nodes };
}
