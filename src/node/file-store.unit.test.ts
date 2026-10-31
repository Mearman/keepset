import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { KeepsetError } from "../errors";
import type { FetchPort } from "../fetch";
import { collect } from "../test-support/archives";
import { fileStore } from "./file-store";

const KIBIBYTE = 1024;
/** A read-back chunk far smaller than the bodies below, so every body is read back in several chunks and the last is a part one. */
const CHUNK_KIBIBYTES = 4;
const CHUNK_BYTES = CHUNK_KIBIBYTES * KIBIBYTE;
const BODY_CHUNKS = 10;
const PAST_THE_LAST_CHUNK = 123;
const BODY_BYTES = BODY_CHUNKS * CHUNK_BYTES + PAST_THE_LAST_CHUNK;
const PARTIAL_CONTENT = 206;
const OK = 200;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const directory = mkdtempSync(join(tmpdir(), "keepset-store-"));
const store = fileStore({ directory, readChunkBytes: CHUNK_BYTES });
const request = { url: "https://example.org/a.zip", port: async (): Promise<Response> => Promise.reject(new Error("nothing more is requested")), randomAccess: false } as const;

/**
 * A body that arrives in pieces of a set size.
 * @param bytes - The body.
 * @param pieceBytes - How many bytes each piece holds.
 * @returns The stream.
 */
function streamOf(bytes: Uint8Array, pieceBytes: number): ReadableStream<Uint8Array> {
  let offset = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();

        return;
      }
      controller.enqueue(bytes.slice(offset, offset + pieceBytes));
      offset += pieceBytes;
    },
  });
}

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("fileStore", () => {
  // A plain array, not the Buffer randomBytes gives, so a slice of it is a copy.
  const body = new Uint8Array(randomBytes(BODY_BYTES));

  it("keeps a body in a temporary file, hashed as it arrives, read back in order a chunk at a time or by range, and deletes the file on close", async () => {
    const kept = await store.keep(new Response(streamOf(body, KIBIBYTE + 1)), request);
    expect(await kept.received()).toEqual({ sha256: sha256(body), byteLength: BODY_BYTES });
    expect(kept.size).toBe(BODY_BYTES);
    const chunks = await collect(kept.chunks());
    expect(chunks.every((chunk) => chunk.length <= CHUNK_BYTES)).toBe(true);
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(body);
    expect(await kept.read({ offset: CHUNK_BYTES - 1, length: 2 })).toEqual(body.subarray(CHUNK_BYTES - 1, CHUNK_BYTES + 1));
    await expect(kept.read({ offset: BODY_BYTES, length: 1 })).rejects.toThrow(KeepsetError);
    expect(readdirSync(directory)).toHaveLength(1);
    await kept.close();
    expect(readdirSync(directory)).toEqual([]);
  });

  it("deletes what it wrote when the body fails part way, and gives the body's failure", async () => {
    const failure = new Error("connection reset");
    let sent = false;
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.error(failure);

          return;
        }
        sent = true;
        controller.enqueue(body.slice(0, CHUNK_BYTES));
      },
    });
    await expect(store.keep(new Response(failing), request)).rejects.toBe(failure);
    expect(readdirSync(directory)).toEqual([]);
  });

  it("hashes bytes already held, and reads them where they are", async () => {
    const held = await store.hold(body);
    expect(await held.received()).toEqual({ sha256: sha256(body), byteLength: BODY_BYTES });
    expect(await held.bytes()).toBe(body);
    expect(readdirSync(directory)).toEqual([]);
  });

  describe("a zip read by ranges", () => {
    const ranged = fileStore({ directory, readChunkBytes: CHUNK_BYTES, rangedMinBytes: BODY_BYTES });
    const head = (size: number): Response => new Response(streamOf(body, CHUNK_BYTES), { headers: { "accept-ranges": "bytes", "content-length": String(size) } });

    /** A port that answers a ranged request with the bytes asked for, as a server that reads ranges does, and records the ranges. */
    function rangedPort(): { readonly port: FetchPort; readonly asked: string[] } {
      const asked: string[] = [];
      const port: FetchPort = async (_url, init) => {
        const { range } = init;
        if (range === undefined) {
          return Promise.resolve(new Response(body));
        }
        asked.push(`${String(range.offset)}+${String(range.length)}`);
        const last = range.offset + range.length - 1;

        return Promise.resolve(new Response(body.slice(range.offset, last + 1), { status: PARTIAL_CONTENT, headers: { "content-range": `bytes ${String(range.offset)}-${String(last)}/${String(BODY_BYTES)}` } }));
      };

      return { port, asked };
    }

    it("leaves a large zip on a server that reads ranges, fetches only the ranges read, and records them beside the hash of what arrived", async () => {
      const { port, asked } = rangedPort();
      const kept = await ranged.keep(head(BODY_BYTES), { ...request, port, randomAccess: true });
      const first = { offset: BODY_BYTES - CHUNK_BYTES, length: CHUNK_BYTES };
      const second = { offset: 1, length: 2 };
      expect(await kept.read(first)).toEqual(body.subarray(first.offset, first.offset + first.length));
      expect(await kept.read(second)).toEqual(body.subarray(second.offset, second.offset + second.length));
      expect(asked).toEqual([`${String(first.offset)}+${String(first.length)}`, `${String(second.offset)}+${String(second.length)}`]);
      expect(await kept.received()).toEqual({
        sha256: sha256(Buffer.concat([body.subarray(first.offset), body.subarray(second.offset, second.offset + second.length)])),
        byteLength: first.length + second.length,
        ranges: [first, second],
        size: BODY_BYTES,
      });
      expect(readdirSync(directory)).toEqual([]);
    });

    it("downloads a zip whole when it is below the size, when the reader does not read by ranges, or when the server does not say it reads them", async () => {
      const { port, asked } = rangedPort();
      const below = await ranged.keep(head(BODY_BYTES - 1), { ...request, port, randomAccess: true });
      const sequential = await ranged.keep(head(BODY_BYTES), { ...request, port, randomAccess: false });
      const silent = await ranged.keep(new Response(streamOf(body, CHUNK_BYTES), { headers: { "content-length": String(BODY_BYTES) } }), { ...request, port, randomAccess: true });
      const records = await Promise.all([below, sequential, silent].map(async (kept) => kept.received()));
      await Promise.all([below, sequential, silent].map(async (kept) => kept.close()));
      expect(records.map((record) => record.ranges)).toEqual([undefined, undefined, undefined]);
      expect(asked).toEqual([]);
    });

    it("refuses an answer to a ranged request that is not those bytes", async () => {
      const whole: FetchPort = async () => Promise.resolve(new Response(body, { status: OK }));
      const kept = await ranged.keep(head(BODY_BYTES), { ...request, port: whole, randomAccess: true });
      await expect(kept.read({ offset: 0, length: 1 })).rejects.toThrow(/answered a request for bytes 0 to 1 with 200/);
    });
  });
});
