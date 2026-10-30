import { describe, expect, it } from "vitest";
import { parseStarred, serialiseStarred, toggled } from "./starred";

describe("parseStarred", () => {
  it("reads a stored list of ids", () => {
    expect(parseStarred('["cora","g53"]')).toEqual(new Set(["cora", "g53"]));
  });

  it("reads nothing stored as nothing starred", () => {
    expect(parseStarred(null)).toEqual(new Set());
  });

  it("reads a value that is no list of strings as nothing starred", () => {
    for (const raw of ["", "not json", "{}", "[1]", '["a",null]', '"cora"']) {
      expect(parseStarred(raw)).toEqual(new Set());
    }
  });
});

describe("toggled", () => {
  it("stars an id that is not starred and unstars one that is", () => {
    const one = toggled(new Set(), "cora");
    expect(one).toEqual(new Set(["cora"]));
    expect(toggled(one, "cora")).toEqual(new Set());
  });

  it("leaves the set it was given as it was", () => {
    const before: ReadonlySet<string> = new Set(["a"]);
    toggled(before, "b");
    expect(before).toEqual(new Set(["a"]));
  });
});

describe("serialiseStarred", () => {
  it("writes the same text for the same ids whatever order they were starred in", () => {
    expect(serialiseStarred(new Set(["b", "a"]))).toBe(serialiseStarred(new Set(["a", "b"])));
    expect(serialiseStarred(new Set(["b", "a"]))).toBe('["a","b"]');
  });

  it("round-trips through parseStarred", () => {
    const starred = new Set(["x", "y/z"]);
    expect(parseStarred(serialiseStarred(starred))).toEqual(starred);
  });
});
