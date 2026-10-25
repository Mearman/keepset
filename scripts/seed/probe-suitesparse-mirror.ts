/* Records which of the pipeline catalogue's SuiteSparse Matrix Market downloads each place that holds copies of them lists.

   pnpm exec tsx scripts/seed/probe-suitesparse-mirror.ts [--pipeline <catalog.json>] [--holder <inventory file>]...

   --pipeline defaults to the committed copy in scripts/seed/sources/. --holder limits the run to the named inventories (by file name), reading the committed inventories of the holders before them, whose files are not asked of the later ones, instead of probing them again; without it every holder is probed. The holders are the University of Florida mirror, whose copy of each `https://sparse.tamu.edu/MM/<group>/<name>.tar.gz` download in the pipeline catalogue is requested directly with a HEAD request through the polite client (paced per host), and the file host the collection's own links redirect to, which refuses requests but whose files the Wayback Machine captured, listed by one query of its capture index for the captures that answered 200. The paths found are written to the holder's inventory in scripts/seed/sources/, dated today; a path an earlier holder has is not asked of a later one, so each inventory lists the files only it offers. The capture index says a capture exists, not that the Machine serves it, which scripts/archive-sources.ts finds out when it pins the snapshot. A path the mirror answers 404 for is left out and reported; any other answer, or a request that fails, stops the run, since the inventory would otherwise silently shrink. */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { canonicalJson } from "../../src/serialise";
import { MIRROR_INVENTORIES, type SuiteSparseMirror, SuiteSparseMirrorSchema, suiteSparsePaths } from "./mirror";
import { SourceCatalogueSchema } from "./source";
import { HTTP_STATUS } from "../sources/http-status";
import { systemClock } from "../sources/pacing";
import { DEFAULT_POLITENESS, PoliteClient } from "../sources/polite-client";
import { WAYBACK_HOST_INTERVALS } from "../sources/wayback";

/** The length of the `YYYY-MM-DD` prefix of an ISO 8601 timestamp. */
const ISO_DATE_LENGTH = "YYYY-MM-DD".length;

/** What a holder says of the paths asked of it: those it lists, and each it does not with why. */
interface Found {
  readonly holds: readonly string[];
  readonly missing: readonly string[];
}

/** A place that holds copies of SuiteSparse files: its inventory's file and name, the host the files live under, and how it is asked which of some paths it holds. */
interface Holder {
  readonly file: string;
  readonly label: string;
  readonly host: string;
  readonly find: (wanted: readonly string[]) => Promise<Found>;
}

const sourcesDir = join(dirname(fileURLToPath(import.meta.url)), "sources");
const { values } = parseArgs({ options: { pipeline: { type: "string" }, holder: { type: "string", multiple: true } }, strict: true });
const catalogue = SourceCatalogueSchema.parse(JSON.parse(readFileSync(values.pipeline ?? join(sourcesDir, "pipeline-catalog.json"), "utf8")));
const client = new PoliteClient(fetch, systemClock, { ...DEFAULT_POLITENESS, hostIntervalOverrides: WAYBACK_HOST_INTERVALS });
const today = new Date(systemClock.now()).toISOString().slice(0, ISO_DATE_LENGTH);

const MIRROR_HOST = "https://www.cise.ufl.edu/research/sparse/";
const FILE_HOST = "http://sparse-files.engr.tamu.edu/";

/** The Wayback Machine's capture index, which answers a query for every capture under a prefix at once. */
const CAPTURE_INDEX = "https://web.archive.org/cdx/search/cdx";

/**
 * Asks the mirror for each remaining path with a HEAD request, one after another, the client pacing them.
 * @param remaining - The paths not yet asked.
 * @param found - What the mirror has answered so far.
 * @returns What the mirror holds and lacks.
 * @throws Error when it answers anything but 200 or 404.
 */
async function headEach(remaining: readonly string[], found: Found): Promise<Found> {
  const [path, ...rest] = remaining;
  if (path === undefined) {
    return found;
  }
  const { status } = await client.request(`${MIRROR_HOST}${path}`, { method: "HEAD" });
  if (status !== HTTP_STATUS.ok && status !== HTTP_STATUS.notFound) {
    throw new Error(`the mirror answered ${String(status)} for ${path}`);
  }

  return headEach(rest, status === HTTP_STATUS.ok ? { ...found, holds: [...found.holds, path] } : { ...found, missing: [...found.missing, `${path} ${String(status)}`] });
}

/**
 * Lists the paths the Wayback Machine holds a 200 capture of under the file host, by one query of its capture index.
 * @param wanted - The paths asked about.
 * @returns The wanted paths the index lists, and the rest as not captured.
 * @throws Error when the index does not answer 200 with a table of originals.
 */
async function captured(wanted: readonly string[]): Promise<Found> {
  const response = await client.request(`${CAPTURE_INDEX}?url=${encodeURIComponent(`${FILE_HOST.slice("http://".length)}MM/`)}&matchType=prefix&filter=statuscode:200&collapse=urlkey&fl=original&output=json`);
  if (response.status !== HTTP_STATUS.ok) {
    throw new Error(`the capture index answered ${String(response.status)}`);
  }
  const rows = z.array(z.tuple([z.string()])).parse(await response.json());
  const listed = new Set(rows.flatMap(([original]) => (original.startsWith(FILE_HOST) ? [original.slice(FILE_HOST.length)] : [])));

  return { holds: wanted.filter((path) => listed.has(path)), missing: wanted.filter((path) => !listed.has(path)).map((path) => `${path} not captured`) };
}

const HOLDERS: readonly Holder[] = [
  { file: "suitesparse-mirror.json", label: "the University of Florida mirror", host: MIRROR_HOST, find: async (wanted) => headEach(wanted, { holds: [], missing: [] }) },
  { file: "suitesparse-file-host.json", label: "the file host it redirects to, as the Wayback Machine captured it", host: FILE_HOST, find: captured },
];

/**
 * Probes each holder in turn for the paths the holders before it lack, writing its inventory; a holder not selected keeps its committed inventory, which is read in place of probing it.
 * @param holders - The holders still to probe.
 * @param wanted - The paths no earlier holder has.
 */
async function probeAll(holders: readonly Holder[], wanted: readonly string[]): Promise<void> {
  const [holder, ...later] = holders;
  if (holder === undefined) {
    return;
  }
  if (values.holder !== undefined && !values.holder.includes(holder.file)) {
    const { holds: committed } = SuiteSparseMirrorSchema.parse(JSON.parse(readFileSync(join(sourcesDir, holder.file), "utf8")));

    return probeAll(later, wanted.filter((path) => !committed.includes(path)));
  }
  const { holds, missing } = await holder.find(wanted);
  const inventory: SuiteSparseMirror = SuiteSparseMirrorSchema.parse({ label: holder.label, readOn: today, host: holder.host, holds: [...holds].sort() });
  writeFileSync(join(sourcesDir, holder.file), canonicalJson(inventory));
  console.log(`${String(holds.length)} of ${String(wanted.length)} downloads are held by ${holder.label}; not listed:\n${[...missing].sort().join("\n")}`);

  return probeAll(later, wanted.filter((path) => !holds.includes(path)));
}

if (HOLDERS.map(({ file }) => file).join() !== MIRROR_INVENTORIES.join()) {
  throw new Error("the holders probed are not the inventories the import reads, in the same order");
}
await probeAll(HOLDERS, suiteSparsePaths(catalogue));
