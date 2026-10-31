/* Node's store: a download is written to a temporary file as it arrives and hashed on the way, so a source larger than memory is read from disk a chunk or a range at a time, and a zip too large to download whole is read by ranged requests of its central directory and the members a recipe selects. */

import { createHash, type Hash } from "node:crypto";
import { type FileHandle, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeepsetError } from "../errors";
import { assertWithin, bytesSource, emptyBody, type ByteRange, type KeepRequest, type Received, type StoredSource, type StorePort } from "../source-bytes";
import { inTurn, piecesOf } from "../in-turn";
import { SATURATED_32 } from "./zip";

/** How many bytes a kept file is read back at a time, which is what a reader holds of the file at once: a mebibyte makes the cost of each read small beside the bytes it gives, and is the size the gzip stream is fed in, so one chunk is one feed. */
const KIBIBYTE = 1024;
export const READ_CHUNK_BYTES = KIBIBYTE * KIBIBYTE;

/** The smallest zip that is read by ranged requests rather than downloaded whole: the size past which a zip must be zip64 (APPNOTE.TXT 4.4.8 and 4.4.16, whose 32-bit fields stop at 4 GiB). A ranged read hashes the ranges it reads and not the whole file, so every zip below it keeps the hash of the whole file that a pinned snapshot records, and only an archive whose size the issue of reading it whole is about is read by ranges. */
export const RANGED_MIN_BYTES = SATURATED_32 + 1;

/** The status of a partial answer to a ranged request (RFC 9110, section 15.3.7). */
const PARTIAL_CONTENT = 206;

/** What a file store can be given: the directory its temporary files go in (the system's own by default), the smallest zip it reads by ranges, and how many bytes it reads back at a time, the last two only changed by a test. */
export interface FileStoreOptions {
  readonly directory?: string;
  readonly rangedMinBytes?: number;
  readonly readChunkBytes?: number;
}

/**
 * Hashes bytes held whole, a chunk at a time, as `Hash.update` refuses a buffer of 2 GiB or more.
 * @param bytes - The bytes.
 * @param chunkBytes - How many bytes to give the hash at a time.
 * @returns The digest, as hex.
 */
function hashWhole(bytes: Uint8Array, chunkBytes: number): string {
  const hash = createHash("sha256");
  for (let start = 0; start < bytes.length; start += chunkBytes) {
    hash.update(bytes.subarray(start, start + chunkBytes));
  }

  return hash.digest("hex");
}

/**
 * Reads exactly a range of an open file.
 * @param handle - The file.
 * @param range - The range, which lies within the file.
 * @returns The bytes.
 * @throws KeepsetError when the file ends before the range does.
 */
async function readFully(handle: Readonly<FileHandle>, range: Readonly<ByteRange>): Promise<Uint8Array> {
  const bytes = new Uint8Array(range.length);
  // A read may give fewer bytes than asked for, so the rest is read by recursion until the range is filled.
  const fill = async (filled: number): Promise<void> => {
    if (filled === range.length) {
      return;
    }
    const { bytesRead } = await handle.read(bytes, filled, range.length - filled, range.offset + filled);
    if (bytesRead === 0) {
      throw new KeepsetError(`the kept file ended at byte ${String(range.offset + filled)}, before the ${String(range.length)} bytes from ${String(range.offset)} that were asked for`);
    }
    await fill(filled + bytesRead);
  };
  await fill(0);

  return bytes;
}

/**
 * Writes all of a chunk to an open file at a position, by recursion while a write takes fewer bytes than it is given.
 * @param handle - The file.
 * @param chunk - The bytes.
 * @param position - Where they go.
 */
async function writeFully(handle: Readonly<FileHandle>, chunk: Uint8Array, position: number): Promise<void> {
  if (chunk.length === 0) {
    return;
  }
  const { bytesWritten } = await handle.write(chunk, 0, chunk.length, position);
  await writeFully(handle, chunk.subarray(bytesWritten), position + bytesWritten);
}

/**
 * Writes a body to a temporary file as it arrives, hashing it on the way, so it is never held in memory beyond the chunk that is arriving.
 * @param body - The body.
 * @param directory - Where the temporary file's own directory is made.
 * @param chunkBytes - How many bytes the file is read back at a time.
 * @returns The kept source; closing it deletes the file.
 * @throws The body's own failure, after deleting what was written.
 */
async function spool(body: Readonly<ReadableStream<Uint8Array>>, directory: string, chunkBytes: number): Promise<StoredSource> {
  const folder = await mkdtemp(join(directory, "keepset-"));
  const discard = async (): Promise<void> => {
    await rm(folder, { recursive: true, force: true });
  };
  let handle: FileHandle;
  try {
    handle = await open(join(folder, "source"), "w+");
  } catch (error) {
    await discard();
    throw error;
  }
  const hash = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of body) {
      hash.update(chunk);
      await writeFully(handle, chunk, size);
      size += chunk.length;
    }
  } catch (error) {
    await handle.close();
    await discard();
    throw error;
  }

  return fileSource({ handle, size, chunkBytes, received: { sha256: hash.digest("hex"), byteLength: size }, discard });
}

/** A file a body was written to: the open file, its length, how many bytes it is read back at a time, the record of what arrived, and what deletes it. */
interface KeptFile {
  readonly handle: FileHandle;
  readonly size: number;
  readonly chunkBytes: number;
  readonly received: Received;
  readonly discard: () => Promise<void>;
}

/**
 * A source kept in an open file.
 * @param file - The file.
 * @returns The source.
 */
function fileSource(file: KeptFile): StoredSource {
  const { handle, size, chunkBytes, received, discard } = file;
  const read = async (range: Readonly<ByteRange>): Promise<Uint8Array> => {
    assertWithin(range, size);

    return readFully(handle, range);
  };

  return {
    size,
    chunks: () => inTurn(piecesOf(size, chunkBytes), read),
    read,
    async bytes() {
      return read({ offset: 0, length: size });
    },
    async received() {
      return Promise.resolve(received);
    },
    async close() {
      await handle.close();
      await discard();
    },
  };
}

/**
 * Whether a `Content-Range` header names exactly a range of a file of a size.
 * @param header - The header.
 * @param range - The range asked for.
 * @param size - The file's size.
 * @returns True when it does.
 */
function namesRange(header: string | null, range: ByteRange, size: number): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(header ?? "");

  return match !== null && Number(match[1]) === range.offset && Number(match[2]) === range.offset + range.length - 1 && (match[3] === "*" || Number(match[3]) === size);
}

/**
 * A source left on the server and read by ranged requests, each range hashed as it arrives, in the order read.
 * @param request - The request whose answer said the server reads ranges.
 * @param size - The file's size, from that answer.
 * @param chunkBytes - How many bytes a sequential read asks for at a time.
 * @returns The source.
 */
function rangedSource(request: Readonly<KeepRequest>, size: number, chunkBytes: number): StoredSource {
  const { url, port, signal } = request;
  const hash: Hash = createHash("sha256");
  const ranges: ByteRange[] = [];
  let byteLength = 0;
  const read = async (range: ByteRange): Promise<Uint8Array> => {
    assertWithin(range, size);
    if (range.length === 0) {
      // A range header cannot ask for no bytes, and there are none to hash.
      return new Uint8Array(0);
    }
    const response = await port(url, { range, ...(signal === undefined ? {} : { signal }) });
    if (response.status !== PARTIAL_CONTENT || !namesRange(response.headers.get("content-range"), range, size)) {
      await response.body?.cancel();
      throw new KeepsetError(`${url} answered a request for bytes ${String(range.offset)} to ${String(range.offset + range.length)} with ${String(response.status)} ${response.statusText}, not with those bytes, after saying it reads ranges`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== range.length) {
      throw new KeepsetError(`${url} sent ${String(bytes.length)} bytes for a range of ${String(range.length)}`);
    }
    hash.update(bytes);
    ranges.push(range);
    byteLength += bytes.length;

    return bytes;
  };

  return {
    size,
    chunks: () => inTurn(piecesOf(size, chunkBytes), read),
    read,
    async bytes() {
      return read({ offset: 0, length: size });
    },
    async received() {
      // A copy of the running hash, so the record can be read part way and the hash still takes the ranges after it.
      return Promise.resolve({ sha256: hash.copy().digest("hex"), byteLength, ranges: [...ranges], size });
    },
    async close() {
      await Promise.resolve();
    },
  };
}

/**
 * The size a response says its whole body is, when it is the file as stored: no transport encoding, and a stated length.
 * @param response - The answer.
 * @returns The size, or undefined when the answer does not state it.
 */
function sizeOf(response: Response): number | undefined {
  const length = response.headers.get("content-length");
  if (length === null || !/^\d+$/.test(length) || response.headers.has("content-encoding")) {
    return undefined;
  }

  return Number(length);
}

/**
 * Node's store: every body is written to a temporary file as it arrives and hashed on the way; a zip of at least `rangedMinBytes` from a server that reads ranges is left on the server and read by ranged requests instead; bytes already held are hashed a chunk at a time and read where they are.
 * @param options - Where temporary files go, and the sizes a test changes.
 * @returns The store.
 */
export function fileStore(options: FileStoreOptions = {}): StorePort {
  const { rangedMinBytes = RANGED_MIN_BYTES, readChunkBytes = READ_CHUNK_BYTES } = options;

  return {
    async keep(response, request) {
      const size = sizeOf(response);
      if (request.randomAccess && size !== undefined && size >= rangedMinBytes && response.headers.get("accept-ranges") === "bytes") {
        // Only the ranges the reader asks for are fetched, so the whole body is never read.
        await response.body?.cancel();

        return rangedSource(request, size, readChunkBytes);
      }

      return spool(response.body ?? emptyBody(), options.directory ?? tmpdir(), readChunkBytes);
    },
    async hold(bytes) {
      const received = { sha256: hashWhole(bytes, readChunkBytes), byteLength: bytes.byteLength };

      return Promise.resolve({
        ...bytesSource(bytes),
        async received() {
          return Promise.resolve(received);
        },
        async close() {
          await Promise.resolve();
        },
      });
    },
  };
}
