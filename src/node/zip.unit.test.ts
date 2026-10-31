import { describe, expect, it } from "vitest";
import { ArchiveError } from "../errors";
import { zip, zip64 } from "../test-support/archives";
import { readU64, unzipEntries } from "./zip";

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
