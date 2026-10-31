/* The browser entry point (`keepset/browser`): the platform-neutral fetch core with the platform's own downloader and an in-memory store preset. Everything else, the parsers, the archive readers, the crosswalk step and the catalogue, is shared with Node unchanged. */


import type { Dataset } from "../catalogue";
import { fetchDataset as fetchCore, fetchEntry as fetchEntryCore, type FetchOptions, roundTripEntry as roundTripEntryCore } from "../fetch";
import { requestCapture as requestCaptureCore } from "../resolve";
import { type DigestPort, memoryStore } from "../source-bytes";
import { downloadRaw } from "./download";


/** The radix of one byte's two hex characters, and their count. */
const HEX_RADIX = 16;
const HEX_DIGITS = 2;

/** The platform's SHA-256, which SubtleCrypto answers; a copy, so the hash reads an ArrayBuffer even when the bytes arrived as a view over a SharedArrayBuffer. SubtleCrypto hashes only bytes held whole, and a page has no filesystem to keep a download in, so the browser keeps every source in memory. */
const digest: DigestPort = async (bytes) => {
  const hashed = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));

  return [...new Uint8Array(hashed)].map((byte) => byte.toString(HEX_RADIX).padStart(HEX_DIGITS, "0")).join("");
};

export type { Download, DownloadProvenance, FetchedDataset, FetchOptions, FetchPort, FilesProvenance, Provenance, RoundTripReport } from "../fetch";
export type { ByteRange, DigestPort, KeepRequest, Received, SourceBytes, StoredSource, StorePort } from "../source-bytes";
export { downloadUrl } from "../fetch";
export { captureRequestsFor } from "../resolve";
export { RecipeError, UnreachableSourceError } from "../errors";
export { downloadRaw, type DownloadInit, STALL_MILLISECONDS } from "./download";

/** The browser's own options: an abort signal and the clock, the downloader and the in-memory store already chosen. */
export type BrowserFetchOptions = Omit<FetchOptions, "fetch" | "store"> & { readonly fetch?: FetchOptions["fetch"] };

const store = memoryStore(digest);

const ports = (options: BrowserFetchOptions): FetchOptions => ({ ...options, fetch: options.fetch ?? downloadRaw, store });

/**
 * Fetches a dataset of the bundled catalogue by id through the platform's downloader and digest. See `../fetch`'s `fetchEntry` for what a fetch does; see `./download` for the one way the platform's bytes can differ from Node's.
 * @param id - The entry id.
 * @param options - An abort signal and the clock.
 * @returns The fetched dataset.
 */
export async function fetchDataset(id: string, options: BrowserFetchOptions): Promise<Awaited<ReturnType<typeof fetchCore>>> {
  return fetchCore(id, ports(options));
}

/**
 * Fetches a dataset object through the platform's downloader and digest.
 * @param dataset - A dataset from any catalogue.
 * @param options - An abort signal and the clock.
 * @returns The fetched dataset.
 */
export async function fetchEntry(dataset: Dataset, options: BrowserFetchOptions): Promise<Awaited<ReturnType<typeof fetchEntryCore>>> {
  return fetchEntryCore(dataset, ports(options));
}

/**
 * Checks a dataset's crosswalk on its real data through the platform's ports.
 * @param dataset - A dataset from any catalogue.
 * @param options - An abort signal and the clock.
 * @returns Whether the round trip holds.
 */
export async function roundTripEntry(dataset: Dataset, options: BrowserFetchOptions): Promise<Awaited<ReturnType<typeof roundTripEntryCore>>> {
  return roundTripEntryCore(dataset, ports(options));
}

/**
 * Runs `roundTripEntry` on a dataset of the bundled catalogue by id.
 * @param id - The entry id.
 * @param options - An abort signal and the clock.
 * @returns Whether the round trip holds.
 */
export async function roundTripDataset(id: string, options: BrowserFetchOptions): Promise<Awaited<ReturnType<typeof roundTripEntryCore>>> {
  return roundTripEntryCore((await import("../bundled")).getDataset(id), ports(options));
}

/**
 * Asks the Archive to capture a URL a fetch read live; see `../resolve`'s `requestCapture`. The platform sends it without reading the answer, which the Archive's replies to a page on another origin do not allow.
 * @param saveUrl - A request URL from `captureRequestsFor`.
 * @param signal - Aborts the request.
 */
export async function requestCapture(saveUrl: string, signal?: AbortSignal): Promise<void> {
  await requestCaptureCore(saveUrl, async (url, init) => await fetch(url, { ...init, mode: "no-cors" }), signal);
}
