import { NativeParseError } from "../errors";
import type { NativeInstance, NativeRow } from "./native";

/** The columns of an utterance line, as the parser names them: the transcript, which is everything after the id. Both are text. */
export const UTTERANCE_LINES_COLUMNS = ["text"] as const;

/** The columns whose values are text; all of them. */
export const UTTERANCE_LINES_TEXT_COLUMNS = UTTERANCE_LINES_COLUMNS;

/** The metadata keys the parser emits: none, as a file of utterance lines says nothing beyond its lines. */
export const UTTERANCE_LINES_META = [] as const;

const FORMAT = "utterance-lines";

/** The byte order mark some editors put at the start of a text file. */
const BYTE_ORDER_MARK = "﻿";

/** The id of a line and the whitespace after it, which the transcript follows. */
const ID_THEN_TEXT = /^(\S+)(?:\s+([\s\S]*))?$/;

/**
 * Reads a file of utterance lines, as Kaldi's `text` files and LibriSpeech's `.trans.txt` files write them: one utterance per line, its id and then its transcript, separated by whitespace. A line holding only an id has a null transcript, and blank lines are skipped. Lines are split at LF, CRLF or CR, and the transcript is trimmed but otherwise kept as written, its inner spacing included.
 * @param text - The file text.
 * @returns The utterances in line order, each with its id and `text`, and an empty meta.
 * @throws NativeParseError naming the line when two lines have the same id.
 */
export function parseUtteranceLines(text: string): NativeInstance {
  const lines = (text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text).split(/\r\n|\n|\r/);
  const nodes: NativeRow[] = [];
  const seen = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const match = ID_THEN_TEXT.exec(trimmed);
    const id = match?.[1] ?? trimmed;
    if (seen.has(id)) {
      throw new NativeParseError(FORMAT, index + 1, `the utterance ${id} is listed twice`);
    }
    seen.add(id);
    const transcript = match?.[2]?.trim() ?? "";
    nodes.push({ id, text: transcript === "" ? null : transcript });
  }

  return { meta: {}, nodes };
}
