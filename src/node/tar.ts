import { ArchiveError } from "../errors";

/** A tar archive is a sequence of 512-byte blocks: a header block, then the member's data padded to a whole number of blocks. */
export const BLOCK = 512;

/** The ustar header layout (POSIX.1-1988, pax(1) "ustar Interchange Format"): each field's byte offset and length. */
export const HEADER = {
  name: { offset: 0, length: 100 },
  mode: { offset: 100, length: 8 },
  size: { offset: 124, length: 12 },
  checksum: { offset: 148, length: 8 },
  type: { offset: 156, length: 1 },
  magic: { offset: 257, length: 6 },
  version: { offset: 263, length: 2 },
  prefix: { offset: 345, length: 155 },
} as const;

/** The byte the checksum field counts as while the checksum is computed: an ASCII space. */
export const CHECKSUM_FILL = 0x20;

/** GNU tar's base-256 numeric form: the high bit of a field's first byte flags it, and the remaining bits and bytes are a big-endian number. */
const BASE256_FLAG = 0x80;
const BASE256_FIRST_BITS = 0x7f;
const BYTE_RADIX = 256;

/** One regular file in a tar archive. */
export interface TarMember {
  readonly path: string;
  readonly data: Uint8Array;
}

/**
 * Reads a NUL-terminated (or field-filling) string from a header field.
 * @param bytes - The block.
 * @param offset - Field start.
 * @param length - Field length.
 * @returns The field text.
 */
function field(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.subarray(offset, offset + length);
  const end = slice.indexOf(0);

  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

/**
 * Reads a numeric header field: octal text, or for values too large for octal the GNU base-256 form, flagged by the high bit of the first byte.
 * @param bytes - The block.
 * @param offset - Field start.
 * @param length - Field length.
 * @returns The number.
 */
function numeric(bytes: Uint8Array, offset: number, length: number): number {
  const first = bytes[offset];
  if (first !== undefined && (first & BASE256_FLAG) !== 0) {
    let value = first & BASE256_FIRST_BITS;
    for (const byte of bytes.subarray(offset + 1, offset + length)) {
      value = value * BYTE_RADIX + byte;
    }

    return value;
  }
  const text = field(bytes, offset, length).trim();
  if (!/^[0-7]*$/.test(text)) {
    throw new ArchiveError(`tar header field is not octal: ${JSON.stringify(text)}`);
  }

  return text === "" ? 0 : Number.parseInt(text, 8);
}

/**
 * Reads the `path` record of a pax extended header (POSIX.1-2001): records are `<length> <key>=<value>\n`.
 * @param data - The extended header's data.
 * @returns The path it sets, if it sets one.
 */
function paxPath(data: Uint8Array): string | undefined {
  const text = new TextDecoder().decode(data);
  let path: string | undefined;
  for (const record of text.split("\n")) {
    const match = /^\d+ path=(.*)$/s.exec(record);
    if (match?.[1] !== undefined) {
      path = match[1];
    }
  }

  return path;
}

/** The bytes that have arrived and are not yet read, as the chunks they came in, so a stream of any length is read without joining it. */
class ChunkQueue {
  private readonly chunks: Uint8Array[] = [];

  /** How far into the first chunk the read has got. */
  private offset = 0;

  /** The number of unread bytes. */
  public size = 0;

  public push(chunk: Uint8Array): void {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }

  /**
   * Reads exactly `count` bytes, which must have arrived.
   * @param count - How many bytes.
   * @returns The bytes: a view of one chunk where they lie within it, otherwise a copy.
   */
  public take(count: number): Uint8Array {
    const first = this.chunks[0];
    if (first !== undefined && first.length - this.offset >= count) {
      const view = first.subarray(this.offset, this.offset + count);
      this.advance(count);

      return view;
    }
    const joined = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const chunk = this.chunks[0];
      if (chunk === undefined) {
        throw new ArchiveError("tar reader asked for more bytes than have arrived");
      }
      const piece = chunk.subarray(this.offset, this.offset + Math.min(count - filled, chunk.length - this.offset));
      joined.set(piece, filled);
      filled += piece.length;
      this.advance(piece.length);
    }

    return joined;
  }

  /** Drops everything unread. */
  public clear(): void {
    this.chunks.length = 0;
    this.offset = 0;
    this.size = 0;
  }

  private advance(count: number): void {
    this.offset += count;
    this.size -= count;
    const first = this.chunks[0];
    if (first !== undefined && this.offset >= first.length) {
      this.chunks.shift();
      this.offset = 0;
    }
  }
}

/** The entry being read: its header's position, its data's size and how much is still to come, and what to do with the data. */
interface Entry {
  readonly start: number;
  readonly size: number;
  remaining: number;
  /** A GNU long name (`L`) or pax extended header (`x`) record, whose data names the entry after it, or undefined for any other entry. */
  readonly special: "L" | "x" | undefined;
  /** The path of a regular file, or undefined for anything else. */
  readonly path: string | undefined;
  /** Whether the data is kept: a record's always, a regular file's when the caller keeps it. */
  readonly collect: boolean;
  readonly parts: Uint8Array[];
}

/**
 * Reads a tar archive as it arrives in chunks of any size, keeping only the data of the regular files a caller selects, so an archive far larger than a process can hold is read in the memory of its largest selected file. It reads ustar with GNU long names and pax path records, verifying each header's checksum.
 */
export class TarScanner {
  /** The path of every regular file seen, in archive order. */
  public readonly paths: string[] = [];

  /** The regular files `keep` accepted, with their data, in archive order. */
  public readonly members: TarMember[] = [];

  private readonly queue = new ChunkQueue();

  private entry: Entry | undefined;

  private padding = 0;

  private finished = false;

  private position = 0;

  private longName: string | undefined;

  /**
   * @param keep - Given a regular file's path, whether to keep its data.
   */
  public constructor(private readonly keep: (path: string) => boolean) {}

  /**
   * Takes the kept files read so far, so a reader that hands each on as it completes holds only the files not yet taken.
   * @returns The kept files completed since the last take, in archive order.
   */
  public take(): TarMember[] {
    return this.members.splice(0);
  }

  /**
   * Reads the next chunk of the archive.
   * @param chunk - The bytes that follow those already pushed.
   * @throws ArchiveError when a header checksum fails.
   */
  public push(chunk: Uint8Array): void {
    this.queue.push(chunk);
    this.drain();
  }

  /**
   * Ends the archive. An archive may end without its end-of-archive blocks, as one a tool cut at a member's end does, but never part of the way through a header, a member's data or its padding, which is where a download or a decompression cut short ends.
   * @throws ArchiveError when the archive ends inside a header, a member or a member's padding.
   */
  public end(): void {
    if (this.entry !== undefined) {
      throw new ArchiveError(`tar member at byte ${String(this.entry.start)} runs past the end of the archive`);
    }
    if (this.finished) {
      return;
    }
    if (this.padding > 0) {
      throw new ArchiveError(`the padding of the tar member before byte ${String(this.position + this.padding)} runs past the end of the archive`);
    }
    if (this.queue.size > 0) {
      throw new ArchiveError(`tar header at byte ${String(this.position)} runs past the end of the archive`);
    }
  }

  private drain(): void {
    for (;;) {
      if (this.finished) {
        this.queue.clear();

        return;
      }
      if (this.padding > 0) {
        const skip = Math.min(this.padding, this.queue.size);
        if (skip === 0) {
          return;
        }
        this.queue.take(skip);
        this.padding -= skip;
        this.position += skip;
        continue;
      }
      const { entry } = this;
      if (entry === undefined) {
        if (this.queue.size < BLOCK) {
          return;
        }
        this.start(this.queue.take(BLOCK));
        continue;
      }
      if (entry.remaining > 0) {
        const count = Math.min(entry.remaining, this.queue.size);
        if (count === 0) {
          return;
        }
        const piece = this.queue.take(count);
        if (entry.collect) {
          // A copy, so a kept file does not hold the whole chunk it arrived in.
          entry.parts.push(piece.slice());
        }
        entry.remaining -= count;
        this.position += count;
      }
      if (entry.remaining === 0) {
        this.complete(entry);
      }
    }
  }

  private start(header: Uint8Array): void {
    const start = this.position;
    this.position += BLOCK;
    if (header.every((byte) => byte === 0)) {
      this.finished = true;

      return;
    }
    // The checksum is the sum of the header's bytes with its own field counted as spaces.
    const { checksum } = HEADER;
    let sum = 0;
    for (const [index, byte] of header.entries()) {
      sum += index >= checksum.offset && index < checksum.offset + checksum.length ? CHECKSUM_FILL : byte;
    }
    if (sum !== numeric(header, checksum.offset, checksum.length)) {
      throw new ArchiveError(`tar header at byte ${String(start)} fails its checksum`);
    }
    const size = numeric(header, HEADER.size.offset, HEADER.size.length);
    const type = field(header, HEADER.type.offset, HEADER.type.length);
    if (type === "L" || type === "x") {
      this.entry = { start, size, remaining: size, special: type, path: undefined, collect: true, parts: [] };

      return;
    }
    const name = field(header, HEADER.name.offset, HEADER.name.length);
    const prefix = field(header, HEADER.magic.offset, HEADER.magic.length).startsWith("ustar") ? field(header, HEADER.prefix.offset, HEADER.prefix.length) : "";
    const path = this.longName ?? (prefix === "" ? name : `${prefix}/${name}`);
    this.longName = undefined;
    // "0" and an empty (NUL) type mark a regular file, "7" a contiguous one; directories, links and devices carry no data to read.
    const regular = type === "0" || type === "" || type === "7";
    this.entry = { start, size, remaining: size, special: undefined, path: regular ? path : undefined, collect: regular && this.keep(path), parts: [] };
  }

  private complete(entry: Readonly<Entry>): void {
    this.entry = undefined;
    this.padding = (BLOCK - (entry.size % BLOCK)) % BLOCK;
    if (entry.special !== undefined) {
      const data = join(entry.parts, entry.size);
      this.longName = entry.special === "L" ? field(data, 0, data.length) : paxPath(data);

      return;
    }
    if (entry.path === undefined) {
      return;
    }
    this.paths.push(entry.path);
    if (entry.collect) {
      this.members.push({ path: entry.path, data: join(entry.parts, entry.size) });
    }
  }
}

/**
 * Joins the parts of a member's data.
 * @param parts - The parts, in order.
 * @param size - Their total length.
 * @returns The data.
 */
function join(parts: readonly Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1 && parts[0] !== undefined) {
    return parts[0];
  }
  const data = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.length;
  }

  return data;
}

/**
 * Reads a tar archive that arrives in chunks, keeping the data of the regular files `keep` accepts: the archive is read as the chunks arrive, so it is held only a chunk at a time beside the files kept.
 * @param chunks - The archive's bytes, in order, cut anywhere.
 * @param keep - Given a regular file's path, whether to keep its data.
 * @returns The path of every regular file and the kept files with their data.
 * @throws ArchiveError when a header checksum fails or a member runs past the end of the archive; whatever the chunks' source throws.
 */
export async function scanTar(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, keep: (path: string) => boolean): Promise<{ readonly paths: readonly string[]; readonly members: readonly TarMember[] }> {
  const scanner = new TarScanner(keep);
  for await (const chunk of chunks) {
    scanner.push(chunk);
  }
  scanner.end();

  return { paths: scanner.paths, members: scanner.members };
}
