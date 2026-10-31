import { createHash } from "node:crypto";
import { assertRoundTrip, encode, RoundTripMismatchError, type Crosswalk } from "crossmap";
import { getStreamedShape, isStreamable } from "../categories";
import type { Dataset } from "../catalogue";
import { STREAMED_FILE_FORMATS, type Entry, type FilesArchive, type Parser, type Recipe, type Source, type StreamedFileFormat } from "../entry";
import { KeepsetError, RecipeError, type RecipeStep } from "../errors";
import { TableReader } from "../parsers/csv-table";
import type { NativeRow, NativeTable } from "../parsers/native";
import { parseNativeFiles, PieceDecoder } from "../parsers/parse-native";
import type { JsonScalar } from "../targets/json-scalar";
import { IdSet } from "./id-set";
import { csvPages, type CsvPaging } from "../paged";
import type { Download, DownloadProvenance, FetchOptions, RoundTripReport } from "../fetch";
import { streamFiles, type Member } from "../archive";
import { resolveSource } from "../resolve";
import type { StreamedNodes, StreamableId } from "../categories";
import { countWarnings, downloadOf, metaOf, sourceRecord, sourceUrl, step, unpackOptionsOf } from "../recipe-run";

/** Where a streamed result goes: the meta once, before any node, then the nodes a page at a time, each already checked against the category's node shape and for an id no earlier node had. A sink that returns a promise is awaited before the next page is read, so a slow sink holds the stream back rather than letting pages pile up. */
export interface NodeSink {
  readonly meta: (meta: Readonly<Record<string, JsonScalar>>) => void | Promise<void>;
  readonly nodes: (nodes: readonly StreamedNode[]) => void | Promise<void>;
}

/** What a streamed fetch ends with, once every node has been handed on: the meta, the provenance of the bytes, how many nodes there were, and any warnings, such as a count that differs from the one the entry records. */
export interface StreamedDataset {
  readonly dataset: Dataset;
  readonly meta: Readonly<Record<string, JsonScalar>>;
  readonly provenance: DownloadProvenance;
  readonly counts: ReadonlyMap<string, number>;
  readonly warnings: readonly string[];
}

/** A node a streamed result hands on: a node of a streamable category's target. */
export type StreamedNode = StreamedNodes[StreamableId];

/** A streamed recipe, narrowed to the parts streaming reads: a CSV paged source read a page at a time by the csv-table parser, or an archive whose files are read one at a time, each file one row. */
type StreamedRecipe =
  | { readonly source: number; readonly paging: CsvPaging; readonly parser: Extract<Parser, { readonly format: "csv-table" }> }
  | { readonly source: number; readonly archive: FilesArchive; readonly parser: Extract<Parser, { readonly format: StreamedFileFormat }> };

/**
 * Whether a parser reads each file of a files archive into one row on its own, and so can be given the files one at a time.
 * @param parser - A recipe's parser.
 * @returns True for such a parser.
 */
function readsFileByFile(parser: Parser): parser is Extract<Parser, { readonly format: StreamedFileFormat }> {
  return STREAMED_FILE_FORMATS.has(parser.format);
}

/**
 * The parts of a recipe a stream reads, checked to be a streamed recipe: the entry schema refuses a `stream` recipe that is neither a CSV paged source read by the csv-table parser with no archive nor a files archive read file by file with no paging, so this only fails for an entry whose recipe does not stream.
 * @param entry - The entry.
 * @returns The recipe's source, how it is read and its parser, and the category.
 * @throws RecipeError when the recipe is not fetchable, does not stream, or its category has no streamed form.
 */
function streamedRecipe(entry: Entry): StreamedRecipe & { readonly category: StreamableId } {
  const { recipe, category } = entry;
  if (recipe.status === "not-fetchable") {
    throw new RecipeError(entry.id, "recipe", `the entry has no fetchable recipe: ${recipe.reason}`);
  }
  if ("files" in recipe || recipe.stream !== true) {
    throw new RecipeError(entry.id, "recipe", "the recipe is not streamed, so fetchDataset reads it as one document");
  }
  const { paging, parser, archive, source } = recipe;
  if (!isStreamable(category)) {
    throw new RecipeError(entry.id, "recipe", `${category} has no streamed form`);
  }
  if (paging !== undefined && paging.kind !== "arcgis-query" && parser.format === "csv-table" && archive.kind === "none") {
    return { source, paging, parser, category };
  }
  if (paging === undefined && "files" in archive && readsFileByFile(parser)) {
    return { source, archive, parser, category };
  }

  throw new RecipeError(entry.id, "recipe", "a streamed recipe reads a CSV paged source through the csv-table parser, or a files archive file by file");
}

/**
 * Whether a recipe is streamed, so `fetchDataset` refuses it and `streamDataset` reads it.
 * @param recipe - A recipe.
 * @returns True for a streamed recipe.
 */
export function isStreamed(recipe: Recipe): boolean {
  return recipe.status === "fetchable" && !("files" in recipe) && recipe.stream === true;
}

/**
 * What a crosswalk path addresses, for the separability check: the document's meta, a field of every node, or anything else.
 * @param path - A crosswalk path.
 * @returns Its class.
 */
function pathClass(path: string): "meta" | "node" | "other" {
  if (path === "meta" || path.startsWith("meta.")) {
    return "meta";
  }

  return path === "nodes[]" || path.startsWith("nodes[].") ? "node" : "other";
}

/**
 * Why a crosswalk cannot be applied a page of nodes at a time, if it cannot: every rule must read and write the meta alone or one node's fields alone, with no `when`, so encoding a page's nodes under the document's meta gives exactly that page's part of encoding the whole document, and a round trip that holds on every page holds on the whole.
 * @param crosswalk - The crosswalk.
 * @returns The first rule that breaks this, described, or undefined when every rule keeps to it.
 */
export function inseparableRule(crosswalk: Crosswalk): string | undefined {
  for (const [index, rule] of [...crosswalk.rules, ...crosswalk.oneWay].entries()) {
    if ("when" in rule && rule.when !== undefined) {
      return `rule ${String(index)} (${rule.op}) has a when, which may read the whole document`;
    }
    const paths = ["from" in rule ? rule.from : undefined, "to" in rule ? rule.to : undefined].filter((path) => path !== undefined);
    const classes = new Set(paths.map(pathClass));
    const [only] = classes;
    if (classes.size !== 1 || only === "other") {
      return `rule ${String(index)} (${rule.op}) reads or writes ${paths.join(" and ")}, not the meta alone or one node's fields alone`;
    }
  }

  return undefined;
}

/**
 * Passes on what an async iterable yields, rethrowing its failure as a RecipeError naming the entry and the step, as `step` does for one call.
 * @param entryId - The entry.
 * @param name - The step.
 * @param source - What the step yields.
 * @returns The same items, in order.
 */
async function* inStep<Item>(entryId: string, name: RecipeStep, source: Readonly<AsyncIterable<Item>>): AsyncGenerator<Item, void, undefined> {
  try {
    yield* source;
  } catch (error) {
    if (error instanceof RecipeError) {
      throw error;
    }
    throw new RecipeError(entryId, name, error instanceof Error ? error.message : String(error), { cause: error });
  }
}

/** A recipe run as a stream of native rows: the meta the crosswalk receives with every page, the pages of rows, and the provenance of the bytes read, complete once the pages are done. */
interface NativeStream {
  readonly meta: Record<string, JsonScalar>;
  readonly pages: AsyncGenerator<readonly NativeRow[], void, undefined>;
  readonly provenance: () => Promise<DownloadProvenance>;
}

/**
 * Runs a streamed recipe's download and parse steps a page at a time.
 * @param dataset - The dataset.
 * @param recipe - Its streamed recipe.
 * @param options - The network port, store, abort signal and clock.
 * @returns The stream.
 * @throws RecipeError when the recipe names a source the entry does not have.
 */
function openNative(dataset: Dataset, recipe: StreamedRecipe, options: FetchOptions): NativeStream {
  const { entry } = dataset;
  const source = entry.sources[recipe.source];
  if (source === undefined) {
    throw new RecipeError(entry.id, "recipe", `the recipe names source ${String(recipe.source)}, which the entry does not have`);
  }

  return "paging" in recipe ? openTable(dataset, source, recipe, options) : openFiles(dataset, source, recipe, options);
}

/**
 * Runs a streamed files recipe a file at a time: the source is resolved through the chain of pinned snapshot, closest capture and live URL and kept whole by the store, then its files are unpacked one at a time as `streamFiles` hands them on, each parsed on its own into its row, which is the page, and let go before the next is read.
 * @param dataset - The dataset.
 * @param source - The recipe's source.
 * @param recipe - Its streamed files recipe.
 * @param options - The network port, store, abort signal and clock.
 * @returns The stream; its provenance names every file read, in the order read.
 */
function openFiles(dataset: Dataset, source: Source, recipe: Extract<StreamedRecipe, { readonly archive: FilesArchive }>, options: FetchOptions): NativeStream {
  const { entry } = dataset;
  const { fetch: port, store, signal, now = () => new Date() } = options;
  const retrievedAt = now().toISOString();
  const members: string[] = [];
  let download: Download | undefined;

  async function* pages(): AsyncGenerator<readonly NativeRow[], void, undefined> {
    // Every byte of the files a stream reads is read in order, so the source is downloaded whole in one request and hashed whole, never fetched range by range.
    const resolved = await step(entry.id, "download", async () => resolveSource(source, { port, store, randomAccess: false, ...(signal === undefined ? {} : { signal }) }));
    const { source: stored, url: fetchedUrl } = resolved;
    try {
      for await (const file of inStep(entry.id, "extract", streamFiles(stored, recipe.archive, unpackOptionsOf(options)))) {
        members.push(file.path);
        const parsed = await step(entry.id, "parse", () => parseInstanceFile(file, recipe.parser, members.length));
        yield parsed.nodes;
      }
      download = await downloadOf(source, fetchedUrl, stored);
    } finally {
      await stored.close();
    }
  }

  return {
    meta: metaOf(entry),
    pages: pages(),
    provenance: async () => {
      if (download === undefined) {
        throw new KeepsetError("the provenance of a streamed archive is known once every file has been read");
      }

      return Promise.resolve({ entryId: entry.id, catalogue: dataset.catalogue, category: entry.category, retrievedAt, ...download, members: [...members] });
    },
  };
}

/**
 * Parses one file of a streamed files archive into its row, naming the file when it fails, as a collection names its member.
 * @param file - The file.
 * @param parser - The recipe's parser, one that reads each file on its own.
 * @param position - The file's 1-based position among the files read.
 * @returns The table of the file's one row.
 * @throws KeepsetError naming the file when it does not parse.
 */
function parseInstanceFile(file: Readonly<Member>, parser: Readonly<Extract<Parser, { readonly format: StreamedFileFormat }>>, position: number): NativeTable {
  try {
    return parseNativeFiles([file], parser);
  } catch (error) {
    throw new KeepsetError(`file ${String(position)} (${file.path}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Runs a streamed table's download and parse steps a page at a time: each page's bytes are hashed, decoded and read into rows, and then let go.
 * @param dataset - The dataset.
 * @param source - The recipe's source.
 * @param recipe - Its streamed table recipe.
 * @param options - The network port, abort signal and clock; a paged table is read page by page and kept nowhere.
 * @returns The stream.
 */
function openTable(dataset: Dataset, source: Source, recipe: Extract<StreamedRecipe, { readonly paging: CsvPaging }>, options: FetchOptions): NativeStream {
  const { entry } = dataset;
  const { fetch: port, signal, now = () => new Date() } = options;
  const fetchedUrl = sourceUrl(source);
  const retrievedAt = now().toISOString();
  const hash = createHash("sha256");
  let byteLength = 0;

  async function* pages(): AsyncGenerator<readonly NativeRow[], void, undefined> {
    const decoder = new PieceDecoder(recipe.parser);
    const reader = new TableReader(recipe.parser);
    for await (const page of inStep(entry.id, "download", csvPages(fetchedUrl, recipe.paging, port, signal))) {
      hash.update(page);
      byteLength += page.byteLength;
      const rows = await step(entry.id, "parse", () => reader.push(decoder.decode(page)));
      if (rows.length > 0) {
        yield rows;
      }
    }
    const rows = await step(entry.id, "parse", () => [...reader.push(decoder.end()), ...reader.end()]);
    if (rows.length > 0) {
      yield rows;
    }
  }

  return {
    meta: metaOf(entry),
    pages: pages(),
    // A copy of the running hash, so the provenance can be read part way and the hash still takes the pages after it.
    provenance: async () => Promise.resolve({ entryId: entry.id, catalogue: dataset.catalogue, category: entry.category, source: sourceRecord(source), fetchedUrl, retrievedAt, sha256: hash.copy().digest("hex"), byteLength }),
  };
}

/**
 * The nodes of an encoded page: the crosswalk writes only the meta and the nodes, so the result is an object with a `nodes` array.
 * @param encoded - The crosswalk's output for a page.
 * @returns Its nodes.
 * @throws KeepsetError when the output is not an object with a nodes array and nothing beyond meta.
 */
function nodesOf(encoded: unknown): readonly unknown[] {
  if (typeof encoded !== "object" || encoded === null || Array.isArray(encoded) || !("nodes" in encoded) || !Array.isArray(encoded.nodes)) {
    throw new KeepsetError("the crosswalk's output is not an object with a nodes array");
  }
  const extra = Object.keys(encoded).filter((key) => key !== "meta" && key !== "nodes");
  if (extra.length > 0) {
    throw new KeepsetError(`the crosswalk's output has ${extra.join(", ")} beside meta and nodes`);
  }

  return encoded.nodes;
}

/**
 * Checks a crosswalk can run a page at a time, or fails the crosswalk step.
 * @param entry - The entry.
 * @param crosswalk - Its crosswalk.
 * @throws RecipeError when a rule reaches beyond the meta or one node's fields.
 */
function assertSeparable(entry: Entry, crosswalk: Crosswalk): void {
  const reason = inseparableRule(crosswalk);
  if (reason !== undefined) {
    throw new RecipeError(entry.id, "crosswalk", `a streamed crosswalk must apply to a page of nodes on its own: ${reason}`);
  }
}

/** What resolving a streamed table needs besides its pages: the entry, its crosswalk, the category's node and meta shapes, and the meta the crosswalk receives with every page. */
interface StreamedTable {
  readonly entry: Entry;
  readonly crosswalk: Crosswalk;
  readonly shape: ReturnType<typeof getStreamedShape>;
  readonly meta: Readonly<Record<string, JsonScalar>>;
}

/**
 * Resolves a streamed table's meta: the crosswalk applied to the meta alone, checked against the category's meta shape.
 * @param table - The table's entry, crosswalk, shape and meta.
 * @returns The resolved meta.
 * @throws RecipeError at the crosswalk step when the crosswalk fails, and at the validate step when the result is not the category's meta.
 */
async function resolveMeta(table: StreamedTable): Promise<Readonly<Record<string, JsonScalar>>> {
  const { entry, crosswalk, shape, meta } = table;

  return step(entry.id, "validate", async () => {
    const encoded: unknown = await step(entry.id, "crosswalk", () => encode(crosswalk, { meta, nodes: [] }));
    const parsed = shape.meta.safeParse(typeof encoded === "object" && encoded !== null && !Array.isArray(encoded) && "meta" in encoded ? encoded.meta : undefined);
    if (!parsed.success) {
      throw new KeepsetError(`the result's meta is not ${entry.category} meta: ${parsed.error.issues.map((issue) => `${["meta", ...issue.path.map(String)].join(".")}: ${issue.message}`).join("; ")}`);
    }

    return parsed.data;
  });
}

/**
 * Resolves one page of a streamed table's rows to nodes: the crosswalk applied to the page under the meta, each node checked against the category's node shape and for an id no earlier node had.
 * @param table - The table's entry, crosswalk, shape and meta.
 * @param rows - The page's rows.
 * @param ids - The ids of the nodes before this page, which this page's nodes are added to.
 * @returns The page's nodes.
 * @throws RecipeError at the crosswalk step when the crosswalk fails, and at the validate step when a node is not the category's or repeats an id.
 */
async function resolvePage(table: StreamedTable, rows: readonly NativeRow[], ids: IdSet): Promise<readonly StreamedNode[]> {
  const { entry, crosswalk, shape, meta } = table;
  const offset = ids.size;
  const encoded = await step(entry.id, "crosswalk", () => nodesOf(encode(crosswalk, { meta, nodes: rows })));

  return step(entry.id, "validate", () =>
    encoded.map((candidate, index) => {
      const parsed = shape.node.safeParse(candidate);
      if (!parsed.success) {
        throw new KeepsetError(`the result is not ${entry.category}: ${parsed.error.issues.map((issue) => `${["nodes", String(offset + index), ...issue.path.map(String)].join(".")}: ${issue.message}`).join("; ")}`);
      }
      if (!ids.add(parsed.data.id)) {
        throw new KeepsetError(`the result is not ${entry.category}: nodes.${String(offset + index)}.id: duplicate node id ${JSON.stringify(parsed.data.id)}`);
      }

      return parsed.data;
    }),
  );
}

/**
 * Streams a dataset a page at a time, as `streamEntry` describes: a paged table a page of rows at a time, or an archive of files a file at a time, each file its own page.
 * @param dataset - A dataset whose recipe streams.
 * @param sink - Where the meta and the nodes go.
 * @param options - The network port, store, abort signal and clock.
 * @returns The meta, the provenance, the node count and any count warnings, once every node has been handed on.
 * @throws RecipeError naming the entry and the failing step, after which the sink has had the nodes of the pages before the failure and no more; a recipe that does not stream, or a crosswalk that cannot run a page at a time, fails before anything is downloaded.
 */
export async function streamTable(dataset: Dataset, sink: NodeSink, options: FetchOptions): Promise<StreamedDataset> {
  const { entry, crosswalk } = dataset;
  const recipe = streamedRecipe(entry);
  assertSeparable(entry, crosswalk);
  const shape = getStreamedShape(recipe.category);
  const native = openNative(dataset, recipe, options);
  const table: StreamedTable = { entry, crosswalk, shape, meta: native.meta };
  const meta = await resolveMeta(table);
  await sink.meta(meta);
  const ids = new IdSet();
  for await (const rows of native.pages) {
    await sink.nodes(await resolvePage(table, rows, ids));
  }
  const counts = new Map([["nodes", ids.size]]);

  return { dataset, meta, provenance: await native.provenance(), counts, warnings: countWarnings(entry, counts) };
}

/**
 * Checks a streamed dataset's crosswalk on its real data a page at a time, from one download: crossmap's `assertRoundTrip` on the meta alone and then on each page's rows under the meta. The crosswalk applies to a page on its own, so the round trip holds on the whole table exactly when it holds on every page. Each page is also resolved to nodes exactly as `streamTable` does, so the report carries the counts and warnings of the target the table resolves to; the first page that differs is recorded and the table is still read to its end, since the counts are those of the whole table.
 * @param dataset - A dataset whose recipe streams.
 * @param options - The network port, store, abort signal and clock.
 * @returns Whether the round trip holds, and where it first differs in the whole document when it does not, with the provenance of every byte read and the counts and warnings of the resolved table.
 * @throws RecipeError naming the entry and the failing step when the recipe fails, the table does not resolve to the target or the crosswalk cannot run.
 */
export async function roundTripTable(dataset: Dataset, options: FetchOptions): Promise<RoundTripReport> {
  const { entry, crosswalk } = dataset;
  const recipe = streamedRecipe(entry);
  assertSeparable(entry, crosswalk);
  const shape = getStreamedShape(recipe.category);
  const native = openNative(dataset, recipe, options);
  const check = (nodes: readonly NativeRow[], offset: number): { readonly path: string; readonly message: string } | undefined => {
    try {
      assertRoundTrip(crosswalk, [{ meta: native.meta, nodes }]);
    } catch (error) {
      if (error instanceof RoundTripMismatchError) {
        const path = error.path.replace(/^nodes\[(\d+)\]/, (_, index: string) => `nodes[${String(offset + Number(index))}]`);

        return { path, message: error.message.replaceAll(error.path, path) };
      }
      throw new RecipeError(entry.id, "crosswalk", error instanceof Error ? error.message : String(error), { cause: error });
    }

    return undefined;
  };
  const table: StreamedTable = { entry, crosswalk, shape, meta: native.meta };
  await resolveMeta(table);
  let mismatch = check([], 0);
  const ids = new IdSet();
  let offset = 0;
  for await (const rows of native.pages) {
    await resolvePage(table, rows, ids);
    mismatch ??= check(rows, offset);
    offset += rows.length;
  }
  const counts = new Map([["nodes", ids.size]]);
  const resolved = { provenance: await native.provenance(), counts, warnings: countWarnings(entry, counts) };

  return mismatch === undefined ? { holds: true, ...resolved } : { holds: false, ...mismatch, ...resolved };
}
