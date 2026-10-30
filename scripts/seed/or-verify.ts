/* Runs each fetchable item of a curation on a real sample of its download, through the same fetch flow `keepset fetch` uses: the first part of the file is downloaded, cut back to whole rows, parsed with the recipe's parser, mapped by the crosswalk and validated against tasks/v1. It needs the network and is a curator's check, not part of CI: the committed import is checked offline by `seed:check`.

   pnpm exec tsx scripts/seed/or-verify.ts <curation.json> [or-1,or-7] [--whole]

   With `--whole` the flow runs on the entire download instead of a sample (a paged source and anything in an archive are always read whole), which is the only way to meet a fault that lies further into the file than the sample (an id that repeats or is empty, a malformed row, a table too large to hold in memory) or a source that returns only part of a table; each line then also gives the row count the curation recorded. A whole run downloads every table, so it is slow and is best given a list of items. A streamed recipe is read through streamEntry and its nodes are tallied as they arrive, never held.

   Per item it prints the rows read and, for each mapped field, how many of them have a value, with the range of a number field, so a mapping that picked the wrong column shows as an empty or implausible field, then the most rows held at once (every row for a held fetch, the largest page for a streamed one) and the peak heap and resident memory sampled as the fetch ran. A download that is not a plain table (an archive, a page, an error) fails with the reason. */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCrosswalk } from "crossmap";
import { createCatalogue } from "../../src/catalogue";
import { fetchEntry, streamEntry, type StreamedNode } from "../../src/node/fetch-dataset";
import { convertItem } from "./convert-or";
import { CurationSchema, SurveySourceSchema, TARGET_FIELD_NAMES, type CurationItem } from "./or-survey";

const KIBIBYTE = 1024;
/** How many kibibytes of a download are read: enough rows to see the columns' values, little enough to be quick. */
const SAMPLE_KIBIBYTES = 256;
const SAMPLE_BYTES = SAMPLE_KIBIBYTES * KIBIBYTE;
/** How many lines back from the end of the sample a cut may retreat to land outside a quoted field. */
const MAX_CUTS = 40;
const LINE_FEED = "\n".charCodeAt(0);
/** The longest message or value printed. */
const PRINT_WIDTH = 300;
const VALUE_WIDTH = 30;

const here = dirname(fileURLToPath(import.meta.url));
const whole = process.argv.includes("--whole");
const [path, only] = process.argv.slice(2).filter((argument) => argument !== "--whole");
if (path === undefined) {
  throw new Error("usage: or-verify <curation.json> [or-1,or-7] [--whole]");
}
const wanted = only === undefined ? undefined : new Set(only.split(","));
const survey = SurveySourceSchema.parse(JSON.parse(readFileSync(join(here, "sources/or-datasets-survey.json"), "utf8")));
const curation = CurationSchema.parse(JSON.parse(readFileSync(path, "utf8")));
const nodesCrosswalk = parseCrosswalk(JSON.parse(readFileSync(join(here, "../../catalogue/crosswalks/tasks-v1/nodes.json"), "utf8")));
const manifest = { id: "or-verify", name: "or verify", description: "A throwaway catalogue for checking one entry.", version: "0.0.0", repository: "https://github.com/Mearman/keepset" };

/** A stream reader, as far as this tool uses one. */
interface ChunkReader {
  readonly read: () => Promise<{ readonly done: boolean; readonly value?: Uint8Array }>;
}

function isChunkReader(value: unknown): value is ChunkReader {
  return typeof value === "object" && value !== null && "read" in value && typeof value.read === "function";
}

/**
 * Reads chunks from a stream until it ends or holds enough bytes.
 * @param reader - The stream reader.
 * @param chunks - The chunks read so far.
 * @param held - The bytes in them.
 * @returns Every chunk read.
 */
async function collect(reader: ChunkReader, chunks: readonly Uint8Array[], held: number): Promise<readonly Uint8Array[]> {
  if (held >= SAMPLE_BYTES) {
    return chunks;
  }
  const { done, value } = await reader.read();
  if (done || value === undefined) {
    return chunks;
  }

  return collect(reader, [...chunks, value], held + value.length);
}

/**
 * The first part of a download.
 * @param url - The download.
 * @returns At most `SAMPLE_BYTES` of its start.
 * @throws Error when the download does not answer successfully.
 */
async function startOf(url: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const response = await fetch(url, { headers: { Range: `bytes=0-${String(SAMPLE_BYTES - 1)}`, "User-Agent": "keepset-seed-verify" }, redirect: "follow", signal: controller.signal });
  if (!response.ok) {
    throw new Error(`${url} answered ${String(response.status)}`);
  }
  const reader: unknown = response.body?.getReader();
  const chunks = isChunkReader(reader) ? await collect(reader, [], 0) : [];
  controller.abort();
  const bytes = new Uint8Array(Math.min(chunks.reduce((sum, chunk) => sum + chunk.length, 0), SAMPLE_BYTES));
  let offset = 0;
  for (const chunk of chunks) {
    const take = Math.min(chunk.length, bytes.length - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
  }

  return bytes;
}

/**
 * Cuts a sample back to whole lines, `back` lines further than its last complete one.
 * @param bytes - The sample.
 * @param back - How many more lines to drop.
 * @returns The cut sample.
 */
function cutBack(bytes: Uint8Array, back: number): Uint8Array {
  let end = bytes.length;
  for (let cut = 0; cut <= back; cut += 1) {
    const last = bytes.subarray(0, end).lastIndexOf(LINE_FEED);
    if (last === -1) {
      return bytes.subarray(0, end);
    }
    end = cut === back ? last + 1 : last;
  }

  return bytes.subarray(0, end);
}

/** What the values of each mapped field are, tallied a page at a time so a streamed table is described without being held: how many nodes have a value, the range of the numbers, and the first value seen. */
class FieldTally {
  private readonly counts = new Map<string, number>();

  private readonly least = new Map<string, number>();

  private readonly most = new Map<string, number>();

  private readonly first = new Map<string, unknown>();

  public constructor(private readonly fields: readonly string[]) {}

  /**
   * Tallies nodes.
   * @param nodes - Nodes of the result.
   */
  public add(nodes: readonly StreamedNode[]): void {
    for (const node of nodes) {
      for (const field of this.fields) {
        const value: unknown = Object.entries(node).find(([key]) => key === field)?.[1];
        if (value !== null && value !== undefined) {
          this.counts.set(field, (this.counts.get(field) ?? 0) + 1);
          if (!this.first.has(field)) {
            this.first.set(field, value);
          }
          if (typeof value === "number") {
            this.least.set(field, Math.min(this.least.get(field) ?? value, value));
            this.most.set(field, Math.max(this.most.get(field) ?? value, value));
          }
        }
      }
    }
  }

  /** @returns Each field's count, with its numbers' range or an example value. */
  public describe(): string {
    return this.fields
      .map((field) => {
        const least = this.least.get(field);
        const most = this.most.get(field);
        const range = least !== undefined && most !== undefined ? ` [${String(least)}..${String(most)}]` : this.first.has(field) ? ` e.g. ${JSON.stringify(this.first.get(field)).slice(0, VALUE_WIDTH)}` : "";

        return `${field} ${String(this.counts.get(field) ?? 0)}${range}`;
      })
      .join("; ");
  }
}

const MEBIBYTE = KIBIBYTE * KIBIBYTE;

/** The most heap and resident memory the process used at the moments it was sampled. */
class MemoryPeak {
  private heap = 0;

  private resident = 0;

  /** Samples the process's memory now. */
  public sample(): void {
    const usage = process.memoryUsage();
    this.heap = Math.max(this.heap, usage.heapUsed + usage.arrayBuffers);
    this.resident = Math.max(this.resident, usage.rss);
  }

  /** @returns The peaks, in mebibytes. */
  public describe(): string {
    return `peak heap ${String(Math.round(this.heap / MEBIBYTE))} MiB, peak resident ${String(Math.round(this.resident / MEBIBYTE))} MiB`;
  }
}

/**
 * Runs one fetchable item on the start of its download through the real flow, retreating the cut when it lands inside a quoted field.
 * @param curated - The curation item.
 * @returns A line saying how many rows were read and what each mapped field holds.
 * @throws Error with the last failure when no cut parses.
 */
async function verifyOne(curated: CurationItem): Promise<string> {
  const item = survey.entries.find((candidate) => candidate.id === curated.surveyId);
  if (item === undefined || curated.outcome.status === "not-fetchable") {
    return "";
  }
  const { outcome } = curated;
  const { entry } = convertItem(item, curated, curation.probedOn);
  const dataset = createCatalogue({ manifest, crosswalks: { "crosswalks/tasks-v1/nodes.json": nodesCrosswalk }, entries: [entry] }).listDatasets()[0];
  if (dataset === undefined || entry.recipe.status !== "fetchable") {
    throw new Error("the entry did not build");
  }
  const { recipe } = entry;
  const entire = whole || "files" in recipe || recipe.paging !== undefined || recipe.archive.kind !== "none";
  const sample = entire || "files" in recipe ? new Uint8Array() : await startOf(entry.sources[recipe.source]?.url ?? "");
  const attempt = async (back: number): Promise<Awaited<ReturnType<typeof fetchEntry>>> => {
    try {
      return await fetchEntry(dataset, { fetch: async () => Promise.resolve(new Response(cutBack(sample, back))) });
    } catch (error) {
      if (back < MAX_CUTS && error instanceof Error && /never closed|fields, the header has/.test(error.message)) {
        return attempt(back + 1);
      }
      throw error;
    }
  };
  const fields = TARGET_FIELD_NAMES.filter((field) => outcome.map[field] !== undefined);
  const tally = new FieldTally(fields);
  const memory = new MemoryPeak();
  let held = 0;
  let shape: string;
  let warnings: readonly string[];
  if (!("files" in recipe) && recipe.stream === true) {
    const streamed = await streamEntry(dataset, {
      meta: () => undefined,
      nodes: (page) => {
        tally.add(page);
        held = Math.max(held, page.length);
        memory.sample();
      },
    });
    shape = `${String(streamed.counts.get("nodes"))} rows, streamed`;
    ({ warnings } = streamed);
  } else {
    const result = entire ? await fetchEntry(dataset) : await attempt(0);
    memory.sample();
    const instances = "instances" in result.data ? result.data.instances : [];
    const nodes = "nodes" in result.data ? result.data.nodes : instances.flatMap((instance) => [...instance.nodes]);
    tally.add(nodes);
    held = nodes.length;
    shape = "instances" in result.data ? `${String(instances.length)} instances, ${String(nodes.length)} nodes` : `${String(nodes.length)} rows`;
    ({ warnings } = result);
  }

  const recorded = entire && "rowCount" in outcome && outcome.rowCount !== undefined ? ` (the curation recorded ${String(outcome.rowCount)})` : "";
  const warned = warnings.length > 0 ? ` WARNING ${warnings.join("; ")}` : "";
  const fieldsText = tally.describe();
  const memoryText = `; rows held at most ${String(held)}; ${memory.describe()}`;

  return `${curated.surveyId} ${curated.id}: ${shape}${recorded}; ${fieldsText}${memoryText}${warned}`;
}

/**
 * Verifies the items one after another, printing each result as it arrives.
 * @param items - The curation items still to verify.
 * @returns How many failed.
 */
async function verifyAll(items: readonly CurationItem[]): Promise<number> {
  const [curated, ...rest] = items;
  if (curated === undefined) {
    return 0;
  }
  let failed = 0;
  if (curated.outcome.status !== "not-fetchable" && (wanted === undefined || wanted.has(curated.surveyId))) {
    try {
      console.log(await verifyOne(curated));
    } catch (error) {
      failed = 1;
      console.log(`${curated.surveyId} ${curated.id}: FAILED ${error instanceof Error ? error.message.slice(0, PRINT_WIDTH) : String(error)}`);
    }
  }

  return failed + (await verifyAll(rest));
}

process.exitCode = (await verifyAll(curation.items)) === 0 ? 0 : 1;
