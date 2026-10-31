import { ZStream, zlibInflate, zlibInflateInit2, Z_BUF_ERROR, Z_NO_FLUSH, Z_OK, Z_STREAM_END } from "pako";
import { updateCrc32 } from "./crc32";
import { ArchiveError } from "./errors";

/** The two bytes every gzip member starts with (RFC 1952 section 2.3.1). */
const MAGIC_FIRST = 0x1f;
const MAGIC_SECOND = 0x8b;
/** The compression method byte that names deflate, the only method RFC 1952 defines. */
const DEFLATE_METHOD = 8;
/** The fixed part of a member header: magic, method, flags, modification time, extra flags and operating system. */
const FIXED_HEADER_BYTES = 10;
const FLAGS_OFFSET = 3;
const METHOD_OFFSET = 2;
/** The header flag bits (RFC 1952 section 2.3.1): a header CRC, an extra field, a file name and a comment follow the fixed part, in that field order; the three high bits are reserved and must be zero. */
const FLAG_HEADER_CRC = 0x02;
const FLAG_EXTRA = 0x04;
const FLAG_NAME = 0x08;
const FLAG_COMMENT = 0x10;
const RESERVED_FLAGS = 0xe0;
/** The extra field's length and the header CRC are each a little-endian 16-bit number. */
const U16_BYTES = 2;
const BYTE_BITS = 8;
const LOW_16_BITS = 0xffff;
/** The trailer every member ends with: the CRC-32 of the data it decompresses to, then that data's length modulo 2^32, each little-endian 32 bits. */
const TRAILER_BYTES = 8;
const U32_BYTES = 4;
/** zlib's window bits for raw deflate, with no wrapper of its own: negative, and the largest window, 2^15 bytes, which every deflate stream's back references fit. The gzip framing around it is read here, so this module knows where each member's deflate data ends and its trailer begins. */
const RAW_DEFLATE_WINDOW_BITS = -15;
const KIBIBYTE = 1024;
/** How much decompressed data one output array holds before the inflater starts another: each array is handed on in pieces as it fills, so this bounds the copy the inflater makes at once, and zlib's own default buffer is this size. */
const OUTPUT_ARRAY_KIBIBYTES = 64;
const OUTPUT_ARRAY_BYTES = OUTPUT_ARRAY_KIBIBYTES * KIBIBYTE;
/** A CRC-32 in an error message is written as hexadecimal, two digits to a byte. */
const HEX_RADIX = 16;
const HEX_DIGITS_PER_BYTE = 2;
/** A member's length is recorded modulo 2^32. */
const LENGTH_BITS = 32;
const LENGTH_MODULUS = 2 ** LENGTH_BITS;

/** Where the reader is in the gzip data: before the first member, inside a member's header, deflate data or trailer, just after a member, or in the zero padding after the last one. */
type Phase = "start" | "header" | "data" | "trailer" | "after" | "padding";

/** Which variable header field is being read, after the fixed part. */
type HeaderField = "fixed" | "extraLength" | "extra" | "name" | "comment" | "headerCrc" | "done";

/**
 * Formats a 32-bit number as eight hexadecimal digits, for an error message.
 * @param value - The number.
 * @returns The digits.
 */
function hex(value: number): string {
  return `0x${value.toString(HEX_RADIX).padStart(U32_BYTES * HEX_DIGITS_PER_BYTE, "0")}`;
}

/**
 * A little-endian unsigned number from bytes.
 * @param bytes - The bytes, least significant first.
 * @returns The number.
 */
function littleEndian(bytes: Uint8Array): number {
  let value = 0;
  for (const [index, byte] of bytes.entries()) {
    value += byte * 2 ** (BYTE_BITS * index);
  }

  return value;
}

/**
 * Decompresses gzip data as it arrives: one member or several concatenated ones, as `gzip -d` reads them, with any zero padding after the last. Every member's header is checked (magic, method, reserved flags and, when present, its header CRC), and at its end the CRC-32 and the length modulo 2^32 of everything it decompressed to are compared with the ones its trailer records. Input that ends inside a member, or holds anything after the last member other than zero bytes and further members, fails, so a download cut short or corrupted never yields a prefix of the file as the whole of it.
 *
 * The framing is read here and only each member's deflate data goes to the inflater, pako's port of zlib, run in raw mode, which reports exactly where the deflate data ends. The reader holds the inflater's window and one output array, whatever the size of the data.
 */
export class GunzipStream {
  private readonly onData: (chunk: Uint8Array<ArrayBuffer>) => void;

  private phase: Phase = "start";

  /** How many members have begun, the current one included, to name a member in an error. */
  private members = 0;

  private readonly stream = new ZStream();

  private headerField: HeaderField = "fixed";

  /** The fixed header, the extra field's length, the header CRC or the trailer, as its bytes arrive. */
  private readonly field = new Uint8Array(Math.max(FIXED_HEADER_BYTES, TRAILER_BYTES));

  private fieldLength = 0;

  private flags = 0;

  /** How many bytes of the extra field are still to be skipped. */
  private extraRemaining = 0;

  /** The CRC-32 of the header bytes read so far, which the header CRC, when present, checks. */
  private headerCrc = 0;

  /** The CRC-32 and the length modulo 2^32 of what the current member has decompressed to. */
  private dataCrc = 0;

  private dataLength = 0;

  /** The array the inflater writes into, and how much of it has been handed on. */
  private output = new Uint8Array(OUTPUT_ARRAY_BYTES);

  private handedOn = 0;

  /**
   * @param onData - Given each piece of decompressed data, in order.
   */
  public constructor(onData: (chunk: Uint8Array<ArrayBuffer>) => void) {
    this.onData = onData;
  }

  /**
   * Decompresses the next piece of the data.
   * @param chunk - The bytes that follow those already pushed.
   * @throws ArchiveError when a member's header is not a gzip header, its deflate data is corrupt, its trailer does not match what it decompressed to, or bytes after a member are neither zero padding nor another member.
   */
  public push(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length) {
      at = this.step(chunk, at);
    }
  }

  /**
   * Ends the data.
   * @throws ArchiveError when the data holds no member or ends inside one.
   */
  public end(): void {
    if (this.phase === "start") {
      throw new ArchiveError("not valid gzip data: it holds no gzip member");
    }
    if (this.phase !== "after" && this.phase !== "padding") {
      throw new ArchiveError(`not valid gzip data: it ends inside a gzip member (member ${String(this.members)}, in its ${this.phase})`);
    }
  }

  /**
   * Reads as much of a chunk as the current phase takes.
   * @param chunk - The chunk.
   * @param at - Where in it to start.
   * @returns Where in it the next phase starts.
   */
  private step(chunk: Uint8Array, at: number): number {
    const { phase } = this;
    if (phase === "padding") {
      return this.skipPadding(chunk, at);
    }
    if (phase === "header") {
      return this.readHeader(chunk, at);
    }
    if (phase === "data") {
      return this.inflate(chunk, at);
    }
    if (phase === "trailer") {
      return this.readTrailer(chunk, at);
    }

    return this.startMember(chunk, at);
  }

  /**
   * Begins the next member, or, after a member, the zero padding that may end the data.
   * @param chunk - The chunk.
   * @param at - Where the member or the padding starts.
   * @returns The same place, for the phase begun to read.
   */
  private startMember(chunk: Uint8Array, at: number): number {
    if (this.phase === "after" && chunk[at] === 0) {
      this.phase = "padding";

      return at;
    }
    this.members += 1;
    this.phase = "header";
    this.headerField = "fixed";
    this.fieldLength = 0;
    this.headerCrc = 0;

    return at;
  }

  /**
   * Checks that what follows the last member is zero bytes only.
   * @param chunk - The chunk.
   * @param at - Where the padding goes on.
   * @returns The chunk's end.
   * @throws ArchiveError at the first byte that is not zero.
   */
  private skipPadding(chunk: Uint8Array, at: number): number {
    if (chunk.subarray(at).some((byte) => byte !== 0)) {
      throw new ArchiveError("not valid gzip data: it holds bytes after its last member that are neither zero padding nor another gzip member");
    }

    return chunk.length;
  }

  /**
   * Takes bytes of a fixed-size header or trailer field until it is complete.
   * @param chunk - The chunk.
   * @param at - Where the field goes on.
   * @param size - The field's size.
   * @returns Where the field's bytes taken from this chunk end.
   */
  private collect(chunk: Uint8Array, at: number, size: number): number {
    const taken = Math.min(size - this.fieldLength, chunk.length - at);
    this.field.set(chunk.subarray(at, at + taken), this.fieldLength);
    this.fieldLength += taken;

    return at + taken;
  }

  /**
   * Reads the member header a field at a time, as its bytes arrive.
   * @param chunk - The chunk.
   * @param at - Where the header goes on.
   * @returns Where the header's bytes taken from this chunk end.
   * @throws ArchiveError when the header is not a gzip member header.
   */
  private readHeader(chunk: Uint8Array, at: number): number {
    // The field is read before the call moves past it: every header byte before the header CRC is what that CRC covers.
    const field = this.headerField;
    const end = this.readHeaderField(chunk, at);
    if (field !== "headerCrc") {
      this.headerCrc = updateCrc32(this.headerCrc, chunk.subarray(at, end));
    }
    if (this.headerField === "done") {
      this.beginData();
    }

    return end;
  }

  /**
   * Reads the current header field, moving to the next once it is complete.
   * @param chunk - The chunk.
   * @param at - Where the field goes on.
   * @returns Where the field's bytes taken from this chunk end.
   * @throws ArchiveError when the fixed part is not a gzip header or the header CRC does not match.
   */
  private readHeaderField(chunk: Uint8Array, at: number): number {
    const field = this.headerField;
    if (field === "fixed") {
      return this.readFixedHeader(chunk, at);
    }
    if (field === "extraLength") {
      return this.readExtraLength(chunk, at);
    }
    if (field === "extra") {
      const taken = Math.min(this.extraRemaining, chunk.length - at);
      this.extraRemaining -= taken;
      this.finishExtra();

      return at + taken;
    }
    if (field === "name" || field === "comment") {
      const terminator = chunk.indexOf(0, at);
      if (terminator === -1) {
        return chunk.length;
      }
      this.nextField(field === "name" ? FLAG_COMMENT : FLAG_HEADER_CRC);

      return terminator + 1;
    }
    if (field === "headerCrc") {
      return this.readHeaderCrc(chunk, at);
    }

    return at;
  }

  /**
   * Reads the fixed part of the header, checking the magic bytes as soon as they arrive and the method and flags once it is complete.
   * @param chunk - The chunk.
   * @param at - Where the fixed part goes on.
   * @returns Where its bytes taken from this chunk end.
   * @throws ArchiveError when it is not a gzip member header.
   */
  private readFixedHeader(chunk: Uint8Array, at: number): number {
    const end = this.collect(chunk, at, FIXED_HEADER_BYTES);
    this.checkMagic();
    if (this.fieldLength === FIXED_HEADER_BYTES) {
      this.checkFixedHeader();
      this.nextField(FLAG_EXTRA);
    }

    return end;
  }

  /**
   * Reads the extra field's length, then moves to skipping the field.
   * @param chunk - The chunk.
   * @param at - Where the length goes on.
   * @returns Where its bytes taken from this chunk end.
   */
  private readExtraLength(chunk: Uint8Array, at: number): number {
    const end = this.collect(chunk, at, U16_BYTES);
    if (this.fieldLength === U16_BYTES) {
      this.extraRemaining = littleEndian(this.field.subarray(0, U16_BYTES));
      this.headerField = "extra";
      this.finishExtra();
    }

    return end;
  }

  /**
   * Reads the header CRC and checks it against the low 16 bits of the CRC-32 of the header before it.
   * @param chunk - The chunk.
   * @param at - Where the header CRC goes on.
   * @returns Where its bytes taken from this chunk end.
   * @throws ArchiveError when it does not match.
   */
  private readHeaderCrc(chunk: Uint8Array, at: number): number {
    const end = this.collect(chunk, at, U16_BYTES);
    if (this.fieldLength === U16_BYTES) {
      const recorded = littleEndian(this.field.subarray(0, U16_BYTES));
      if (recorded !== (this.headerCrc & LOW_16_BITS)) {
        throw new ArchiveError(`not valid gzip data: the header of member ${String(this.members)} fails its checksum`);
      }
      this.headerField = "done";
    }

    return end;
  }

  /**
   * Checks the magic bytes as soon as they have arrived, so data that is not gzip fails at its first bytes.
   * @throws ArchiveError when they are not gzip's.
   */
  private checkMagic(): void {
    const [first, second] = this.field;
    const wrong = (this.fieldLength >= 1 && first !== MAGIC_FIRST) || (this.fieldLength >= U16_BYTES && second !== MAGIC_SECOND);
    if (!wrong) {
      return;
    }
    throw new ArchiveError(this.members === 1 ? "not valid gzip data: it does not start with the gzip magic bytes" : "not valid gzip data: it holds bytes after its last member that are neither zero padding nor another gzip member");
  }

  /**
   * Checks the method and flags of a complete fixed header.
   * @throws ArchiveError when the method is not deflate or a reserved flag is set.
   */
  private checkFixedHeader(): void {
    const method = this.field[METHOD_OFFSET];
    const flags = this.field[FLAGS_OFFSET];
    if (method === undefined || flags === undefined) {
      throw new RangeError("the header field array is shorter than the fixed header, which only a fault in this module could cause");
    }
    if (method !== DEFLATE_METHOD) {
      throw new ArchiveError(`not valid gzip data: member ${String(this.members)} names compression method ${String(method)}, not deflate`);
    }
    this.flags = flags;
    if ((flags & RESERVED_FLAGS) !== 0) {
      throw new ArchiveError(`not valid gzip data: member ${String(this.members)} sets reserved header flags`);
    }
  }

  /**
   * Moves to the first optional field, from the one given on, that the flags say is present, or to the deflate data when none is left.
   * @param from - The flag of the field to consider first.
   */
  private nextField(from: number): void {
    this.fieldLength = 0;
    const order: readonly (readonly [number, HeaderField])[] = [
      [FLAG_EXTRA, "extraLength"],
      [FLAG_NAME, "name"],
      [FLAG_COMMENT, "comment"],
      [FLAG_HEADER_CRC, "headerCrc"],
    ];
    const next = order.slice(order.findIndex(([flag]) => flag === from)).find(([flag]) => (this.flags & flag) !== 0);
    this.headerField = next === undefined ? "done" : next[1];
  }

  /** Moves past the extra field once all of it has been skipped. */
  private finishExtra(): void {
    if (this.extraRemaining === 0) {
      this.nextField(FLAG_NAME);
    }
  }

  /**
   * Starts the inflater on a member's deflate data.
   * @throws ArchiveError when the inflater cannot be set up, which only a fault in the inflater could cause.
   */
  private beginData(): void {
    if (zlibInflateInit2(this.stream, RAW_DEFLATE_WINDOW_BITS) !== Z_OK) {
      throw new ArchiveError(`the inflater could not be set up: ${this.stream.msg}`);
    }
    this.dataCrc = 0;
    this.dataLength = 0;
    this.phase = "data";
  }

  /**
   * Inflates a member's deflate data, handing on what it decompresses to, until the chunk is used up or the deflate data ends.
   * @param chunk - The chunk.
   * @param at - Where the deflate data goes on.
   * @returns Where the deflate data taken from this chunk ends: the chunk's end, or the start of the member's trailer.
   * @throws ArchiveError when the deflate data is corrupt.
   */
  private inflate(chunk: Uint8Array, at: number): number {
    const { stream } = this;
    stream.input = chunk.subarray(at);
    stream.next_in = 0;
    stream.avail_in = chunk.length - at;
    for (;;) {
      if (this.handedOn === this.output.length) {
        this.output = new Uint8Array(OUTPUT_ARRAY_BYTES);
        this.handedOn = 0;
      }
      stream.output = this.output;
      stream.next_out = this.handedOn;
      stream.avail_out = this.output.length - this.handedOn;
      const status = zlibInflate(stream, Z_NO_FLUSH);
      this.handOn(stream.next_out);
      if (status === Z_STREAM_END) {
        this.phase = "trailer";
        this.fieldLength = 0;

        return at + stream.next_in;
      }
      if (status !== Z_OK && status !== Z_BUF_ERROR) {
        throw new ArchiveError(`not valid gzip data: the deflate data of member ${String(this.members)} is corrupt: ${stream.msg}`);
      }
      // Output room left over means the inflater stopped for want of input, which is the whole chunk taken.
      if (stream.avail_out > 0) {
        return chunk.length;
      }
    }
  }

  /**
   * Hands on what the inflater has written beyond what was handed on before, counting it into the member's CRC-32 and length.
   * @param written - How far into the output array the inflater has written.
   */
  private handOn(written: number): void {
    if (written === this.handedOn) {
      return;
    }
    const piece = this.output.subarray(this.handedOn, written);
    this.handedOn = written;
    this.dataCrc = updateCrc32(this.dataCrc, piece);
    this.dataLength = (this.dataLength + piece.length) % LENGTH_MODULUS;
    this.onData(piece);
  }

  /**
   * Reads a member's trailer and checks it against what the member decompressed to.
   * @param chunk - The chunk.
   * @param at - Where the trailer goes on.
   * @returns Where the trailer's bytes taken from this chunk end.
   * @throws ArchiveError when the recorded CRC-32 or length differs from the data's.
   */
  private readTrailer(chunk: Uint8Array, at: number): number {
    const end = this.collect(chunk, at, TRAILER_BYTES);
    if (this.fieldLength < TRAILER_BYTES) {
      return end;
    }
    const recordedCrc = littleEndian(this.field.subarray(0, U32_BYTES));
    const recordedLength = littleEndian(this.field.subarray(U32_BYTES, TRAILER_BYTES));
    const member = String(this.members);
    if (recordedCrc !== this.dataCrc) {
      throw new ArchiveError(`not valid gzip data: the gzip stream fails its checksum (member ${member} records CRC-32 ${hex(recordedCrc)}, its data gives ${hex(this.dataCrc)})`);
    }
    if (recordedLength !== this.dataLength) {
      throw new ArchiveError(`not valid gzip data: member ${member} decompresses to ${String(this.dataLength)} bytes modulo 2^32, so its length differs from the one it records, ${String(recordedLength)}`);
    }
    this.phase = "after";

    return end;
  }
}

/**
 * Decompresses gzip data held whole, as `GunzipStream` does.
 * @param bytes - The compressed data.
 * @returns The decompressed bytes.
 * @throws ArchiveError as `GunzipStream` fails.
 */
export function gunzip(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  const stream = new GunzipStream((chunk) => {
    chunks.push(chunk);
  });
  stream.push(bytes);
  stream.end();
  const joined = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  return joined;
}

/**
 * A transform that gunzips a byte stream as `GunzipStream` does, for a body whose transport encoding is gzip.
 * @returns The transform: compressed bytes in, decompressed bytes out, and a failure as `GunzipStream` fails.
 */
export function gunzipTransform(): TransformStream<Uint8Array, Uint8Array<ArrayBuffer>> {
  const produced: Uint8Array<ArrayBuffer>[] = [];
  const stream = new GunzipStream((chunk) => {
    produced.push(chunk);
  });

  return new TransformStream<Uint8Array, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      stream.push(chunk);
      for (const piece of produced.splice(0)) {
        controller.enqueue(piece);
      }
    },
    flush() {
      stream.end();
    },
  });
}
