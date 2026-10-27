import { describe, expect, it } from "vitest";
import { parseEntry, type Entry } from "../../src/entry";
import { liveEntry } from "../../src/test-support/entries";
import { SameDataSchema, withSameData } from "./same-data";

const entry = (id: string): Entry => parseEntry({ ...liveEntry, id, name: `Entry ${id}` });

describe("withSameData", () => {
  const entries = [entry("a"), entry("b"), entry("c"), entry("d")];

  it("gives each entry of a group the others' ids and leaves the rest alone", () => {
    const result = withSameData(entries, { groups: [["a", "b", "c"]] });
    expect(result.map((item) => item.sameDataAs)).toEqual([["b", "c"], ["a", "c"], ["a", "b"], undefined]);
  });

  it("refuses a group that names an id no entry has", () => {
    expect(() => withSameData(entries, { groups: [["a", "missing"]] })).toThrow("missing");
  });

  it("refuses an entry in two groups", () => {
    expect(() => withSameData(entries, { groups: [["a", "b"], ["b", "c"]] })).toThrow("more than one");
  });

  it("refuses a group of one or one that lists an entry twice", () => {
    expect(SameDataSchema.safeParse({ groups: [["a"]] }).success).toBe(false);
    expect(SameDataSchema.safeParse({ groups: [["a", "a"]] }).success).toBe(false);
  });
});
