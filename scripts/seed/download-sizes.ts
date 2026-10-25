import { z } from "zod";
import type { Entry } from "../../src/entry";

/* The size of each download a recipe fetches, as the host serving it reports it. The source catalogue states a size for few datasets and states the raw data's, not the download's, so probe-download-sizes.ts asks each host and commits the answers, and the import reads the committed copy and never the network. */

/** The sizes: the day they were read and, for each download URL, its size in bytes. */
export const DownloadSizesSchema = z
  .object({
    readOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date, YYYY-MM-DD" }),
    sizes: z.record(z.url(), z.int().positive()),
  })
  .strict();
export type DownloadSizes = z.infer<typeof DownloadSizesSchema>;

/**
 * The size of a download.
 * @param sizes - The committed sizes.
 * @param url - The download's URL.
 * @returns The size in bytes, or undefined when no host reported one.
 */
export function downloadSize(sizes: DownloadSizes, url: string): number | undefined {
  return Object.hasOwn(sizes.sizes, url) ? sizes.sizes[url] : undefined;
}

/**
 * The size a response states for the whole of its body: its Content-Length, or for a range response the total after the slash of its Content-Range. A response that is not a success states the size of its error page, which is no download's, so it states none.
 * @param response - The response.
 * @returns The size in bytes, or undefined when the response failed or states none.
 */
export function statedSize(response: Pick<Response, "headers" | "ok">): number | undefined {
  if (!response.ok) {
    return undefined;
  }
  const range = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get("content-range") ?? "")?.[1];
  const length = range === undefined ? Number(response.headers.get("content-length")) : Number(range);

  return Number.isInteger(length) && length > 0 ? length : undefined;
}

/**
 * The size of a body counted by reading it to its end, for a host that states no length: the bytes a fetch receives, after any content encoding is undone, which are the bytes a recipe's fetch reads.
 * @param body - The response body, which is consumed.
 * @returns The number of bytes, or undefined when the body is absent or empty.
 */
export async function countedSize(body: ReadableStream<Uint8Array> | null): Promise<number | undefined> {
  if (body === null) {
    return undefined;
  }
  const reader = body.getReader();
  const read = async (total: number): Promise<number> => {
    const chunk = await reader.read();

    return chunk.done ? total : read(total + chunk.value.byteLength);
  };
  const total = await read(0);

  return total > 0 ? total : undefined;
}

/**
 * The URLs of the downloads an entry's recipe fetches whole: the source of a recipe that downloads one, or each file's source in a collection of files. A paged query is read a page at a time, so it has no download to size. An entry with no recipe offers, for a graph, the first source its catalogue lists, which is a download; for any other category the sources of such an entry are landing pages, which are no download.
 * @param entry - The entry.
 * @returns The distinct URLs, in order, none when the entry has no download.
 */
export function downloadedUrls(entry: Entry): readonly string[] {
  const { recipe } = entry;
  const indexes =
    "files" in recipe ? recipe.files.map((file) => file.source)
    : "source" in recipe ? (recipe.paging === undefined ? [recipe.source] : [])
    : entry.category === "graph/v1" ? [0]
    : [];

  return [...new Set(indexes.flatMap((index) => entry.sources[index]?.url ?? []))];
}

/**
 * The size of the download an entry's recipe fetches: the sum of its downloads' sizes, each the byte length recorded with the pinned snapshot a fetch resolves first, else the size the host stated.
 * @param entry - The entry, with the checksums its pinned snapshots record.
 * @param sizes - The committed sizes.
 * @returns The size in bytes, or undefined when the entry has no download or one of its downloads has no known size.
 */
export function downloadBytesOf(entry: Entry, sizes: DownloadSizes): number | undefined {
  const urls = downloadedUrls(entry);
  const parts = urls.map((url) => entry.sources.find((source) => source.url === url)?.snapshot?.byteLength ?? downloadSize(sizes, url));

  return urls.length === 0 || parts.some((part) => part === undefined) ? undefined : parts.reduce<number>((total, part) => total + (part ?? 0), 0);
}
