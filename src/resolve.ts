/* The fetch-side resolution of a source: where its bytes come from when the live URL is not the only place they live. A pinned snapshot comes first, because the recipe was written against those bytes, then the closest capture the Wayback Machine's availability API names when the source has no pin or its pin is unusable, and the live URL last. When the live URL is what a fetch read, the provenance says so, and `captureRequestFor` names the Save Page Now request that would leave the next fetcher a snapshot; making that request is the entry point's to do after the fetch, so a capture never delays a result. Everything outside is a port, so the platform-neutral core runs this unchanged in Node and in a browser. */

import { KeepsetError, UnreachableSourceError } from "./errors";
import { rawSnapshotUrl, type Source } from "./entry";
import type { Download, FetchPort, Provenance } from "./fetch";

/** The availability API, which answers with the closest capture of a URL as JSON and, unlike the replay endpoints, sends CORS headers, so a browser can ask it. */
const AVAILABILITY_URL = "https://archive.org/wayback/available";

/** Save Page Now's endpoint: a request for `<this><url>` asks the Archive to capture the URL. */
const SAVE_URL = "https://web.archive.org/save/";

/** The status the availability API reports for a capture whose page answered successfully, the only kind worth reading. */
const CAPTURED_OK = "200";

/** Where a resolved source's bytes came from, in the order the chain tries them. */
export type Tier = "pinned snapshot" | "closest snapshot" | "live source";

/** What the chain resolved: the bytes, the URL they were requested from and the tier that gave them. */
export interface Resolved {
  readonly bytes: Uint8Array;
  readonly url: string;
  readonly tier: Tier;
}

/** What the chain needs from outside: the network port and an abort signal. */
export interface ResolveOptions {
  readonly port: FetchPort;
  readonly signal?: AbortSignal;
}

/** The first and second byte of gzip data. */
const GZIP_FIRST_BYTE = 0x1f;
const GZIP_SECOND_BYTE = 0x8b;

/** The extensions of URLs that name a compressed file or archive, whose bytes are the file itself even when the server labels them `Content-Encoding: gzip`: a recipe unpacks them with its archive kind. */
const COMPRESSED_FILE_EXTENSIONS: ReadonlySet<string> = new Set(["gz", "tgz", "bz2", "tbz2", "zip", "xz", "zst", "7z"]);

/**
 * Whether a response's bytes are a gzip transport encoding of the page and not a compressed file: the server labels them `Content-Encoding: gzip`, they are gzip data, and the URL does not name a compressed file. A browser's platform `fetch` has undone the encoding by then, so its bytes are not gzip data and are left alone; the Node downloader hands the encoding over as served, and the Wayback Machine replays a capture gzip-encoded or plain as its cache stands, so the decoded page is the one form a pinned hash can name.
 * @param url - The URL requested.
 * @param response - The server's answer.
 * @param bytes - The body.
 * @returns True when the body is to be gunzipped.
 */
function isTransportGzip(url: string, response: Response, bytes: Uint8Array): boolean {
  const extension = new URL(url).pathname.split(".").at(-1)?.toLowerCase() ?? "";

  return response.headers.get("content-encoding")?.toLowerCase() === "gzip" && bytes[0] === GZIP_FIRST_BYTE && bytes[1] === GZIP_SECOND_BYTE && !COMPRESSED_FILE_EXTENSIONS.has(extension);
}

/** The warning the Wayback Machine replays with a capture that stopped at its size limit (`299 wayback content truncated by "length"`): such a capture holds a prefix of the file and not the file. */
const TRUNCATED_CAPTURE_WARNING = /\btruncated\b/i;

/**
 * Requests one URL's bytes through the port, with a gzip transport encoding undone.
 * @param port - The network port.
 * @param url - The URL.
 * @param signal - Aborts the request.
 * @returns The bytes.
 * @throws KeepsetError when the server does not answer successfully, or says the bytes are a truncated capture.
 * @throws TypeError when a gzip transport encoding is not valid gzip data.
 */
async function bytesOf(port: FetchPort, url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const response = await port(url, signal === undefined ? {} : { signal });
  if (!response.ok) {
    throw new KeepsetError(`${url} answered ${String(response.status)} ${response.statusText}`);
  }
  // A truncated capture is a prefix of the file, so reading it would hand a recipe a file that ends partway through a record; the chain moves on to the next tier instead.
  if (TRUNCATED_CAPTURE_WARNING.test(response.headers.get("warning") ?? "")) {
    throw new KeepsetError(`${url} is a truncated capture`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  return isTransportGzip(url, response, bytes) ? new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()) : bytes;
}

/**
 * The timestamp of the closest successful capture the availability API holds of a URL.
 * @param port - The network port.
 * @param url - The source URL.
 * @param signal - Aborts the request.
 * @returns The capture's timestamp, or undefined when the Archive holds none or its answer is not one this reads.
 */
async function closestCapture(port: FetchPort, url: string, signal: AbortSignal | undefined): Promise<string | undefined> {
  const response = await port(`${AVAILABILITY_URL}?${new URLSearchParams({ url }).toString()}`, signal === undefined ? {} : { signal });
  if (!response.ok) {
    return undefined;
  }
  const answer: unknown = await response.json();
  if (typeof answer !== "object" || answer === null || !("archived_snapshots" in answer)) {
    return undefined;
  }
  const { archived_snapshots: snapshots } = answer;
  if (typeof snapshots !== "object" || snapshots === null || !("closest" in snapshots)) {
    return undefined;
  }
  const { closest } = snapshots;
  if (typeof closest !== "object" || closest === null || !("available" in closest) || !("status" in closest) || !("timestamp" in closest)) {
    return undefined;
  }

  return closest.available === true && closest.status === CAPTURED_OK && typeof closest.timestamp === "string" ? closest.timestamp : undefined;
}

/**
 * Resolves a source's bytes through the chain: its pinned snapshot, the closest capture the Archive names, then (for a live source) the live URL.
 * @param source - The entry's source.
 * @param options - The network port and the abort signal.
 * @returns The bytes with the URL and tier they came from.
 * @throws UnreachableSourceError when every tier that was tried failed without an HTTP answer, and KeepsetError otherwise, either naming every tier that was tried and why it gave nothing, when none gave the bytes; the abort's own reason when the signal aborts.
 */
export async function resolveSource(source: Source, options: Readonly<ResolveOptions>): Promise<Resolved> {
  const { port, signal } = options;
  const failures: string[] = [];
  // A tier that failed with a TypeError never got an HTTP answer; any other failure is a host that answered with an error.
  const outcome = { answered: false };
  const fail = (tier: Tier, error: unknown): void => {
    outcome.answered ||= !(error instanceof TypeError);
    failures.push(`${tier}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const tryUrl = async (url: string, tier: Tier): Promise<Resolved | undefined> => {
    try {
      return { bytes: await bytesOf(port, url, signal), url, tier };
    } catch (error) {
      if (signal?.aborted === true) {
        throw error;
      }
      fail(tier, error);

      return undefined;
    }
  };

  if (source.snapshot !== undefined) {
    const pinned = await tryUrl(rawSnapshotUrl(source.snapshot.timestamp, source.url), "pinned snapshot");
    if (pinned !== undefined) {
      return pinned;
    }
  }
  let closest: string | undefined;
  try {
    closest = await closestCapture(port, source.url, signal);
  } catch (error) {
    if (signal?.aborted === true) {
      throw error;
    }
    fail("closest snapshot", error);
  }
  if (closest !== undefined && closest !== source.snapshot?.timestamp) {
    const captured = await tryUrl(rawSnapshotUrl(closest, source.url), "closest snapshot");
    if (captured !== undefined) {
      return captured;
    }
  }
  if (source.status === "live") {
    const live = await tryUrl(source.url, "live source");
    if (live !== undefined) {
      return live;
    }
  }

  const message = `${source.url} could not be read from any source: ${failures.length === 0 ? "no snapshot is pinned or captured, and the source is dead" : failures.join("; ")}`;
  throw failures.length > 0 && !outcome.answered ? new UnreachableSourceError(message) : new KeepsetError(message);
}

/**
 * The Save Page Now request that would capture a source a fetch read live, so the next fetcher starts from the Archive: named only when the URL the bytes came from is the live source's own, which means the pinned snapshot and the Archive's closest capture gave nothing.
 * @param download - What a fetch recorded of one download: the entry's source and the URL requested.
 * @returns The capture request's URL, or undefined when the bytes came from a snapshot or the source is dead.
 */
export function captureRequestFor(download: Pick<Download, "source" | "fetchedUrl">): string | undefined {
  return download.source.status === "live" && download.fetchedUrl === download.source.url ? `${SAVE_URL}${download.source.url}` : undefined;
}

/**
 * The capture requests a whole fetch leaves to make: one per download the fetch read live, in the order they were read, each named once.
 * @param provenance - What the fetch recorded.
 * @returns The capture requests' URLs, none when every download came from a snapshot.
 */
export function captureRequestsFor(provenance: Provenance): readonly string[] {
  const downloads = "files" in provenance ? provenance.files : [provenance];

  return [...new Set(downloads.flatMap((download) => captureRequestFor(download) ?? []))];
}

/** How long a capture request is held open before the client lets go of it: Save Page Now goes on capturing after the client disconnects (a request dropped after four seconds still left a capture, checked live), so a fetch never waits for the capture itself. */
export const CAPTURE_HAND_OFF_MILLISECONDS = 5000;

/**
 * Asks the Archive to capture a URL by sending a Save Page Now request and letting go of it after `CAPTURE_HAND_OFF_MILLISECONDS`, which is how the request is made, not a failure.
 * @param saveUrl - A request URL from `captureRequestFor`.
 * @param send - The network port; a browser's sends it without reading the answer.
 * @param signal - Aborts the request.
 * @throws The network failure when the request cannot be sent at all; the abort's own reason when the signal aborts.
 */
export async function requestCapture(saveUrl: string, send: FetchPort, signal?: AbortSignal): Promise<void> {
  const handOff = new AbortController();
  const timer = setTimeout(() => {
    handOff.abort();
  }, CAPTURE_HAND_OFF_MILLISECONDS);
  const abort = (): void => {
    handOff.abort(signal?.reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    await send(saveUrl, { signal: handOff.signal });
  } catch (error) {
    if (signal?.aborted === true) {
      throw signal.reason;
    }
    if (!handOff.signal.aborted) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
