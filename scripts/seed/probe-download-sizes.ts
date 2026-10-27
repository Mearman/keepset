/* Records the size of each download an entry's recipe fetches whole, as the host serving it reports it.

   pnpm exec tsx scripts/seed/probe-download-sizes.ts

   The URLs are those downloadedUrls names for each entry: a paged query has none, and an entry with no recipe offers only a graph's first source. A URL whose source pins a snapshot that records its byte length needs no request, since that length is the size, and one whose source pins a snapshot with no recorded length is asked for at the snapshot first, which a fetch resolves first, and at the URL itself where the snapshot states none, its size recorded under the source's own URL. Each is requested through the polite client, paced per host, first with a HEAD request, then, where that gives no size, with a request for the first byte, whose Content-Range states the whole size, and last, for a host that states no length at all, by reading the whole body and counting its bytes. The sizes are written to scripts/seed/sources/download-sizes.json, which the import reads and `seed:check` verifies the entries against. A size already recorded is kept and the host not asked again, so a host that answers wrongly in one run (a throttle page with a short length) cannot overwrite a good figure; to re-read one, delete its line from the committed file. A URL no host gives a size for is left out and named, so the script can be run again. */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEntry, rawSnapshotUrl } from "../../src/entry";
import { canonicalJson } from "../../src/serialise";
import { systemClock } from "../sources/pacing";
import { DEFAULT_POLITENESS, PoliteClient, RequestFailure } from "../sources/polite-client";
import { WAYBACK_HOST_INTERVALS } from "../sources/wayback";
import { countedSize, downloadedUrls, DownloadSizesSchema, statedSize } from "./download-sizes";

/** The length of the `YYYY-MM-DD` prefix of an ISO 8601 timestamp. */
const ISO_DATE_LENGTH = "YYYY-MM-DD".length;
const here = dirname(fileURLToPath(import.meta.url));
const sizesPath = join(here, "sources", "download-sizes.json");
const entriesDir = join(here, "..", "..", "catalogue", "entries");

/** The URLs to ask for each download's size, by the download's own URL, in order: the pinned snapshot's raw form where its source pins one that records no length, then the download itself; a download whose snapshot records its length is not asked for. */
const wanted = new Map(
  readdirSync(entriesDir)
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => {
      const entry = parseEntry(JSON.parse(readFileSync(join(entriesDir, file), "utf8")));

      return downloadedUrls(entry).flatMap((url): [string, readonly string[]][] => {
        const snapshot = entry.sources.find((source) => source.url === url)?.snapshot;

        return snapshot?.byteLength !== undefined ? [] : [[url, snapshot === undefined ? [url] : [rawSnapshotUrl(snapshot.timestamp, url), url]]];
      });
    })
    .sort(([left], [right]) => left.localeCompare(right)),
);

const known = existsSync(sizesPath) ? DownloadSizesSchema.parse(JSON.parse(readFileSync(sizesPath, "utf8"))).sizes : {};
/** How many times the polite client's allowance for one request a whole body is given: a header answers at once, but a body is read to its end and a host that streams an export without a length can take several times the allowance. */
const BODY_ALLOWANCE_FACTOR = 10;
const politeness = { ...DEFAULT_POLITENESS, hostIntervalOverrides: WAYBACK_HOST_INTERVALS };
const client = new PoliteClient(fetch, systemClock, politeness);
const bodyClient = new PoliteClient(fetch, systemClock, { ...politeness, timeoutMilliseconds: politeness.timeoutMilliseconds * BODY_ALLOWANCE_FACTOR });

/**
 * Sends a request and keeps only what it states.
 * @param url - The download's URL.
 * @param init - The request options.
 * @returns The size the response states, or undefined when the host failed or stated none.
 */
async function ask(url: string, init: RequestInit): Promise<number | undefined> {
  try {
    const response = await client.request(url, init);
    await response.body?.cancel();

    return statedSize(response);
  } catch (error) {
    if (error instanceof RequestFailure) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Reads a download to its end and counts the bytes, for a host that states no size.
 * @param url - The download's URL.
 * @returns The bytes received, or undefined when the host failed or sent nothing.
 */
async function count(url: string): Promise<number | undefined> {
  try {
    const response = await bodyClient.request(url, {});

    return response.ok ? await countedSize(response.body) : undefined;
  } catch (error) {
    if (error instanceof RequestFailure || (error instanceof DOMException && error.name === "TimeoutError")) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The first size any of the URLs states, asking each with a HEAD request and then a request for the first byte.
 * @param urls - The URLs to ask, in order.
 * @returns The size in bytes, or undefined when none states one.
 */
async function stated(urls: readonly string[]): Promise<number | undefined> {
  const [url, ...rest] = urls;
  if (url === undefined) {
    return undefined;
  }

  return (await ask(url, { method: "HEAD" })) ?? (await ask(url, { headers: { range: "bytes=0-0" } })) ?? (await stated(rest));
}

const sizes: Record<string, number> = {};
const unmeasured: string[] = [];
/**
 * Measures the remaining downloads one after another, the client pacing them.
 * @param remaining - Each download's own URL with the URLs to ask for its size, in order, for those not yet measured.
 */
async function measure(remaining: readonly (readonly [string, readonly string[]])[]): Promise<void> {
  const [next, ...rest] = remaining;
  if (next === undefined) {
    return;
  }
  const [url, asked] = next;
  const size = known[url] ?? (await stated(asked)) ?? (await count(url));
  if (size === undefined) {
    unmeasured.push(url);
  } else {
    sizes[url] = size;
  }

  return measure(rest);
}
await measure([...wanted]);

const today = new Date(systemClock.now()).toISOString().slice(0, ISO_DATE_LENGTH);
writeFileSync(sizesPath, canonicalJson(DownloadSizesSchema.parse({ readOn: today, sizes })));
console.log(`${String(Object.keys(sizes).length)} of ${String(wanted.size)} downloads have a size; none stated for:\n${unmeasured.join("\n")}`);
