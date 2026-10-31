import { assertRoundTrip, encode, RoundTripMismatchError } from "crossmap";
import { getDataset } from "./bundled";
import { countTarget, getCollectionTarget, getTarget, type CategoryTarget, type CollectionTarget } from "./categories";
import type { Dataset } from "./catalogue";
import { ArchiveError, KeepsetError, RecipeError } from "./errors";
import type { NativeDocument } from "./parsers/native";
import { parseNative, parseNativeFiles, parseNativeParts } from "./parsers/parse-native";
import type { JsonScalar } from "./targets/json-scalar";
import { readsByRanges, unpack, unpackFiles, unpackMembers, unpackParts, type Unpacked } from "./archive";
import { downloadPaged } from "./paged";
import { metaOf, sourceRecord, sourceUrl, step } from "./recipe-run";
import { resolveSource } from "./resolve";
import type { ByteRange, StoredSource, StorePort } from "./source-bytes";
import type { Archive, Entry, FilesRecipe, Parser, Snapshot, Source } from "./entry";

/** The network port a recipe downloads through: `downloadRaw` by default, which returns the bytes exactly as served, or a stand-in under test. A `range` asks for those bytes of the file only; a port may answer 206 with them or 200 with the whole file, and the reader tells which from the status. */
export type FetchPort = (url: string, init: { readonly signal?: AbortSignal; readonly range?: ByteRange }) => Promise<Response>;

/** What a fetch takes beyond the dataset: the network port and the store every entry point supplies its own of (the store keeps what arrives and hashes it as it arrives), an abort signal and the clock that dates the provenance record. */
export interface FetchOptions {
  readonly fetch: FetchPort;
  readonly store: StorePort;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

/** One download a result's bytes came from: the entry's source, the URL actually requested (the snapshot's for a dead source) and exactly which bytes arrived, hashed in the order they arrived. A source read by ranged requests rather than downloaded whole (a zip too large to download, whose directory and selected members are all a recipe reads) also records the ranges and the whole file's size, so its hash is told apart from a whole file's. */
export interface Download {
  readonly source: { readonly url: string; readonly status: Source["status"]; readonly snapshot?: Snapshot };
  readonly fetchedUrl: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly ranges?: readonly ByteRange[];
  readonly size?: number;
}

/** What every provenance record says: which entry and catalogue produced the result, its category, and when it was fetched. */
interface ProvenanceOf {
  readonly entryId: string;
  readonly catalogue: Dataset["catalogue"];
  readonly category: Entry["category"];
  readonly retrievedAt: string;
}

/** The provenance of a result read from one download: the download, and the archive member or members it was read from. */
export interface DownloadProvenance extends ProvenanceOf, Download {
  /** The archive member a document was read from. */
  readonly member?: string;
  /** The archive members a collection, or a document read from several files, was read from, in the order they were read. */
  readonly members?: readonly string[];
}

/** One file of a collection read file by file: its download, the file's path in the collection, and the instances it gave (the path itself, or the path joined to each archive member it unpacked into). */
export interface FileDownload extends Download {
  readonly path: string;
  readonly instances: readonly string[];
}

/** The provenance of a collection read from files downloaded one by one: each file's download, in the order they were read. */
export interface FilesProvenance extends ProvenanceOf {
  readonly files: readonly FileDownload[];
}

/** Where a fetched result's bytes came from: enough to say which entry, catalogue and source produced it, which URL was actually requested, when, and exactly which bytes arrived, for the one download a recipe reads or for each file of a collection read file by file (told apart by `files`). */
export type Provenance = DownloadProvenance | FilesProvenance;

/** Whether decoding a dataset's encoded native document gives the native document back, with the provenance of the bytes it was checked on. */
export type RoundTripReport = { readonly holds: true; readonly provenance: Provenance } | { readonly holds: false; readonly path: string; readonly message: string; readonly provenance: Provenance };



/**
 * The URL a recipe downloads a source from. A dead source is fetched from its pinned snapshot in the Wayback Machine's `id_` form, which serves the archived bytes as they were captured rather than wrapped in the archive's page chrome.
 * @param source - The source.
 * @returns The URL to request.
 */
export function downloadUrl(source: Source): string {
  return sourceUrl(source);
}

/** A fetched dataset: the resolved category target (one document, or for a recipe that selects archive members a collection of them), the provenance of the bytes it came from, and any warnings, such as a count that differs from the one the entry records. */
export interface FetchedDataset {
  readonly dataset: Dataset;
  readonly data: CategoryTarget | CollectionTarget;
  readonly provenance: Provenance;
  readonly warnings: readonly string[];
}

/** A native document with the `meta` the crosswalk receives. */
type NativeWithMeta = NativeDocument & { readonly meta: Record<string, JsonScalar> };

/** A recipe run up to the native documents, before the crosswalk: what both a fetch and a round-trip check start from. A document recipe has one, the parser's output with the entry's `meta` over the parser's own header values (a multi-file format's document among them, read from every file its archive selects); a collection recipe has one per archive member, named by the member's path, each the parser's output with only its own header values as `meta`, because the entry's metadata belongs to the collection and not to each instance. */
interface NativeRun {
  readonly collection: boolean;
  readonly documents: readonly { readonly id: string | undefined; readonly native: NativeWithMeta }[];
  readonly provenance: Provenance;
}

/**
 * Puts an instance's id beside the fields of its encoded document. A document that is not an object is left as it is, for the collection schema to refuse.
 * @param document - The crosswalk's output for one member.
 * @param id - The member's path.
 * @returns The instance.
 */
function withId(document: unknown, id: string | undefined): unknown {
  return typeof document === "object" && document !== null && !Array.isArray(document) ? { ...document, id } : document;
}

/**
 * The record of one download: the source, the URL requested and a hash of exactly the bytes that arrived. Read once the source has been read, as a source read by ranges goes on arriving while it is read.
 * @param source - The entry's source.
 * @param fetchedUrl - The URL requested.
 * @param stored - What the store kept.
 * @returns The download record.
 */
async function downloadOf(source: Source, fetchedUrl: string, stored: StoredSource): Promise<Download> {
  const { sha256, byteLength, ranges, size } = await stored.received();

  return { source: sourceRecord(source), fetchedUrl, sha256, byteLength, ...(ranges === undefined ? {} : { ranges }), ...(size === undefined ? {} : { size }) };
}

/**
 * Reads a kept source and lets it go, whether the reading succeeds or fails.
 * @param stored - The kept source.
 * @param read - The reading.
 * @returns What the reading returns.
 */
async function reading<Result>(stored: StoredSource, read: () => Promise<Result>): Promise<Result> {
  try {
    return await read();
  } finally {
    await stored.close();
  }
}

/**
 * Parses one file of a collection into its native document, naming the file when it fails.
 * @param id - The instance's id.
 * @param bytes - The file's bytes.
 * @param parser - The recipe's parser.
 * @returns The instance's native document, with only its own header values as `meta`.
 * @throws KeepsetError naming the instance when the file does not parse.
 */
function parseInstance(id: string, bytes: Uint8Array, parser: Parser): { readonly id: string; readonly native: NativeWithMeta } {
  try {
    const parsed = parseNative(bytes, parser);

    return { id, native: { ...parsed, meta: "meta" in parsed ? parsed.meta : {} } };
  } catch (error) {
    throw new KeepsetError(`member ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Unpacks and parses a source of one archive or file into instances, each member let go once it is parsed.
 * @param stored - The kept source.
 * @param archive - Its archive layout.
 * @param parser - The recipe's parser.
 * @param prefix - The path the instance ids are filed under, joined to each member's path, or undefined to use the member's path alone.
 * @returns The instances, in member order.
 */
async function instancesOf(stored: StoredSource, archive: Archive, parser: Parser, prefix: string | undefined): Promise<{ readonly id: string; readonly native: NativeWithMeta }[]> {
  const named = (member: string | undefined): string => {
    if (prefix === undefined) {
      // A collection read from one download is always of `members`, which name every instance.
      if (member === undefined) {
        throw new KeepsetError("an instance of a collection has no path");
      }

      return member;
    }

    return member === undefined ? prefix : `${prefix}/${member}`;
  };
  if ("members" in archive) {
    const instances: { readonly id: string; readonly native: NativeWithMeta }[] = [];
    for await (const member of unpackMembers(stored, archive)) {
      instances.push(parseInstance(named(member.path), member.bytes, parser));
    }

    return instances;
  }
  if ("parts" in archive) {
    throw new ArchiveError(`an instance is read from one file or from matching members, not from the named parts ${archive.parts.map((part) => part.name).join(", ")}`);
  }
  if ("files" in archive) {
    throw new ArchiveError("an instance is read from one file or from matching members, not from every file a multi-file format's files selector matches");
  }
  const unpacked = await unpack(stored, archive);

  return [parseInstance(named(unpacked.member), unpacked.bytes, parser)];
}

/**
 * Unpacks and parses instances as `instancesOf` does, failing at the extract step when the archive cannot be read or its selector matches nothing, and at the parse step when a member does not parse: the members are unpacked one at a time as they are parsed, so the two steps interleave.
 * @param entryId - The entry.
 * @param run - The unpacking and parsing.
 * @returns The instances.
 * @throws RecipeError naming the entry and the step that failed.
 */
async function extractAndParse<Result>(entryId: string, run: () => Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    throw new RecipeError(entryId, error instanceof ArchiveError ? "extract" : "parse", error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/**
 * Runs a files recipe: downloads each file in turn (a dead file from its own pinned snapshot), unpacks it and parses it into its instances, so only one file's bytes are kept at a time.
 * @param dataset - The dataset.
 * @param recipe - Its files recipe.
 * @param options - The network port, store, abort signal and clock.
 * @returns The instances and the provenance of every file.
 */
async function runFiles(dataset: Dataset, recipe: FilesRecipe, options: FetchOptions): Promise<NativeRun> {
  const { entry } = dataset;
  const { fetch: port, store, signal, now = () => new Date() } = options;
  const retrievedAt = now().toISOString();
  const read = async (index: number): Promise<readonly { readonly documents: readonly { readonly id: string; readonly native: NativeWithMeta }[]; readonly download: FileDownload }[]> => {
    const file = recipe.files[index];
    if (file === undefined) {
      return [];
    }
    const source = entry.sources[file.source];
    if (source === undefined) {
      throw new RecipeError(entry.id, "recipe", `file ${file.path} names source ${String(file.source)}, which the entry does not have`);
    }
    const resolved = await step(entry.id, "download", async () => resolveSource(source, { port, store, randomAccess: readsByRanges(file.archive), ...(signal === undefined ? {} : { signal }) }));
    const { source: stored, url: fetchedUrl } = resolved;
    const one = await reading(stored, async () => {
      const documents = await extractAndParse(entry.id, async () => instancesOf(stored, file.archive, recipe.parser, file.path));

      return { documents, download: { ...(await downloadOf(source, fetchedUrl, stored)), path: file.path, instances: documents.map((document) => document.id) } };
    });

    return [one, ...(await read(index + 1))];
  };
  const files = await read(0);
  const documents = files.flatMap((file) => file.documents);
  const ids = new Set<string>();
  for (const { id } of documents) {
    if (ids.has(id)) {
      throw new RecipeError(entry.id, "extract", `two files give the instance ${id}`);
    }
    ids.add(id);
  }

  return { collection: true, documents, provenance: { entryId: entry.id, catalogue: dataset.catalogue, category: entry.category, retrievedAt, files: files.map((file) => file.download) } };
}

/**
 * Runs a recipe's download, extract and parse steps, and builds the native documents the crosswalk receives.
 * @param dataset - The dataset.
 * @param options - The network port, store, abort signal and clock.
 * @returns The native documents and the provenance of their bytes.
 */
async function runToNative(dataset: Dataset, options: FetchOptions): Promise<NativeRun> {
  const { entry } = dataset;
  const { fetch: fetchPort, store, signal, now = () => new Date() } = options;
  const { recipe } = entry;
  if (recipe.status === "not-fetchable") {
    throw new RecipeError(entry.id, "recipe", `the entry has no fetchable recipe: ${recipe.reason}`);
  }
  if ("files" in recipe) {
    return runFiles(dataset, recipe, options);
  }
  if (recipe.stream === true) {
    throw new RecipeError(entry.id, "recipe", "the table is too large to hold as one document, so its recipe streams: read it with streamDataset, which hands its nodes on a page at a time");
  }
  const source = entry.sources[recipe.source];
  if (source === undefined) {
    throw new RecipeError(entry.id, "recipe", `the recipe names source ${String(recipe.source)}, which the entry does not have`);
  }
  const retrievedAt = now().toISOString();
  const { archive } = recipe;
  // A paged query is not a file anyone archives (a capture of the URL is not the data), so a paged source is read directly; every other source goes through the chain of pinned snapshot, closest capture and live URL.
  const resolved = await step(entry.id, "download", async () =>
    recipe.paging === undefined
      ? resolveSource(source, { port: fetchPort, store, randomAccess: readsByRanges(archive), ...(signal === undefined ? {} : { signal }) })
      : { source: await store.hold(await downloadPaged(sourceUrl(source), recipe.paging, fetchPort, signal)), url: sourceUrl(source) },
  );
  const { source: stored, url: fetchedUrl } = resolved;
  const provenanceOf = async (extra: Pick<DownloadProvenance, "member" | "members">): Promise<DownloadProvenance> => ({
    entryId: entry.id,
    catalogue: dataset.catalogue,
    category: entry.category,
    retrievedAt,
    ...(await downloadOf(source, fetchedUrl, stored)),
    ...extra,
  });

  return reading(stored, async () => {
    if ("members" in archive) {
      const documents = await extractAndParse(entry.id, async () => instancesOf(stored, archive, recipe.parser, undefined));

      return { collection: true, documents, provenance: await provenanceOf({ members: documents.map((document) => document.id) }) };
    }
    if ("parts" in archive) {
      const parts = await step(entry.id, "extract", async () => unpackParts(stored, archive));
      const parsed = await step(entry.id, "parse", () => parseNativeParts(parts, recipe.parser));

      return { collection: false, documents: [{ id: undefined, native: { ...parsed, meta: metaOf(entry) } }], provenance: await provenanceOf({ members: parts.map((part) => part.path) }) };
    }
    if ("files" in archive) {
      const files = await step(entry.id, "extract", async () => unpackFiles(stored, archive));
      const parsed = await step(entry.id, "parse", () => parseNativeFiles(files, recipe.parser));

      return { collection: false, documents: [{ id: undefined, native: { ...parsed, meta: metaOf(entry) } }], provenance: await provenanceOf({ members: files.map((file) => file.path) }) };
    }
    const unpacked: Unpacked = await step(entry.id, "extract", async () => unpack(stored, archive));
    const parsed = await step(entry.id, "parse", () => parseNative(unpacked.bytes, recipe.parser));
    const native = { ...parsed, meta: { ...("meta" in parsed ? parsed.meta : {}), ...metaOf(entry) } };

    return { collection: false, documents: [{ id: undefined, native }], provenance: await provenanceOf(unpacked.member === undefined ? {} : { member: unpacked.member }) };
  });
}

/**
 * Runs a dataset's recipe: downloads the source (from its pinned snapshot when the source is dead), unpacks the archive, parses the native shape, applies the crossmap crosswalk and validates the result against the category target. The native document the crosswalk receives is the parser's output with `meta` built from the entry.
 * @param dataset - A dataset from any catalogue.
 * @param options - The network port, abort signal and clock.
 * @returns The resolved target with its provenance and any count warnings.
 * @throws RecipeError naming the entry and the failing step, including for a recipe that streams, which `streamEntry` reads; nothing partial or default-shaped is ever returned.
 */
export async function fetchEntry(dataset: Dataset, options: FetchOptions): Promise<FetchedDataset> {
  const { entry, crosswalk } = dataset;
  const { collection, documents, provenance } = await runToNative(dataset, options);
  const encoded = await step(entry.id, "crosswalk", () =>
    documents.map(({ id, native }) => {
      try {
        return encode(crosswalk, native);
      } catch (error) {
        throw new KeepsetError(`${id === undefined ? "" : `member ${id}: `}${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }),
  );
  const data = await step(entry.id, "validate", () => {
    const [only] = encoded;
    const whole = collection ? { meta: metaOf(entry), instances: encoded.map((document, index) => withId(document, documents[index]?.id)) } : only;
    const result = (collection ? getCollectionTarget(entry.category) : getTarget(entry.category)).safeParse(whole);
    if (!result.success) {
      throw new KeepsetError(`the result is not ${collection ? "a collection of " : ""}${entry.category}: ${result.error.issues.map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
    }

    return result.data;
  });

  const counts = countTarget(entry.category, data);
  const warnings = Object.entries(entry.expectedCounts)
    .filter(([key, expected]) => counts.get(key) !== expected)
    .map(([key, expected]) => `${key}: the entry records ${String(expected)}, the fetched result has ${String(counts.get(key))}`);

  return { dataset, data, provenance, warnings };
}

/**
 * Fetches a dataset of the bundled catalogue by id and resolves it to its category's target shape, so `fetchDataset("cora")` yields graph/v1 `{ meta, nodes, edges }` directly. Node-only: it downloads with Node's http and https clients and unpacks with Node's zlib.
 * @param id - The entry id.
 * @param options - The network port, abort signal and clock.
 * @returns The resolved target with its provenance and any count warnings.
 * @throws DatasetNotFoundError when no entry has that id, and RecipeError naming the entry and the failing step when the recipe fails.
 */
export async function fetchDataset(id: string, options: FetchOptions): Promise<FetchedDataset> {
  return fetchEntry(getDataset(id), options);
}

/**
 * Checks a dataset's crosswalk on its real data: runs the recipe to the native document, then crossmap's `assertRoundTrip`, which encodes it, decodes the result and compares the two over every path the crosswalk promises to preserve. A streamed recipe is checked a page at a time, with the round trip holding on the whole table exactly when it holds on every page, so the table is never held.
 * @param dataset - A dataset from any catalogue.
 * @param options - The network port, abort signal and clock.
 * @returns Whether the round trip holds, and where it first differs when it does not.
 * @throws RecipeError naming the entry and the failing step when the recipe fails before the comparison, or when the crosswalk cannot run.
 */
export async function roundTripEntry(dataset: Dataset, options: FetchOptions): Promise<RoundTripReport> {
  const { documents, provenance } = await runToNative(dataset, options);
  try {
    assertRoundTrip(
      dataset.crosswalk,
      documents.map(({ native }) => native),
    );
  } catch (error) {
    // A mismatch is the answer this check exists to give, so it becomes the report; any other failure is the crosswalk failing to run.
    if (error instanceof RoundTripMismatchError) {
      return { holds: false, path: error.path, message: error.message, provenance };
    }
    throw new RecipeError(dataset.entry.id, "crosswalk", error instanceof Error ? error.message : String(error), { cause: error });
  }

  return { holds: true, provenance };
}

/**
 * Runs `roundTripEntry` on a dataset of the bundled catalogue by id.
 * @param id - The entry id.
 * @param options - The network port, abort signal and clock.
 * @returns Whether the round trip holds.
 * @throws DatasetNotFoundError when no entry has that id, and RecipeError as `roundTripEntry` does.
 */
export async function roundTripDataset(id: string, options: FetchOptions): Promise<RoundTripReport> {
  return roundTripEntry(getDataset(id), options);
}
