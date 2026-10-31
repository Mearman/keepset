import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { collect } from "../test-support/archives";
import { chunkedSource, lazyXz } from "../test-support/streams";
import { fixtureBytes, TWO_LINES_XZ_BASE64 } from "../test-support/xz-fixtures";
import { unxz } from "./xz";

const text = (pieces: readonly Uint8Array[]): string => new TextDecoder().decode(Buffer.concat(pieces));

/** The decompressed text of xz bytes cut into chunks of a size. */
async function decoded(bytes: Uint8Array, chunkBytes: number): Promise<string> {
  return text(await collect(unxz(chunkedSource(bytes, chunkBytes).chunks())));
}

const TWO_LINES = "first line\nsecond line\n";
const stream = fixtureBytes(TWO_LINES_XZ_BASE64);

/** The unit the xz format pads to, and how many bytes of the stream's end a truncation takes off, which is part of its footer. */
const WORD_BYTES = 4;
const CUT_OFF = 5;

/** Chunk sizes that cut the stream's header, block, index and footer at every kind of offset, down to a byte at a time. */
const BYTE_AT_A_TIME = 1;
const ODD = 7;
const LARGE = 64;
const CHUNK_SIZES = [BYTE_AT_A_TIME, ODD, LARGE];

/** The data one LZMA2 uncompressed chunk holds at most, a size past it, several times it, and a feed size that is no multiple of anything in the stream. */
const LZMA2_CHUNK = 65_536;
const PAST_A_CHUNK = 70_000;
const CHUNKS_OF_DATA = 4;
const SEVERAL_CHUNKS = LZMA2_CHUNK * CHUNKS_OF_DATA + 1;
const ODD_FEED = 4099;

describe("the xz decoder", () => {
  it.each(CHUNK_SIZES)("reads a stream cut into chunks of %i bytes exactly as it reads it whole", async (chunkBytes) => {
    expect(await decoded(stream, chunkBytes)).toBe(TWO_LINES);
  });

  it("reads concatenated streams as one file, as xz -d does, and the padding the format allows between them", async () => {
    const padding = new Uint8Array(WORD_BYTES);
    expect(await decoded(Buffer.concat([stream, stream]), ODD)).toBe(TWO_LINES + TWO_LINES);
    expect(await decoded(Buffer.concat([stream, padding, stream, padding]), ODD)).toBe(TWO_LINES + TWO_LINES);
  });

  it("reads a stream of many LZMA2 chunks whose size is not a whole number of them, as the lazy writer makes it", async () => {
    const pieces = [randomBytes(PAST_A_CHUNK), randomBytes(1), randomBytes(LZMA2_CHUNK)];
    const out = Buffer.concat(await collect(unxz(chunkedSource(Buffer.concat([...lazyXz(pieces)]), ODD_FEED).chunks())));
    expect(out.equals(Buffer.concat(pieces))).toBe(true);
  });

  it.each([
    ["cut short", stream.subarray(0, stream.length - CUT_OFF)],
    ["followed by bytes that are neither padding nor a stream", Buffer.concat([stream, Buffer.from("garbage!")])],
    ["not xz at all", Buffer.from("this is not xz data at all")],
    ["empty", new Uint8Array(0)],
  ])("refuses data that is %s, as an archive error", async (_description, bytes) => {
    const failure = await decoded(bytes, ODD).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ArchiveError);
    expect(failure instanceof Error ? failure.message : "").toMatch(/^not valid xz data: /);
  });

  it("lets go of the decoder when a reader stops early, so the next stream can be read, and does the same after a failure", async () => {
    const started = unxz(chunkedSource(Buffer.concat([...lazyXz([new Uint8Array(SEVERAL_CHUNKS)])]), ODD_FEED).chunks());
    await started.next();
    await started.return();
    expect(await decoded(stream, LARGE)).toBe(TWO_LINES);
    await expect(decoded(stream.subarray(0, stream.length - CUT_OFF), LARGE)).rejects.toBeInstanceOf(ArchiveError);
    expect(await decoded(stream, LARGE)).toBe(TWO_LINES);
  });
});
