import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { unpack, unpackFiles, unpackMembers, unpackParts, type Member } from "../archive";
import { ArchiveError } from "../errors";
import { bytesSource } from "../source-bytes";
import { extractAllInMemory, sevenZip, type SevenZipSettings } from "../test-support/seven-zip";
import { sevenZipReader } from "./seven-zip";

const KIBIBYTE = 1024;

/** A small dictionary, so the decoder's window wraps many times within the spanning member, at the fastest level that still compresses with LZMA. */
const DICTIONARY_KIBIBYTES = 64;
const DICTIONARY_BYTES = DICTIONARY_KIBIBYTES * KIBIBYTE;
const SOLID: SevenZipSettings = { solid: true, method: "LZMA", dictionaryBytes: DICTIONARY_BYTES, level: 1 };

/** How much 7-Zip's LZMA decoder reads of the packed stream and writes of the unpacked one at a time (`1 << 20` as `_inBufSizeNew` and `_outStep` in 7-Zip's `CPP/7zip/Compress/LzmaDecoder.cpp`). */
const DECODER_STEP_BITS = 20;
const DECODER_STEP_BYTES = 2 ** DECODER_STEP_BITS;
/** A prime number of bytes added to a member's size, so it is a multiple of no buffer or window and starts or ends on no boundary. */
const OFF_BOUNDARY_BYTES = 7;
/** The member that spans the decoder's boundaries: random, so it packs to about its own size, two decoder steps and several dictionaries long, and off every boundary. */
const STEPS_SPANNED = 2;
const WINDOWS_SPANNED = 3;
const SPANNING_BYTES = STEPS_SPANNED * DECODER_STEP_BYTES + WINDOWS_SPANNED * DICTIONARY_BYTES + OFF_BOUNDARY_BYTES;
/** A member before the spanning one, a dictionary and off every boundary, so the spanning member starts on none. */
const LEADING_BYTES = DICTIONARY_BYTES + OFF_BOUNDARY_BYTES;

/** The fixed start header every 7z archive opens with (SignatureHeader in 7-Zip's `DOC/7zFormat.txt`): signature, version, start header CRC, and the next header's offset, size and CRC. */
const START_HEADER_BYTES = 32;

/** The time one 7-Zip command may take (a worker started, the archive's headers or its whole solid block decoded), set far above what an unloaded host needs so a loaded runner does not fail the test; a test's allowance is this times the commands it runs, a listing and an extraction for each unpacking. */
const MILLISECONDS_PER_COMMAND = 15_000;
const COMMANDS_PER_UNPACKING = 2;
/** The selectors a 7z archive is unpacked by in one test: `members`, `files` and `parts`. */
const SELECTOR_KINDS = 3;
const allowance = (unpackings: number): number => unpackings * COMMANDS_PER_UNPACKING * MILLISECONDS_PER_COMMAND;

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const reader = sevenZipReader();
const options = { sevenZip: reader };

const files = [
  { path: "corpus/a.txt", bytes: text("alpha\n") },
  { path: "corpus/lead.bin", bytes: randomBytes(LEADING_BYTES) },
  { path: "corpus/middle.txt", bytes: text("the middle member\n") },
  { path: "corpus/span.bin", bytes: randomBytes(SPANNING_BYTES) },
  { path: "corpus/z.txt", bytes: text("zulu\n") },
  { path: "corpus/star*?.txt", bytes: text("a literal name\n") },
  { path: "corpus/star.txt", bytes: text("not the starred one\n") },
];
const archive = await sevenZip(files, SOLID);
const reference = await extractAllInMemory(archive);
const referenced = (path: string): Uint8Array => reference.get(path) ?? expect.unreachable(`the reference extracted ${path}`);
const same = (left: Uint8Array, right: Uint8Array): boolean => Buffer.from(left).equals(Buffer.from(right));

const collect = async (members: Readonly<AsyncIterable<Member>>): Promise<Member[]> => {
  const collected: Member[] = [];
  for await (const member of members) {
    collected.push(member);
  }

  return collected;
};

describe("the naive reference", () => {
  it("extracts every file of the solid archive as it went in", () => {
    expect([...reference.keys()].sort()).toEqual(files.map((file) => file.path).sort());
    for (const file of files) {
      expect(same(referenced(file.path), file.bytes)).toBe(true);
    }
  });
});

describe("Node's 7z reader", () => {
  it(
    "lists the files of a solid archive and none of its directories",
    async () => {
      expect([...(await reader.list(bytesSource(archive)))].sort()).toEqual(files.map((file) => file.path).sort());
    },
    allowance(1),
  );

  it(
    "reads a member in the middle of the solid block as the reference does",
    async () => {
      const unpacked = await unpack(archive, { kind: "7z", member: { path: "middle.txt" } }, options);
      expect(unpacked.member).toBe("corpus/middle.txt");
      expect(unpacked.bytes).toEqual(referenced("corpus/middle.txt"));
    },
    allowance(1),
  );

  it(
    "reads a member spanning the decoder's buffers and its dictionary's window as the reference does",
    async () => {
      const span = await unpack(archive, { kind: "7z", member: { path: "corpus/span.bin" } }, options);
      expect(span.bytes.length).toBe(SPANNING_BYTES);
      expect(same(span.bytes, referenced("corpus/span.bin"))).toBe(true);
    },
    allowance(1),
  );

  it(
    "takes a member name holding wildcard characters literally",
    async () => {
      expect((await unpack(archive, { kind: "7z", member: { pattern: "corpus/star\\*\\?\\.txt" } }, options)).bytes).toEqual(text("a literal name\n"));
    },
    allowance(1),
  );

  it(
    "gives every member a `members` selector matches, in path order, and a `files` selector's and the parts' the same way",
    async () => {
      const members = await collect(unpackMembers(archive, { kind: "7z", members: { extensions: [".txt"] } }, options));
      expect(members.map((member) => member.path)).toEqual(["corpus/a.txt", "corpus/middle.txt", "corpus/star*?.txt", "corpus/star.txt", "corpus/z.txt"]);
      for (const member of members) {
        expect(member.bytes).toEqual(referenced(member.path));
      }
      expect((await unpackFiles(archive, { kind: "7z", files: { pattern: "corpus/[a-z]\\.txt" } }, options)).map((member) => member.path)).toEqual(["corpus/a.txt", "corpus/z.txt"]);
      const parts = await unpackParts(
        archive,
        {
          kind: "7z",
          parts: [
            { name: "last", member: { path: "z.txt" } },
            { name: "first", member: { path: "a.txt" } },
          ],
        },
        options,
      );
      expect(parts.map((part) => [part.name, new TextDecoder().decode(part.bytes)])).toEqual([
        ["last", "zulu\n"],
        ["first", "alpha\n"],
      ]);
    },
    allowance(SELECTOR_KINDS),
  );

  it(
    "reads a 7z archive that is a member of another archive",
    async () => {
      const outer = await sevenZip([{ path: "bundle/inner.7z", bytes: archive }], { ...SOLID, level: 0 });
      const unpacked = await unpack(outer, { kind: "7z", member: { extensions: [".7z"] }, inner: { kind: "7z", member: { path: "z.txt" } } }, options);
      expect(unpacked).toEqual({ bytes: text("zulu\n"), member: "bundle/inner.7z/corpus/z.txt" });
    },
    allowance(2),
  );

  it(
    "reads an archive of a block per file the same way",
    async () => {
      const separate = await sevenZip(files, { ...SOLID, solid: false, method: "LZMA2" });
      expect((await unpack(separate, { kind: "7z", member: { path: "middle.txt" } }, options)).bytes).toEqual(referenced("corpus/middle.txt"));
    },
    allowance(1),
  );

  it(
    "refuses a selector that matches nothing, naming it and the members",
    async () => {
      await expect(unpack(archive, { kind: "7z", member: { path: "nope.txt" } }, options)).rejects.toThrow(/expected member nope\.txt, found 0 among: .*corpus\/middle\.txt/);
      await expect(collect(unpackMembers(archive, { kind: "7z", members: { extensions: [".csv"] } }, options))).rejects.toThrow(/expected at least one member ending \.csv, found none among: .*corpus\/a\.txt/);
    },
    allowance(2),
  );

  it(
    "refuses a truncated archive as unreadable",
    async () => {
      const truncated = archive.subarray(0, archive.length - KIBIBYTE);
      const refused = await unpack(truncated, { kind: "7z", member: { path: "middle.txt" } }, options).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ArchiveError);
      expect(refused).toHaveProperty("message", expect.stringMatching(/^not a readable 7z archive: 7-Zip listing the archive ended with status 2: .*Unexpected end of archive/));
    },
    allowance(1),
  );

  it(
    "refuses an archive whose packed data is damaged, though its headers read",
    async () => {
      const damaged = new Uint8Array(archive);
      // The packed stream follows the start header and holds the random members' megabytes, with the headers after it at the archive's end, so a kibibyte this far in is packed data and no header.
      const inside = START_HEADER_BYTES + LEADING_BYTES;
      damaged.fill(0, inside, inside + KIBIBYTE);
      await expect(unpack(damaged, { kind: "7z", member: { path: "z.txt" } }, options)).rejects.toThrow(/not a readable 7z archive: 7-Zip extracting members ended with status 2/);
    },
    allowance(1),
  );

  it("is refused where the platform gives no 7z reader", async () => {
    await expect(unpack(archive, { kind: "7z", member: { path: "middle.txt" } })).rejects.toThrow(/a 7z archive is read only where the platform gives a 7z reader/);
  });

  it(
    "stops at an abort",
    async () => {
      const reason = new Error("stopped");
      await expect(unpack(archive, { kind: "7z", member: { path: "middle.txt" } }, { ...options, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    },
    allowance(1),
  );
});
