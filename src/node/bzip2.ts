import unbzip2 from "unbzip2-stream";
import { ArchiveError } from "../errors";

/** The four bytes every bzip2 stream starts with, as ASCII: `BZh` and the block size digit, `1` to `9`. */
const MAGIC = /^BZh[1-9]$/;
const MAGIC_LENGTH = 4;

/**
 * Decompresses bzip2 data as it arrives: one stream or several concatenated ones, as `bzip2 -d` reads them. The decoder verifies every block's CRC and the stream's, and fails on input that ends inside a stream or holds anything after the last one, so a download cut short or corrupted never yields a prefix of the file as the whole of it.
 *
 * `unbzip2-stream` is a stream interface, but its decoder runs inside `write` and `end` and emits every `data`, `error` and `end` event before they return, so each push hands on every block its input completes, and `end` the rest; the check that `end` was emitted guards that. A block decompresses to at most its block size (900 kB at level 9), so the decoder holds about one block of input and one of output whatever the size of the data.
 */
export class Bunzip2Stream {
  private readonly decoder = unbzip2();

  private readonly outcome: { failure?: unknown; finished: boolean } = { finished: false };

  /** The stream's first bytes, until there are enough of them to check the header. */
  private head = "";

  /**
   * @param onData - Given each piece of decompressed data, in order.
   */
  public constructor(onData: (chunk: Uint8Array) => void) {
    this.decoder.on("data", (chunk: Uint8Array) => {
      // A plain Uint8Array over the same memory: the reader gets the type every other unpacker gives, not a Buffer.
      onData(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    });
    this.decoder.on("error", (error: unknown) => {
      this.outcome.failure ??= error;
    });
    this.decoder.on("end", () => {
      this.outcome.finished = true;
    });
  }

  /**
   * Decompresses the next piece of the data.
   * @param chunk - The bytes that follow those already pushed.
   * @throws ArchiveError when the data does not start with a bzip2 header or fails a CRC.
   */
  public push(chunk: Uint8Array): void {
    if (this.head.length < MAGIC_LENGTH) {
      this.head += String.fromCharCode(...chunk.subarray(0, MAGIC_LENGTH - this.head.length));
      if (this.head.length === MAGIC_LENGTH) {
        this.checkHead();
      }
    }
    this.decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    this.rethrow();
  }

  /**
   * Ends the data.
   * @throws ArchiveError when the data ends inside a stream, holds trailing bytes that are not another stream, or never started one.
   */
  public end(): void {
    this.checkHead();
    this.decoder.end();
    this.rethrow();
    if (!this.outcome.finished) {
      throw new ArchiveError("the bzip2 decoder did not finish when its input ended");
    }
  }

  private checkHead(): void {
    if (!MAGIC.test(this.head)) {
      throw new ArchiveError("not valid bzip2 data: it does not start with the BZh header and a block size digit");
    }
  }

  private rethrow(): void {
    const { failure } = this.outcome;
    if (failure !== undefined) {
      throw new ArchiveError(`not valid bzip2 data: ${failure instanceof Error ? failure.message : JSON.stringify(failure)}`, { cause: failure });
    }
  }
}

/**
 * Decompresses bzip2 data held whole, as `Bunzip2Stream` does.
 * @param bytes - The compressed data.
 * @returns The decompressed bytes.
 * @throws ArchiveError when the data does not start with a bzip2 header, fails a CRC, ends early or holds trailing bytes that are not another stream.
 */
export function bunzip2(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  const stream = new Bunzip2Stream((chunk) => {
    chunks.push(chunk);
  });
  stream.push(bytes);
  stream.end();
  const joined = Buffer.concat(chunks);

  // A plain Uint8Array over the same memory: callers get the type every other unpacker returns, not a Buffer.
  return new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength);
}
