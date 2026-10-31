import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { unpack, unpackMembers, unpackParts } from "./archive";
import { BLOCK, scanTar } from "./node/tar";
import { bzip2, collect, gzip, tar, zip64 } from "./test-support/archives";
import { chunkedSource } from "./test-support/streams";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const KIBIBYTE = 1024;

/** A member whose data spans many chunks of every size below (two hundred kibibytes is fifty of the largest), and whose length is not a whole number of tar blocks, so its last block is padded. */
const LARGE_MEMBER_KIBIBYTES = 200;
const PAST_A_BLOCK = 17;
const LARGE_MEMBER_BYTES = LARGE_MEMBER_KIBIBYTES * KIBIBYTE + PAST_A_BLOCK;
/** Chunk sizes that cut headers, data and padding at offsets a block boundary falls just before, just after and far from, all smaller than every form of the archive. */
const ODD_CHUNK_KIBIBYTES = 4;
const ODD_CHUNK_PAST = 3;
const ODD_CHUNK_BYTES = ODD_CHUNK_KIBIBYTES * KIBIBYTE + ODD_CHUNK_PAST;
const LARGE_CHUNK_KIBIBYTES = 64;
const LARGE_CHUNK_BYTES = LARGE_CHUNK_KIBIBYTES * KIBIBYTE + 1;
const CHUNK_SIZES = [BLOCK - 1, BLOCK + 1, ODD_CHUNK_BYTES, LARGE_CHUNK_BYTES];
/** How deep a path must be to need a GNU long-name record, past the ustar name field's hundred bytes. */
const LONG_PATH_DEPTH = 30;

/** Base64 writes three bytes as four characters, so this many random bytes give text of the length asked for. */
const BASE64_BYTES_PER_CHARACTER = 0.75;

/**
 * Base64 text of random bytes, which neither gzip nor bzip2 shrinks much, so a compressed archive is several chunks long too.
 * @param length - The text's length.
 * @returns The text.
 */
const noise = (length: number): string => randomBytes(Math.ceil(length * BASE64_BYTES_PER_CHARACTER)).toString("base64").slice(0, length);

const files = [
  { path: "suite/readme.md", text: "readme" },
  { path: "suite/a.txt", text: "alpha" },
  { path: "suite/large.txt", text: noise(LARGE_MEMBER_BYTES) },
  { path: "suite/skipped.bin", text: noise(LARGE_MEMBER_BYTES) },
  { path: `suite/${"deep/".repeat(LONG_PATH_DEPTH)}c.txt`, text: "gamma" },
  { path: "suite/b.txt", text: "beta" },
];
const archive = tar(files);

/** Each compressed form beside the naive decompression of it into one array, the reference the streamed reader is held to. */
const kinds = [
  { kind: "tar", bytes: archive, whole: (bytes: Uint8Array): Uint8Array => bytes },
  { kind: "tar.gz", bytes: gzip(archive), whole: (bytes: Uint8Array): Uint8Array => gunzipSync(bytes) },
  { kind: "tar.bz2", bytes: bzip2(archive), whole: (bytes: Uint8Array): Uint8Array => execFileSync("bzip2", ["-dc"], { input: bytes, maxBuffer: Number.MAX_SAFE_INTEGER }) },
] as const;

/** Orders members by path, as a collection is read. */
const byPath = (left: readonly [string, string], right: readonly [string, string]): number => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);

describe("the streamed tar reader against the whole-archive reference", () => {
  it.each(kinds)("gives a $kind's selected members exactly as decompressing it whole and reading that does, however the source is cut", async ({ kind, bytes, whole }) => {
    const selected = (path: string): boolean => path.endsWith(".txt");
    const reference = (await scanTar([whole(bytes)], selected)).members.map((member) => [member.path, text(member.data)] as const).toSorted(byPath);
    expect(reference.map(([path]) => path)).toContain("suite/large.txt");
    expect(bytes.length).toBeGreaterThan(Math.max(...CHUNK_SIZES));
    const streamed = await Promise.all(CHUNK_SIZES.map(async (size) => collect(unpackMembers(chunkedSource(bytes, size), { kind, members: { extensions: [".txt"] } }))));
    for (const members of streamed) {
      expect(members.map((member) => [member.path, text(member.bytes)])).toEqual(reference);
    }
  });

  it.each(kinds)("selects one member and named parts of a $kind cut into chunks as the whole-archive reference does", async ({ kind, bytes, whole }) => {
    const [large] = (await scanTar([whole(bytes)], (path) => path === "suite/large.txt")).members;
    const source = chunkedSource(bytes, BLOCK + 1);
    const unpacked = await unpack(source, { kind, member: { path: "large.txt" } });
    // Compared as text: the reference reads a Buffer that Node's decompressors give, the streamed reader plain arrays.
    expect([unpacked.member, text(unpacked.bytes)]).toEqual(["suite/large.txt", text(large?.data ?? expect.unreachable("the reference holds the member"))]);
    const parts = await unpackParts(source, { kind, parts: [{ name: "second", member: { path: "b.txt" } }, { name: "first", member: { path: "a.txt" } }] });
    expect(parts.map((part) => [part.name, part.path, text(part.bytes)])).toEqual([
      ["second", "suite/b.txt", "beta"],
      ["first", "suite/a.txt", "alpha"],
    ]);
  });

  it("fails a tar.gz cut short in the middle, however it is chunked", async () => {
    const compressed = gzip(archive);
    const cut = compressed.subarray(0, compressed.length >> 1);
    await Promise.all(
      CHUNK_SIZES.map(async (size) => {
        await expect(unpack(chunkedSource(cut, size), { kind: "tar.gz", member: { path: "b.txt" } })).rejects.toThrow(/runs past the end/);
      }),
    );
  });
});

describe("the zip reader by ranges", () => {
  /** A filler member far larger than the archive's tail, its directory and the member a reader selects, so a reader that read it would have read more than its size. */
  const FILLER_KIBIBYTES = 512;
  const FILLER_BYTES = FILLER_KIBIBYTES * KIBIBYTE;
  /** Lines enough that the selected member is deflated, not stored. */
  const EDGE_LINES = 100;
  const bundle = zipSync({
    "data/filler.bin": randomBytes(FILLER_BYTES),
    "data/net.txt": new TextEncoder().encode("1 2\n2 3\n".repeat(EDGE_LINES)),
    "data/readme.md": new TextEncoder().encode("readme"),
  });

  it("reads only the directory and the selected member, giving what an in-memory unzip gives", async () => {
    const source = chunkedSource(bundle, BLOCK);
    const unpacked = await unpack(source, { kind: "zip", member: { path: "net.txt" } });
    expect(unpacked).toEqual({ bytes: unzipSync(bundle)["data/net.txt"], member: "data/net.txt" });
    expect(source.rangeBytes()).toBeLessThan(FILLER_BYTES);
  });

  it("reads a zip64 archive's records by ranges", async () => {
    const archive64 = zip64("net/out.txt", new TextEncoder().encode("zip64 data"));
    expect(text((await unpack(chunkedSource(archive64, 1), { kind: "zip", member: { path: "out.txt" } })).bytes)).toBe("zip64 data");
  });

  it("refuses a directory whose entry count runs past the entries it holds", async () => {
    /** Where the end of central directory record starts in an archive with no comment, and where its entry count lies in it (APPNOTE.TXT 4.3.16). */
    const END_RECORD_LENGTH = 22;
    const COUNT_FIELD = 10;
    const counted = bundle.slice();
    const entries = Object.keys(unzipSync(bundle)).length;
    new DataView(counted.buffer).setUint16(counted.length - END_RECORD_LENGTH + COUNT_FIELD, entries + 1, true);
    await expect(unpack(chunkedSource(counted, BLOCK), { kind: "zip", member: { path: "net.txt" } })).rejects.toThrow(/central directory entry at byte \d+ is malformed/);
  });
});
