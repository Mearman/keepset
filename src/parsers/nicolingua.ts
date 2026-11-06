import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseCsvTable } from "./csv-table";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";

type NicolinguaParser = Extract<Parser, { format: "nicolingua" }>;

const FORMAT = "nicolingua";
const METADATA = "metadata.csv";
const VOCABULARIES = ["vocab_contact_management.csv", "vocab_digits.csv", "vocab_names.csv", "vocab_wake_words.csv", "vocab_parents.csv"] as const;
const LANGUAGES = new Map([["francais", "French"], ["maninka", "Maninka"], ["susu", "Susu"], ["pular", "Pular"], ["_language_independent", "Name"]]);

/**
 * Reads Nicolingua recording metadata and vocabulary tables, resolving each recording's prompt by its utterance ID and language. The result preserves the metadata fields and adds the prompt as text and the filename as audio.
 * @param files - The recording and vocabulary CSV files selected from the archive.
 * @param parser - The recipe's encoding and format.
 * @returns One row per recording, in metadata file order.
 * @throws NativeParseError when a file is missing, repeated or invalid, a recording or vocabulary ID is duplicated, or a prompt cannot be resolved.
 */
export function parseNicolingua(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<NicolinguaParser>): NativeTable {
  const byName = new Map<string, Uint8Array>();
  for (const file of files) {
    const name = file.path.split("/").at(-1);
    if (name === undefined || (name !== METADATA && !VOCABULARIES.some((vocabulary) => vocabulary === name))) {
      throw new NativeParseError(FORMAT, 1, `${file.path}: unexpected file`);
    }
    if (byName.has(name)) throw new NativeParseError(FORMAT, 1, `${name}: duplicate file`);
    byName.set(name, file.bytes);
  }
  const read = (name: string, idColumn: string): readonly NativeRow[] => {
    const bytes = byName.get(name);
    if (bytes === undefined) throw new NativeParseError(FORMAT, 1, `${name}: missing file`);

    return parseCsvTable(decode(bytes, parser), { format: "csv-table", encoding: "utf-8", delimiter: "comma", skipLines: 0, idColumn, numericColumns: [] }).nodes;
  };
  const vocabulary = new Map<string, NativeRow>();
  for (const name of VOCABULARIES) {
    for (const row of read(name, "ID")) {
      if (vocabulary.has(row.id)) throw new NativeParseError(FORMAT, 1, `${name}: duplicate vocabulary ID ${row.id}`);
      vocabulary.set(row.id, row);
    }
  }
  const seen = new Set<string>();
  const nodes = read(METADATA, "file").map((row, index): NativeRow => {
    if (seen.has(row.id)) throw new NativeParseError(FORMAT, index + 2, `duplicate recording ${row.id}`);
    seen.add(row.id);
    const utterance = row["utterance_id"];
    const language = row["language"];
    if (typeof utterance !== "string" || typeof language !== "string") throw new NativeParseError(FORMAT, index + 2, `${row.id}: missing utterance ID or language`);
    const column = LANGUAGES.get(language);
    if (column === undefined) throw new NativeParseError(FORMAT, index + 2, `${row.id}: unknown language ${language}`);
    const promptId = utterance.split("_", 1)[0];
    const text = promptId === undefined ? undefined : vocabulary.get(promptId)?.[column];
    if (typeof text !== "string" || text === "") throw new NativeParseError(FORMAT, index + 2, `${row.id}: no ${column} prompt for ${utterance}`);

    return { ...row, audio: row.id, text };
  });

  return { nodes };
}
