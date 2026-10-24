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
 * The size a response states for the whole of its body: its Content-Length, or for a range response the total after the slash of its Content-Range.
 * @param headers - The response's headers.
 * @returns The size in bytes, or undefined when the response states none.
 */
export function statedSize(headers: Headers): number | undefined {
  const range = /^bytes \d+-\d+\/(\d+)$/.exec(headers.get("content-range") ?? "")?.[1];
  const length = range === undefined ? Number(headers.get("content-length")) : Number(range);

  return Number.isInteger(length) && length > 0 ? length : undefined;
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
