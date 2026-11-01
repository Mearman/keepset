import { parseCrosswalk } from "crossmap";
import { describe, expect, it } from "vitest";
import { parseEntry } from "./entry";
import { parseManifest } from "./manifest";
import { CROSSWALK_SCHEMA_URL, ENTRY_SCHEMA_URL, MANIFEST_SCHEMA_URL, serialise } from "./serialise";
import { liveEntry } from "./test-support/entries";

describe("serialise", () => {
  it("names the schema each kind of document is written against", () => {
    expect(JSON.parse(serialise(parseEntry(liveEntry)))).toHaveProperty("$schema", ENTRY_SCHEMA_URL);
    expect(JSON.parse(serialise(parseManifest({ id: "cat", name: "Cat", description: "A catalogue.", version: "1.0.0", repository: "https://example.com/cat" })))).toHaveProperty("$schema", MANIFEST_SCHEMA_URL);
    expect(JSON.parse(serialise(parseCrosswalk({ source: "a", target: "b" })))).toHaveProperty("$schema", CROSSWALK_SCHEMA_URL);
  });

  it("writes the paths a crosswalk carries unchanged as keep, other rules as rules, and leaves an empty list out", () => {
    const crosswalk = parseCrosswalk({
      source: "a",
      target: "b",
      rules: [{ op: "scale", from: "w", to: "weight", factor: 2 }],
      keep: ["meta", "nodes[].id"],
    });
    expect(JSON.parse(serialise(crosswalk))).toEqual({
      $schema: CROSSWALK_SCHEMA_URL,
      keep: ["meta", "nodes[].id"],
      rules: [{ factor: 2, from: "w", op: "scale", to: "weight" }],
      source: "a",
      target: "b",
    });
  });

  it("keeps a move that renames a path or is gated as a rule, since it is not carried unchanged", () => {
    const gated = { op: "move", from: "x", to: "x", when: { kind: "textCompare", op: "equals", left: { kind: "reference", key: "kind" }, right: { kind: "textLiteral", value: "a" } } };
    const crosswalk = parseCrosswalk({ source: "a", target: "b", rules: [{ op: "move", from: "p", to: "q" }, gated], keep: ["z"] });
    const written: unknown = JSON.parse(serialise(crosswalk));
    expect(written).toMatchObject({ keep: ["z"], rules: [{ from: "p", to: "q" }, { from: "x", to: "x", when: {} }] });
  });

  it("writes an entry's inline crosswalk the same way and gives it no schema of its own", () => {
    const written: unknown = JSON.parse(serialise(parseEntry(liveEntry)));
    expect(written).toMatchObject({ crosswalk: { keep: expect.arrayContaining(["meta"]) as unknown } });
    expect(JSON.stringify(written).split("$schema")).toHaveLength(2);
  });

  it("is stable: what it writes parses to a document that writes the same text", () => {
    const text = serialise(parseEntry(liveEntry));
    expect(serialise(parseEntry(JSON.parse(text)))).toBe(text);
  });
});
