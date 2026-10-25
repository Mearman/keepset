import { describe, expect, it } from "vitest";
import { parseEntry } from "../../src/entry";
import { filesCollectionEntry, liveEntry, notFetchableEntry, socrataEntry, taskEntry } from "../../src/test-support/entries";
import { countedSize, downloadBytesOf, downloadedUrls, downloadSize, DownloadSizesSchema, statedSize } from "./download-sizes";

const GZIP_SIZE = 4989;
const RAW_SIZE = 72_301;
const RECORDED_SIZE = 10;

describe("statedSize", () => {
  it("reads the size from Content-Length", () => {
    expect(statedSize(new Response(null, { headers: { "content-length": String(GZIP_SIZE) } }))).toBe(GZIP_SIZE);
  });

  it("reads the whole size from the total of a range response", () => {
    expect(statedSize(new Response(null, { status: 206, headers: { "content-range": `bytes 0-0/${String(RAW_SIZE)}`, "content-length": "1" } }))).toBe(RAW_SIZE);
  });

  it("states no size for a failed response, whose length is its error page's", () => {
    expect(statedSize(new Response(null, { status: 403, headers: { "content-length": String(GZIP_SIZE) } }))).toBeUndefined();
  });

  it("states no size for an empty, absent or unknown length", () => {
    expect(statedSize(new Response(null, { headers: { "content-length": "0" } }))).toBeUndefined();
    expect(statedSize(new Response(null))).toBeUndefined();
    expect(statedSize(new Response(null, { status: 206, headers: { "content-range": "bytes 0-0/*" } }))).toBeUndefined();
  });
});

describe("countedSize", () => {
  const stream = (chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(controller): void {
        chunks.forEach((chunk) => {
          controller.enqueue(chunk);
        });
        controller.close();
      },
    });

  it("counts the bytes of every chunk of a body", async () => {
    const chunks = [new Uint8Array(GZIP_SIZE), new Uint8Array(RECORDED_SIZE), new Uint8Array(1)];

    expect(await countedSize(stream(chunks))).toBe(GZIP_SIZE + RECORDED_SIZE + 1);
  });

  it("states no size for an absent or empty body", async () => {
    expect(await countedSize(null)).toBeUndefined();
    expect(await countedSize(stream([]))).toBeUndefined();
  });
});

describe("downloadSize", () => {
  const sizes = DownloadSizesSchema.parse({ readOn: "2026-10-24", sizes: { "https://example.org/a.zip": RECORDED_SIZE } });

  it("reads the size recorded for a URL and none for another", () => {
    expect(downloadSize(sizes, "https://example.org/a.zip")).toBe(RECORDED_SIZE);
    expect(downloadSize(sizes, "https://example.org/b.zip")).toBeUndefined();
    expect(downloadSize(sizes, "__proto__")).toBeUndefined();
  });

  it("accepts a size only as a positive whole number of bytes", () => {
    expect(DownloadSizesSchema.safeParse({ readOn: "2026-10-24", sizes: { "https://example.org/a.zip": 0 } }).success).toBe(false);
    expect(DownloadSizesSchema.safeParse({ readOn: "2026-10-24", sizes: { "https://example.org/a.zip": 1.5 } }).success).toBe(false);
  });
});

describe("downloadedUrls", () => {
  it("names the source a recipe downloads, and each distinct file's source of a collection of files", () => {
    expect(downloadedUrls(parseEntry(liveEntry))).toEqual(["https://example.org/data/karate.txt"]);
    expect(downloadedUrls(parseEntry(filesCollectionEntry))).toEqual(["https://example.org/data/routes/north.csv", "https://example.org/data/routes/south.csv", "https://example.org/data/routes/more.zip"]);
  });

  it("names nothing for a paged query, which is read a page at a time", () => {
    expect(downloadedUrls(parseEntry(socrataEntry))).toEqual([]);
  });

  it("names a graph's first source when it has no recipe, and no source of another category's, whose sources are landing pages", () => {
    expect(downloadedUrls(parseEntry(notFetchableEntry))).toEqual(["https://example.com/datasets/walled"]);
    expect(downloadedUrls(parseEntry({ ...taskEntry, recipe: { status: "not-fetchable", reason: "no table" } }))).toEqual([]);
  });
});

describe("downloadBytesOf", () => {
  const north = "https://example.org/data/routes/north.csv";
  const south = "https://example.org/data/routes/south.csv";
  const more = "https://example.org/data/routes/more.zip";

  it("sums the sizes of every download of a collection of files", () => {
    const parts = { [north]: 1, [south]: 20, [more]: 300 };
    const sizes = DownloadSizesSchema.parse({ readOn: "2026-10-24", sizes: parts });
    expect(downloadBytesOf(parseEntry(filesCollectionEntry), sizes)).toBe(Object.values(parts).reduce((total, part) => total + part, 0));
  });

  it("is unknown when any download has no size, never a partial sum", () => {
    const sizes = DownloadSizesSchema.parse({ readOn: "2026-10-24", sizes: { [north]: 1, [south]: 20 } });
    expect(downloadBytesOf(parseEntry(filesCollectionEntry), sizes)).toBeUndefined();
  });

  it("is unknown for an entry with no download", () => {
    expect(downloadBytesOf(parseEntry(socrataEntry), DownloadSizesSchema.parse({ readOn: "2026-10-24", sizes: {} }))).toBeUndefined();
  });
});
