import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { memberId } from "./member-id";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";

type ChatParser = Extract<Parser, { format: "chat" }>;

const FORMAT = "chat";

/** The byte order mark some editors put at the start of a text file. */
const BYTE_ORDER_MARK = "﻿";

/** The character that brackets a time mark (a bullet) in a CHAT line: `<NAK>start_end<NAK>`, in milliseconds. */
const BULLET_DELIMITER = "\u0015";

/** A time mark between its delimiters: the start and end of the stretch of speech the text before it transcribes. */
const BULLET = /^(\d+)_(\d+)$/;

/** How many characters of a line an error quotes. */
const EXCERPT_LENGTH = 20;

/** The start of a main line: an asterisk, the speaker's code, a colon and a tab. */
const MAIN_LINE = /^\*([^:\s]+):\t/;

/** One turn of a CHAT file: who spoke, and the lines of text and time marks it holds. */
interface Turn {
  readonly speaker: string;
  readonly lines: string[];
}

/**
 * Splits the lines of a CHAT file into its turns: a main line (`*SPK:` and a tab) and the tab-led lines that continue it. Header lines (`@`) and dependent tiers (`%`) are not turns, nor are the lines that continue them.
 * @param text - The file text.
 * @param position - The file's 1-based position among the files, for errors.
 * @returns The turns, in file order.
 * @throws NativeParseError when a line begins with anything but the characters CHAT lines begin with, or a continuation has nothing to continue.
 */
function turnsOf(text: string, position: number): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;
  for (const line of (text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text).split(/\r\n|\n|\r/)) {
    if (line === "") {
      continue;
    }
    const speaker = MAIN_LINE.exec(line)?.[1];
    if (speaker !== undefined) {
      current = { speaker, lines: [line.slice(line.indexOf("\t") + 1)] };
      turns.push(current);
    } else if (line.startsWith("*")) {
      throw new NativeParseError(FORMAT, position, `the main line ${JSON.stringify(line.slice(0, EXCERPT_LENGTH))} is not of the form *SPEAKER:<tab>text`);
    } else if (line.startsWith("@") || line.startsWith("%")) {
      // A header or a dependent tier is not a turn, and the tab-led lines after it continue it and not the turn before.
      current = undefined;
    } else if (line.startsWith("\t")) {
      current?.lines.push(line.slice(1));
    } else {
      throw new NativeParseError(FORMAT, position, `the line ${JSON.stringify(line.slice(0, EXCERPT_LENGTH))} begins with none of *, @, % or a tab`);
    }
  }

  return turns;
}

/**
 * Reads a turn's text and its time marks.
 * @param turn - The turn.
 * @param position - The file's 1-based position among the files, for errors.
 * @returns The text with its time marks taken out and its runs of white space made one space, or null when nothing is left, and the start of the first time mark and the end of the last, or null for a turn with none.
 * @throws NativeParseError when a time mark is not closed or is not two whole numbers joined by an underscore.
 */
function readTurn(turn: Turn, position: number): { readonly text: string | null; readonly start: number | null; readonly end: number | null } {
  const pieces = turn.lines.join("\n").split(BULLET_DELIMITER);
  if (pieces.length % 2 === 0) {
    throw new NativeParseError(FORMAT, position, `a time mark in the turn of ${turn.speaker} is not closed`);
  }
  const words: string[] = [];
  let start: number | null = null;
  let end: number | null = null;
  for (const [index, piece] of pieces.entries()) {
    if (index % 2 === 0) {
      words.push(piece);
      continue;
    }
    const mark = BULLET.exec(piece);
    if (mark === null) {
      throw new NativeParseError(FORMAT, position, `the time mark ${JSON.stringify(piece)} in the turn of ${turn.speaker} is not start_end in milliseconds`);
    }
    start ??= Number(mark[1]);
    end = Number(mark[2]);
  }
  const text = words.join(" ").replaceAll(/\s+/g, " ").trim();

  return { text: text === "" ? null : text, start, end };
}

/**
 * Reads a corpus whose transcripts are CHAT files (the TalkBank format, as the Santa Barbara Corpus of Spoken American English is distributed): each main line is a row, a turn of one speaker, with the lines that continue it. A row's id is the file's id (the capture group of the recipe's `idPattern` on the file's path), a slash and the turn's 1-based position among the file's turns. A row has the `speaker` code, the `text` without its time marks and with its runs of white space made one space (the transcription conventions the corpus uses are the source's and are kept), and for a turn with time marks the `start` of the first and the `end` of the last, in milliseconds, which are null for a turn with none. Header lines and dependent tiers are not read.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser.
 * @returns The rows, in file and turn order.
 * @throws NativeParseError when a file is not valid UTF-8, a line begins with none of the characters a CHAT line begins with, a time mark is malformed, two files give the same id, or a path does not match the pattern.
 */
export function parseChat(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<ChatParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const stem = memberId(FORMAT, file.path, parser.idPattern, index + 1);
    if (seen.has(stem)) {
      throw new NativeParseError(FORMAT, index + 1, `the id ${stem} is given by two files`);
    }
    seen.add(stem);
    for (const [turnIndex, turn] of turnsOf(decode(file.bytes, parser), index + 1).entries()) {
      nodes.push({ id: `${stem}/${String(turnIndex + 1)}`, speaker: turn.speaker, ...readTurn(turn, index + 1) });
    }
  }

  return { nodes };
}
