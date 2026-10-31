import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Gzip } from "fflate";
import { BLOCK } from "../node/tar";
import { tarHeader } from "./archives";
import { inTurn, piecesOf } from "../in-turn";
import { assertWithin, type ByteRange, type SourceBytes } from "../source-bytes";

/** The type flag of a regular file, and the zero blocks that end a tar archive. */
const REGULAR_FILE = "0";
const END_OF_ARCHIVE_BLOCKS = 2;

/**
 * Whether a value is the garbage collector V8 hands a context made after `--expose-gc` is set.
 * @param value - The value.
 * @returns True for a function.
 */
function isCollector(value: unknown): value is () => void {
  return typeof value === "function";
}

/**
 * V8's garbage collector. V8's flags are the process's, so a context made after `--expose-gc` is set has `gc` among its globals, which a test can call without the runner being started with the flag.
 * @returns The collector.
 * @throws Error when V8 does not expose it.
 */
function exposedCollector(): () => void {
  setFlagsFromString("--expose-gc");
  const collector: unknown = runInNewContext("gc");
  if (!isCollector(collector)) {
    throw new Error("V8 did not expose its garbage collector");
  }

  return collector;
}

const collectGarbage = exposedCollector();

/**
 * The bytes of every ArrayBuffer still reachable: a full collection is run twice, a turn of the event loop apart so the buffers it frees are swept before the count is read, so the count is what the process retains and not what it has let go of.
 * @returns The bytes.
 */
export async function retainedBufferBytes(): Promise<number> {
  collectGarbage();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  collectGarbage();

  return process.memoryUsage().arrayBuffers;
}

/** A member of a lazily written tar archive: its path, its size and the bytes of any range of it, made when asked for, so the archive is never held. */
export interface LazyMember {
  readonly path: string;
  readonly size: number;
  readonly bytes: (offset: number, length: number) => Uint8Array;
}

/**
 * Writes a tar archive a piece at a time, each member's data made a piece at a time as it is reached.
 * @param members - The members.
 * @param pieceBytes - How many bytes of a member's data are made at once.
 * @returns The archive's bytes, in order.
 */
export function* lazyTar(members: readonly LazyMember[], pieceBytes: number): Generator<Uint8Array, void, undefined> {
  for (const member of members) {
    yield tarHeader(member.path, member.size, REGULAR_FILE);
    for (let offset = 0; offset < member.size; offset += pieceBytes) {
      yield member.bytes(offset, Math.min(pieceBytes, member.size - offset));
    }
    yield new Uint8Array((BLOCK - (member.size % BLOCK)) % BLOCK);
  }
  yield new Uint8Array(BLOCK * END_OF_ARCHIVE_BLOCKS);
}

/**
 * Cuts a stream of pieces into chunks of one size (the last may be shorter), each a fresh array, so the chunks' boundaries fall wherever that size puts them and not where the pieces end.
 * @param pieces - The bytes, in pieces of any size.
 * @param chunkBytes - The chunk size.
 * @returns The chunks.
 */
export function* rechunk(pieces: Readonly<Iterable<Uint8Array>>, chunkBytes: number): Generator<Uint8Array, void, undefined> {
  let chunk = new Uint8Array(chunkBytes);
  let filled = 0;
  for (const piece of pieces) {
    for (let at = 0; at < piece.length; ) {
      const taken = Math.min(chunkBytes - filled, piece.length - at);
      chunk.set(piece.subarray(at, at + taken), filled);
      filled += taken;
      at += taken;
      if (filled === chunkBytes) {
        yield chunk;
        chunk = new Uint8Array(chunkBytes);
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    yield chunk.subarray(0, filled);
  }
}

/**
 * Gzips a stream of pieces as one gzip member, a piece at a time.
 * @param pieces - The bytes to compress.
 * @returns The compressed bytes, in pieces.
 */
export function* lazyGzip(pieces: Readonly<Iterable<Uint8Array>>): Generator<Uint8Array, void, undefined> {
  const out: Uint8Array[] = [];
  // The fastest level: the bytes these tests compress are random filler, which no level shrinks.
  const stream = new Gzip({ level: 1 }, (chunk) => {
    out.push(chunk);
  });
  for (const piece of pieces) {
    stream.push(piece, false);
    yield* out.splice(0);
  }
  stream.push(new Uint8Array(0), true);
  yield* out.splice(0);
}

/** A source held in memory whose chunks are of a set size, each a fresh copy, and which counts the bytes its ranges give, so a test can cut an archive anywhere and see what a reader read. */
export interface CountingSource extends SourceBytes {
  /** The bytes `read` has given. */
  readonly rangeBytes: () => number;
}

/**
 * A source over bytes held in memory, given out a chunk of a set size at a time.
 * @param bytes - The bytes.
 * @param chunkBytes - How many bytes each chunk holds.
 * @returns The source.
 */
export function chunkedSource(bytes: Uint8Array, chunkBytes: number): CountingSource {
  let given = 0;

  return {
    size: bytes.length,
    // A copy of each chunk, as a store that reads from a file or a server gives one.
    chunks: () => inTurn(piecesOf(bytes.length, chunkBytes), async (piece) => Promise.resolve(bytes.slice(piece.offset, piece.offset + piece.length))),
    async read(range: ByteRange) {
      assertWithin(range, bytes.length);
      given += range.length;

      return Promise.resolve(bytes.slice(range.offset, range.offset + range.length));
    },
    async bytes() {
      return Promise.resolve(bytes);
    },
    rangeBytes: () => given,
  };
}
