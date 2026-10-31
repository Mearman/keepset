import { NativeParseError } from "../errors";

/** The eight bytes every compound file (the OLE2 container of a legacy Office document) starts with. */
export const CFB_SIGNATURE: readonly number[] = Array.from("\u00d0\u00cf\u0011\u00e0\u00a1\u00b1\u001a\u00e1", (character) => character.charCodeAt(0));

/** The sector chain markers a compound file's allocation tables hold: the end of a chain, and a sector no stream owns. */
const END_OF_CHAIN = 0xffff_fffe;
const FREE_SECTOR = 0xffff_ffff;

/** The offsets and sizes the compound file header and its directory entries fix. */
const HEADER_BYTES = 512;
const HEADER_SECTOR_SHIFT = 30;
const HEADER_MINI_SECTOR_SHIFT = 32;
const HEADER_FAT_SECTORS = 44;
const HEADER_FIRST_DIRECTORY_SECTOR = 48;
const HEADER_MINI_STREAM_CUTOFF = 56;
const HEADER_FIRST_MINI_FAT_SECTOR = 60;
const HEADER_FIRST_DIFAT_SECTOR = 68;
const HEADER_DIFAT_SECTORS = 72;
const HEADER_DIFAT = 76;
const HEADER_DIFAT_ENTRIES = 109;
const DIRECTORY_ENTRY_BYTES = 128;
const DIRECTORY_NAME_LENGTH = 64;
const DIRECTORY_NAME_BYTES = 64;
const DIRECTORY_TYPE = 66;
const DIRECTORY_START_SECTOR = 116;
const DIRECTORY_SIZE = 120;
const ROOT_STORAGE = 5;
const UINT32_BYTES = 4;

/** One entry of a compound file's directory: its name, whether it is the root, where its stream starts and how long it is. */
interface DirectoryEntry {
  readonly name: string;
  readonly isRoot: boolean;
  readonly start: number;
  readonly size: number;
}

/** A compound file read far enough to give its streams by name. */
export interface CompoundFile {
  /**
   * Reads a stream of the file.
   * @param name - The stream's name in the root storage.
   * @returns The stream's bytes, or undefined when the root storage holds no stream of that name.
   * @throws NativeParseError when a sector chain of the file runs outside it or loops.
   */
  readonly stream: (name: string) => Uint8Array | undefined;
}

/**
 * Whether bytes start as a compound file does.
 * @param bytes - The file's bytes.
 * @returns True when the signature matches.
 */
export function isCompoundFile(bytes: Uint8Array): boolean {
  return CFB_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * Reads a compound file's header, allocation tables and directory.
 * @param bytes - The file's bytes.
 * @param format - The name of the format being parsed, for errors.
 * @returns The file, whose streams are read on request.
 * @throws NativeParseError when the bytes are not a compound file or its allocation tables run outside it.
 */
export function readCompoundFile(bytes: Uint8Array, format: string): CompoundFile {
  if (!isCompoundFile(bytes) || bytes.length < HEADER_BYTES) {
    throw new NativeParseError(format, 1, "not a compound file");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 2 ** view.getUint16(HEADER_SECTOR_SHIFT, true);
  const miniSectorSize = 2 ** view.getUint16(HEADER_MINI_SECTOR_SHIFT, true);
  const cutoff = view.getUint32(HEADER_MINI_STREAM_CUTOFF, true);
  const entriesPerSector = sectorSize / UINT32_BYTES;

  const sectorAt = (sector: number): Uint8Array => {
    const start = (sector + 1) * sectorSize;
    if (sector >= END_OF_CHAIN || start + sectorSize > bytes.length) {
      throw new NativeParseError(format, 1, `sector ${String(sector)} lies outside the file`);
    }

    return bytes.subarray(start, start + sectorSize);
  };
  const wordsOf = (sectors: readonly number[]): number[] =>
    sectors.flatMap((sector) => {
      const data = sectorAt(sector);
      const sectorView = new DataView(data.buffer, data.byteOffset, data.byteLength);

      return Array.from({ length: entriesPerSector }, (_unused, index) => sectorView.getUint32(index * UINT32_BYTES, true));
    });

  const fatSectors = Array.from({ length: HEADER_DIFAT_ENTRIES }, (_unused, index) => view.getUint32(HEADER_DIFAT + index * UINT32_BYTES, true)).filter((sector) => sector !== FREE_SECTOR);
  let difat = view.getUint32(HEADER_FIRST_DIFAT_SECTOR, true);
  for (let remaining = view.getUint32(HEADER_DIFAT_SECTORS, true); remaining > 0 && difat < END_OF_CHAIN; remaining -= 1) {
    const words = wordsOf([difat]);
    fatSectors.push(...words.slice(0, entriesPerSector - 1).filter((sector) => sector !== FREE_SECTOR));
    difat = words[entriesPerSector - 1] ?? END_OF_CHAIN;
  }
  const fat = wordsOf(fatSectors.slice(0, view.getUint32(HEADER_FAT_SECTORS, true)));

  const chain = (first: number, next: readonly number[]): number[] => {
    const sectors: number[] = [];
    for (let sector = first; sector < END_OF_CHAIN; sector = next[sector] ?? END_OF_CHAIN) {
      if (sectors.length > next.length) {
        throw new NativeParseError(format, 1, "a sector chain loops");
      }
      sectors.push(sector);
    }

    return sectors;
  };
  const read = (sectors: readonly number[], size: number): Uint8Array => {
    const whole = new Uint8Array(sectors.length * sectorSize);
    sectors.forEach((sector, index) => {
      whole.set(sectorAt(sector), index * sectorSize);
    });

    return whole.subarray(0, size);
  };

  const directoryBytes = read(chain(view.getUint32(HEADER_FIRST_DIRECTORY_SECTOR, true), fat), Number.POSITIVE_INFINITY);
  const directoryView = new DataView(directoryBytes.buffer, directoryBytes.byteOffset, directoryBytes.byteLength);
  const entries: DirectoryEntry[] = [];
  for (let at = 0; at + DIRECTORY_ENTRY_BYTES <= directoryBytes.length; at += DIRECTORY_ENTRY_BYTES) {
    const nameBytes = Math.min(directoryView.getUint16(at + DIRECTORY_NAME_LENGTH, true), DIRECTORY_NAME_BYTES);
    entries.push({
      name: new TextDecoder("utf-16le").decode(directoryBytes.subarray(at, at + Math.max(nameBytes - 2, 0))),
      isRoot: directoryBytes[at + DIRECTORY_TYPE] === ROOT_STORAGE,
      start: directoryView.getUint32(at + DIRECTORY_START_SECTOR, true),
      size: directoryView.getUint32(at + DIRECTORY_SIZE, true),
    });
  }

  const root = entries.find((entry) => entry.isRoot);
  const miniFat = wordsOf(chain(view.getUint32(HEADER_FIRST_MINI_FAT_SECTOR, true), fat));
  let miniStream: Uint8Array | undefined;
  const miniSectors = (entry: DirectoryEntry): Uint8Array => {
    if (root === undefined) {
      throw new NativeParseError(format, 1, "the file has no root storage");
    }
    miniStream ??= read(chain(root.start, fat), root.size);
    const container = miniStream;
    const sectors = chain(entry.start, miniFat);
    const whole = new Uint8Array(sectors.length * miniSectorSize);
    sectors.forEach((sector, index) => {
      whole.set(container.subarray(sector * miniSectorSize, (sector + 1) * miniSectorSize), index * miniSectorSize);
    });

    return whole.subarray(0, entry.size);
  };

  return {
    stream: (name) => {
      const entry = entries.find((candidate) => !candidate.isRoot && candidate.name === name);
      if (entry === undefined) {
        return undefined;
      }

      return entry.size < cutoff ? miniSectors(entry) : read(chain(entry.start, fat), entry.size);
    },
  };
}
