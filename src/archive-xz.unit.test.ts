import { describe, expect, it } from "vitest";
import { unpack, unpackFiles, unpackMembers, unpackParts } from "./archive";
import { ArchiveError } from "./errors";
import { unxz } from "./node/xz";
import { collect } from "./test-support/archives";
import { chunkedSource } from "./test-support/streams";
import { fixtureBytes, QURAN_TAR_XZ_BASE64, TWO_LINES_XZ_BASE64 } from "./test-support/xz-fixtures";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Chunk sizes that cut the compressed archive anywhere, down to a byte at a time. */
const BYTE_AT_A_TIME = 1;
const ODD = 7;
const LARGE = 4096;
const CHUNK_SIZES = [BYTE_AT_A_TIME, ODD, LARGE];

/** The archive of the Quran speech dataset's layout, in chunks of a size. */
const quran = (chunkBytes: number): ReturnType<typeof chunkedSource> => chunkedSource(fixtureBytes(QURAN_TAR_XZ_BASE64), chunkBytes);

describe("a tar.xz archive", () => {
  it.each(CHUNK_SIZES)("gives the members a selector matches, whatever the chunks of %i bytes it arrives in", async (chunkBytes) => {
    const members = await collect(unpackMembers(quran(chunkBytes), { kind: "tar.xz", members: { pattern: "audio_data/[^/]+/[^/]+\\.mp3" } }, { xz: unxz }));
    expect(members.map((member) => member.path)).toEqual(["audio_data/reader_1/001001.mp3", "audio_data/reader_2/001002.mp3"]);
    expect(members.map((member) => text(member.bytes))).toEqual(["ID3\u0004audio-one", "ID3\u0004audio-two"]);
  });

  it("gives the one file a document recipe selects, and the files of a files archive, as it does for the other compressions", async () => {
    const { bytes, member } = await unpack(quran(ODD), { kind: "tar.xz", member: { pattern: "(?:.*/)?transcripts\\.tsv" } }, { xz: unxz });
    expect(member).toBe("transcripts.tsv");
    expect(text(bytes)).toMatch(/^PATH\tDURATION\tTRANSCRIPT\naudio_data\/reader_1\/001001\.mp3\t6\.552\n\tبِسْمِ/);
    const files = await unpackFiles(quran(ODD), { kind: "tar.xz", files: { extensions: [".txt", ".json"] } }, { xz: unxz });
    expect(files.map((file) => file.path)).toEqual(["all_ayat.json", "audo_list.txt"]);
  });

  it("gives the named parts of a parts archive", async () => {
    const parts = await unpackParts(
      quran(LARGE),
      { kind: "tar.xz", parts: [{ name: "table", member: { path: "transcripts.tsv" } }, { name: "list", member: { path: "audo_list.txt" } }] },
      { xz: unxz },
    );
    expect(parts.map((part) => part.name)).toEqual(["table", "list"]);
  });

  it("is refused where no xz decoder is given, with an error that says so", async () => {
    await expect(collect(unpackMembers(quran(LARGE), { kind: "tar.xz", members: { pattern: ".*" } }))).rejects.toThrow(/no xz decoder is available here/);
    await expect(collect(unpackMembers(quran(LARGE), { kind: "tar.xz", members: { pattern: ".*" } }))).rejects.toBeInstanceOf(ArchiveError);
  });

  it("fails on data that is not xz, as an archive error", async () => {
    await expect(collect(unpackMembers(chunkedSource(new TextEncoder().encode("not xz"), ODD), { kind: "tar.xz", members: { pattern: ".*" } }, { xz: unxz }))).rejects.toThrow(/^not valid xz data: /);
  });
});

describe("an xz compressed file", () => {
  it("is decompressed whole for the parser that reads one file, however its chunks fall", async () => {
    const source = (chunkBytes: number): ReturnType<typeof chunkedSource> => chunkedSource(fixtureBytes(TWO_LINES_XZ_BASE64), chunkBytes);
    const unpacked = await Promise.all(CHUNK_SIZES.map(async (chunkBytes) => unpack(source(chunkBytes), { kind: "xz" }, { xz: unxz })));
    expect(unpacked.map(({ bytes }) => text(bytes))).toEqual(CHUNK_SIZES.map(() => "first line\nsecond line\n"));
    await expect(unpack(source(LARGE), { kind: "xz" })).rejects.toThrow(/no xz decoder is available here/);
  });
});
