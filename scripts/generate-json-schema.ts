/* Generates schemas/entry.schema.json and schemas/manifest.schema.json from the package's own Zod schemas via z.toJSONSchema() (https://zod.dev/json-schema). Run as part of `pnpm build` after tsdown (see package.json's build script), so schemas/ is always fresh for a real publish.

   Imports from the freshly built ../dist/index.js, so each schema describes exactly what the published dist validates. This script is therefore a member of tsconfig.node.json's program rather than the runtime src/ one.

   Each schema is one self-contained 2020-12 document: its root is a $ref to its own entry under $defs, and every shared schema the root reaches sits beside it under $defs. zod's registry conversion returns a bag of separately addressable documents whose cross-references are bare id strings, which do not resolve inside one document; the `uri` callback redirects each to an in-document fragment ("#/$defs/<id>"). "__shared" is the fixed key zod uses for schemas reused across registered roots, and mapping it to the empty string keeps its already-correct internal fragments intact.

   The entry's inline crosswalk is crossmap's own CrosswalkSchema, registered under the id "Crosswalk" so the conversion references it by fragment, and $defs.Crosswalk is then overwritten with an external $ref to crossmap's published schema at the installed crossmap version: an embedded copy could drift from the published crosswalk format with no signal. A $defs entry that is itself an external $ref is valid 2020-12.

   Written in RFC 8785 canonical form with no trailing newline, so each file's bytes are exactly canonicalize(JSON.parse(file)).

   No try/catch anywhere: any failure (a Zod throw, a filesystem error) crashes the script loudly with a non-zero exit. */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { CrosswalkSchema } from "crossmap";
import { z } from "zod";
import { EntrySchema, ManifestSchema } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const schemasDir = join(repoRoot, "schemas");

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the string `version` of a package.json.
 * @param path - The package.json path.
 * @returns The version.
 */
function readVersion(path: string): string {
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPlainRecord(manifest)) {
    throw new Error(`expected ${path} to parse to a JSON object`);
  }
  const version = manifest["version"];
  if (typeof version !== "string") {
    throw new Error(`expected ${path} to have a string "version"`);
  }

  return version;
}

/**
 * The subset of `defs` reachable from `rootId` through in-document `#/$defs/<id>` references.
 * @param defs - Every candidate definition, by id.
 * @param rootId - The id the document's root refers to.
 * @returns The reachable definitions, by id.
 */
function reachableDefs(defs: Readonly<Record<string, z.core.JSONSchema.JSONSchema>>, rootId: string): Record<string, z.core.JSONSchema.JSONSchema> {
  const reachable: Record<string, z.core.JSONSchema.JSONSchema> = {};
  const pending = [rootId];
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (Object.hasOwn(reachable, id)) {
      continue;
    }
    const def = Object.hasOwn(defs, id) ? defs[id] : undefined;
    if (def === undefined) {
      throw new Error(`#/$defs/${id} is referenced but no definition has that id.`);
    }
    Object.defineProperty(reachable, id, { value: def, enumerable: true, writable: true, configurable: true });
    for (const match of JSON.stringify(def).matchAll(/"#\/\$defs\/([^"]+)"/g)) {
      if (match[1] !== undefined) {
        pending.push(match[1]);
      }
    }
  }

  return reachable;
}

const packageVersion = readVersion(join(repoRoot, "package.json"));
// The crossmap version of the actual install (an exact pin in package.json), so the external $ref names precisely the crosswalk schema this build validated against. Read as a file: crossmap's exports map does not expose its package.json.
const crossmapVersion = readVersion(join(repoRoot, "node_modules/crossmap/package.json"));

/** The documents this script writes: the published file name and the registry id of its root schema. */
const documents = [
  { file: "entry.schema.json", id: "Entry", schema: EntrySchema },
  { file: "manifest.schema.json", id: "Manifest", schema: ManifestSchema },
] as const;

mkdirSync(schemasDir, { recursive: true });

for (const document of documents) {
  const registry = z.registry<z.core.JSONSchemaMeta>();
  registry.add(document.schema, { id: document.id });
  registry.add(CrosswalkSchema, { id: "Crosswalk" });

  const { schemas } = z.toJSONSchema(registry, {
    // The documents are what the schemas describe, so the shape they are written in (a crosswalk's `keep` list, a field with a default left out) is the one a schema states, not the shape parsing turns them into.
    io: "input",
    uri: (id) => (id === "__shared" ? "" : `#/$defs/${id}`),
  });

  // The registry overload types `schemas` as a plain record, so each lookup widens to `T | undefined` even though the id was registered just above: fail loudly rather than let an undefined entry reach the output.
  const rootEntry = schemas[document.id];
  if (rootEntry === undefined) {
    throw new Error(`z.toJSONSchema produced no ${document.id} entry for the registered schema.`);
  }

  // Each registry entry comes back as its own standalone resource, with $schema and an $id equal to its own fragment-only ref; both are meaningless once nested under $defs, so both are stripped.
  const rootDef: z.core.JSONSchema.JSONSchema = { ...rootEntry };
  delete rootDef.$schema;
  delete rootDef.$id;

  // The crosswalk's own conversion (crossmap's rules and trilean's recursive predicate and JSON value schemas) lands in the shared $defs, but once $defs.Crosswalk is an external $ref nothing in this document points at it, so only the shared definitions the root actually reaches are kept.
  const sharedDefs = schemas["__shared"]?.$defs ?? {};
  const defs: Record<string, z.core.JSONSchema.JSONSchema> = {
    [document.id]: rootDef,
    Crosswalk: { $ref: `https://cdn.jsdelivr.net/npm/crossmap@${crossmapVersion}/schemas/crossmap.schema.json` },
    ...sharedDefs,
  };

  const combined: z.core.JSONSchema.JSONSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    // Version-pinned, never "latest": jsDelivr serves files straight out of a published npm package by version, so this identifies the exact schema shipped in this published version.
    $id: `https://cdn.jsdelivr.net/npm/keepset@${packageVersion}/schemas/${document.file}`,
    $defs: reachableDefs(defs, document.id),
    $ref: `#/$defs/${document.id}`,
  };

  const canonicalJson = canonicalize(combined);
  if (canonicalJson === undefined) {
    throw new Error(`canonicalize() produced no output for ${document.file}.`);
  }

  const outputPath = join(schemasDir, document.file);
  writeFileSync(outputPath, canonicalJson, "utf8");
  console.log(`Wrote ${outputPath}`);
}
