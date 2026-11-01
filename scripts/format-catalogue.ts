/* Rewrites every catalogue file (the manifest, each entry and each crosswalk) in the canonical form `serialise` writes, so a file written by hand or by a script that does not know the form (key order, the `$schema` line, identity moves as a `keep` list) is brought to it. Run it after editing the catalogue by any means other than `serialise`; `pnpm catalogue` refuses a file that is not canonical. Each file must parse, and one that does not stops the script, naming it. */

import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseCrosswalk } from "crossmap";
import { parseEntry } from "../src/entry";
import { parseManifest } from "../src/manifest";
import { serialise } from "../src/serialise";
import { catalogueDir, jsonFiles, repoRoot } from "./catalogue-files";

/**
 * Rewrites a catalogue file in canonical form.
 * @param path - The file.
 * @param parse - The document's parser.
 * @returns True when the file changed.
 */
function format(path: string, parse: (doc: unknown) => Parameters<typeof serialise>[0]): boolean {
  const before = readFileSync(path, "utf8");
  const after = serialise(parse(JSON.parse(before)));
  if (after === before) {
    return false;
  }
  writeFileSync(path, after, "utf8");

  return true;
}

const changed = [
  ...(format(join(catalogueDir, "manifest.json"), parseManifest) ? [join(catalogueDir, "manifest.json")] : []),
  ...jsonFiles(join(catalogueDir, "crosswalks")).filter((path) => format(path, parseCrosswalk)),
  ...jsonFiles(join(catalogueDir, "entries")).filter((path) => format(path, parseEntry)),
];
console.log(`Rewrote ${String(changed.length)} catalogue files${changed.length > 0 ? `, the first ${relative(repoRoot, changed[0] ?? "")}` : ""}`);
