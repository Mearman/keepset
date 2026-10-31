import { Inflate, inflateSync } from "fflate";
import { ArchiveError } from "../errors";
import { inTurn, piecesOf } from "../in-turn";
import { asSource, type SourceBytes } from "../source-bytes";

/** The signatures of the zip structures this reader finds, as the little-endian 32-bit values they are stored as. */
export const ZIP_SIGNATURES = { endOfCentralDirectory: 0x06054b50, zip64Locator: 0x07064b50, zip64EndOfCentralDirectory: 0x06064b50, centralEntry: 0x02014b50, localHeader: 0x04034b50 } as const;

/** Fixed sizes and offsets inside those structures. */
const EOCD_LENGTH = 22;
const MAX_COMMENT = 0xffff;
const LOCATOR_LENGTH = 20;
const CENTRAL_ENTRY_LENGTH = 46;
const LOCAL_HEADER_LENGTH = 30;

/** A field that holds all ones says its real value is in the zip64 record. */
export const SATURATED_16 = 0xffff;
export const SATURATED_32 = 0xffff_ffff;

/** The zip64 extended information extra field, and the general purpose flag bits this reader acts on. */
const ZIP64_EXTRA_ID = 0x0001;
const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;

/** Compression methods: stored, and deflate. */
const STORED = 0;
const DEFLATE = 8;

/** The byte width of the fixed-size fields, and of one byte, in bits. */
export const U16 = 2;
export const U32 = 4;
export const U64 = 8;

/** Where the fields this reader needs lie in each structure, as offsets from its start. */
const EOCD = { count: 10, directoryOffset: 16 } as const;
const ZIP64_RECORD = { count: 32, directoryOffset: 48 } as const;
const LOCATOR = { recordOffset: 8 } as const;
const CENTRAL = { flags: 8, compression: 10, size: 20, originalSize: 24, nameLength: 28, extraLength: 30, commentLength: 32, offset: 42 } as const;
const LOCAL = { nameLength: 26, extraLength: 28 } as const;
const EXTRA = { id: 0, size: 2, data: 4 } as const;

/** How many bytes of the end of an archive can hold its end of central directory record: the record and the longest comment that may follow it. */
const TAIL_LENGTH = EOCD_LENGTH + MAX_COMMENT;

/** How much of the zip64 end of central directory record this reader reads: up to and including the directory's offset. */
const ZIP64_RECORD_READ = ZIP64_RECORD.directoryOffset + U64;

/** What a filter is told of an entry before any of it is inflated, as fflate's own zip reader tells it. */
export interface ZipEntryInfo {
  readonly name: string;
  readonly size: number;
  readonly originalSize: number;
  readonly compression: number;
}

/** One entry of the central directory, with its sizes and the offset of its local header as full numbers. */
export interface ZipEntry extends ZipEntryInfo {
  readonly flags: number;
  readonly offset: number;
}

/**
 * Reads an unsigned 64-bit little-endian field as a number.
 * @param view - The bytes.
 * @param at - The field's position.
 * @returns The value.
 * @throws ArchiveError when it is beyond what a number holds exactly, which no file a filesystem or a server holds can be.
 */
export function readU64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveError("a zip field is larger than 2^53 bytes");
  }

  return Number(value);
}

/**
 * A DataView over bytes.
 * @param bytes - The bytes.
 * @returns The view.
 */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/**
 * Reads a range of an archive, refusing one the archive does not hold.
 * @param source - The archive.
 * @param offset - Where the range starts.
 * @param length - How many bytes.
 * @param what - What the range is, for the error.
 * @returns The bytes.
 * @throws ArchiveError when the range runs past the end of the archive.
 */
async function readRange(source: SourceBytes, offset: number, length: number, what: string): Promise<Uint8Array> {
  if (offset < 0 || offset + length > source.size) {
    throw new ArchiveError(`not a valid zip archive: ${what} at byte ${String(offset)} runs past the end of the archive`);
  }

  return source.read({ offset, length });
}

/**
 * Finds the end of the central directory record by scanning back from the end of the archive, past any comment.
 * @param tail - The archive's last bytes, as many as can hold the record and a comment.
 * @returns The record's position in the tail.
 * @throws ArchiveError when there is none.
 */
function findEnd(tail: DataView): number {
  for (let at = tail.byteLength - EOCD_LENGTH; at >= 0; at -= 1) {
    if (tail.getUint32(at, true) === ZIP_SIGNATURES.endOfCentralDirectory) {
      return at;
    }
  }

  throw new ArchiveError("not a zip archive: no end of central directory record");
}

/**
 * Reads where the central directory is, how many entries it holds and where it ends, from the zip64 record where the ordinary one says its fields are saturated. The directory ends where the record after it starts: the zip64 record, or the end of central directory record.
 * @param source - The archive.
 * @returns The directory's offset, its entry count and the offset it ends before.
 * @throws ArchiveError when the archive has no end of central directory record, or its zip64 locator points at no zip64 record.
 */
async function locateDirectory(source: SourceBytes): Promise<{ readonly offset: number; readonly count: number; readonly end: number }> {
  const tailStart = Math.max(0, source.size - TAIL_LENGTH);
  const tail = viewOf(await source.read({ offset: tailStart, length: source.size - tailStart }));
  const endInTail = findEnd(tail);
  const end = tailStart + endInTail;
  const count = tail.getUint16(endInTail + EOCD.count, true);
  const offset = tail.getUint32(endInTail + EOCD.directoryOffset, true);
  if (count !== SATURATED_16 && offset !== SATURATED_32) {
    return { offset, count, end };
  }
  const locator = end - LOCATOR_LENGTH;
  if (locator < 0) {
    return { offset, count, end };
  }
  const locatorView = viewOf(await source.read({ offset: locator, length: LOCATOR_LENGTH }));
  if (locatorView.getUint32(0, true) !== ZIP_SIGNATURES.zip64Locator) {
    return { offset, count, end };
  }
  const record = readU64(locatorView, LOCATOR.recordOffset);
  const recordView = record + ZIP64_RECORD_READ > source.size ? undefined : viewOf(await source.read({ offset: record, length: ZIP64_RECORD_READ }));
  if (recordView?.getUint32(0, true) !== ZIP_SIGNATURES.zip64EndOfCentralDirectory) {
    throw new ArchiveError("not a valid zip64 archive: the end of central directory locator points at no zip64 record");
  }

  return { offset: readU64(recordView, ZIP64_RECORD.directoryOffset), count: readU64(recordView, ZIP64_RECORD.count), end: record };
}

/**
 * Reads the zip64 values of an entry, which its extra field gives in the order uncompressed size, compressed size, local header offset, for only those fields the entry's own record saturates.
 * @param view - The central directory.
 * @param extra - The extra field's position.
 * @param length - The extra field's length.
 * @param saturated - Which of the three the entry's record saturates.
 * @returns The three values, each undefined where the entry's record held the real one.
 */
function zip64Values(view: DataView, extra: number, length: number, saturated: readonly [boolean, boolean, boolean]): readonly [number | undefined, number | undefined, number | undefined] {
  const values: (number | undefined)[] = [undefined, undefined, undefined];
  for (let at = extra; at + EXTRA.data <= extra + length; ) {
    const id = view.getUint16(at + EXTRA.id, true);
    const size = view.getUint16(at + EXTRA.size, true);
    if (id === ZIP64_EXTRA_ID) {
      let cursor = at + EXTRA.data;
      for (const [index, wanted] of saturated.entries()) {
        if (wanted && cursor + U64 <= at + EXTRA.data + size) {
          values[index] = readU64(view, cursor);
          cursor += U64;
        }
      }
    }
    at += EXTRA.data + size;
  }

  return [values[0], values[1], values[2]];
}

/**
 * Decodes an entry's name: UTF-8 where the entry's flags say so, Latin-1 otherwise, as fflate's reader does.
 * @param bytes - The name's bytes.
 * @param flags - The entry's general purpose flags.
 * @returns The name.
 */
function nameOf(bytes: Uint8Array, flags: number): string {
  return new TextDecoder((flags & FLAG_UTF8) === 0 ? "latin1" : "utf-8").decode(bytes);
}

/**
 * Lists the central directory of a zip archive, with every size and offset as a full number, so an archive larger than 4 GiB is read as well as a small one. Only the end of the archive and the directory are read, so a source kept on the server is listed by a few ranged requests.
 * @param input - The archive, held in memory or kept anywhere.
 * @returns Each entry, in directory order.
 * @throws ArchiveError when the archive has no readable central directory.
 */
export async function listZip(input: Uint8Array | SourceBytes): Promise<ZipEntry[]> {
  const source = asSource(input);
  const { offset, count, end } = await locateDirectory(source);
  const malformed = (at: number): ArchiveError => new ArchiveError(`not a valid zip archive: the central directory entry at byte ${String(at)} is malformed`);
  if (count === 0) {
    return [];
  }
  if (offset > end) {
    throw malformed(offset);
  }
  const directory = await source.read({ offset, length: end - offset });
  const view = viewOf(directory);
  const entries: ZipEntry[] = [];
  let at = 0;
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_ENTRY_LENGTH > view.byteLength || view.getUint32(at, true) !== ZIP_SIGNATURES.centralEntry) {
      throw malformed(offset + at);
    }
    const flags = view.getUint16(at + CENTRAL.flags, true);
    const compression = view.getUint16(at + CENTRAL.compression, true);
    const size32 = view.getUint32(at + CENTRAL.size, true);
    const original32 = view.getUint32(at + CENTRAL.originalSize, true);
    const nameLength = view.getUint16(at + CENTRAL.nameLength, true);
    const extraLength = view.getUint16(at + CENTRAL.extraLength, true);
    const commentLength = view.getUint16(at + CENTRAL.commentLength, true);
    const offset32 = view.getUint32(at + CENTRAL.offset, true);
    if (at + CENTRAL_ENTRY_LENGTH + nameLength + extraLength > view.byteLength) {
      throw malformed(offset + at);
    }
    const name = nameOf(directory.subarray(at + CENTRAL_ENTRY_LENGTH, at + CENTRAL_ENTRY_LENGTH + nameLength), flags);
    const [original64, size64, offset64] = zip64Values(view, at + CENTRAL_ENTRY_LENGTH + nameLength, extraLength, [original32 === SATURATED_32, size32 === SATURATED_32, offset32 === SATURATED_32]);
    entries.push({ name, flags, compression, size: size64 ?? size32, originalSize: original64 ?? original32, offset: offset64 ?? offset32 });
    at += CENTRAL_ENTRY_LENGTH + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Reads one entry's bytes: stored as they are, deflated inflated. Only the entry's local header and its data are read.
 * @param input - The archive, held in memory or kept anywhere.
 * @param entry - The entry, as `listZip` gives it.
 * @returns The entry's uncompressed bytes.
 * @throws ArchiveError for an encrypted entry, a compression method other than stored and deflate, a local header that is not there, or data that runs past the end of the archive.
 */
export async function readZipEntry(input: Uint8Array | SourceBytes, entry: ZipEntry): Promise<Uint8Array> {
  const source = asSource(input);
  const start = await dataStart(source, entry);
  const data = await readRange(source, start, entry.size, `the data of ${entry.name}`);
  if (entry.compression === STORED) {
    // A copy, so a member its reader keeps does not hold the larger range or file it was read from.
    return data.slice();
  }

  return inflateSync(data, { out: new Uint8Array(entry.originalSize) });
}

/**
 * Where an entry's data starts, once the entry is known to be one this reader can read: past its local header, whose name and extra field may differ in length from the central directory's.
 * @param source - The archive.
 * @param entry - The entry, as `listZip` gives it.
 * @returns The offset of the entry's first byte of data.
 * @throws ArchiveError for an encrypted entry, a compression method other than stored and deflate, or a local header that is not there.
 */
async function dataStart(source: SourceBytes, entry: ZipEntry): Promise<number> {
  if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
    throw new ArchiveError(`zip member ${entry.name} is encrypted`);
  }
  if (entry.compression !== STORED && entry.compression !== DEFLATE) {
    throw new ArchiveError(`zip member ${entry.name} uses compression method ${String(entry.compression)}, which is neither stored nor deflate`);
  }
  const local = entry.offset + LOCAL_HEADER_LENGTH > source.size ? undefined : viewOf(await source.read({ offset: entry.offset, length: LOCAL_HEADER_LENGTH }));
  if (local?.getUint32(0, true) !== ZIP_SIGNATURES.localHeader) {
    throw new ArchiveError(`not a valid zip archive: the local header of ${entry.name} is not at byte ${String(entry.offset)}`);
  }

  return entry.offset + LOCAL_HEADER_LENGTH + local.getUint16(LOCAL.nameLength, true) + local.getUint16(LOCAL.extraLength, true);
}

/** How many compressed bytes a streamed read takes from the source and feeds the inflater at a time. The inflater hands on each feed's output in one array, so what a feed yields, which is what is held of the member at once, is the feed times the data's compression ratio; a mebibyte keeps the per-call cost small and that output a few mebibytes, as the gzip stream's feed does. */
const KIBIBYTE = 1024;
export const INFLATE_FEED_BYTES = KIBIBYTE * KIBIBYTE;

/**
 * Reads one entry's bytes a piece at a time, inflating a deflated entry as its compressed bytes are read, so a member far larger than memory (a tar archive zipped whole) is read in the memory of one piece. The pieces joined are exactly what `readZipEntry` gives.
 * @param input - The archive, held in memory or kept anywhere.
 * @param entry - The entry, as `listZip` gives it.
 * @param feedBytes - How many compressed bytes are read and fed at a time; only a test changes it.
 * @returns The entry's uncompressed bytes, in order, cut anywhere.
 * @throws ArchiveError for an encrypted entry, a compression method other than stored and deflate, a local header that is not there, data that runs past the end of the archive, data that is not valid deflate data, or data that does not inflate to the size the directory states.
 */
export async function* readZipEntryChunks(input: Uint8Array | SourceBytes, entry: ZipEntry, feedBytes: number = INFLATE_FEED_BYTES): AsyncGenerator<Uint8Array, void, undefined> {
  const source = asSource(input);
  const start = await dataStart(source, entry);
  if (start + entry.size > source.size) {
    throw new ArchiveError(`not a valid zip archive: the data of ${entry.name} at byte ${String(start)} runs past the end of the archive`);
  }
  const produced: Uint8Array[] = [];
  let emitted = 0;
  const inflater =
    entry.compression === DEFLATE
      ? new Inflate((chunk) => {
          produced.push(chunk);
          emitted += chunk.length;
        })
      : undefined;
  const feed = (piece: Uint8Array, final: boolean): void => {
    try {
      inflater?.push(piece, final);
    } catch (error) {
      throw new ArchiveError(`zip member ${entry.name} is not valid deflate data: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  let read = 0;
  for await (const bytes of inTurn(piecesOf(entry.size, feedBytes), async (piece) => source.read({ offset: start + piece.offset, length: piece.length }))) {
    read += bytes.length;
    if (inflater === undefined) {
      emitted += bytes.length;
      yield bytes;
      continue;
    }
    feed(bytes, read === entry.size);
    yield* produced.splice(0);
  }
  if (inflater !== undefined && entry.size === 0) {
    // An empty deflated entry is told so with an empty last piece, which the inflater refuses as a stream with no end.
    feed(new Uint8Array(0), true);
  }
  if (emitted !== entry.originalSize) {
    throw new ArchiveError(`zip member ${entry.name} gives ${String(emitted)} bytes, not the ${String(entry.originalSize)} its directory entry states`);
  }
}

/**
 * Reads the entries of a zip archive that a filter accepts, as fflate's `unzipSync` does but with the 64-bit offsets and sizes of zip64, which fflate truncates to 32 bits and so reads a central directory in the wrong place in an archive larger than 4 GiB.
 * @param input - The archive, held in memory or kept anywhere.
 * @param filter - Given an entry's name and sizes before anything is inflated, whether to read it.
 * @returns The accepted entries' bytes, by name.
 * @throws ArchiveError when the archive is malformed, or an accepted entry is encrypted or compressed by a method other than stored or deflate.
 */
export async function unzipEntries(input: Uint8Array | SourceBytes, filter: (entry: ZipEntryInfo) => boolean): Promise<Record<string, Uint8Array>> {
  const source = asSource(input);
  const files: Record<string, Uint8Array> = {};
  const accepted = (await listZip(source)).filter((entry) => filter({ name: entry.name, size: entry.size, originalSize: entry.originalSize, compression: entry.compression }));
  for await (const [name, bytes] of inTurn(accepted, async (entry) => [entry.name, await readZipEntry(source, entry)] as const)) {
    // Defined rather than assigned, as a member's name is the archive's to choose and `__proto__` must land as an own property, not reach the prototype.
    Object.defineProperty(files, name, { value: bytes, enumerable: true, writable: true, configurable: true });
  }

  return files;
}
