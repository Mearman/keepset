import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";

type MusanParser = Extract<Parser, { format: "musan-annotations" }>;

const FORMAT = "musan-annotations";

/** The kind of sound a MUSAN directory holds and the directory beneath it, from the path of an `ANNOTATIONS` file: `musan/music/fma/ANNOTATIONS` is music from `fma`. */
const LOCATION = /(?:^|\/)(music|speech|noise)\/([^/]+)\/ANNOTATIONS$/u;

/** The fields of a music line after its id: genres joined by commas, whether the music has vocals (`Y` or `N`), the artist, and for Western art music the composer. */
const MUSIC_FIELDS = ["genre", "vocals", "artist", "composer"] as const;

/** The fields of a speech line after its id. */
const SPEECH_FIELDS = ["gender", "language"] as const;

/** The columns a row has whichever kind of sound it is, null where the kind lacks the field. */
const FIELDS = [...MUSIC_FIELDS, ...SPEECH_FIELDS] as const;

/** How many fields after the id each kind of line has: music without or with a composer, speech, and noise, whose line is its id alone. */
const FIELD_COUNTS = { music: [MUSIC_FIELDS.length - 1, MUSIC_FIELDS.length], speech: [SPEECH_FIELDS.length], noise: [0] } as const;

/** The characters a line may end with to be a heading of a noise list (`Background noises:`), not a recording. */
const HEADING_SUFFIX = ":";

/**
 * Reads the annotation files of the MUSAN corpus (`ANNOTATIONS` in each directory beneath `music`, `speech` and `noise`), whose lines are fields separated by white space with no header: a music line is a recording's id, its genres joined by commas, `Y` or `N` for vocals, the artist and, for Western art music, the composer; a speech line is the id, the speaker's gender and the language; a noise line is the id alone, with headings that end in a colon above them. A row's id is the recording's id as the file writes it. A row has the `label` (`music`, `speech` or `noise`, from the directory the file is in), the `source` (the directory beneath it, such as `fma`) and `genre`, `vocals`, `artist`, `composer`, `gender` and `language`, each null for a kind of sound whose lines do not have it.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser, which gives the encoding.
 * @returns The rows, in file and line order.
 * @throws NativeParseError when a path is not an annotation file of a kind of sound, a line has a number of fields its kind does not allow, or two lines give the same id.
 */
export function parseMusanAnnotations(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<MusanParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const position = index + 1;
    const location = LOCATION.exec(file.path);
    const kind = location?.[1];
    const source = location?.[2];
    if (kind !== "music" && kind !== "speech" && kind !== "noise") {
      throw new NativeParseError(FORMAT, position, `the path ${file.path} is not the ANNOTATIONS file of a music, speech or noise directory`);
    }
    if (source === undefined) {
      throw new NativeParseError(FORMAT, position, `the path ${file.path} names no directory beneath ${kind}`);
    }
    for (const [lineIndex, line] of decode(file.bytes, parser).split(/\r?\n/u).entries()) {
      const [id, ...rest] = line.trim().split(/\s+/u);
      if (id === undefined || id === "" || (kind === "noise" && line.trim().endsWith(HEADING_SUFFIX))) {
        continue;
      }
      const allowed: readonly number[] = FIELD_COUNTS[kind];
      if (!allowed.includes(rest.length)) {
        throw new NativeParseError(FORMAT, position, `line ${String(lineIndex + 1)} of ${file.path} has ${String(rest.length)} fields after the id, and a ${kind} line has ${allowed.join(" or ")}`);
      }
      if (seen.has(id)) {
        throw new NativeParseError(FORMAT, position, `the id ${id} is given twice`);
      }
      seen.add(id);
      const names: readonly string[] = kind === "speech" ? SPEECH_FIELDS : kind === "music" ? MUSIC_FIELDS : [];
      const values = new Map(names.map((name, at) => [name, rest[at]]));
      nodes.push({ id, label: kind, source, ...Object.fromEntries(FIELDS.map((name) => [name, values.get(name) ?? null])) });
    }
  }

  return { nodes };
}
