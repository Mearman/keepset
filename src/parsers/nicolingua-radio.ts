import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseCsvTable } from "./csv-table";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";

type RadioParser = Extract<Parser, { format: "nicolingua-radio" }>;
type CsvParser = Extract<Parser, { format: "csv-table" }>;

const FORMAT = "nicolingua-radio";
const FILES = ["train.tsv", "valid.tsv", "metadata.csv"] as const;

/**
 * Reads Nicolingua radio manifests and tagged validation metadata as one clip table. The two manifests divide the training-audio collection for the model, while the tagged validation clips form a separate collection.
 * @param files - The two TSV manifests and the tagged CSV selected from the archive.
 * @param parser - The recipe's encoding and format.
 * @returns One row per clip, in train manifest, validation manifest and tagged metadata order.
 * @throws NativeParseError when a file is missing, repeated or invalid, or a clip ID occurs more than once.
 */
export function parseNicolinguaRadio(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<RadioParser>): NativeTable {
  const byName = new Map<string, Uint8Array>();
  for (const file of files) {
    const name = file.path.split("/").at(-1);
    if (name === undefined || !FILES.some((expected) => expected === name)) throw new NativeParseError(FORMAT, 1, `${file.path}: unexpected file`);
    if (byName.has(name)) throw new NativeParseError(FORMAT, 1, `${name}: duplicate file`);
    byName.set(name, file.bytes);
  }
  const read = (name: string, options: CsvParser): readonly NativeRow[] => {
    const bytes = byName.get(name);
    if (bytes === undefined) throw new NativeParseError(FORMAT, 1, `${name}: missing file`);

    return parseCsvTable(decode(bytes, parser), options).nodes;
  };
  const manifest: CsvParser = { format: "csv-table", encoding: "utf-8", delimiter: "tab", skipLines: 1, headerNames: ["file", "samples"], idColumn: "file", columns: ["samples"], numericColumns: [{ column: "samples", factor: 1 }] };
  const tagged: CsvParser = { format: "csv-table", encoding: "utf-8", delimiter: "comma", skipLines: 0, idColumn: "file", columns: ["tags"], numericColumns: [] };
  const nodes: NativeRow[] = [];
  const seen = new Set<string>();
  const add = (row: NativeRow): void => {
    if (seen.has(row.id)) throw new NativeParseError(FORMAT, 1, `duplicate clip ${row.id}`);
    seen.add(row.id);
    nodes.push(row);
  };
  for (const name of ["train", "valid"] as const) {
    for (const row of read(`${name}.tsv`, manifest)) {
      const samples = row["samples"];
      if (typeof samples !== "number" || !Number.isSafeInteger(samples) || samples < 0) throw new NativeParseError(FORMAT, 1, `${row.id}: sample count must be a nonnegative integer`);
      add({ id: row.id, audio: row.id, samples, label: null, collection: "training", split: name });
    }
  }
  for (const row of read("metadata.csv", tagged)) {
    const label = row["tags"];
    if (label === undefined) throw new NativeParseError(FORMAT, 1, `${row.id}: missing tags column`);
    add({ id: row.id, audio: row.id, samples: null, label, collection: "tagged-validation", split: null });
  }

  return { nodes };
}
