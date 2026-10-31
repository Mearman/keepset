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

/** The most data one LZMA2 uncompressed chunk holds, which its two-byte size field limits. */
const LZMA2_CHUNK_BYTES = 0x10000;

/** The control bytes of an LZMA2 uncompressed chunk (the first resets the dictionary) and of the end of the data. */
const LZMA2_STORED_RESET = 0x01;
const LZMA2_STORED = 0x02;
const LZMA2_END = 0x00;

/** The reflected polynomial of the CRC-32 the xz format uses for its headers, index and footer, the one gzip uses. */
const CRC32_POLYNOMIAL = 0xedb88320;
const CRC32_START = 0xffffffff;
const BITS_PER_BYTE = 8;
const BYTE_MASK = 0xff;

/** The length of a checksum and the unit the format pads every part to. */
const WORD_BYTES = 4;

/** What a variable-length integer carries in each byte: seven bits, with the eighth set on every byte but the last. */
const VLI_RADIX = 0x80;

/** The magic bytes opening a stream (`\xFD7zXZ\0`) and closing its footer (`YZ`). */
const HEADER_MAGIC = Uint8Array.from("\xFD7zXZ\0", (character) => character.charCodeAt(0));
const FOOTER_MAGIC = Uint8Array.from("YZ", (character) => character.charCodeAt(0));

/** The stream flags: no integrity check on the data, so the data's own checksum is never computed. */
const STREAM_FLAGS = [0x00, 0x00];

/** The id of the LZMA2 filter, and its property byte for a 1 MiB dictionary (the size is `(2 | (property & 1)) << (property / 2 + 11)`). */
const LZMA2_FILTER_ID = 0x21;
const LZMA2_DICTIONARY_PROPERTY = 0x10;

/** The block header: its size in words less one, no optional sizes and one filter, LZMA2 (id 0x21) with its one property byte naming a 1 MiB dictionary, then padding to the word before the checksum. */
const BLOCK_HEADER_BODY = [0x02, 0x00, LZMA2_FILTER_ID, 0x01, LZMA2_DICTIONARY_PROPERTY, 0x00, 0x00, 0x00];

/** The index's indicator byte; its one record then follows. */
const INDEX_INDICATOR = 0x00;

/**
 * The CRC-32 of some bytes, as four little-endian bytes. It is computed bitwise, as only headers, an index and a footer are ever summed.
 * @param bytes - The bytes.
 * @returns Their checksum.
 */
function crc32(bytes: Uint8Array): Uint8Array {
  let crc = CRC32_START;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < BITS_PER_BYTE; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ CRC32_POLYNOMIAL : crc >>> 1;
    }
  }
  const out = new Uint8Array(WORD_BYTES);
  new DataView(out.buffer).setUint32(0, ~crc >>> 0, true);

  return out;
}

/**
 * A number as an xz variable-length integer: seven bits a byte, least significant first, the high bit set on every byte but the last.
 * @param value - A non-negative integer.
 * @returns The bytes.
 */
function vli(value: number): number[] {
  const bytes: number[] = [];
  let rest = value;
  while (rest >= VLI_RADIX) {
    bytes.push((rest % VLI_RADIX) | VLI_RADIX);
    rest = Math.floor(rest / VLI_RADIX);
  }
  bytes.push(rest);

  return bytes;
}

/**
 * Joins byte arrays.
 * @param parts - The arrays.
 * @returns One array of them all.
 */
function joined(...parts: readonly (Uint8Array | readonly number[])[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/**
 * The zero bytes that round a length up to a whole number of words, as the format pads each part.
 * @param length - The length so far.
 * @returns The padding.
 */
function padding(length: number): Uint8Array {
  return new Uint8Array((WORD_BYTES - (length % WORD_BYTES)) % WORD_BYTES);
}

/**
 * Writes pieces of data as one xz stream of one block whose LZMA2 chunks are stored uncompressed, with no integrity check on the data (the stream's headers, index and footer are checksummed as the format requires). The result is a valid `.xz` file that a decoder reads as it would any other, without the cost of compressing the random filler a memory test pushes through it.
 * @param pieces - The data, in pieces.
 * @returns The stream's bytes, in pieces.
 */
export function* lazyXz(pieces: Readonly<Iterable<Uint8Array>>): Generator<Uint8Array, void, undefined> {
  yield joined(HEADER_MAGIC, STREAM_FLAGS, crc32(Uint8Array.from(STREAM_FLAGS)));
  const blockHeader = joined(BLOCK_HEADER_BODY, crc32(Uint8Array.from(BLOCK_HEADER_BODY)));
  yield blockHeader;
  let compressed = 0;
  let uncompressed = 0;
  let first = true;
  for (const piece of pieces) {
    for (let start = 0; start < piece.length; start += LZMA2_CHUNK_BYTES) {
      const chunk = piece.subarray(start, start + LZMA2_CHUNK_BYTES);
      const size = chunk.length - 1;
      const framed = joined([first ? LZMA2_STORED_RESET : LZMA2_STORED, size >> BITS_PER_BYTE, size & BYTE_MASK], chunk);
      first = false;
      compressed += framed.length;
      uncompressed += chunk.length;
      yield framed;
    }
  }
  yield Uint8Array.from([LZMA2_END]);
  compressed += 1;
  yield padding(compressed);
  const indexBody = joined([INDEX_INDICATOR], vli(1), vli(blockHeader.length + compressed), vli(uncompressed));
  const indexUnchecked = joined(indexBody, padding(indexBody.length));
  const index = joined(indexUnchecked, crc32(indexUnchecked));
  yield index;
  const footerBody = new Uint8Array(WORD_BYTES + STREAM_FLAGS.length);
  new DataView(footerBody.buffer).setUint32(0, index.length / WORD_BYTES - 1, true);
  footerBody.set(STREAM_FLAGS, WORD_BYTES);
  yield joined(crc32(footerBody), footerBody, FOOTER_MAGIC);
}
