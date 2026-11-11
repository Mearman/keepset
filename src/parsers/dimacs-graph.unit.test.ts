import { describe, expect, it } from "vitest";
import { parseNative } from "./parse-native";

const dimacs = { format: "dimacs-graph", encoding: "utf-8", layout: "dimacs" } as const;
const pace = { format: "dimacs-graph", encoding: "utf-8", layout: "pace" } as const;

const bytes = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

describe("the DIMACS graph parser", () => {
  it("reads the nodes 1 to N, an isolated one included, and each edge line once in file order", () => {
    const expected = {
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      edges: [
        { source: "1", target: "2" },
        { source: "3", target: "1" },
      ],
    };
    expect(parseNative(bytes("c a comment", "p edge 4 2   ", "e 1 2", "c another", "e 3 1"), dimacs)).toEqual(expected);
    expect(parseNative(bytes("p ds 4 2", "1 2", "3 1"), pace)).toEqual(expected);
    expect(parseNative(new TextEncoder().encode("p ds 4 2\r\n1 2\r\n3 1\r\n\r\n"), pace)).toEqual(expected);
  });

  it("refuses a file whose problem line or edges disagree with the format", () => {
    expect(() => parseNative(bytes("e 1 2"), dimacs)).toThrow(/line 1: an edge line before the problem line/);
    expect(() => parseNative(bytes("p col 2 1", "e 1 2"), dimacs)).toThrow(/line 1: expected the problem line p edge N M/);
    expect(() => parseNative(bytes("p edge 2 1", "p edge 2 1", "e 1 2"), dimacs)).toThrow(/line 2: a second problem line/);
    expect(() => parseNative(bytes("p edge 2 1", "1 2"), dimacs)).toThrow(/line 2: expected an edge line e U V/);
    expect(() => parseNative(bytes("p ds 2 1", "e 1 2"), pace)).toThrow(/line 2: expected an edge line U V/);
    expect(() => parseNative(bytes("p edge 2 1", "e 1 3"), dimacs)).toThrow(/line 2: expected a node from 1 to 2, found 3/);
    expect(() => parseNative(bytes("p edge 2 1", "e 2 2"), dimacs)).toThrow(/line 2: an edge from node 2 to itself/);
    expect(() => parseNative(bytes("p edge 2 2", "e 1 2", "e 2 1"), dimacs)).toThrow(/line 3: the edge between nodes 2 and 1 is given twice/);
    expect(() => parseNative(bytes("p edge 3 2", "e 1 2"), dimacs)).toThrow(/expected 2 edges, found 1/);
    expect(() => parseNative(bytes("c nothing"), dimacs)).toThrow(/the file has no problem line/);
  });
});
