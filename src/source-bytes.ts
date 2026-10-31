/* The bytes of a downloaded source as the archive readers see them: read in order a chunk at a time, or a range at a time, wherever they are kept (in memory, in a temporary file, or on the server and fetched by ranged requests). The store that keeps them is a port, so the platform-neutral core reads a source that does not fit in memory where the platform can keep it elsewhere, and reads it in memory where it cannot. */

import type { FetchPort } from "./fetch";
import { KeepsetError } from "./errors";

/** A run of bytes of a source: where it starts and how many bytes it holds. */
export interface ByteRange {
  readonly offset: number;
  readonly length: number;
}

/** A source's bytes, however they are kept. */
export interface SourceBytes {
  /** How many bytes the source holds. */
  readonly size: number;
  /**
   * Every byte of the source in order, a chunk at a time; each call starts again from the first byte.
   * @returns The chunks, each a fresh array the reader may keep.
   */
  readonly chunks: () => AsyncIterable<Uint8Array>;
  /**
   * The bytes of one range of the source.
   * @param range - A range within the source.
   * @returns Exactly its bytes.
   * @throws KeepsetError when the range is not within the source, or the bytes cannot be read.
   */
  readonly read: (range: Readonly<ByteRange>) => Promise<Uint8Array>;
  /**
   * The whole source as one array, for a reader that needs all of it at once (a plain file, a workbook).
   * @returns The bytes.
   */
  readonly bytes: () => Promise<Uint8Array>;
  /** The path of the file the bytes are kept in, when a store keeps them in one, for a reader that opens the file itself rather than reading it through this port (a 7z reader that runs outside JavaScript). The file is the store's: a reader never writes to it, and it is deleted when the source is closed. */
  readonly file?: string;
}

/** What arrived of a source: the SHA-256 of exactly the bytes that arrived, in the order they arrived, and how many there were; for a source read by ranged requests, which ranges of how large a file those bytes are. */
export interface Received {
  readonly sha256: string;
  readonly byteLength: number;
  /** The ranges a ranged read requested, in the order they arrived, when the source was read by ranges rather than downloaded whole. */
  readonly ranges?: readonly ByteRange[];
  /** The whole file's size, which a ranged read learns from the server, beside its ranges. */
  readonly size?: number;
}

/** A source the store keeps, with the record of what arrived and the means to let it go. */
export interface StoredSource extends SourceBytes {
  /**
   * The record of what has arrived. A source read by ranges goes on arriving as it is read, so its record is complete once the reading is done.
   * @returns The hash and count of the bytes that arrived.
   */
  readonly received: () => Promise<Received>;
  /** Lets the source go: a temporary file is deleted, and nothing more may be read. */
  readonly close: () => Promise<void>;
}

/** What a store is told of the request whose answer it keeps: the URL, the network port and abort signal for any further request it makes, and whether the reader reads the source by ranges (a zip's central directory and the members it selects), so a store may leave the bytes on the server and fetch only those ranges. */
export interface KeepRequest {
  readonly url: string;
  readonly port: FetchPort;
  readonly signal?: AbortSignal;
  readonly randomAccess: boolean;
}

/** The store port: where a fetch keeps a source's bytes. In memory where the platform has nowhere else (the browser's), or a temporary file and ranged requests where it has (Node's), so a source larger than memory is read. */
export interface StorePort {
  /**
   * Keeps a successful response's body.
   * @param response - The answer, its body unread.
   * @param request - The request it answers.
   * @returns The kept source, its whole body arrived unless it is read by ranges.
   * @throws The body's own failure when it does not arrive whole.
   */
  readonly keep: (response: Response, request: Readonly<KeepRequest>) => Promise<StoredSource>;
  /**
   * Keeps bytes already held, such as the pages of a paged query joined into one table.
   * @param bytes - The bytes.
   * @returns The kept source.
   */
  readonly hold: (bytes: Uint8Array) => Promise<StoredSource>;
}

/** The digest a memory store hashes a source through: SHA-256 as hex, of bytes held whole. */
export type DigestPort = (bytes: Uint8Array) => Promise<string>;

/**
 * The body of a response that has none: a stream that ends at once.
 * @returns The stream.
 */
export function emptyBody(): ReadableStream<Uint8Array<ArrayBuffer>> {
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.close();
    },
  });
}

/**
 * Checks that a range lies within a source.
 * @param range - The range.
 * @param size - The source's size.
 * @throws KeepsetError when it does not.
 */
export function assertWithin(range: Readonly<ByteRange>, size: number): void {
  if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset < 0 || range.length < 0 || range.offset + range.length > size) {
    throw new KeepsetError(`bytes ${String(range.offset)} to ${String(range.offset + range.length)} are not within a source of ${String(size)} bytes`);
  }
}

/**
 * A source held in memory: its one chunk is the bytes themselves.
 * @param bytes - The bytes.
 * @returns The source.
 */
export function bytesSource(bytes: Uint8Array): SourceBytes {
  return {
    size: bytes.byteLength,
    async *chunks() {
      yield await Promise.resolve(bytes);
    },
    async read(range) {
      assertWithin(range, bytes.byteLength);

      return Promise.resolve(bytes.subarray(range.offset, range.offset + range.length));
    },
    async bytes() {
      return Promise.resolve(bytes);
    },
  };
}

/**
 * Reads bytes as a source, or a source as it is.
 * @param input - Bytes held in memory, or a source kept anywhere.
 * @returns The source.
 */
export function asSource(input: Uint8Array | Readonly<SourceBytes>): Readonly<SourceBytes> {
  return input instanceof Uint8Array ? bytesSource(input) : input;
}

/**
 * The store that keeps every source in memory and hashes it whole: the browser's, and the one a caller gets by giving a digest of its own.
 * @param digest - The SHA-256 of bytes held whole.
 * @returns The store.
 */
export function memoryStore(digest: DigestPort): StorePort {
  const hold = async (bytes: Uint8Array): Promise<StoredSource> => {
    const sha256 = await digest(bytes);

    return {
      ...bytesSource(bytes),
      async received() {
        return Promise.resolve({ sha256, byteLength: bytes.byteLength });
      },
      async close() {
        await Promise.resolve();
      },
    };
  };

  return {
    async keep(response) {
      return hold(new Uint8Array(await response.arrayBuffer()));
    },
    hold,
  };
}
