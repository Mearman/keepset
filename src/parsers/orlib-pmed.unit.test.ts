import { describe, expect, it } from "vitest";
import { parseNative } from "./parse-native";

const pmed = { format: "orlib-pmed", encoding: "utf-8" } as const;

const bytes = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

describe("the OR-Library p-median parser", () => {
  it("reads every vertex, one edge per line with its cost, and p into meta (the layout of pmed1.txt, with its leading spaces and trailing blank line)", () => {
    expect(parseNative(bytes(" 4 3 2 ", " 1 2 30 ", " 2 3 46 ", " 3 4 1 ", "    "), pmed)).toEqual({
      meta: { p: 2 },
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      edges: [
        { source: "1", target: "2", cost: 30 },
        { source: "2", target: "3", cost: 46 },
        { source: "3", target: "4", cost: 1 },
      ],
    });
  });

  it("keeps one edge per vertex pair, where it is first listed, with the cost of the last line that gives the pair, as the OR-Library page defines a repeated edge", () => {
    expect(parseNative(bytes("3 4 1", "1 2 30", "2 3 46", "2 1 12", "1 2 9"), pmed)).toEqual({
      meta: { p: 1 },
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }],
      edges: [
        { source: "1", target: "2", cost: 9 },
        { source: "2", target: "3", cost: 46 },
      ],
    });
  });

  it("refuses a file whose edge lines disagree with its count, a vertex outside 1 to n, a malformed line and a p above n", () => {
    expect(() => parseNative(bytes("3 3 1", "1 2 30", "2 3 46"), pmed)).toThrow(/expected 3 edge lines, found 2/);
    expect(() => parseNative(bytes("3 2 1", "1 2 30", "2 4 46"), pmed)).toThrow(/line 3: expected a vertex from 1 to 3, found 4/);
    expect(() => parseNative(bytes("3 2 1", "1 2 30", "2 3"), pmed)).toThrow(/line 3: expected an edge/);
    expect(() => parseNative(bytes("3 1 4", "1 2 30"), pmed)).toThrow(/line 1: p is 4, more than the 3 vertices/);
    expect(() => parseNative(bytes(""), pmed)).toThrow(/expected the vertex count, edge count and p/);
  });
});
