import { inflateSync } from "fflate";
import { ArchiveError } from "../errors";

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

/** What a filter is told of an entry before any of it is inflated, as fflate's own zip reader tells it. */
export interface ZipEntryInfo {
  readonly name: string;
  readonly size: number;
  readonly originalSize: number;
  readonly compression: number;
}

/** One entry of the central directory, with its sizes and the offset of its local header as full numbers. */
interface CentralEntry extends ZipEntryInfo {
  readonly flags: number;
  readonly offset: number;
}

/**
 * Reads an unsigned 64-bit little-endian field as a number.
 * @param view - The bytes.
 * @param at - The field's position.
 * @returns The value.
 * @throws ArchiveError when it is beyond what a number holds exactly, which no archive in memory can be.
 */
export function readU64(view: DataView, at: number): number {
  const value = view.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ArchiveError("a zip field is larger than 2^53 bytes");
  }

  return Number(value);
}

/**
 * Finds the end of the central directory record by scanning back from the end of the archive, past any comment.
 * @param view - The archive.
 * @returns The record's position.
 * @throws ArchiveError when there is none.
 */
function findEnd(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - EOCD_LENGTH - MAX_COMMENT);
  for (let at = view.byteLength - EOCD_LENGTH; at >= lowest; at -= 1) {
    if (view.getUint32(at, true) === ZIP_SIGNATURES.endOfCentralDirectory) {
      return at;
    }
  }

  throw new ArchiveError("not a zip archive: no end of central directory record");
}

/**
 * Reads where the central directory is and how many entries it holds, from the zip64 record where the ordinary one says its fields are saturated.
 * @param view - The archive.
 * @param end - The position of the end of central directory record.
 * @returns The directory's offset and its entry count.
 * @throws ArchiveError when a saturated field has no zip64 record to say what it is.
 */
function locateDirectory(view: DataView, end: number): { readonly offset: number; readonly count: number } {
  const count = view.getUint16(end + EOCD.count, true);
  const offset = view.getUint32(end + EOCD.directoryOffset, true);
  if (count !== SATURATED_16 && offset !== SATURATED_32) {
    return { offset, count };
  }
  const locator = end - LOCATOR_LENGTH;
  if (locator < 0 || view.getUint32(locator, true) !== ZIP_SIGNATURES.zip64Locator) {
    return { offset, count };
  }
  const record = readU64(view, locator + LOCATOR.recordOffset);
  if (view.getUint32(record, true) !== ZIP_SIGNATURES.zip64EndOfCentralDirectory) {
    throw new ArchiveError("not a valid zip64 archive: the end of central directory locator points at no zip64 record");
  }

  return { offset: readU64(view, record + ZIP64_RECORD.directoryOffset), count: readU64(view, record + ZIP64_RECORD.count) };
}

/**
 * Reads the zip64 values of an entry, which its extra field gives in the order uncompressed size, compressed size, local header offset, for only those fields the entry's own record saturates.
 * @param view - The archive.
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
 * Lists the central directory of a zip archive, with every size and offset as a full number, so an archive larger than 4 GiB is read as well as a small one.
 * @param bytes - The archive.
 * @returns Each entry, in directory order.
 * @throws ArchiveError when the archive has no readable central directory.
 */
function readDirectory(bytes: Uint8Array): CentralEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { offset, count } = locateDirectory(view, findEnd(view));
  const entries: CentralEntry[] = [];
  let at = offset;
  for (let index = 0; index < count; index += 1) {
    if (at + CENTRAL_ENTRY_LENGTH > view.byteLength || view.getUint32(at, true) !== ZIP_SIGNATURES.centralEntry) {
      throw new ArchiveError(`not a valid zip archive: the central directory entry at byte ${String(at)} is malformed`);
    }
    const flags = view.getUint16(at + CENTRAL.flags, true);
    const compression = view.getUint16(at + CENTRAL.compression, true);
    const size32 = view.getUint32(at + CENTRAL.size, true);
    const original32 = view.getUint32(at + CENTRAL.originalSize, true);
    const nameLength = view.getUint16(at + CENTRAL.nameLength, true);
    const extraLength = view.getUint16(at + CENTRAL.extraLength, true);
    const commentLength = view.getUint16(at + CENTRAL.commentLength, true);
    const offset32 = view.getUint32(at + CENTRAL.offset, true);
    const name = nameOf(bytes.subarray(at + CENTRAL_ENTRY_LENGTH, at + CENTRAL_ENTRY_LENGTH + nameLength), flags);
    const [original64, size64, offset64] = zip64Values(view, at + CENTRAL_ENTRY_LENGTH + nameLength, extraLength, [original32 === SATURATED_32, size32 === SATURATED_32, offset32 === SATURATED_32]);
    entries.push({ name, flags, compression, size: size64 ?? size32, originalSize: original64 ?? original32, offset: offset64 ?? offset32 });
    at += CENTRAL_ENTRY_LENGTH + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Reads one entry's bytes: stored as they are, deflated inflated.
 * @param bytes - The archive.
 * @param entry - The entry.
 * @returns The entry's uncompressed bytes.
 * @throws ArchiveError for an encrypted entry, a compression method other than stored and deflate, or a local header that is not there.
 */
function extract(bytes: Uint8Array, entry: CentralEntry): Uint8Array {
  if ((entry.flags & FLAG_ENCRYPTED) !== 0) {
    throw new ArchiveError(`zip member ${entry.name} is encrypted`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (entry.offset + LOCAL_HEADER_LENGTH > view.byteLength || view.getUint32(entry.offset, true) !== ZIP_SIGNATURES.localHeader) {
    throw new ArchiveError(`not a valid zip archive: the local header of ${entry.name} is not at byte ${String(entry.offset)}`);
  }
  const start = entry.offset + LOCAL_HEADER_LENGTH + view.getUint16(entry.offset + LOCAL.nameLength, true) + view.getUint16(entry.offset + LOCAL.extraLength, true);
  const data = bytes.subarray(start, start + entry.size);
  if (entry.compression === STORED) {
    return data.slice();
  }
  if (entry.compression === DEFLATE) {
    return inflateSync(data, { out: new Uint8Array(entry.originalSize) });
  }

  throw new ArchiveError(`zip member ${entry.name} uses compression method ${String(entry.compression)}, which is neither stored nor deflate`);
}

/**
 * Reads the entries of a zip archive that a filter accepts, as fflate's `unzipSync` does but with the 64-bit offsets and sizes of zip64, which fflate truncates to 32 bits and so reads a central directory in the wrong place in an archive larger than 4 GiB.
 * @param bytes - The archive.
 * @param filter - Given an entry's name and sizes before anything is inflated, whether to read it.
 * @returns The accepted entries' bytes, by name.
 * @throws ArchiveError when the archive is malformed, or an accepted entry is encrypted or compressed by a method other than stored or deflate.
 */
export function unzipEntries(bytes: Uint8Array, filter: (entry: ZipEntryInfo) => boolean): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of readDirectory(bytes)) {
    if (filter({ name: entry.name, size: entry.size, originalSize: entry.originalSize, compression: entry.compression })) {
      files[entry.name] = extract(bytes, entry);
    }
  }

  return files;
}
