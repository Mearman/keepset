import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";

type MtedxParser = Extract<Parser, { format: "mtedx" }>;

const FORMAT = "mtedx";

/** The byte order mark some editors put at the start of a text file. */
const BYTE_ORDER_MARK = "﻿";

/** The name of the file that lists each segment of a split: its id, the talk it is cut from and its start and end in that talk's audio, in seconds. */
const SEGMENTS_FILE = "segments";

/** The extension of the file that describes each segment's audio. */
const YAML_EXTENSION = ".yaml";

/** A line of a split's YAML file, a flow mapping in a block sequence: `- {duration: 8.73, offset: 10.94, speaker_id: talk, wav: talk.wav}`. */
const YAML_LINE = /^- \{duration: ([^,{}]+), offset: ([^,{}]+), speaker_id: ([^,{}]+), wav: ([^,{}]+)\}$/;

/** What each line of a split's `segments` file holds: the segment's id, its talk, its start and its end. */
const SEGMENT_FIELDS = 4;

/** A file of the archive as the archive step gives it. */
interface File {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** The three files that describe one split of a language, line-aligned with each other. */
interface Split {
  readonly name: string;
  readonly directory: string;
  segments?: File;
  yaml?: File;
  text?: File;
}

/**
 * Splits a file's text into its lines at line feeds alone, since the files of a split are aligned line by line and a carriage return inside a transcript is not a line break. The empty element after a final line feed is not a line.
 * @param file - The file.
 * @param parser - The recipe's parser.
 * @returns The lines, in order.
 * @throws NativeParseError when the bytes are not valid UTF-8.
 */
function linesOf(file: File, parser: Readonly<MtedxParser>): string[] {
  const decoded = decode(file.bytes, parser);
  const lines = (decoded.startsWith(BYTE_ORDER_MARK) ? decoded.slice(BYTE_ORDER_MARK.length) : decoded).split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

/**
 * Parses a number a file states as text.
 * @param text - The text.
 * @param what - What the number is, for the error.
 * @param where - The file's path and line, for the error.
 * @returns The number.
 * @throws NativeParseError when the text is not a finite number.
 */
function numberOf(text: string, what: string, where: string): number {
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) {
    throw new NativeParseError(FORMAT, 1, `${where}: the ${what} ${JSON.stringify(text)} is not a number`);
  }

  return value;
}

/**
 * Groups the files by the directory that holds them and names each directory's files by their role, so the three files of a split are read together whichever order the archive lists them in.
 * @param files - The files, in path order.
 * @returns The splits, in the order of their directories.
 * @throws NativeParseError when a directory holds a file that is none of the segments file, the YAML file or the transcript file named for the split, holds one of them twice, or lacks one.
 */
function splitsOf(files: readonly File[]): Split[] {
  const byDirectory = new Map<string, File[]>();
  for (const file of files) {
    const slash = file.path.lastIndexOf("/");
    const directory = file.path.slice(0, slash + 1);
    byDirectory.set(directory, [...(byDirectory.get(directory) ?? []), file]);
  }

  return [...byDirectory.entries()].map(([directory, inside]) => {
    const names = inside.map((file) => file.path.slice(directory.length));
    const yamlName = names.find((name) => name.endsWith(YAML_EXTENSION));
    if (yamlName === undefined) {
      throw new NativeParseError(FORMAT, 1, `${directory}: no ${YAML_EXTENSION} file describes the split's segments`);
    }
    const name = yamlName.slice(0, -YAML_EXTENSION.length);
    const split: Split = { name, directory };
    for (const file of inside) {
      const base = file.path.slice(directory.length);
      const role = base === SEGMENTS_FILE ? "segments" : base === yamlName ? "yaml" : base.startsWith(`${name}.`) && !base.slice(name.length + 1).includes(".") ? "text" : undefined;
      if (role === undefined) {
        throw new NativeParseError(FORMAT, 1, `${file.path}: not the segments file, the ${YAML_EXTENSION} file or a transcript named ${name}.<language>`);
      }
      if (split[role] !== undefined) {
        throw new NativeParseError(FORMAT, 1, `${directory}: more than one ${role} file, so the split's transcript is ambiguous`);
      }
      split[role] = file;
    }
    for (const role of ["segments", "text"] as const) {
      if (split[role] === undefined) {
        throw new NativeParseError(FORMAT, 1, `${directory}: no ${role === "segments" ? SEGMENTS_FILE : `${name}.<language>`} file`);
      }
    }

    return split;
  });
}

/**
 * Reads the rows of one split: its three files line-aligned, so line n of each describes the same segment.
 * @param split - The split's files.
 * @param parser - The recipe's parser.
 * @returns One row per segment, in line order.
 * @throws NativeParseError when the files have different numbers of lines, a segments line is not four fields, a YAML line is not of its form, or a line's YAML speaker or offset disagrees with its segments line, which says the files are not aligned.
 */
function rowsOf(split: Split, parser: Readonly<MtedxParser>): NativeRow[] {
  const { segments, yaml, text } = split;
  if (segments === undefined || yaml === undefined || text === undefined) {
    throw new NativeParseError(FORMAT, 1, `${split.directory}: the split lacks one of its three files`);
  }
  const segmentLines = linesOf(segments, parser);
  const yamlLines = linesOf(yaml, parser);
  const textLines = linesOf(text, parser);
  if (yamlLines.length !== segmentLines.length || textLines.length !== segmentLines.length) {
    throw new NativeParseError(FORMAT, 1, `${split.directory}: the segments, ${yaml.path.slice(split.directory.length)} and ${text.path.slice(split.directory.length)} files have ${String(segmentLines.length)}, ${String(yamlLines.length)} and ${String(textLines.length)} lines, so they are not aligned`);
  }
  const language = text.path.slice(text.path.lastIndexOf(".") + 1);

  return segmentLines.map((segmentLine, index): NativeRow => {
    const where = `${split.directory}:${String(index + 1)}`;
    const fields = segmentLine.split(" ");
    const [id, talk, start, end] = fields;
    if (fields.length !== SEGMENT_FIELDS || id === undefined || talk === undefined || start === undefined || end === undefined || id === "") {
      throw new NativeParseError(FORMAT, index + 1, `${where}: a segments line is ${String(SEGMENT_FIELDS)} space-separated fields, the segment, its talk, its start and its end`);
    }
    const described = YAML_LINE.exec(yamlLines[index] ?? "");
    const [, duration, offset, speaker, wav] = described ?? [];
    if (duration === undefined || offset === undefined || speaker === undefined || wav === undefined) {
      throw new NativeParseError(FORMAT, index + 1, `${where}: the ${YAML_EXTENSION} line is not of the form - {duration: d, offset: o, speaker_id: s, wav: w}`);
    }
    const startSeconds = numberOf(start, "start", where);
    if (speaker !== talk || numberOf(offset, "offset", where) !== startSeconds) {
      throw new NativeParseError(FORMAT, index + 1, `${where}: the segment ${id} is in talk ${talk} from ${start}, but the ${YAML_EXTENSION} line says speaker ${speaker} from ${offset}`);
    }
    const transcript = textLines[index] ?? "";

    return {
      id,
      text: transcript.trim() === "" ? null : transcript.trim(),
      speaker,
      audio: wav,
      start: startSeconds,
      end: numberOf(end, "end", where),
      duration: numberOf(duration, "duration", where),
      split: split.name,
      language,
    };
  });
}

/**
 * Reads a Multilingual TEDx language directory: each split's `segments` file (a segment's id, its talk and its start and end in seconds), `<split>.yaml` file (its duration, offset, speaker and audio file) and `<split>.<language>` transcript file, which are aligned line by line, are read together into one row per segment. The row's speaker is the YAML file's `speaker_id`, which mTEDx sets to the talk's id, and its audio is the talk's audio file; the split is the name the files give it and the language the transcript file's extension. The files of a split are found by their names, in any order and under any directory, so one recipe reads the monolingual archives whatever the language's code. A translation file beside the transcript of a pair archive is refused, not skipped, as the split's transcript would be ambiguous. The text is each line trimmed and a blank line is a null text; HTML entities in it are kept as the source writes them.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser.
 * @returns One row per segment, the splits in directory order and each split's segments in line order.
 * @throws NativeParseError naming the split and line of the first problem, as `splitsOf` and `rowsOf` report them, or when a segment id appears twice.
 */
export function parseMtedx(files: readonly File[], parser: Readonly<MtedxParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const split of splitsOf(files)) {
    for (const row of rowsOf(split, parser)) {
      if (seen.has(row.id)) {
        throw new NativeParseError(FORMAT, 1, `${split.directory}: the segment ${row.id} is listed twice`);
      }
      seen.add(row.id);
      nodes.push(row);
    }
  }

  return { nodes };
}
