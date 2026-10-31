import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { collect, zip, zip64 } from "../test-support/archives";
import { listZip, readU64, readZipEntryChunks, unzipEntries, type ZipEntry } from "./zip";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

/** The sample archive's text repeated enough to be deflated, and the member sizes the filter is told of. */
const REPEATS = 200;
const REPEATED_SIZE = "alpha ".length * REPEATS;
/** A 64-bit value above 2^32, a zip's central directory offset in an archive over 4 GiB, and one beyond what a number holds. */
const OVER_FOUR_GIB = 6_814_788_036n;
const BEYOND_SAFE = BigInt(Number.MAX_SAFE_INTEGER) * BigInt(Number.MAX_SAFE_INTEGER);
const SECOND_FIELD = 8;
/** A compression method that is neither stored nor deflate, and the flag bit that marks a member encrypted. */
const UNKNOWN_METHOD = 99;
const ENCRYPTED_FLAG = 1;

describe("unzipEntries", () => {
  it("reads the entries a filter accepts from an ordinary zip, deflated or stored, and tells the filter their names and sizes first", async () => {
    const archive = zip([
      { path: "dir/a.txt", text: "alpha ".repeat(REPEATS) },
      { path: "b.txt", text: "beta" },
    ]);
    const seen: string[] = [];
    const files = (await unzipEntries(archive, (entry) => {
      seen.push(`${entry.name}:${String(entry.originalSize)}`);

      return entry.name === "dir/a.txt";
    }));
    expect(seen).toEqual([`dir/a.txt:${String(REPEATED_SIZE)}`, "b.txt:4"]);
    expect(Object.keys(files)).toEqual(["dir/a.txt"]);
    expect(text(files["dir/a.txt"] ?? new Uint8Array())).toBe("alpha ".repeat(REPEATS));
  });

  it("reads a zip64 archive whose sizes and offsets are in extra fields", async () => {
    const files = await unzipEntries(zip64("net/out.txt", encode("zip64 data")), () => true);
    expect(Object.keys(files)).toEqual(["net/out.txt"]);
    expect(text(files["net/out.txt"] ?? new Uint8Array())).toBe("zip64 data");
  });

  it("reads a 64-bit field above 2^32 exactly, and refuses one beyond 2^53", () => {
    const view = new DataView(new ArrayBuffer(SECOND_FIELD * 2));
    view.setBigUint64(0, OVER_FOUR_GIB, true);
    view.setBigUint64(SECOND_FIELD, BEYOND_SAFE, true);
    expect(readU64(view, 0)).toBe(Number(OVER_FOUR_GIB));
    expect(() => readU64(view, SECOND_FIELD)).toThrow(ArchiveError);
  });

  it("refuses bytes that are not a zip, an encrypted member, a compression method it does not read, and a directory that points at no local header", async () => {
    await expect(unzipEntries(encode("not a zip at all, long enough to hold the fixed record sizes"), () => true)).rejects.toThrow(/no end of central directory/);
    await expect(unzipEntries(zip64("a.txt", encode("x"), { method: 0, flags: ENCRYPTED_FLAG }), () => true)).rejects.toThrow(/encrypted/);
    await expect(unzipEntries(zip64("a.txt", encode("x"), { method: UNKNOWN_METHOD, flags: 0 }), () => true)).rejects.toThrow(/compression method 99/);
    const broken = zip64("a.txt", encode("x"));
    broken[0] = 0;
    await expect(unzipEntries(broken, () => true)).rejects.toThrow(/local header/);
    expect(await unzipEntries(broken, () => false)).toEqual({});
  });
});

describe("readZipEntryChunks", () => {
  /** A member large enough, once deflated, to span several feeds of the sizes below. */
  const MEMBER_REPEATS = 5000;
  const member = encode("A line of a book that repeats.\r\n".repeat(MEMBER_REPEATS));
  /** Feed sizes that end at different places in the compressed data: a single byte, an odd size and a power of two. */
  const ODD_FEED = 7;
  const EVEN_FEED = 64;
  const FEEDS = [1, ODD_FEED, EVEN_FEED] as const;
  const STORED_FEED = 1024;
  /** Enough of the member for several stored feeds, kept small as the zip64 writer builds its archive a byte at a time. */
  const STORED_PIECES = 4;
  /** The compression method fflate's zip writer uses for a member that shrinks. */
  const DEFLATED = 8;

  const joined = (pieces: readonly Uint8Array[]): Uint8Array => {
    const out = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
    let at = 0;
    for (const piece of pieces) {
      out.set(piece, at);
      at += piece.length;
    }

    return out;
  };
  const only = async (archive: Uint8Array): Promise<ZipEntry> => {
    const [entry] = await listZip(archive);

    return entry ?? expect.unreachable("the test archive has a member");
  };

  it.each(FEEDS)("gives exactly what readZipEntry gives for a deflated member, read and inflated %i compressed bytes at a time", async (feed) => {
    const archive = zip([{ path: "books.tar", text: text(member) }]);
    const entry = await only(archive);
    expect(entry.compression).toBe(DEFLATED);
    const pieces = await collect(readZipEntryChunks(archive, entry, feed));
    expect(joined(pieces)).toEqual(member);
    expect(pieces.length).toBeGreaterThan(1);
  });

  it("gives a stored zip64 member a feed at a time, as it is stored", async () => {
    const stored = member.subarray(0, STORED_FEED * STORED_PIECES);
    const archive = zip64("books.tar", stored);
    const pieces = await collect(readZipEntryChunks(archive, await only(archive), STORED_FEED));
    expect(joined(pieces)).toEqual(stored);
    expect(pieces).toHaveLength(STORED_PIECES);
  });

  it("refuses data that does not give the size the directory states, and an encrypted member", async () => {
    const archive = zip([{ path: "books.tar", text: text(member) }]);
    const entry = await only(archive);
    await expect(collect(readZipEntryChunks(archive, { ...entry, originalSize: entry.originalSize + 1 }))).rejects.toThrow(/gives \d+ bytes, not the \d+ its directory entry states/);
    const encrypted = zip64("books.tar", member.subarray(0, STORED_FEED), { method: 0, flags: 1 });
    await expect(collect(readZipEntryChunks(encrypted, await only(encrypted)))).rejects.toThrow(ArchiveError);
  });
});
