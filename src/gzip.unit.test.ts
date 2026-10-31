import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "./errors";
import { gunzip, GunzipStream, gunzipTransform } from "./gzip";
import { gzip, gzipMember, referenceGunzip } from "./test-support/archives";

/** The fixed header and the trailer of a gzip member (RFC 1952 section 2.3.1). */
const FIXED_HEADER_BYTES = 10;
const TRAILER_BYTES = 8;
const CRC_BYTES = 4;
/** Zero bytes after the last member, as a tool that pads its output to a block leaves them. */
const PADDING_BYTES = 37;
/** The bit flipped in a byte to corrupt it. */
const FLIPPED_BIT = 0x01;

/** Text that compresses well, so its deflate data has back references as well as literals, and noise, which compresses little, so its deflate data is mostly literals. */
const TEXT_REPEATS = 64;
const NOISE_BYTES = 512;
const text = "the quick brown fox jumps over the lazy dog\n".repeat(TEXT_REPEATS);
const noise = randomBytes(NOISE_BYTES).toString("base64");

/**
 * Pushes data through a stream in pieces of one size, and ends it.
 * @param bytes - The gzip data.
 * @param pieceBytes - The size of every piece but the last.
 * @returns What the stream decompressed to.
 */
function streamed(bytes: Uint8Array, pieceBytes: number): Uint8Array {
  const produced: Uint8Array[] = [];
  const stream = new GunzipStream((chunk) => {
    produced.push(chunk);
  });
  for (let at = 0; at < bytes.length; at += pieceBytes) {
    stream.push(bytes.subarray(at, at + pieceBytes));
  }
  stream.end();

  return new Uint8Array(Buffer.concat(produced));
}

/**
 * Whether two byte arrays hold the same bytes, compared natively: the property tests compare thousands of results, which an element-by-element deep equality makes slow.
 * @param left - One array.
 * @param right - The other.
 * @returns True when they are equal.
 */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.compare(left, right) === 0;
}

/**
 * The data with one bit of one byte flipped.
 * @param bytes - The data.
 * @param index - Which byte.
 * @returns A corrupted copy.
 */
function flipped(bytes: Uint8Array, index: number): Uint8Array {
  const copy = bytes.slice();
  copy[index] = (copy[index] ?? expect.unreachable(`byte ${String(index)} is inside the data`)) ^ FLIPPED_BIT;

  return copy;
}

/**
 * Whether the reference reads the data.
 * @param bytes - The gzip data.
 * @returns What it decompresses to, or undefined when the reference refuses it.
 */
function reference(bytes: Uint8Array): Uint8Array | undefined {
  try {
    return referenceGunzip(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Checks that the stream, read whole and in pieces of every size, gives what the reference gives, or refuses with an ArchiveError exactly when the reference refuses.
 * @param bytes - The gzip data.
 * @param sizes - The piece sizes.
 */
function agreesWithReference(bytes: Uint8Array, sizes: readonly number[]): void {
  const expected = reference(bytes);
  for (const size of sizes) {
    if (expected === undefined) {
      expect(() => streamed(bytes, size), `pieces of ${String(size)}`).toThrow(ArchiveError);
    } else {
      expect(sameBytes(streamed(bytes, size), expected), `pieces of ${String(size)}`).toBe(true);
    }
  }
}

/**
 * Every piece size from one byte to the whole data, so the cuts between pieces fall at every offset of the header, the deflate data and the trailer.
 * @param bytes - The data.
 * @returns The sizes.
 */
function everySize(bytes: Uint8Array): number[] {
  return Array.from({ length: bytes.length }, (_, index) => index + 1);
}

/** A member with every optional header field, which the stream must read past to reach the deflate data. */
const fullHeader = gzipMember(text, { extra: new TextEncoder().encode("extra"), name: "fox.txt", comment: "a pangram", headerCrc: true });
const members = { text: gzip(text), noise: gzip(noise), empty: gzip(""), fullHeader };

describe("GunzipStream against the zlib reference", () => {
  it("reads every member form the same as zlib, in pieces of every size", () => {
    for (const [name, member] of Object.entries(members)) {
      expect(reference(member), name).toBeDefined();
      agreesWithReference(member, everySize(member));
    }
  });

  it("reads concatenated members as one stream, every member checked, in pieces of every size", () => {
    const joined = Uint8Array.from([...members.text, ...members.empty, ...members.fullHeader, ...members.noise]);
    expect(streamed(joined, joined.length)).toEqual(new TextEncoder().encode(`${text}${text}${noise}`));
    agreesWithReference(joined, everySize(joined));
    // A fault in a member that is not the last fails the stream as a fault in the only one does.
    const crcOfFirst = members.text.length - TRAILER_BYTES;
    expect(() => streamed(flipped(joined, crcOfFirst), joined.length)).toThrow(/the gzip stream fails its checksum \(member 1 /);
  });

  it("refuses a member whose recorded CRC-32 differs from its data's, at whichever of its bytes is flipped", () => {
    for (const member of Object.values(members)) {
      for (let index = member.length - TRAILER_BYTES; index < member.length - TRAILER_BYTES + CRC_BYTES; index += 1) {
        const corrupt = flipped(member, index);
        expect(reference(corrupt)).toBeUndefined();
        expect(() => streamed(corrupt, member.length)).toThrow(/the gzip stream fails its checksum/);
      }
    }
  });

  it("refuses a member whose recorded length differs from its data's, at whichever of its bytes is flipped", () => {
    for (const member of Object.values(members)) {
      for (let index = member.length - CRC_BYTES; index < member.length; index += 1) {
        const corrupt = flipped(member, index);
        expect(reference(corrupt)).toBeUndefined();
        expect(() => streamed(corrupt, member.length)).toThrow(/its length differs from the one it records/);
      }
    }
  });

  it("refuses a flipped byte anywhere in a member exactly when zlib does, never giving a partial result", () => {
    for (const member of Object.values(members)) {
      for (let index = 0; index < member.length; index += 1) {
        agreesWithReference(flipped(member, index), [member.length, FIXED_HEADER_BYTES - 1]);
      }
    }
  });

  it("refuses data cut short anywhere, inside the header, the deflate data or the trailer", () => {
    for (const member of Object.values(members)) {
      for (let length = 0; length < member.length; length += 1) {
        const cut = member.subarray(0, length);
        expect(reference(cut)).toBeUndefined();
        expect(() => streamed(cut, member.length)).toThrow(ArchiveError);
      }
      expect(() => streamed(member.subarray(0, member.length - 1), member.length)).toThrow(/it ends inside a gzip member \(member 1, in its trailer\)/);
    }
    expect(() => streamed(new Uint8Array(0), 1)).toThrow(/it holds no gzip member/);
  });

  it("reads zero padding after the last member, in pieces of every size", () => {
    const padded = Uint8Array.from([...members.text, ...new Uint8Array(PADDING_BYTES)]);
    agreesWithReference(padded, everySize(padded));
    expect(streamed(padded, 1)).toEqual(new TextEncoder().encode(text));
  });

  it("refuses bytes after the last member that are neither zero padding nor another member, padding first or not", () => {
    const junk = new TextEncoder().encode("junk");
    const afterMember = Uint8Array.from([...members.text, ...junk]);
    expect(reference(afterMember)).toBeUndefined();
    agreesWithReference(afterMember, everySize(afterMember));
    // zlib stops at the first zero byte after a member and reads no further, so it takes junk after padding for padding; the stream reads to the end and refuses it.
    const afterPadding = Uint8Array.from([...members.text, ...new Uint8Array(PADDING_BYTES), ...junk]);
    expect(reference(afterPadding)).toBeDefined();
    for (const size of everySize(afterPadding)) {
      expect(() => streamed(afterPadding, size)).toThrow(/neither zero padding nor another gzip member/);
    }
  });

  it("refuses data that is not gzip at its first bytes, and a member header that names another method or sets reserved flags", () => {
    expect(() => streamed(new TextEncoder().encode("not gzip data at all"), 1)).toThrow(/it does not start with the gzip magic bytes/);
    const method = members.text.slice();
    method[2] = 0;
    expect(() => streamed(method, method.length)).toThrow(/names compression method 0, not deflate/);
    const reserved = members.text.slice();
    reserved[3] = 0x80;
    expect(() => streamed(reserved, reserved.length)).toThrow(/sets reserved header flags/);
    const headerCrc = fullHeader.slice();
    const nameAt = fullHeader.indexOf("f".charCodeAt(0), FIXED_HEADER_BYTES);
    headerCrc[nameAt] = "F".charCodeAt(0);
    expect(() => streamed(headerCrc, headerCrc.length)).toThrow(/the header of member 1 fails its checksum/);
  });
});

describe("gunzip and gunzipTransform", () => {
  it("gunzip reads data held whole as the stream does", () => {
    const joined = Uint8Array.from([...members.text, ...members.noise, ...new Uint8Array(PADDING_BYTES)]);
    expect(gunzip(joined)).toEqual(referenceGunzip(joined));
    expect(() => gunzip(flipped(members.text, members.text.length - TRAILER_BYTES))).toThrow(/fails its checksum/);
  });

  it("gunzipTransform decodes a byte stream as the stream does, and errors the stream on a fault", async () => {
    // A copy, which owns a plain ArrayBuffer as a Blob part must.
    const through = async (bytes: Uint8Array): Promise<Uint8Array> => new Uint8Array(await new Response(new Blob([bytes.slice()]).stream().pipeThrough(gunzipTransform())).arrayBuffer());
    const joined = Uint8Array.from([...members.text, ...members.noise]);
    expect(await through(joined)).toEqual(referenceGunzip(joined));
    await expect(through(flipped(members.text, members.text.length - CRC_BYTES))).rejects.toThrow(/its length differs from the one it records/);
    await expect(through(members.text.subarray(0, members.text.length - 1))).rejects.toThrow(/it ends inside a gzip member/);
  });
});
