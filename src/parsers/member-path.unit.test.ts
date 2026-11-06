import { describe, expect, it } from "vitest";
import { parseMemberPaths } from "./member-path";

const parser = { format: "member-path", encoding: "utf-8", idPattern: "(?:[^/]+/)*([^/]+)\\.wav" } as const;

describe("archive paths", () => {
  it("reads identifiers and retains each source path", () => {
    expect(parseMemberPaths(["a/one.wav", "b/two.wav"], parser).nodes).toEqual([{ id: "one", path: "a/one.wav" }, { id: "two", path: "b/two.wav" }]);
  });
  it("exposes named captures, using null for an absent optional capture", () => {
    const labelled = { ...parser, idPattern: "(?:[^/]+/)*((?<label>[a-z]+)(?<variant>[0-9])?)\\.wav" };
    expect(parseMemberPaths(["audio/piano1.wav", "audio/piano.wav"], labelled).nodes).toEqual([{ id: "piano1", path: "audio/piano1.wav", label: "piano", variant: "1" }, { id: "piano", path: "audio/piano.wav", label: "piano", variant: null }]);
    expect(() => parseMemberPaths(["a.wav"], { ...parser, idPattern: "(?<id>[^/]+)\\.wav" })).toThrow("named captures must not be id or path");
  });
  it("rejects nonmatching and duplicate identifiers", () => {
    expect(() => parseMemberPaths(["a/no.txt"], parser)).toThrow("gives no id");
    expect(() => parseMemberPaths(["a/one.wav", "b/one.wav"], parser)).toThrow("given by two files");
  });
});
