import { z } from "zod";
import { KeepsetError } from "./errors";
import type { Paging } from "./entry";
import type { FetchPort } from "./fetch";

const countResponse = (value: unknown): number | undefined => (typeof value === "object" && value !== null && "count" in value && typeof value.count === "number" && Number.isInteger(value.count) && value.count >= 0 ? value.count : undefined);

/**
 * The error message an ArcGIS server returns in a 200 response, if the body is one.
 * @param value - A parsed response body.
 * @returns The message, or undefined when the body is not an error.
 */
function arcgisError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("error" in value)) {
    return undefined;
  }
  const { error } = value;

  return typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "the server returned an error";
}

/**
 * Reads one JSON response of the layer's query endpoint.
 * @param port - The network port.
 * @param url - The request URL.
 * @param signal - Aborts the request.
 * @returns The parsed body.
 * @throws KeepsetError when the server does not answer successfully, the body is not JSON, or it is an ArcGIS error.
 */
async function getJson(port: FetchPort, url: string, signal: AbortSignal | undefined): Promise<unknown> {
  const response = await port(url, signal === undefined ? {} : { signal });
  if (!response.ok) {
    // The body is never read, so its connection is let go of now rather than whenever the response is collected.
    await response.body?.cancel();
    throw new KeepsetError(`${url} answered ${String(response.status)} ${response.statusText}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8").decode(new Uint8Array(await response.arrayBuffer())));
  } catch (error) {
    throw new KeepsetError(`${url} did not answer JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const message = arcgisError(body);
  if (message !== undefined) {
    throw new KeepsetError(`${url} answered an error: ${message}`);
  }

  return body;
}

/** What a layer read needs at every page: where the layer is, how its pages are ordered, how many features it holds, and how to reach it. */
interface LayerRead {
  readonly query: string;
  readonly orderBy: string;
  readonly count: number;
  readonly port: FetchPort;
  readonly signal: AbortSignal | undefined;
}

const FeatureListSchema = z.array(z.unknown());

/**
 * Reads a layer's features page by page, each request starting where the features held so far end.
 * @param layer - The layer read.
 * @param held - The features read so far.
 * @returns Every feature of the layer.
 * @throws KeepsetError when a page is empty before the count is reached or the server answers an error.
 */
async function readPages(layer: Readonly<LayerRead>, held: readonly unknown[]): Promise<readonly unknown[]> {
  if (held.length >= layer.count) {
    return held;
  }
  const url = `${layer.query}?where=1%3D1&outFields=*&orderByFields=${encodeURIComponent(layer.orderBy)}&resultOffset=${String(held.length)}&f=geojson`;
  const page = await withAttempts(async () => getJson(layer.port, url, layer.signal), layer.signal);
  const features = FeatureListSchema.safeParse(typeof page === "object" && page !== null && "features" in page ? page.features : undefined);
  if (!features.success || features.data.length === 0) {
    throw new KeepsetError(`${layer.query} gave no features at offset ${String(held.length)}, before the ${String(layer.count)} it reports, so it does not page by offset`);
  }

  return readPages(layer, [...held, ...features.data]);
}

/**
 * Downloads a whole ArcGIS feature layer as one GeoJSON feature collection: the layer's feature count is read first, then its pages in `orderBy` order by offset until every feature is held, so a server that ignores the offset is an error and not an endless loop.
 * @param layerUrl - The layer's URL, such as `.../FeatureServer/0`.
 * @param orderBy - The field the pages are ordered by.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns The bytes of one `FeatureCollection`, which is what the parser reads and what the provenance hashes.
 * @throws KeepsetError when the layer does not report a count, a page is empty before the count is reached, or the server answers an error.
 */
async function downloadArcgisLayer(layerUrl: string, orderBy: string, port: FetchPort, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const query = `${layerUrl.replace(/\/+$/, "")}/query`;
  const count = countResponse(await getJson(port, `${query}?where=1%3D1&returnCountOnly=true&f=json`, signal));
  if (count === undefined) {
    throw new KeepsetError(`${layerUrl} did not report a feature count`);
  }
  const pages = await readPages({ query, orderBy, count, port, signal }, []);

  return new TextEncoder().encode(JSON.stringify({ type: "FeatureCollection", features: pages }));
}

/** How many times a page is requested before the download fails: a connection can drop or go silent in one request of dozens and succeed in the next, and the pages are read by offset so asking again is exact. */
const PAGE_ATTEMPTS = 3;

/**
 * Runs one page read, asking again when it fails, so one bad response of a long download does not lose the rest.
 * @param read - The page read.
 * @param signal - Aborts the download, which is not asked again.
 * @param attempt - Which attempt this is, from 1.
 * @returns What the read returns.
 * @throws The last failure, when the attempts are used up or the download was aborted.
 */
async function withAttempts<Result>(read: () => Promise<Result>, signal: AbortSignal | undefined, attempt = 1): Promise<Result> {
  try {
    return await read();
  } catch (error) {
    if (attempt >= PAGE_ATTEMPTS || signal?.aborted === true) {
      throw error;
    }

    return withAttempts(read, signal, attempt + 1);
  }
}

const LINE_FEED = 0x0a;
const QUOTE = 0x22;

/**
 * How many CSV records a response holds: the line feeds outside a quoted field, and one more when the last record has no line feed.
 * @param bytes - A CSV response.
 * @returns The number of records, the header included.
 */
function recordsIn(bytes: Uint8Array): number {
  let records = 0;
  let quoted = false;
  for (const byte of bytes) {
    if (byte === QUOTE) {
      quoted = !quoted;
    } else if (byte === LINE_FEED && !quoted) {
      records += 1;
    }
  }

  return bytes.length > 0 && bytes[bytes.length - 1] !== LINE_FEED ? records + 1 : records;
}

/**
 * Reads one response of a Socrata resource endpoint as bytes.
 * @param port - The network port.
 * @param url - The request URL.
 * @param signal - Aborts the request.
 * @returns The response body.
 * @throws KeepsetError when the server does not answer successfully.
 */
async function getBytes(port: FetchPort, url: string, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const response = await port(url, signal === undefined ? {} : { signal });
  if (!response.ok) {
    // The body is never read, so its connection is let go of now rather than whenever the response is collected.
    await response.body?.cancel();
    throw new KeepsetError(`${url} answered ${String(response.status)} ${response.statusText}`);
  }

  return new Uint8Array(await response.arrayBuffer());
}

/** What a paged CSV read needs at every page: the source's name for errors, the URL of the page that starts at a row, how many rows a page holds, how many rows the source has, and how to reach it. */
interface ResourceRead {
  readonly resource: string;
  readonly pageUrl: (offset: number) => string;
  readonly pageSize: number;
  readonly count: number;
  readonly port: FetchPort;
  readonly signal: AbortSignal | undefined;
}

/**
 * Reads a source's pages in order, each starting where the rows read so far end, and checks each holds exactly the rows it should, so a response cut short is an error and not a table with rows missing. Only the page being read and the first page's header are held, so a caller that hands each page on holds no more of the source than that.
 * @param read - The source read.
 * @returns Each page, the first with its header record and every later one without it.
 * @throws KeepsetError when the source has no rows, a page holds a different number of rows than the count says it should, or its header differs from the first page's.
 */
async function* resourcePages(read: Readonly<ResourceRead>): AsyncGenerator<Uint8Array, void, undefined> {
  if (read.count === 0) {
    throw new KeepsetError(`${read.resource} has no rows`);
  }
  yield* pagesFrom(read, 0, undefined);
}

/**
 * Reads one page and then, by recursion, the pages after it.
 * @param read - The source read.
 * @param offset - The row the page starts at.
 * @param header - The first page's header record, or undefined when this is the first page.
 * @returns This page and every page after it.
 * @throws KeepsetError as `resourcePages` does.
 */
async function* pagesFrom(read: Readonly<ResourceRead>, offset: number, header: Uint8Array | undefined): AsyncGenerator<Uint8Array, void, undefined> {
  if (offset >= read.count) {
    return;
  }
  const expected = Math.min(read.pageSize, read.count - offset);
  const page = await withAttempts(async () => {
    const bytes = await getBytes(read.port, read.pageUrl(offset), read.signal);
    const rows = recordsIn(bytes) - 1;
    if (rows !== expected) {
      throw new KeepsetError(`${read.resource} gave ${String(rows)} rows at offset ${String(offset)} where ${String(expected)} of its ${String(read.count)} were due, so a response was cut short or the table changed during the download`);
    }

    return bytes;
  }, read.signal);
  const headerEnd = page.indexOf(LINE_FEED) + 1;
  if (header === undefined) {
    yield page;
    // A copy, so holding the header does not hold the whole first page.
    yield* pagesFrom(read, offset + expected, page.slice(0, headerEnd));

    return;
  }
  if (headerEnd !== header.length || !page.subarray(0, headerEnd).every((byte, index) => byte === header[index])) {
    throw new KeepsetError(`${read.resource} gave a different header at offset ${String(offset)} than at the start`);
  }
  yield page.subarray(headerEnd);
  yield* pagesFrom(read, offset + expected, header);
}

/**
 * Downloads a CSV source a page at a time and joins the pages under the first header.
 * @param read - The source read, with its count.
 * @returns The bytes of one CSV, which is what the parser reads and what the provenance hashes.
 * @throws KeepsetError when the source has no rows or a page is not what it should be.
 */
async function downloadPages(read: Readonly<ResourceRead>): Promise<Uint8Array> {
  const pages: Uint8Array[] = [];
  for await (const page of resourcePages(read)) {
    pages.push(page);
  }

  return Buffer.concat(pages);
}

/** The paging kinds whose pages are CSV, each with its own header. */
export type CsvPaging = Exclude<Paging, { readonly kind: "arcgis-query" }>;

/**
 * How a Socrata resource is read: its row count is read first, then pages of `pageSize` rows in the order of the rows' ids, with only the `select` columns when the recipe lists them, so the columns a parser drops are never transferred.
 * @param resource - The resource's URL, such as `https://data.example.org/resource/abcd-1234.csv`, without a query.
 * @param paging - The recipe's paging.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns The source read.
 * @throws KeepsetError when the resource does not report a count.
 */
async function socrataRead(resource: string, paging: Extract<Paging, { readonly kind: "socrata-resource" }>, port: FetchPort, signal: AbortSignal | undefined): Promise<ResourceRead> {
  const reported = /^"count"\r?\n"(\d+)"/.exec(new TextDecoder("utf-8").decode(await getBytes(port, `${resource}?%24select=count(*)`, signal)));
  if (reported?.[1] === undefined) {
    throw new KeepsetError(`${resource} did not report a row count`);
  }
  const { pageSize, select } = paging;
  const columns = select === undefined ? "" : `%24select=${encodeURIComponent(select.join(","))}&`;

  return { resource, pageUrl: (offset) => `${resource}?${columns}%24order=%3Aid&%24limit=${String(pageSize)}&%24offset=${String(offset)}`, pageSize, count: Number(reported[1]), port, signal };
}

const CountResultSchema = z.object({ result: z.object({ total: z.int().min(0) }) });

/**
 * How a CKAN datastore table is read: the row count is read from the portal's datastore API, then pages of `pageSize` rows of the table's CSV dump.
 * @param dump - The dump's URL, such as `https://data.example.org/datastore/dump/<resource id>`, without a query; a portal that serves CKAN under a path prefix keeps it before `/datastore/dump/`.
 * @param pageSize - How many rows a page holds.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns The source read.
 * @throws KeepsetError when the URL is not a datastore dump or the table does not report a count.
 */
async function ckanRead(dump: string, pageSize: number, port: FetchPort, signal: AbortSignal | undefined): Promise<ResourceRead> {
  const parsed = /^(.*)\/datastore\/dump\/([^/?#]+)$/.exec(dump);
  if (parsed?.[1] === undefined || parsed[2] === undefined) {
    throw new KeepsetError(`${dump} is not a CKAN datastore dump URL`);
  }
  const url = `${parsed[1]}/api/3/action/datastore_search?resource_id=${parsed[2]}&limit=0`;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8").decode(await getBytes(port, url, signal)));
  } catch (error) {
    throw new KeepsetError(`${url} did not answer JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const count = CountResultSchema.safeParse(body);
  if (!count.success) {
    throw new KeepsetError(`${dump} did not report a row count`);
  }

  return { resource: dump, pageUrl: (offset) => `${dump}?format=csv&limit=${String(pageSize)}&offset=${String(offset)}`, pageSize, count: count.data.result.total, port, signal };
}

const OpenFemaCountSchema = z.object({ metadata: z.object({ count: z.int().min(0) }) });

/**
 * How an OpenFEMA entity, or the rows of it the source URL selects, is read: the row count is read from the API's own metadata, then pages of `pageSize` rows in the order of the entity's id.
 * @param entity - The entity's URL with any `$select` or `$filter` but no `$top`, `$skip`, `$orderby` or `$format`, such as `https://www.fema.gov/api/open/v3/NfipClaims?$select=id,state`.
 * @param pageSize - How many rows a page holds.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns The source read.
 * @throws KeepsetError when the source URL sets a paging parameter or the entity does not report a count.
 */
async function openFemaRead(entity: string, pageSize: number, port: FetchPort, signal: AbortSignal | undefined): Promise<ResourceRead> {
  const base = new URL(entity);
  for (const name of ["$top", "$skip", "$orderby", "$format", "$inlinecount"]) {
    if (base.searchParams.has(name)) {
      throw new KeepsetError(`${entity} sets ${name}, which the download sets itself`);
    }
  }
  const withParameters = (parameters: Readonly<Record<string, string>>): string => {
    const url = new URL(entity);
    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(name, value);
    }

    return url.href;
  };
  const countUrl = withParameters({ $inlinecount: "allpages", $top: "1" });
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8").decode(await withAttempts(async () => getBytes(port, countUrl, signal), signal)));
  } catch (error) {
    throw new KeepsetError(`${countUrl} did not answer JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const count = OpenFemaCountSchema.safeParse(body);
  if (!count.success) {
    throw new KeepsetError(`${entity} did not report a row count`);
  }

  return { resource: entity, pageUrl: (offset) => withParameters({ $format: "csv", $orderby: "id", $top: String(pageSize), $skip: String(offset) }), pageSize, count: count.data.metadata.count, port, signal };
}

/**
 * How a CSV paged source is read, in the way its recipe's paging says.
 * @param url - The source's URL.
 * @param paging - How the source is paged.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns The source read.
 */
async function csvRead(url: string, paging: Readonly<CsvPaging>, port: FetchPort, signal: AbortSignal | undefined): Promise<ResourceRead> {
  if (paging.kind === "socrata-resource") {
    return socrataRead(url, paging, port, signal);
  }

  return paging.kind === "ckan-datastore" ? ckanRead(url, paging.pageSize, port, signal) : openFemaRead(url, paging.pageSize, port, signal);
}

/**
 * Reads a CSV paged source a page at a time: the first page with its header and every later page without it, so the pages in order are the one CSV `downloadPaged` joins them into. Only the page being read is held.
 * @param url - The source's URL.
 * @param paging - How the source is paged.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns Each page's bytes, in order.
 * @throws KeepsetError when the source does not report a count, has no rows, or a page is not what it should be.
 */
export async function* csvPages(url: string, paging: Readonly<CsvPaging>, port: FetchPort, signal: AbortSignal | undefined): AsyncGenerator<Uint8Array, void, undefined> {
  yield* resourcePages(await csvRead(url, paging, port, signal));
}

/**
 * Downloads a paged source as the one file its pages make, in the way its recipe's paging says: an ArcGIS layer as one GeoJSON feature collection, any other source as one CSV of its pages joined under the first page's header.
 * @param url - The source's URL.
 * @param paging - How the source is paged.
 * @param port - The network port.
 * @param signal - Aborts the download.
 * @returns The bytes the parser reads.
 * @throws KeepsetError when a page cannot be read or the pages do not add up to what the source reports.
 */
export async function downloadPaged(url: string, paging: Readonly<Paging>, port: FetchPort, signal: AbortSignal | undefined): Promise<Uint8Array> {
  if (paging.kind === "arcgis-query") {
    return downloadArcgisLayer(url, paging.orderBy, port, signal);
  }

  return downloadPages(await csvRead(url, paging, port, signal));
}
