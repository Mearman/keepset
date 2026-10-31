import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createCatalogue, type Dataset } from "../catalogue";
import type { FetchPort } from "../fetch";
import { bytesSource, type StoredSource, type StorePort } from "../source-bytes";
import { fixtureIndex, liveEntry } from "../test-support/entries";
import { allowance } from "../test-support/allowance";
import { lazyGzip, lazyTar, rechunk, retainedBufferBytes } from "../test-support/streams";
import { sevenZip as sevenZipBytes, sevenZipFolder, type SevenZipSettings } from "../test-support/seven-zip";
import { fileStore } from "./file-store";
import { fetchEntry } from "./fetch-dataset";
import { sevenZipReader, type SevenZipRun } from "./seven-zip";

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;

/** The memory a fetch of a large archive may retain beyond what it held before it began: a chunk read back from the kept file, what one gzip feed decompresses to, the tar reader's unread bytes, the selected member and the streams' own queues, each about a mebibyte at most, so eight of them leave room to spare. */
const BUDGET_MEBIBYTES = 8;
const MEMORY_BUDGET = BUDGET_MEBIBYTES * MEBIBYTE;
/** A member the recipe does not select, several times the budget, so a fetch that held the source, decompressed or not, would retain far more than the budget. */
const BUDGETS_OF_FILLER = 4;
const FILLER_BYTES = BUDGETS_OF_FILLER * MEMORY_BUDGET;
/** The size of the pieces the source arrives in (a quarter of a mebibyte, so the filler is a hundred and more of them), and how many of them pass between two measurements, so each phase of the fetch is measured several times over its length. */
const PIECES_PER_MEBIBYTE = 4;
const PIECE_BYTES = MEBIBYTE / PIECES_PER_MEBIBYTE;
const MEASURE_EVERY = 16;
/** The time one mebibyte of the filler takes through the whole pipeline (generated, gzipped, hashed, written to the kept file, read back, gunzipped and scanned, with a garbage collection at each measurement) alone on a quiet host, rounded up. */
const QUIET_MILLISECONDS_PER_FILLER_MEBIBYTE = 70;
const FETCH_TIMEOUT_MILLISECONDS = allowance((FILLER_BYTES / MEBIBYTE) * QUIET_MILLISECONDS_PER_FILLER_MEBIBYTE);

const karate = "% karate excerpt\n1 2\n2 3\n3 1\n";
const now = (): Date => new Date("2026-10-31T12:00:00.000Z");

const datasetWith = (entry: unknown): Dataset => createCatalogue({ ...fixtureIndex, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the fixture catalogue lists its one entry");

/** The most bytes the process retains at any measurement, beyond what it retained at the start. */
class Peak {
  public most = 0;

  private baseline = 0;

  /** Takes what the process retains now as the start. */
  public async start(): Promise<void> {
    this.baseline = await retainedBufferBytes();
  }

  /**
   * Measures what the process retains, every so many pieces of a stream.
   * @param index - Which piece this is.
   */
  public async measure(index: number): Promise<void> {
    if (index % MEASURE_EVERY === 0) {
      this.most = Math.max(this.most, (await retainedBufferBytes()) - this.baseline);
    }
  }
}

describe("a fetch of a source larger than memory", () => {
  it("downloads, hashes, decompresses and scans a tar.gz far larger than the memory budget while retaining less than it, and keeps only the selected member", async () => {
    const peak = new Peak();
    const hash = createHash("sha256");
    let byteLength = 0;
    const members = [
      { path: "net/filler.bin", size: FILLER_BYTES, bytes: (_offset: number, length: number): Uint8Array => randomBytes(length) },
      { path: "net/karate.txt", size: karate.length, bytes: (offset: number, length: number): Uint8Array => new TextEncoder().encode(karate.slice(offset, offset + length)) },
    ];
    const pieces = rechunk(lazyGzip(lazyTar(members, PIECE_BYTES)), PIECE_BYTES);
    let index = 0;
    // The archive is made as the fetch pulls it and hashed here as it goes, so neither side of the test holds it.
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await peak.measure(index);
          index += 1;
          const next = pieces.next();
          if (next.done === true) {
            controller.close();

            return;
          }
          hash.update(next.value);
          byteLength += next.value.length;
          controller.enqueue(next.value);
        },
      },
      { highWaterMark: 0 },
    );
    // The source has no snapshot, so the chain asks the availability API first, which holds no capture here, and then reads the live URL.
    const fetch: FetchPort = async (requested) => Promise.resolve(requested === liveEntry.sources[0]?.url ? new Response(body) : new Response(null, { status: 404 }));
    const files = fileStore();
    // Node's own store, with each chunk it reads back from the kept file measured on the way, so the reading is measured as the download is.
    const store: StorePort = {
      keep: async (response, request) => {
        const kept: StoredSource = await files.keep(response, request);
        let read = 0;

        return {
          ...kept,
          async *chunks() {
            for await (const chunk of kept.chunks()) {
              await peak.measure(read);
              read += 1;
              yield chunk;
            }
          },
        };
      },
      hold: async (bytes) => files.hold(bytes),
    };
    const entry = { ...liveEntry, expectedCounts: { nodes: 3, edges: 3 }, recipe: { ...liveEntry.recipe, archive: { kind: "tar.gz", member: { path: "karate.txt" } } } };
    await peak.start();
    const fetched = await fetchEntry(datasetWith(entry), { fetch, store, now });
    expect(fetched.data).toMatchObject({ nodes: [{ id: "1" }, { id: "2" }, { id: "3" }] });
    expect(fetched.provenance).toMatchObject({ sha256: hash.digest("hex"), byteLength, member: "net/karate.txt" });
    expect(byteLength).toBeGreaterThan(FILLER_BYTES);
    expect(index).toBeGreaterThan(MEASURE_EVERY);
    expect(peak.most).toBeLessThan(MEMORY_BUDGET);
  }, FETCH_TIMEOUT_MILLISECONDS);
});

describe("a fetch of a solid 7z archive larger than memory", () => {
  /** The time one mebibyte of the filler takes through the whole pipeline here (written to disk, compressed with LZMA, read back as the download, hashed, kept, and decoded by 7-Zip in its worker) alone on a quiet host: the tar.gz test's figure scaled by the work LZMA adds, since compressing with it costs several times what gzipping does. */
  const LZMA_WORK_FACTOR = 10;
  const QUIET_MILLISECONDS_PER_SOLID_MEBIBYTE = LZMA_WORK_FACTOR * QUIET_MILLISECONDS_PER_FILLER_MEBIBYTE;
  const SOLID_TIMEOUT_MILLISECONDS = allowance((FILLER_BYTES / MEBIBYTE) * QUIET_MILLISECONDS_PER_SOLID_MEBIBYTE);

  it(
    "downloads, hashes and decodes a solid 7z far larger than the memory budget while retaining less than it in the process and in 7-Zip's heap, and keeps only the selected member",
    async () => {
      const folder = await mkdtemp(join(tmpdir(), "keepset-large-7z-"));
      try {
        const input = join(folder, "in");
        await mkdir(join(input, "net"), { recursive: true });
        // The filler goes first in the solid block and the selected member after it, so reaching the member decodes all of the filler; it is written a piece at a time, so neither it nor the archive is held.
        const pieces = function* (): Generator<Uint8Array, void, undefined> {
          for (let offset = 0; offset < FILLER_BYTES; offset += PIECE_BYTES) {
            yield randomBytes(PIECE_BYTES);
          }
        };
        await pipeline(Readable.from(pieces()), createWriteStream(join(input, "net", "a-filler.bin")));
        await writeFile(join(input, "net", "karate.txt"), karate);
        const archivePath = join(folder, "net.7z");
        // A mebibyte's dictionary, which the decoder holds whole, so the filler is many dictionaries long and the window wraps over it.
        const settings: SevenZipSettings = { solid: true, method: "LZMA", dictionaryBytes: MEBIBYTE, level: 1 };
        await sevenZipFolder(input, archivePath, settings);

        const runs: SevenZipRun[] = [];
        const sevenZip = sevenZipReader({
          observe: (run) => {
            runs.push(run);
          },
        });
        // 7-Zip's heap before it reads anything large: what listing a one-member archive grows it to.
        await sevenZip.list(bytesSource(await sevenZipBytes([{ path: "one.txt", bytes: new TextEncoder().encode(karate) }], settings)));
        const baseline = runs.at(-1)?.heapBytes ?? expect.unreachable("7-Zip reported its heap");

        const peak = new Peak();
        const hash = createHash("sha256");
        let byteLength = 0;
        let index = 0;
        const archive = await open(archivePath, "r");
        const archiveSize = (await archive.stat()).size;
        const body = new ReadableStream<Uint8Array>(
          {
            async pull(controller) {
              await peak.measure(index);
              index += 1;
              const piece = new Uint8Array(PIECE_BYTES);
              const { bytesRead } = await archive.read(piece, 0, PIECE_BYTES, byteLength);
              if (bytesRead === 0) {
                controller.close();

                return;
              }
              const chunk = piece.subarray(0, bytesRead);
              hash.update(chunk);
              byteLength += bytesRead;
              controller.enqueue(chunk);
            },
          },
          { highWaterMark: 0 },
        );
        const fetch: FetchPort = async (requested) => Promise.resolve(requested === liveEntry.sources[0]?.url ? new Response(body) : new Response(null, { status: 404 }));
        const entry = { ...liveEntry, expectedCounts: { nodes: 3, edges: 3 }, recipe: { ...liveEntry.recipe, archive: { kind: "7z", member: { path: "karate.txt" } } } };
        await peak.start();
        const fetched = await fetchEntry(datasetWith(entry), { fetch, sevenZip, now });
        await peak.measure(0);
        await archive.close();
        expect(fetched.data).toMatchObject({ nodes: [{ id: "1" }, { id: "2" }, { id: "3" }] });
        expect(fetched.provenance).toMatchObject({ sha256: hash.digest("hex"), byteLength: archiveSize, member: "net/karate.txt" });
        expect(archiveSize).toBeGreaterThan(FILLER_BYTES);
        expect(index).toBeGreaterThan(MEASURE_EVERY);
        expect(peak.most).toBeLessThan(MEMORY_BUDGET);
        // The fetch listed the archive and extracted the member, each in 7-Zip's own heap, which grew by less than the budget while decoding the whole solid block.
        const fetchRuns = runs.slice(1);
        expect(fetchRuns.map((run) => run.args[0])).toEqual(["l", "x"]);
        for (const run of fetchRuns) {
          expect(run.heapBytes - baseline).toBeLessThan(MEMORY_BUDGET);
        }
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    },
    SOLID_TIMEOUT_MILLISECONDS,
  );
});

describe("a fetch of a zip by ranges", () => {
  /** A zip whose filler member is far larger than its tail, its directory and the member the recipe selects, so a fetch that read the filler would have received more bytes than its size. */
  
  const PARTIAL_CONTENT = 206;
  const bundle = zipSync({ "net/filler.bin": randomBytes(MEBIBYTE), "net/karate.txt": new TextEncoder().encode(karate) }, { level: 0 });
  const url = "https://example.org/data/karate.txt";

  /** A server that reads ranges: the whole file to a plain request, saying it reads ranges, and the bytes asked for to a ranged one. */
  const fetch: FetchPort = async (requested, init) => {
    if (requested !== url) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const { range } = init;
    if (range === undefined) {
      return Promise.resolve(new Response(bundle, { headers: { "accept-ranges": "bytes", "content-length": String(bundle.length) } }));
    }
    const last = range.offset + range.length - 1;

    return Promise.resolve(new Response(bundle.slice(range.offset, last + 1), { status: PARTIAL_CONTENT, headers: { "content-range": `bytes ${String(range.offset)}-${String(last)}/${String(bundle.length)}` } }));
  };
  const entry = { ...liveEntry, expectedCounts: { nodes: 3, edges: 3 }, recipe: { ...liveEntry.recipe, archive: { kind: "zip", member: { path: "karate.txt" } } } };

  it("reads the directory and the selected member by ranges, and records the ranges beside the hash of the bytes that arrived", async () => {
    const fetched = await fetchEntry(datasetWith(entry), { fetch, store: fileStore({ rangedMinBytes: MEBIBYTE }), now });
    expect(fetched.data).toMatchObject({ nodes: [{ id: "1" }, { id: "2" }, { id: "3" }] });
    const { provenance } = fetched;
    if ("files" in provenance || provenance.ranges === undefined) {
      expect.unreachable("a zip this large is read by ranges");
    }
    const arrived = Buffer.concat(provenance.ranges.map((range) => bundle.subarray(range.offset, range.offset + range.length)));
    expect(provenance).toMatchObject({ size: bundle.length, byteLength: arrived.length, sha256: createHash("sha256").update(arrived).digest("hex"), member: "net/karate.txt" });
    expect(provenance.byteLength).toBeLessThan(MEBIBYTE);
  });

  it("downloads the same zip whole below the size it is read by ranges from, recording the hash of the whole file", async () => {
    const { provenance } = await fetchEntry(datasetWith(entry), { fetch, now });
    expect(provenance).toMatchObject({ sha256: createHash("sha256").update(bundle).digest("hex"), byteLength: bundle.length });
    expect(provenance).not.toHaveProperty("ranges");
  });
});
