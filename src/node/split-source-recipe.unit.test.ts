import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { parseEntry } from "../entry";
import { captureRequestsFor } from "../resolve";
import { gzip, tar } from "../test-support/archives";
import { fetchEntry, fileStore, roundTripEntry, type FetchPort, type StorePort } from "./fetch-dataset";

const archive = gzip(tar([{ path: "samples/piano0.wav", text: "audio" }, { path: "samples/simons1.wav", text: "audio" }]));
const cut = Math.floor(archive.length / 2);
const parts = [archive.subarray(0, cut), archive.subarray(cut)];
const urls = ["https://example.test/source.aa", "https://example.test/source.ab"];
const serving: FetchPort = async (url) => {
  if (url.startsWith("https://archive.org/wayback/available")) return Promise.resolve(new Response(JSON.stringify({ archived_snapshots: {} })));
  const index = urls.indexOf(url);
  if (index < 0) throw new Error(`unexpected URL ${url}`);

  return Promise.resolve(new Response(parts[index], { headers: { "content-encoding": "gzip" } }));
};

describe("a collection file split across downloads", () => {
  it("fetches, concatenates and round-trips the archive with each part's provenance", async () => {
    const base = getDataset("openslr-slr81-transcripts");
    const recipe = base.entry.recipe;
    if (recipe.status !== "fetchable" || !("source" in recipe)) throw new Error("expected one source");
    const entry = parseEntry({ ...base.entry, sources: urls.map((url) => ({ url, status: "live", retrieved: "2026-11-06" })), expectedCounts: { instances: 1 }, recipe: { status: "fetchable", files: [{ path: "joined", source: [0, 1], archive: recipe.archive }], parser: recipe.parser } });
    const dataset = { ...base, entry };
    const result = await fetchEntry(dataset, { fetch: serving });
    if (!("instances" in result.data) || !("files" in result.provenance)) throw new Error("expected a collection");
    expect(result.data.instances[0]?.nodes).toMatchObject([{ id: "piano0", label: "piano" }, { id: "simons1", label: "simons" }]);
    const download = result.provenance.files[0];
    if (download === undefined || !("parts" in download)) throw new Error("expected part provenance");
    expect(download.parts.map((part) => part.sha256)).toEqual(parts.map((part) => createHash("sha256").update(part).digest("hex")));
    expect(download.parts.map((part) => part.fetchedUrl)).toEqual(urls);
    expect(captureRequestsFor(result.provenance)).toHaveLength(2);
    expect(result.warnings).toEqual([]);
    expect(await roundTripEntry(dataset, { fetch: serving })).toMatchObject({ holds: true, warnings: [] });
  });

  it("rejects a corrupt final part and refuses duplicate or missing source indices", async () => {
    const base = getDataset("openslr-slr81-transcripts");
    const recipe = base.entry.recipe;
    if (recipe.status !== "fetchable" || !("source" in recipe)) throw new Error("expected one source");
    const create = (source: readonly number[]): unknown => ({ ...base.entry, sources: urls.map((url) => ({ url, status: "live", retrieved: "2026-11-06" })), expectedCounts: { instances: 1 }, recipe: { status: "fetchable", files: [{ path: "joined", source, archive: recipe.archive }], parser: recipe.parser } });
    expect(() => parseEntry(create([0, 0]))).toThrow();
    expect(() => parseEntry(create([0, 2]))).toThrow();
    const entry = parseEntry(create([0, 1]));
    const broken: FetchPort = async (url, init) => url === urls[1] ? Promise.resolve(new Response(parts[1]?.subarray(0, -1))) : serving(url, init);
    await expect(fetchEntry({ ...base, entry }, { fetch: broken })).rejects.toThrow();
  });

  it("releases earlier parts when a later download fails", async () => {
    const base = getDataset("openslr-slr81-transcripts");
    const recipe = base.entry.recipe;
    if (recipe.status !== "fetchable" || !("source" in recipe)) throw new Error("expected one source");
    const entry = parseEntry({ ...base.entry, sources: urls.map((url) => ({ url, status: "live", retrieved: "2026-11-06" })), expectedCounts: { instances: 1 }, recipe: { status: "fetchable", files: [{ path: "joined", source: [0, 1], archive: recipe.archive }], parser: recipe.parser } });
    const files = fileStore();
    let closed = 0;
    const store: StorePort = {
      hold: files.hold,
      async keep(response, request) {
        const kept = await files.keep(response, request);

        return { ...kept, async close() { closed += 1; await kept.close(); } };
      },
    };
    const missing: FetchPort = async (url, init) => url === urls[1] ? Promise.resolve(new Response(null, { status: 404 })) : serving(url, init);
    await expect(fetchEntry({ ...base, entry }, { fetch: missing, store })).rejects.toThrow();
    expect(closed).toBe(1);
  });
});
