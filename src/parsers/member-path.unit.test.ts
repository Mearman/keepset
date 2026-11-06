import { describe, expect, it } from "vitest";
import { parseMemberPaths } from "./member-path";

const parser = { format: "member-path", encoding: "utf-8", idPattern: "(?:[^/]+/)*([^/]+)\\.wav" } as const;

describe("archive paths", () => {
  it("reads identifiers and retains each source path", () => {
    expect(parseMemberPaths(["a/one.wav", "b/two.wav"], parser).nodes).toEqual([{ id: "one", path: "a/one.wav" }, { id: "two", path: "b/two.wav" }]);
  });
  it("rejects nonmatching and duplicate identifiers", () => {
    expect(() => parseMemberPaths(["a/no.txt"], parser)).toThrow("gives no id");
    expect(() => parseMemberPaths(["a/one.wav", "b/one.wav"], parser)).toThrow("given by two files");
  });
});
