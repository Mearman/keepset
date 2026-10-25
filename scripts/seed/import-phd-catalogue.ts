/* The seed import: converts the thesis pipeline's graph dataset catalogue into keepset entries, giving graph/v1 its seed corpus.

   pnpm run seed:import:graph --pipeline <catalog.json> --graphbox <catalog.json> [--snapshot] [--check]

   --pipeline names the pipeline catalogue (a checkout's experiments/pipeline/graphs/catalog.json, or the committed copy in scripts/seed/sources/) and --graphbox the graphbox catalogue, read only for the report's overlap section. Both are read and never written: every path this script writes is inside this repository, and it refuses to run when an input directory contains the repository, so no output can land in a source checkout.

   It writes catalogue/entries/<id>.json for every dataset that converts and the report beside this script. An entry the previous report recorded as converted but this run does not produce is deleted, so a re-import of a later catalogue version is a plain diff; entries the import never wrote are left alone.

   --snapshot also refreshes the committed source copies in scripts/seed/sources/, with every file: URL's path withheld: a local path names a machine, not a public source, and the import drops such downloads whatever their path, so the copy converts to the same entries as the original.

   A SuiteSparse download the University of Florida mirror holds, or the file host the collection's links redirect to holds a Wayback Machine capture of (scripts/seed/sources/suitesparse-mirror.json and suitesparse-file-host.json, written by probe-suitesparse-mirror.ts), is listed as a source ahead of the collection's own link, the mirror's first, and the first listed is the one the recipe fetches. A SuiteSparse matrix the source catalogue gives no domain takes the kind the collection's index states for it as its domain, (scripts/seed/sources/suitesparse-index.json, written by probe-suitesparse-index.ts); a Netzschleuder network the source catalogue gives no domain takes the topic its first tag names (scripts/seed/sources/netzschleuder-index.json, written by probe-netzschleuder-index.ts). A dataset none of these gives a domain takes the one scripts/seed/sources/graph-domains.json curates for it. The size of the download a recipe fetches is recorded from scripts/seed/sources/download-sizes.json, written by probe-download-sizes.ts.

   Every entry's licence comes from scripts/seed/sources/graph-licences.json, which records for each publisher (and for each dataset whose terms differ) the page or file the licence was read from; the import fails when a dataset's source falls under no record, and when a record serves no dataset.

   --check writes nothing and exits non-zero when the committed entries or report differ from what the inputs produce. */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { canonicalJson } from "../../src/serialise";
import { convertCatalogue } from "./convert";
import { apply, entryWrites, reportedIds, staleEntries } from "./emit";
import { GraphLicencesSchema, graphLicenceResolver } from "./licence";
import { MIRROR_INVENTORIES, SuiteSparseMirrorSchema } from "./mirror";
import { DownloadSizesSchema } from "./download-sizes";
import { NetzschleuderIndexSchema } from "./netzschleuder-index";
import { GraphDomainsSchema } from "./source-facts";
import { SuiteSparseIndexSchema } from "./suitesparse-index";
import { GraphboxCatalogueSchema, SourceCatalogueSchema } from "./source";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = realpathSync(join(here, "../.."));
const entriesDir = join(repoRoot, "catalogue/entries");
const reportPath = join(here, "phd-graph-catalogue.report.json");
const sourcesDir = join(here, "sources");

const { values } = parseArgs({
  options: {
    pipeline: { type: "string" },
    graphbox: { type: "string" },
    snapshot: { type: "boolean" },
    check: { type: "boolean" },
  },
  strict: true,
});
if (values.pipeline === undefined || values.graphbox === undefined) {
  throw new Error("usage: import-phd-catalogue --pipeline <catalog.json> --graphbox <catalog.json> [--snapshot] [--check]");
}

/**
 * Resolves an input path, refusing one whose directory contains this repository.
 * @param path - The input file.
 * @returns Its real path.
 */
function inputPath(path: string): string {
  const real = realpathSync(path);
  const dir = dirname(real);
  if (repoRoot === dir || repoRoot.startsWith(`${dir}${sep}`)) {
    throw new Error(`${path} sits in a directory that contains this repository; the import reads its sources from outside the tree it writes`);
  }

  return real;
}

const pipelinePath = inputPath(values.pipeline);
const graphboxPath = inputPath(values.graphbox);
const pipelineText = readFileSync(pipelinePath, "utf8");
const graphboxText = readFileSync(graphboxPath, "utf8");
const pipeline = SourceCatalogueSchema.parse(JSON.parse(pipelineText));
const graphbox = GraphboxCatalogueSchema.parse(JSON.parse(graphboxText));
const licences = GraphLicencesSchema.parse(JSON.parse(readFileSync(join(sourcesDir, "graph-licences.json"), "utf8")));
const mirrors = MIRROR_INVENTORIES.map((file) => SuiteSparseMirrorSchema.parse(JSON.parse(readFileSync(join(sourcesDir, file), "utf8"))));
const facts = { suiteSparse: SuiteSparseIndexSchema.parse(JSON.parse(readFileSync(join(sourcesDir, "suitesparse-index.json"), "utf8"))), netzschleuder: NetzschleuderIndexSchema.parse(JSON.parse(readFileSync(join(sourcesDir, "netzschleuder-index.json"), "utf8"))) };
const { domains } = GraphDomainsSchema.parse(JSON.parse(readFileSync(join(sourcesDir, "graph-domains.json"), "utf8")));
const { entries, report } = convertCatalogue(pipeline, graphbox, { licences: graphLicenceResolver(licences), mirrors, facts, domains });

const writes = entryWrites(entries, entriesDir, DownloadSizesSchema.parse(JSON.parse(readFileSync(join(sourcesDir, "download-sizes.json"), "utf8"))));
writes.set(reportPath, canonicalJson(report));
if (values.snapshot === true) {
  const withheld = (text: string): string => `${JSON.stringify(JSON.parse(text, (_key, value: unknown) => (typeof value === "string" && value.startsWith("file:") ? "file:(local path withheld)" : value)), undefined, 2)}\n`;
  writes.set(join(sourcesDir, "pipeline-catalog.json"), withheld(pipelineText));
  writes.set(join(sourcesDir, "graphbox-catalog.json"), withheld(graphboxText));
}
const previous = existsSync(reportPath) ? reportedIds(readFileSync(reportPath, "utf8"), relative(repoRoot, reportPath), (outcome) => outcome["outcome"] !== "not-converted") : undefined;
const stale = staleEntries(entriesDir, previous, new Set(entries.map((entry) => entry.id)));

apply({ writes, stale }, repoRoot, values.check === true);
if (values.check === true) {
  console.log(`The committed import output matches: ${String(entries.length)} entries and the report.`);
} else {
  const counts = new Map<string, number>();
  for (const outcome of report.outcomes) {
    counts.set(outcome.outcome, (counts.get(outcome.outcome) ?? 0) + 1);
  }
  console.log(`Wrote ${String(entries.length)} entries and ${relative(repoRoot, reportPath)} (${[...counts].map(([outcome, count]) => `${outcome} ${String(count)}`).join(", ")}); removed ${String(stale.length)} stale entries.`);
}
