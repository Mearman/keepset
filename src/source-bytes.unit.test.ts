import { describe, expect, it } from "vitest";
import { listFilePaths } from "./archive";
import { bytesSource, concatenateSources } from "./source-bytes";
import { gzip, tar } from "./test-support/archives";

describe("concatenated sources", () => {
  it("reads chunks and ranges across boundaries, including empty parts", async () => {
    const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
    const source = concatenateSources([bytesSource(encode("ab")), bytesSource(encode("")), bytesSource(encode("cde"))]);
    const text = (value: Uint8Array): string => new TextDecoder().decode(value);
    expect(source.size).toBe("abcde".length);
    expect(text(await source.read({ offset: 1, length: "bcd".length }))).toBe("bcd");
    expect(await source.read({ offset: source.size, length: 0 })).toEqual(new Uint8Array());
    expect(text(await source.bytes())).toBe("abcde");
    let chunks = "";
    for await (const chunk of source.chunks()) chunks += text(chunk);
    expect(chunks).toBe("abcde");
    await expect(source.read({ offset: source.size - 1, length: 2 })).rejects.toThrow(/not within/);
  });

  it("reads a gzip archive split through its header, body and trailer", async () => {
    const archive = gzip(tar([{ path: "data/a.flac", text: "first" }, { path: "data/b.flac", text: "second" }]));
    const midpoint = Math.floor(archive.length / 2);
    const parts = [archive.subarray(0, 1), archive.subarray(1, midpoint), archive.subarray(midpoint, archive.length - 1), archive.subarray(archive.length - 1)].map(bytesSource);
    expect(await listFilePaths(concatenateSources(parts), { kind: "tar.gz", files: { extensions: [".flac"] } })).toEqual(["data/a.flac", "data/b.flac"]);
  });
});
