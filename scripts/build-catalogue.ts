/* Assembles the catalogue directory into src/generated/catalogue.json, the index the package bundles. Run first in `pnpm build`, before tsdown, so the bundle and its declarations see the index; it imports the TypeScript sources directly for the same reason.

   Reads catalogue/manifest.json, every catalogue/entries/<id>.json and every catalogue/crosswalks/**.json. Each file must parse and must already be in canonical form (the bytes serialise() writes for its parsed value), and an entry file must be named for its id, so the committed catalogue has one spelling per document and a re-import diffs cleanly. The assembled index is then checked by createCatalogue, the same check a consumer's own catalogue goes through.

   No try/catch: any failure crashes the script with a non-zero exit, naming the file. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseCrosswalk, type Crosswalk } from "crossmap";
import { createCatalogue } from "../src/catalogue";
import { parseEntry, type Entry } from "../src/entry";
import { parseManifest } from "../src/manifest";
import { serialise } from "../src/serialise";
import { catalogueDir, jsonFiles, repoRoot } from "./catalogue-files";

const outputPath = join(repoRoot, "src/generated/catalogue.json");

/**
 * Reads a catalogue file, parses it and checks it is in canonical form.
 * @param path - The file.
 * @param parse - The document's parser.
 * @returns The parsed document.
 */
function readCanonical<Doc extends Parameters<typeof serialise>[0]>(path: string, parse: (doc: unknown) => Doc): Doc {
  const text = readFileSync(path, "utf8");
  const doc = parse(JSON.parse(text));
  if (serialise(doc) !== text) {
    throw new Error(`${relative(repoRoot, path)} is not in canonical form: run pnpm catalogue:format, or rewrite it as serialise() writes it (two-space JSON in schema key order, trailing newline)`);
  }

  return doc;
}

const manifest = readCanonical(join(catalogueDir, "manifest.json"), parseManifest);

const crosswalks: Record<string, Crosswalk> = {};
for (const path of jsonFiles(join(catalogueDir, "crosswalks"))) {
  // Keyed by the path an entry's crosswalk reference uses: relative to the catalogue root, always with "/".
  const key = relative(catalogueDir, path).split(sep).join("/");
  Object.defineProperty(crosswalks, key, { value: readCanonical(path, parseCrosswalk), enumerable: true, writable: true, configurable: true });
}

const entries: Entry[] = jsonFiles(join(catalogueDir, "entries")).map((path) => {
  const entry = readCanonical(path, parseEntry);
  const expected = join(catalogueDir, "entries", `${entry.id}.json`);
  if (path !== expected) {
    throw new Error(`${relative(repoRoot, path)} holds entry ${entry.id}, so it must be ${relative(repoRoot, expected)}`);
  }

  return entry;
});

const index = { manifest, crosswalks, entries };
createCatalogue(index);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(index)}\n`, "utf8");
console.log(`Wrote ${relative(repoRoot, outputPath)}`);
