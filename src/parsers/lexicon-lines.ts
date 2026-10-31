import type { Parser } from "../entry";
import type { NativeRow, NativeTable } from "./native";

type LexiconLinesParser = Extract<Parser, { format: "lexicon-lines" }>;

/** The byte order mark some editors put at the start of a text file. */
const BYTE_ORDER_MARK = "﻿";

/** The word of a line and the whitespace after it, which the pronunciation follows. */
const WORD_THEN_PRONUNCIATION = /^(\S+)(?:\s+([\s\S]*))?$/;

/**
 * Reads a word list or pronunciation dictionary: one entry per line, the word and then, where the line has more, its pronunciation (the rest of the line, trimmed, with its inner spacing kept). A word may be listed on several lines, one per pronunciation, so the row's id is the line's position among the entries, from 1. Blank lines and lines that start with one of the recipe's comment prefixes are skipped without taking a position.
 * @param text - The file text.
 * @param parser - The recipe's parser, which gives the comment prefixes.
 * @returns One row per entry, in line order, each with `word` and `pronunciation` (null where the line holds only the word).
 */
export function parseLexiconLines(text: string, parser: Readonly<LexiconLinesParser>): NativeTable {
  const nodes: NativeRow[] = [];
  for (const line of (text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text).split(/\r\n|\n|\r/)) {
    const trimmed = line.trim();
    if (trimmed === "" || parser.commentPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
      continue;
    }
    const match = WORD_THEN_PRONUNCIATION.exec(trimmed);
    const pronunciation = match?.[2]?.trim() ?? "";
    nodes.push({ id: String(nodes.length + 1), word: match?.[1] ?? trimmed, pronunciation: pronunciation === "" ? null : pronunciation });
  }

  return { nodes };
}
