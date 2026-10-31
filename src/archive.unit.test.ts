import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { ArchiveError } from "./errors";
import { bzip2, gzip, tar, zip } from "./test-support/archives";
import { unpack, unpackFiles, unpackMembers } from "./archive";
import { BLOCK, readTar, scanTar } from "./node/tar";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const names = (members: readonly { readonly path: string }[]): string[] => members.map((member) => member.path);

describe("readTar", () => {
  it("lists regular files with their full paths, skipping directories", () => {
    // Longer than the 100-byte ustar name field, so the writer emits a GNU long-name record.
    const segments = 30;
    const longPath = `${"deep/".repeat(segments)}file.mtx`;
    const members = readTar(
      tar([
        { path: "net/", text: "", type: "5" },
        { path: "net/net.mtx", text: "matrix" },
        { path: longPath, text: "long" },
      ]),
    );
    expect(members.map((member) => [member.path, text(member.data)])).toEqual([
      ["net/net.mtx", "matrix"],
      [longPath, "long"],
    ]);
  });

  it("reads an archive written by the system tar, not only by this suite's own writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "keepset-tar-"));
    try {
      // Longer than the 100-byte ustar name field, so the system tar must use its long-path form.
      const repeats = 6;
      const longDir = "nested-directory-name-".repeat(repeats);
      mkdirSync(join(dir, "net", longDir), { recursive: true });
      writeFileSync(join(dir, "net", "net.mtx"), "matrix");
      writeFileSync(join(dir, "net", longDir, "deep.txt"), "deep");
      execFileSync("tar", ["-czf", join(dir, "net.tar.gz"), "-C", dir, "net"]);
      const unpacked = unpack(readFileSync(join(dir, "net.tar.gz")), { kind: "tar.gz", member: { extensions: [".txt"] } });
      expect(unpacked.member).toBe(`net/${longDir}/deep.txt`);
      expect(text(unpacked.bytes)).toBe("deep");
      expect(text(unpack(readFileSync(join(dir, "net.tar.gz")), { kind: "tar.gz", member: { path: "net.mtx" } }).bytes)).toBe("matrix");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a header whose checksum fails", () => {
    const bytes = tar([{ path: "a.txt", text: "a" }]);
    bytes[0] = 0x62;
    expect(() => readTar(bytes)).toThrow(ArchiveError);
  });

  it("rejects a member that runs past the end of the archive", () => {
    const block = 512;
    // Several blocks of data, cut off after the header and one block of it.
    const dataBlocks = 4;
    const bytes = tar([{ path: "a.txt", text: "x".repeat(block * dataBlocks) }]).subarray(0, block * 2);
    expect(() => readTar(bytes)).toThrow(/runs past the end/);
  });
});

describe("scanTar", () => {
  /** Directory depth that forces a GNU long-name record, a file longer than one block, and the chunk sizes that cut a header, its data and its padding at every offset a block boundary can fall near. */
  const LONG_PATH_DEPTH = 30;
  const LONG_FILE_BYTES = 1300;
  const ODD_CHUNK = 7;
  const THREE_BLOCKS_OF_CHUNK = 1000;
  const CHUNK_SIZES = [1, ODD_CHUNK, BLOCK - 1, BLOCK, BLOCK + 1, THREE_BLOCKS_OF_CHUNK];
  const PARTIAL_BYTES = 3;
  const CUT_AT = BLOCK * 2 + PARTIAL_BYTES;
  const TRUNCATED_CHUNK_SIZES = [1, BLOCK];
  const archive = tar([
    { path: "net/", text: "", type: "5" },
    { path: "a.txt", text: "alpha" },
    { path: `${"deep/".repeat(LONG_PATH_DEPTH)}long.txt`, text: "x".repeat(LONG_FILE_BYTES) },
    { path: "empty.txt", text: "" },
    { path: "b.txt", text: "beta" },
  ]);
  const cut = (size: number): Uint8Array[] => Array.from({ length: Math.ceil(archive.length / size) }, (_, index) => archive.subarray(index * size, (index + 1) * size));

  it("gives the same paths and kept files however the archive is cut into chunks, including mid-header and mid-padding", () => {
    const whole = scanTar([archive], (path) => path.endsWith("txt") && !path.includes("deep"));
    expect(whole.paths).toEqual(["a.txt", `${"deep/".repeat(LONG_PATH_DEPTH)}long.txt`, "empty.txt", "b.txt"]);
    expect(whole.members.map((member) => [member.path, text(member.data)])).toEqual([
      ["a.txt", "alpha"],
      ["empty.txt", ""],
      ["b.txt", "beta"],
    ]);
    for (const size of CHUNK_SIZES) {
      const chunked = scanTar(cut(size), (path) => path.endsWith("txt") && !path.includes("deep"));
      expect(chunked.paths).toEqual(whole.paths);
      expect(chunked.members.map((member) => [member.path, text(member.data)])).toEqual(whole.members.map((member) => [member.path, text(member.data)]));
    }
  });

  it("keeps no data for a file it is not asked to keep", () => {
    expect(scanTar([archive], () => false).members).toEqual([]);
  });

  it("rejects an archive that ends inside a member however it is cut", () => {
    const truncated = archive.subarray(0, CUT_AT);
    for (const size of [...TRUNCATED_CHUNK_SIZES, truncated.length]) {
      const pieces = Array.from({ length: Math.ceil(truncated.length / size) }, (_, index) => truncated.subarray(index * size, (index + 1) * size));
      expect(() => scanTar(pieces, () => true)).toThrow(/runs past the end/);
    }
  });
});

/** Zero bytes after the gzip member, as the padding a tool leaves after the end of a tar archive. */
const PADDING_BYTES = 37;

describe("unpack of a tar.gz with bytes after its gzip member", () => {
  it("reads the archive a gzip member holds when padding follows it, and still refuses a stream that is not gzip", () => {
    const compressed = gzip(tar([{ path: "pad/a.txt", text: "wanted" }]));
    const padded = Uint8Array.from([...compressed, ...new Uint8Array(PADDING_BYTES)]);
    expect(text(unpack(padded, { kind: "tar.gz", member: { extensions: [".txt"] } }).bytes)).toBe("wanted");
    expect(() => unpack(new TextEncoder().encode("not gzip data at all"), { kind: "tar.gz", member: { extensions: [".txt"] } })).toThrow(/not valid gzip data/);
    expect(() => unpack(compressed.subarray(0, compressed.length >> 1), { kind: "tar.gz", member: { extensions: [".txt"] } })).toThrow(ArchiveError);
  });
});

describe("unpack of a tar.gz larger than one gzip slice", () => {
  const KIBIBYTE = 1024;
  const MEBIBYTE = KIBIBYTE * KIBIBYTE;
  const NOISE_MEBIBYTES = 1.5;
  const MIN_COMPRESSED_MEBIBYTES = 1;
  it("selects a member from a compressed archive whose bytes span several slices, and rejects bytes that do not start as gzip", () => {
    // Random text compresses to little less than its length, so the compressed archive is several times the 1 MiB the gzip stream is fed at a time.
    const noise = randomBytes(Math.ceil(NOISE_MEBIBYTES * MEBIBYTE)).toString("base64");
    const compressed = gzip(
      tar([
        { path: "pad/noise.bin", text: "" },
        { path: "pad/a.txt", text: "wanted" },
        { path: "pad/big.bin", text: noise },
      ]),
    );
    expect(compressed.length).toBeGreaterThan(MIN_COMPRESSED_MEBIBYTES * MEBIBYTE);
    expect(text(unpack(compressed, { kind: "tar.gz", member: { extensions: [".txt"] } }).bytes)).toBe("wanted");
    const corrupt = compressed.slice();
    corrupt.set([0x00], 0);
    expect(() => unpack(corrupt, { kind: "tar.gz", member: { extensions: [".txt"] } })).toThrow(ArchiveError);
  });
});

describe("unpack", () => {
  it("passes plain bytes through and gunzips gzip", () => {
    expect(text(unpack(new TextEncoder().encode("plain"), { kind: "none" }).bytes)).toBe("plain");
    expect(text(unpack(gzip("zipped"), { kind: "gzip" }).bytes)).toBe("zipped");
  });

  it("unpacks a member that is an archive in its turn, naming the file by both paths (the GD 2004 contest bundle's GD04/challenge.zip)", () => {
    const bundle = zipSync({
      "GD04/challenge.zip": zip([
        { path: "challenge/prob1.gd4", text: "prob1" },
        { path: "challenge/prob10.gd4", text: "prob10" },
      ]),
      "GD04/sample1.gd4": new TextEncoder().encode("sample"),
      "GD04/gz/net.txt.gz": gzip("gunzipped"),
    });
    const inner = unpack(bundle, { kind: "zip", member: { extensions: [".zip"] }, inner: { kind: "zip", member: { path: "challenge/prob1.gd4" } } });
    expect(inner.member).toBe("GD04/challenge.zip/challenge/prob1.gd4");
    expect(text(inner.bytes)).toBe("prob1");
    const gunzipped = unpack(bundle, { kind: "zip", member: { extensions: [".gz"] }, inner: { kind: "gzip" } });
    expect([gunzipped.member, text(gunzipped.bytes)]).toEqual(["GD04/gz/net.txt.gz", "gunzipped"]);
    expect(() => unpack(bundle, { kind: "zip", member: { extensions: [".gd4"] }, inner: { kind: "zip", member: { path: "prob1.gd4" } } })).toThrow(ArchiveError);
    expect(() => unpack(bundle, { kind: "zip", member: { extensions: [".zip"] }, inner: { kind: "zip", member: { path: "challenge/prob2.gd4" } } })).toThrow(/found 0/);
  });

  it("selects a zip member by path, by trailing segments and by extension, ignoring resource forks", () => {
    const archive = zip([
      { path: "data/net.gml", text: "gml" },
      { path: "data/readme.txt", text: "readme" },
      { path: "__MACOSX/data/._net.gml", text: "fork" },
    ]);
    expect(unpack(archive, { kind: "zip", member: { path: "data/net.gml" } })).toEqual({ bytes: new TextEncoder().encode("gml"), member: "data/net.gml" });
    expect(unpack(archive, { kind: "zip", member: { path: "net.gml" } }).member).toBe("data/net.gml");
    expect(unpack(archive, { kind: "zip", member: { extensions: [".GML"] } }).member).toBe("data/net.gml");
  });

  it("selects a tar.gz member", () => {
    const archive = gzip(tar([{ path: "adjnoun/adjnoun.mtx", text: "mtx" }]));
    expect(unpack(archive, { kind: "tar.gz", member: { path: "adjnoun/adjnoun.mtx" } }).member).toBe("adjnoun/adjnoun.mtx");
    expect(text(unpack(tar([{ path: "a.net", text: "net" }]), { kind: "tar", member: { extensions: [".net"] } }).bytes)).toBe("net");
  });

  it("rejects a selector matching no member or several, listing what the archive holds", () => {
    const archive = zip([
      { path: "a.txt", text: "a" },
      { path: "b.txt", text: "b" },
    ]);
    expect(() => unpack(archive, { kind: "zip", member: { path: "c.txt" } })).toThrow(/found 0 among: a.txt, b.txt/);
    expect(() => unpack(archive, { kind: "zip", member: { extensions: [".txt"] } })).toThrow(/found 2/);
  });

  it("rejects bytes that are not the stated archive kind", () => {
    const notAnArchive = new TextEncoder().encode("not an archive at all");
    expect(() => unpack(notAnArchive, { kind: "gzip" })).toThrow(ArchiveError);
    expect(() => unpack(notAnArchive, { kind: "zip", member: { path: "a" } })).toThrow(ArchiveError);
  });
});

describe("bzip2 archives", () => {
  const concat = (...parts: readonly Uint8Array[]): Uint8Array => Uint8Array.from(parts.flatMap((part) => [...part]));
  // Long enough to span several 100 kB bzip2 blocks, so a stream cut inside a block, between blocks and inside the trailer are all different faults.
  const REPEATS = 120_000;
  const long = "1 2 3\n".repeat(REPEATS);

  it("unpacks a bare bzip2 file", () => {
    expect(text(unpack(bzip2("1 2\n2 3\n"), { kind: "bzip2" }).bytes)).toBe("1 2\n2 3\n");
    expect(text(unpack(bzip2(long), { kind: "bzip2" }).bytes)).toBe(long);
  });

  it("unpacks the stream of an empty file to no bytes", () => {
    expect(unpack(bzip2(""), { kind: "bzip2" }).bytes).toHaveLength(0);
  });

  it("reads concatenated streams as one file, as bzip2 -d does", () => {
    expect(text(unpack(concat(bzip2("first\n"), bzip2("second\n")), { kind: "bzip2" }).bytes)).toBe("first\nsecond\n");
  });

  it("selects a tar.bz2 member by path, extension and pattern, and gives the same members as a tar.gz", () => {
    const files = [
      { path: "moreno_lesmis/out.moreno_lesmis_lesmis", text: "% sym posweighted\n1 2 1\n" },
      { path: "moreno_lesmis/meta.moreno_lesmis_lesmis", text: "name: Les Miserables\n" },
      { path: "moreno_lesmis/README.moreno_lesmis", text: "readme" },
    ];
    const archive = bzip2(tar(files));
    expect(unpack(archive, { kind: "tar.bz2", member: { path: "out.moreno_lesmis_lesmis" } }).member).toBe("moreno_lesmis/out.moreno_lesmis_lesmis");
    expect(unpack(archive, { kind: "tar.bz2", member: { pattern: "(?:[^/]+/)?out\\.[^/]+" } })).toEqual({ bytes: new TextEncoder().encode("% sym posweighted\n1 2 1\n"), member: "moreno_lesmis/out.moreno_lesmis_lesmis" });
    expect(names([...unpackMembers(archive, { kind: "tar.bz2", members: { extensions: [".moreno_lesmis"] } })])).toEqual(["moreno_lesmis/README.moreno_lesmis"]);
    expect(names([...unpackMembers(archive, { kind: "tar.bz2", members: { pattern: "moreno_lesmis/(?:meta|out)\\..*" } })])).toEqual(names([...unpackMembers(gzip(tar(files)), { kind: "tar.gz", members: { pattern: "moreno_lesmis/(?:meta|out)\\..*" } })]));
  });

  it("reads an archive written by the system tar and bzip2, not only by this suite's own writer", () => {
    const dir = mkdtempSync(join(tmpdir(), "keepset-tarbz2-"));
    try {
      mkdirSync(join(dir, "net"));
      writeFileSync(join(dir, "net", "out.net"), "% sym unweighted\n1 2\n");
      execFileSync("tar", ["-cjf", join(dir, "net.tar.bz2"), "-C", dir, "net"]);
      expect(text(unpack(readFileSync(join(dir, "net.tar.bz2")), { kind: "tar.bz2", member: { path: "out.net" } }).bytes)).toBe("% sym unweighted\n1 2\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const whole = bzip2(long);
  const flipped = Uint8Array.from(whole);
  const MIDDLE = Math.floor(whole.length / 2);
  // Any single flipped bit in the compressed data fails a block's CRC or the decoding that precedes it.
  const FLIPPED_BIT = 0b10000;
  flipped[MIDDLE] = (flipped[MIDDLE] ?? 0) ^ FLIPPED_BIT;
  const TRAILER_BYTES = 10;
  it.each([
    ["data that is not bzip2", new TextEncoder().encode("not bzip2 at all"), /does not start with the BZh header/],
    ["no data", new Uint8Array(0), /does not start with the BZh header/],
    ["a header with an impossible block size digit", new TextEncoder().encode("BZh0"), /does not start with the BZh header/],
    ["a stream cut inside a block", whole.subarray(0, MIDDLE), /./],
    ["a stream missing its end-of-stream trailer", whole.subarray(0, whole.length - TRAILER_BYTES), /input stream ended prematurely/],
    ["a corrupted block", flipped, /./],
    ["bytes after the last stream that are not another stream", concat(whole, new TextEncoder().encode("JUNKJUNKJUNK")), /./],
  ] as const)("rejects %s", (_name, bytes, message) => {
    for (const archive of [{ kind: "bzip2" }, { kind: "tar.bz2", member: { path: "a" } }] as const) {
      // One decode per archive kind: each decode allocates the decoder's block tables, so asserting on three separate calls tripled the work for no extra coverage.
      let failure: unknown;
      try {
        unpack(bytes, archive);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ArchiveError);
      expect(failure).toHaveProperty("message", expect.stringMatching(/not valid bzip2 data/));
      expect(failure).toHaveProperty("message", expect.stringMatching(message));
    }
  });
});

/** A member long enough that the zip writer deflates it rather than storing it. */
const BROKEN_LENGTH = 64;
const ALL_ONES = 0xff;

describe("unpackMembers", () => {
  const files = [
    { path: "suite/b.txt", text: "b" },
    { path: "suite/a.txt", text: "a" },
    { path: "suite/readme.md", text: "readme" },
    { path: "__MACOSX/suite/._a.txt", text: "fork" },
    { path: "suite/other/c.txt", text: "c" },
  ];

  it("gives every member an extension selector matches, in path order and without resource forks", () => {
    const members = [...unpackMembers(zip(files), { kind: "zip", members: { extensions: [".txt"] } })];
    expect(names(members)).toEqual(["suite/a.txt", "suite/b.txt", "suite/other/c.txt"]);
    expect(members.map((member) => text(member.bytes))).toEqual(["a", "b", "c"]);
  });

  it("gives the same members from a tar and a tar.gz", () => {
    const archive = tar(files);
    expect(names([...unpackMembers(archive, { kind: "tar", members: { extensions: [".txt"] } })])).toEqual(["suite/a.txt", "suite/b.txt", "suite/other/c.txt"]);
    expect(names([...unpackMembers(gzip(archive), { kind: "tar.gz", members: { extensions: [".txt"] } })])).toEqual(["suite/a.txt", "suite/b.txt", "suite/other/c.txt"]);
  });

  it("takes a pattern selector as every member whose whole path matches it, so a readme and a solution beside the instances are left out", () => {
    const suite = zip([
      { path: "suite/Coordinates_2.txt", text: "two" },
      { path: "suite/Coordinates_10.txt", text: "ten" },
      { path: "suite/readme.txt", text: "readme" },
      { path: "suite/Coordinates_10.txt.bak", text: "backup" },
    ]);
    const members = { pattern: "suite/Coordinates_\\d+\\.txt" };
    expect(names([...unpackMembers(suite, { kind: "zip", members })])).toEqual(["suite/Coordinates_10.txt", "suite/Coordinates_2.txt"]);
    expect(names([...unpackMembers(tar([{ path: "a/x1.txt", text: "1" }, { path: "a/x2.md", text: "2" }]), { kind: "tar", members: { pattern: ".*\\.txt" } })])).toEqual(["a/x1.txt"]);
    expect(() => [...unpackMembers(suite, { kind: "zip", members: { pattern: "suite/Coordinates" } })]).toThrow(/at least one member matching suite\/Coordinates, found none/);
    expect(unpack(suite, { kind: "zip", member: { pattern: "suite/readme\\.txt" } }).member).toBe("suite/readme.txt");
    expect(() => unpack(suite, { kind: "zip", member: { pattern: "suite/Coordinates_.*" } })).toThrow(/expected one member matching suite\/Coordinates_\.\*, found 3/);
  });

  it("takes a path selector as one member, matched by its trailing segments", () => {
    expect(names([...unpackMembers(zip(files), { kind: "zip", members: { path: "b.txt" } })])).toEqual(["suite/b.txt"]);
  });

  it("rejects a selector that matches nothing, listing what the archive holds", () => {
    expect(() => [...unpackMembers(zip(files), { kind: "zip", members: { extensions: [".csv"] } })]).toThrow(/at least one member ending \.csv, found none among: .*suite\/a\.txt/);
    expect(() => [...unpackMembers(zip(files), { kind: "zip", members: { path: "nope.txt" } })]).toThrow(/at least one member nope\.txt/);
  });

  it("inflates each zip member only when it is reached, so a member that cannot be read fails only once it is taken", () => {
    const archive = zip([
      { path: "suite/b.txt", text: "b".repeat(BROKEN_LENGTH) },
      { path: "suite/a.txt", text: "a".repeat(BROKEN_LENGTH) },
    ]);
    // b is written first, so the first occurrence of its name is its local header; its deflated data follows the name and the extra field, whose length sits just before the name.
    const name = new TextEncoder().encode("suite/b.txt");
    const at = archive.findIndex((_, index) => name.every((byte, offset) => archive[index + offset] === byte));
    const extra = new DataView(archive.buffer, archive.byteOffset).getUint16(at - 2, true);
    const broken = archive.slice();
    // A deflate block header of all ones names block type 3, which does not exist.
    broken[at + name.length + extra] = ALL_ONES;
    const members = unpackMembers(broken, { kind: "zip", members: { extensions: [".txt"] } });
    expect(text(members.next().value?.bytes ?? expect.unreachable("the generator yields the first member"))).toBe("a".repeat(BROKEN_LENGTH));
    expect(() => members.next()).toThrow(ArchiveError);
  });

  it("rejects bytes that are not the stated archive kind", () => {
    expect(() => [...unpackMembers(new TextEncoder().encode("not an archive"), { kind: "zip", members: { extensions: [".txt"] } })]).toThrow(ArchiveError);
  });
});

describe("unpackFiles", () => {
  /** An OGB dataset zip's layout: its tables are gzipped files beside ones the recipe does not read. */
  const archive = zipSync({
    "mag/raw/num-node-dict.csv.gz": gzip("paper,author\n2,1\n"),
    "mag/raw/relations/author___writes___paper/edge.csv.gz": gzip("0,1\n"),
    "mag/raw/node-feat/paper/node-feat.csv.gz": gzip("0.5\n"),
    "mag/mapping/README.md": new TextEncoder().encode("readme"),
  });
  const files = { pattern: "mag/raw/(?:num-node-dict|relations/[^/]+/edge)\\.csv\\.gz" };

  it("gives every file the selector matches, in path order, gunzipped when inner says so and under its own path", () => {
    const unpacked = unpackFiles(archive, { kind: "zip", files, inner: { kind: "gzip" } });
    expect(unpacked.map((file) => [file.path, text(file.bytes)])).toEqual([
      ["mag/raw/num-node-dict.csv.gz", "paper,author\n2,1\n"],
      ["mag/raw/relations/author___writes___paper/edge.csv.gz", "0,1\n"],
    ]);
  });

  it("gives the bytes as stored without inner", () => {
    const [first] = unpackFiles(archive, { kind: "zip", files });
    expect(Array.from(first?.bytes ?? [])).toEqual(Array.from(gzip("paper,author\n2,1\n")));
  });

  it("rejects a selected file that is not gzip when inner says it is, naming it", () => {
    expect(() => unpackFiles(archive, { kind: "zip", files: { path: "mag/mapping/README.md" }, inner: { kind: "gzip" } })).toThrow(/member mag\/mapping\/README\.md: not valid gzip data/);
  });

  it("rejects a selector that matches nothing", () => {
    expect(() => unpackFiles(archive, { kind: "zip", files: { extensions: [".parquet"] } })).toThrow(ArchiveError);
  });
});

