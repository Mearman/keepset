/* The Node entry point (`keepset/node`): the platform-neutral fetch core with Node's own downloader and file store preset, and the streamed reading beside it, which holds a paged table a page at a time and so lives with the platform it streams on. */


import type { Dataset } from "../catalogue";
import { getDataset } from "../bundled";
import { fetchDataset as fetchCore, fetchEntry as fetchEntryCore, type FetchOptions, type FetchPort, roundTripEntry as roundTripEntryCore } from "../fetch";
import type { NodeSink, StreamedDataset } from "./stream-dataset";
import { downloadRaw } from "./download";
import { fileStore } from "./file-store";
import { requestCapture as requestCaptureCore } from "../resolve";
import { type DigestPort, memoryStore, type StorePort } from "../source-bytes";
import { isStreamed, roundTripTable, streamTable } from "./stream-dataset";


export type { Download, DownloadProvenance, FetchedDataset, FetchOptions, FetchPort, FilesProvenance, Provenance, RoundTripReport } from "../fetch";
export type { ByteRange, DigestPort, KeepRequest, Received, SourceBytes, StoredSource, StorePort } from "../source-bytes";
export { downloadUrl } from "../fetch";
export { captureRequestsFor } from "../resolve";
export { memoryStore } from "../source-bytes";
export type { NodeSink, StreamedDataset, StreamedNode } from "./stream-dataset";
export { downloadRaw, type DownloadInit, STALL_MILLISECONDS, DOWNLOAD_ATTEMPTS, RETRY_DELAY_MILLISECONDS } from "./download";
export { fileStore, type FileStoreOptions, RANGED_MIN_BYTES, READ_CHUNK_BYTES } from "./file-store";

/** Where a Node fetch keeps what it downloads: a store of its own, or a digest of its own, which hashes bytes held whole and so keeps every source in memory as `memoryStore` does; with neither, Node's `fileStore`, which keeps a source in a temporary file and hashes it as it arrives. */
type NodeStoreOption = { readonly store?: StorePort; readonly digest?: never } | { readonly digest?: DigestPort; readonly store?: never };

/** What a fetch may be given beyond the dataset in Node: every port is optional, with Node's own as the default. */
export type NodeFetchOptions = Omit<FetchOptions, "fetch" | "store"> & NodeStoreOption & { readonly fetch?: FetchPort; readonly signal?: AbortSignal; readonly now?: () => Date };

/** The store a Node fetch keeps its sources in. */
const storeOf = (options: NodeStoreOption): StorePort => options.store ?? (options.digest === undefined ? fileStore() : memoryStore(options.digest));

/** The Node defaults of the ports: the raw downloader and the file store. */
const defaults = (options: NodeFetchOptions): FetchOptions => ({ ...options, fetch: options.fetch ?? downloadRaw, store: storeOf(options) });

/**
 * Fetches a dataset of the bundled catalogue by id, with Node's own downloader and digest. See `../fetch`'s `fetchEntry` for what a fetch does.
 * @param id - The entry id.
 * @param options - The ports to override, an abort signal and the clock.
 * @returns The fetched dataset.
 */
export async function fetchDataset(id: string, options: NodeFetchOptions = {}): Promise<Awaited<ReturnType<typeof fetchCore>>> {
  return fetchCore(id, defaults(options));
}

/**
 * Fetches a dataset object, with Node's own downloader and digest.
 * @param dataset - A dataset from any catalogue.
 * @param options - The ports to override, an abort signal and the clock.
 * @returns The fetched dataset.
 */
export async function fetchEntry(dataset: Dataset, options: NodeFetchOptions = {}): Promise<Awaited<ReturnType<typeof fetchEntryCore>>> {
  return fetchEntryCore(dataset, defaults(options));
}

/**
 * Checks a dataset's crosswalk on its real data, a streamed table a page at a time.
 * @param dataset - A dataset from any catalogue.
 * @param options - The ports to override, an abort signal and the clock.
 * @returns Whether the round trip holds.
 */
export async function roundTripEntry(dataset: Dataset, options: NodeFetchOptions = {}): Promise<Awaited<ReturnType<typeof roundTripEntryCore>>> {
  if (isStreamed(dataset.entry.recipe)) {
    return roundTripTable(dataset, defaults(options));
  }

  return roundTripEntryCore(dataset, defaults(options));
}

/**
 * Runs `roundTripEntry` on a dataset of the bundled catalogue by id.
 * @param id - The entry id.
 * @param options - The ports to override, an abort signal and the clock.
 * @returns Whether the round trip holds.
 */
export async function roundTripDataset(id: string, options: NodeFetchOptions = {}): Promise<Awaited<ReturnType<typeof roundTripEntryCore>>> {
  return roundTripEntry(getDataset(id), options);
}

/** Streams a dataset of the bundled catalogue by id, as `streamEntry` does. */
export async function streamDataset(id: string, sink: NodeSink, options: NodeFetchOptions = {}): Promise<StreamedDataset> {
  return streamEntry(getDataset(id), sink, options);
}

/** Streams a dataset whose table is too large to hold as one document, a page at a time, as `streamTable` does. */
export async function streamEntry(dataset: Dataset, sink: NodeSink, options: NodeFetchOptions = {}): Promise<StreamedDataset> {
  return streamTable(dataset, sink, defaults(options));
}

export { streamTable };

/**
 * Asks the Archive to capture a URL a fetch read live; see `../resolve`'s `requestCapture`. Node's own `fetch` sends it.
 * @param saveUrl - A request URL from `captureRequestsFor`.
 * @param signal - Aborts the request.
 */
export async function requestCapture(saveUrl: string, signal?: AbortSignal): Promise<void> {
  await requestCaptureCore(saveUrl, async (url, init) => await fetch(url, init), signal);
}
