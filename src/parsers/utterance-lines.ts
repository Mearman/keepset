import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeInstance, NativeRow } from "./native";

/** The columns of an utterance line, as the parser names them: the transcript, which is everything after the id. Both are text. */
export const UTTERANCE_LINES_COLUMNS = ["text"] as const;

/** The columns whose values are text; all of them. */
export const UTTERANCE_LINES_TEXT_COLUMNS = UTTERANCE_LINES_COLUMNS;

/** The metadata keys the parser emits: none, as a file of utterance lines says nothing beyond its lines. */
export const UTTERANCE_LINES_META = [] as const;

const FORMAT = "utterance-lines";

type UtteranceLinesParser = Extract<Parser, { format: "utterance-lines" }>;

/** The byte order mark some editors put at the start of a text file. */
const BYTE_ORDER_MARK = "﻿";

/** The id of a line and the whitespace after it, which the transcript follows. */
const ID_THEN_TEXT = /^(\S+)(?:\s+([\s\S]*))?$/;

/** The transcript of a line and the whitespace before its id, which ends the line. */
const TEXT_THEN_ID = /^(?:([\s\S]*?)\s+)?(\S+)$/;

/** A Festival utterance line, `( id " transcript " )`: the id, then the transcript inside the quotes. */
const FESTIVAL = /^\(\s*(\S+)\s+"([\s\S]*)"\s*\)$/;

/** A Sphinx transcription line, `<s> transcript </s> (id)`: the transcript between the sentence markers, then the id in parentheses. */
const SPHINX = /^<s>\s*([\s\S]*?)\s*<\/s>\s*\(([^()\s]+)\)$/;

/** A backslash and the character it escapes inside a Festival transcript. */
const FESTIVAL_ESCAPE = /\\(.)/g;

/**
 * Splits one trimmed, non-empty line into its id and transcript by the recipe's layout.
 * @param line - The line.
 * @param layout - `id-first` (the default): the id is the first whitespace-separated token and the transcript the rest. `id-last`: the id is the last token and the transcript what comes before it. `festival`: the line is `( id " transcript " )`, a backslash in the transcript escaping the next character. `sphinx`: the line is `<s> transcript </s> (id)`, as Sphinx and PocketSphinx transcription files write it.
 * @param position - The line's 1-based position, for the error.
 * @returns The id and the untrimmed transcript, which is empty where the line gives none.
 * @throws NativeParseError for a `festival` or `sphinx` line that is not of that form.
 */
function split(line: string, layout: UtteranceLinesParser["layout"], position: number): { readonly id: string; readonly transcript: string } {
  if (layout === "sphinx") {
    const match = SPHINX.exec(line);
    if (match?.[2] === undefined) {
      throw new NativeParseError(FORMAT, position, "the line is not of the form <s> text </s> (id)");
    }

    return { id: match[2], transcript: match[1] ?? "" };
  }
  if (layout === "festival") {
    const match = FESTIVAL.exec(line);
    if (match?.[1] === undefined) {
      throw new NativeParseError(FORMAT, position, "the line is not of the form ( id \" text \" )");
    }

    return { id: match[1], transcript: (match[2] ?? "").replaceAll(FESTIVAL_ESCAPE, "$1") };
  }
  if (layout === "id-last") {
    const match = TEXT_THEN_ID.exec(line);

    return { id: match?.[2] ?? line, transcript: match?.[1] ?? "" };
  }
  const match = ID_THEN_TEXT.exec(line);

  return { id: match?.[1] ?? line, transcript: match?.[2] ?? "" };
}

/**
 * Reads a file of utterance lines, as Kaldi's `text` files and LibriSpeech's `.trans.txt` files write them: one utterance per line, its id and then its transcript, separated by whitespace (or with the id last, or in Festival's parenthesised form, as the recipe's `layout` says). A line holding only an id has a null transcript, blank lines are skipped, and a line repeated exactly is read once. Lines are split at LF, CRLF or CR, and the transcript is trimmed but otherwise kept as written, its inner spacing included.
 * @param text - The file text.
 * @param parser - The recipe's parser, of which the layout is read.
 * @returns The utterances in line order, each with its id and `text`, and an empty meta.
 * @throws NativeParseError naming the line when two lines have the same id and different text or a Festival line is malformed.
 */
export function parseUtteranceLines(text: string, parser: Readonly<UtteranceLinesParser>): NativeInstance {
  const lines = (text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text).split(/\r\n|\n|\r/);
  const nodes: NativeRow[] = [];
  const seen = new Map<string, string | null>();
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === "") {
      continue;
    }
    const { id, transcript } = split(trimmed, parser.layout, index + 1);
    const trimmedTranscript = transcript.trim();
    const value = trimmedTranscript === "" ? null : trimmedTranscript;
    if (seen.has(id)) {
      // A line repeated exactly is the same record listed again, not a second utterance; the same id with other text is two utterances sharing an identity, which the target cannot hold.
      if (seen.get(id) === value) {
        continue;
      }
      throw new NativeParseError(FORMAT, index + 1, `the utterance ${id} is listed twice with different text`);
    }
    seen.set(id, value);
    nodes.push({ id, text: value });
  }

  return { meta: {}, nodes };
}
