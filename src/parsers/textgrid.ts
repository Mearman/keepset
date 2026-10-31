import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { memberId } from "./member-id";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";

type TextGridParser = Extract<Parser, { format: "textgrid" }>;

const FORMAT = "textgrid";

/** A double-quoted string as Praat writes one: a quote inside it is doubled, and it may span lines. */
const QUOTED = '"(?:[^"]|"")*"';

/** The first line of a TextGrid file, which says whether its values are labelled (the long form) or bare (the short form). */
const SIGNATURE = /^\s*File type\s*=\s*"ooTextFile( short)?"/;

/** The value after each equals sign of a long form file: a quoted string or a bare word. A structural line such as `item [1]:` has no equals sign and so gives no value. */
const LONG_VALUE = new RegExp(`=\\s*(${QUOTED}|[^\\s"]+)`, "g");

/** Every token of a short form file: a quoted string or a bare word. */
const SHORT_TOKEN = new RegExp(`${QUOTED}|[^\\s"]+`, "g");

/** The character a byte order mark encodes. */
const BYTE_ORDER_MARK = "﻿";

/** The bytes of a UTF-16 code unit. */
const UTF16_UNIT_BYTES = 2;

/**
 * The bytes the byte order mark takes in UTF-16.
 * @param littleEndian - Whether the code unit is written least significant byte first.
 * @returns The two bytes.
 */
function utf16Mark(littleEndian: boolean): number[] {
  const view = new DataView(new ArrayBuffer(UTF16_UNIT_BYTES));
  view.setUint16(0, BYTE_ORDER_MARK.charCodeAt(0), littleEndian);

  return Array.from(new Uint8Array(view.buffer));
}

/** The byte order marks a TextGrid file may start with, and the encoding each states. Praat writes UTF-16 with a mark for any file that has a character beyond Latin-1. */
const BYTE_ORDER_MARKS: readonly { readonly bytes: readonly number[]; readonly encoding: string }[] = [
  { bytes: Array.from(new TextEncoder().encode(BYTE_ORDER_MARK)), encoding: "utf-8" },
  { bytes: utf16Mark(false), encoding: "utf-16be" },
  { bytes: utf16Mark(true), encoding: "utf-16le" },
];

/** One interval or point of a tier: its times in seconds (equal for a point) and its text. */
interface Annotation {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** One tier of a TextGrid, in the file's order. */
interface Tier {
  readonly name: string;
  readonly annotations: readonly Annotation[];
}

/**
 * Decodes a TextGrid file by its byte order mark, strictly: a mark names UTF-8, UTF-16 big-endian or UTF-16 little-endian, and a file with none is read in the recipe's encoding.
 * @param bytes - The file.
 * @param parser - The recipe's parser, which names the encoding of a file without a mark.
 * @returns The text without its mark.
 * @throws NativeParseError when the bytes are not valid in the encoding the mark (or the recipe) names.
 */
function decodeFile(bytes: Uint8Array, parser: Readonly<TextGridParser>): string {
  const mark = BYTE_ORDER_MARKS.find(({ bytes: prefix }) => prefix.every((byte, index) => bytes[index] === byte));
  if (mark === undefined) {
    return decode(bytes, parser);
  }
  try {
    return new TextDecoder(mark.encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    throw new NativeParseError(FORMAT, 1, `the bytes are not valid ${mark.encoding}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The values of a file in the order a TextGrid states them, whichever form it is written in.
 * @param text - The file text.
 * @param position - The file's 1-based position among the files, for errors.
 * @returns The values after the signature line, still quoted where the file quotes them.
 * @throws NativeParseError when the file does not start with the Praat signature.
 */
function valuesOf(text: string, position: number): string[] {
  const signature = SIGNATURE.exec(text);
  if (signature === null) {
    throw new NativeParseError(FORMAT, position, 'the file does not start with File type = "ooTextFile"');
  }
  if (signature[1] === undefined) {
    // The long form labels every value with `key = `; the signature line is itself one, so its value is dropped.
    return Array.from(text.matchAll(LONG_VALUE), (match) => match[1] ?? "").slice(1);
  }

  return text.slice(signature[0].length).match(SHORT_TOKEN) ?? [];
}

/** A cursor over a file's values that reads them as the strings and numbers the format puts there. */
class Values {
  private index = 0;

  public constructor(
    private readonly values: readonly string[],
    private readonly position: number,
  ) {}

  /**
   * Whether every value has been read.
   * @returns True at the end.
   */
  public get done(): boolean {
    return this.index >= this.values.length;
  }

  /**
   * Skips the marker (`<exists>` or `<absent>`) the short form puts after the grid's times, if it is next.
   * @returns True for `<absent>`, which says the grid has no tiers.
   */
  public skipMarker(): boolean {
    const next = this.values[this.index];
    if (next === "<exists>" || next === "<absent>") {
      this.index += 1;

      return next === "<absent>";
    }

    return false;
  }

  /**
   * Reads the next value as a string.
   * @param what - What the value is, for the error.
   * @returns The text, without its quotes and with doubled quotes undone.
   * @throws NativeParseError when the file ends or the value is not quoted.
   */
  public string(what: string): string {
    const value = this.next(what);
    if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
      throw new NativeParseError(FORMAT, this.position, `expected ${what} as a quoted string, found ${value}`);
    }

    return value.slice(1, -1).replaceAll('""', '"');
  }

  /**
   * Reads the next value as a number.
   * @param what - What the value is, for the error.
   * @returns The number.
   * @throws NativeParseError when the file ends or the value is not a finite number.
   */
  public number(what: string): number {
    const value = this.next(what);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new NativeParseError(FORMAT, this.position, `expected ${what} as a number, found ${value}`);
    }

    return parsed;
  }

  /**
   * Reads the next value as a count.
   * @param what - What the value counts, for the error.
   * @returns A whole number of zero or more.
   * @throws NativeParseError when the value is not one.
   */
  public count(what: string): number {
    const value = this.number(what);
    if (!Number.isInteger(value) || value < 0) {
      throw new NativeParseError(FORMAT, this.position, `expected ${what} as a count, found ${String(value)}`);
    }

    return value;
  }

  private next(what: string): string {
    const value = this.values[this.index];
    if (value === undefined) {
      throw new NativeParseError(FORMAT, this.position, `the file ends where ${what} should be`);
    }
    this.index += 1;

    return value;
  }
}

/**
 * Reads a TextGrid's tiers.
 * @param text - The file text.
 * @param position - The file's 1-based position among the files, for errors.
 * @returns The tiers, in the file's order.
 * @throws NativeParseError when the text is not a TextGrid of the long or short form, or holds a tier that is neither an interval tier nor a point tier.
 */
function tiersOf(text: string, position: number): Tier[] {
  const values = new Values(valuesOf(text, position), position);
  const objectClass = values.string("the object class");
  if (objectClass !== "TextGrid") {
    throw new NativeParseError(FORMAT, position, `the file holds a ${objectClass}, not a TextGrid`);
  }
  values.number("the grid's start");
  values.number("the grid's end");
  if (values.skipMarker()) {
    return [];
  }
  const tiers: Tier[] = [];
  for (let remaining = values.count("the number of tiers"); remaining > 0; remaining -= 1) {
    const tierClass = values.string("a tier's class");
    if (tierClass !== "IntervalTier" && tierClass !== "TextTier") {
      throw new NativeParseError(FORMAT, position, `a tier of class ${tierClass} is neither an IntervalTier nor a TextTier`);
    }
    const name = values.string("a tier's name");
    values.number("the tier's start");
    values.number("the tier's end");
    const annotations: Annotation[] = [];
    for (let left = values.count(`the number of ${tierClass === "IntervalTier" ? "intervals" : "points"} of tier ${name}`); left > 0; left -= 1) {
      if (tierClass === "IntervalTier") {
        const start = values.number(`an interval's start in tier ${name}`);
        const end = values.number(`an interval's end in tier ${name}`);
        annotations.push({ start, end, text: values.string(`an interval's text in tier ${name}`) });
      } else {
        const time = values.number(`a point's time in tier ${name}`);
        annotations.push({ start: time, end: time, text: values.string(`a point's mark in tier ${name}`) });
      }
    }
    tiers.push({ name, annotations });
  }
  if (!values.done) {
    throw new NativeParseError(FORMAT, position, "the file holds more after its last tier");
  }

  return tiers;
}

/**
 * Says which tiers of a file the recipe reads: the one named by `tier`, every tier whose whole name matches `tierPattern`, or every tier when the recipe gives neither.
 * @param parser - The recipe's parser, which gives at most one of the two.
 * @returns A predicate on a tier's name, and the words that say, in an error, which tier a file lacks.
 */
function tierSelection(parser: Readonly<TextGridParser>): { readonly selects: (name: string) => boolean; readonly description: string } {
  if (parser.tier !== undefined) {
    return { selects: (name) => name === parser.tier, description: `no tier named ${parser.tier}` };
  }
  if (parser.tierPattern !== undefined) {
    const pattern = new RegExp(`^(?:${parser.tierPattern})$`, "u");

    return { selects: (name) => pattern.test(name), description: `no tier matching ${parser.tierPattern}` };
  }

  return { selects: () => true, description: "no tier" };
}

/**
 * Reads a corpus whose transcripts are Praat TextGrid files, in the long or short text form, in UTF-8, UTF-16 or (for a file with no byte order mark) the recipe's encoding: each non-empty interval of the tiers the recipe selects is a row, and so is each point of a selected point tier with a mark. The recipe selects the tier named by `tier`, every tier whose whole name matches `tierPattern` (for a corpus whose tiers are named for the speakers, who differ from file to file) or, when it gives neither, every tier. A row's id is the file's id (the capture group of the recipe's `idPattern` on the file's path), a slash, the tier's 1-based position in the file, a full stop and the annotation's 1-based position in the tier, which names it even when several tiers share a name. A row has the annotation's `text`, trimmed, the `tier` it is on and its `start` and `end` in seconds as the file states them (equal for a point). An empty interval is the grid's gap between annotations and is left out.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser, which selects the tiers.
 * @returns The rows, in file and tier order.
 * @throws NativeParseError when a file is not a well-formed TextGrid, holds no tier the recipe selects, two files give the same id, or a path does not match the pattern.
 */
export function parseTextGrid(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<TextGridParser>): NativeTable {
  const { selects, description } = tierSelection(parser);
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const stem = memberId(FORMAT, file.path, parser.idPattern, index + 1);
    if (seen.has(stem)) {
      throw new NativeParseError(FORMAT, index + 1, `the id ${stem} is given by two files`);
    }
    seen.add(stem);
    const tiers = tiersOf(decodeFile(file.bytes, parser), index + 1);
    if (!tiers.some((tier) => selects(tier.name))) {
      throw new NativeParseError(FORMAT, index + 1, `the file ${file.path} has ${description}`);
    }
    for (const [tierIndex, tier] of tiers.entries()) {
      if (!selects(tier.name)) {
        continue;
      }
      for (const [annotationIndex, annotation] of tier.annotations.entries()) {
        const text = annotation.text.trim();
        if (text !== "") {
          nodes.push({ id: `${stem}/${String(tierIndex + 1)}.${String(annotationIndex + 1)}`, text, tier: tier.name, start: annotation.start, end: annotation.end });
        }
      }
    }
  }

  return { nodes };
}
