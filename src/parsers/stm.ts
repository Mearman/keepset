import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { memberId } from "./member-id";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";

type StmParser = Extract<Parser, { format: "stm" }>;

const FORMAT = "stm";

/** The prefix of a comment line, which also carries the header (`;; CATEGORY`, `;; LABEL`). */
const COMMENT_PREFIX = ";;";

/** The speakers the format reserves for lines that are not transcribed speech: a stretch nobody speaks in, and a stretch the scoring leaves out. */
const RESERVED_SPEAKERS: ReadonlySet<string> = new Set(["inter_segment_gap", "excluded_region"]);

/** A segment line: the recording, the channel, the speaker, the begin and end times in seconds, the label field in angle brackets and then the transcript, which may be empty. */
const SEGMENT = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+<([^>]*)>(?:\s+(.*))?$/u;

/** How many characters of a line an error quotes. */
const EXCERPT_LENGTH = 40;

/**
 * Reads a time field.
 * @param field - The field as the line writes it.
 * @param what - Which time it is, for the error.
 * @param position - The file's 1-based position among the files, for errors.
 * @returns The time in seconds.
 * @throws NativeParseError when the field is not a finite number.
 */
function seconds(field: string, what: string, position: number): number {
  const value = Number(field);
  if (!Number.isFinite(value)) {
    throw new NativeParseError(FORMAT, position, `the ${what} time ${JSON.stringify(field)} is not a number`);
  }

  return value;
}

/**
 * Reads a corpus whose transcripts are NIST STM files (one segment per line, as the Hub-4 and SCTK tools write them): each line that gives a speaker's transcript is a row. A row's id is the file's id (the capture group of the recipe's `idPattern` on the file's path), a slash and the line's 1-based number in the file. A row has the `speaker`, the `channel` as written, the `start` and `end` in seconds, the `label` field's text between its angle brackets (one label for each category the file's header declares, which the parser does not interpret) and the `text`, null when the line has none. Comment lines (`;;`, which hold the header) and blank lines are not read, nor are the lines of the reserved speakers `inter_segment_gap` and `excluded_region`, which mark stretches that carry no transcript.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser.
 * @returns The rows, in file and line order.
 * @throws NativeParseError when a file is not valid in the recipe's encoding, a line is not a segment line or has a time that is not a number, two files give the same id, or a path does not match the pattern.
 */
export function parseStm(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<StmParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const position = index + 1;
    const stem = memberId(FORMAT, file.path, parser.idPattern, position);
    if (seen.has(stem)) {
      throw new NativeParseError(FORMAT, position, `the id ${stem} is given by two files`);
    }
    seen.add(stem);
    for (const [lineIndex, line] of decode(file.bytes, parser).split(/\r?\n/u).entries()) {
      if (line.trim() === "" || line.startsWith(COMMENT_PREFIX)) {
        continue;
      }
      const fields = SEGMENT.exec(line);
      if (fields === null) {
        throw new NativeParseError(FORMAT, position, `the line ${String(lineIndex + 1)} of ${file.path} (${JSON.stringify(line.slice(0, EXCERPT_LENGTH))}) is not a segment line`);
      }
      const [, , channel = "", speaker = "", begin = "", end = "", label = "", text = ""] = fields;
      if (RESERVED_SPEAKERS.has(speaker)) {
        continue;
      }
      nodes.push({
        id: `${stem}/${String(lineIndex + 1)}`,
        speaker,
        channel,
        start: seconds(begin, "begin", position),
        end: seconds(end, "end", position),
        label,
        text: text.trim() === "" ? null : text.trim(),
      });
    }
  }

  return { nodes };
}
