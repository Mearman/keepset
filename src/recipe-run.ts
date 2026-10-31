import { type Entry, rawSnapshotUrl, type Source } from "./entry";
import { KeepsetError, RecipeError, type RecipeStep } from "./errors";
import type { JsonScalar } from "./targets/json-scalar";
import type { UnpackOptions } from "./archive";
import type { Download, FetchOptions } from "./fetch";
import type { StoredSource } from "./source-bytes";

/**
 * The URL a recipe downloads a source from, as `downloadUrl` gives it. A dead source is fetched from its pinned snapshot in the Wayback Machine's `id_` form, which serves the archived bytes as they were captured rather than wrapped in the archive's page chrome.
 * @param source - The source.
 * @returns The URL to request.
 */
export function sourceUrl(source: Source): string {
  if (source.status === "dead") {
    if (source.snapshot === undefined) {
      // The entry schema requires a snapshot on every dead source, so a parsed entry never reaches this.
      throw new KeepsetError(`dead source ${source.url} has no snapshot`);
    }

    return rawSnapshotUrl(source.snapshot.timestamp, source.url);
  }

  return source.url;
}

/**
 * The source record a provenance carries: the entry's source as recorded.
 * @param source - The source.
 * @returns Its URL, status and any snapshot.
 */
export function sourceRecord(source: Source): Download["source"] {
  return { url: source.url, status: source.status, ...(source.snapshot === undefined ? {} : { snapshot: source.snapshot }) };
}

/**
 * The record of one download: the source, the URL requested and a hash of exactly the bytes that arrived. Read once the source has been read, as a source read by ranges goes on arriving while it is read.
 * @param source - The entry's source.
 * @param fetchedUrl - The URL requested.
 * @param stored - What the store kept.
 * @returns The download record.
 */
export async function downloadOf(source: Source, fetchedUrl: string, stored: Pick<StoredSource, "received">): Promise<Download> {
  const { sha256, byteLength, ranges, size } = await stored.received();

  return { source: sourceRecord(source), fetchedUrl, sha256, byteLength, ...(ranges === undefined ? {} : { ranges }), ...(size === undefined ? {} : { size }) };
}

/**
 * Runs one step, rethrowing any failure as a RecipeError naming the entry and the step, with the original error as its cause.
 * @param entryId - The entry.
 * @param name - The step.
 * @param run - The step's work.
 * @returns What the step returns.
 */
export async function step<Result>(entryId: string, name: RecipeStep, run: () => Result | Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RecipeError) {
      throw error;
    }
    throw new RecipeError(entryId, name, error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/**
 * The metadata a fetched result starts from: the entry's id and name, then its recorded properties. The entry schema keeps `id` and `name` out of the properties, so neither can be overwritten.
 * @param entry - The entry.
 * @returns The meta record the crosswalk receives.
 */
export function metaOf(entry: Entry): Record<string, JsonScalar> {
  return { id: entry.id, name: entry.name, ...entry.properties };
}

/**
 * The warnings for counts that differ from the ones an entry records: one for each recorded count the resolved result does not have, whether it has another value or none.
 * @param entry - The entry.
 * @param counts - The resolved result's counts by key.
 * @returns One warning for each recorded count that differs, in the order the entry records them.
 */
export function countWarnings(entry: Entry, counts: ReadonlyMap<string, number>): readonly string[] {
  return Object.entries(entry.expectedCounts)
    .filter(([key, expected]) => counts.get(key) !== expected)
    .map(([key, expected]) => `${key}: the entry records ${String(expected)}, the fetched result has ${String(counts.get(key))}`);
}

/**
 * What the archive readers are given of a fetch's options: its 7z reader, its xz decoder and its abort signal.
 * @param options - The fetch's options.
 * @returns The options unpacking takes.
 */
export function unpackOptionsOf(options: Readonly<FetchOptions>): UnpackOptions {
  return { ...(options.sevenZip === undefined ? {} : { sevenZip: options.sevenZip }), ...(options.xz === undefined ? {} : { xz: options.xz }), ...(options.signal === undefined ? {} : { signal: options.signal }) };
}
