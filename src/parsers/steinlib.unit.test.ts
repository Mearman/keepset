import { describe, expect, it } from "vitest";
import { parseNative } from "./parse-native";

const steinlib = { format: "steinlib", encoding: "utf-8" } as const;

const bytes = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

/** The odd wheel of the SteinLib format page, shortened to a triangle with a pendant node, with a title case Terminals section as some files write it. */
const SMALL = ["33D32945 STP File, STP Format Version 1.0", "", "SECTION Comment", 'Name    "small"', "Creator Someone", "END", "", "SECTION Graph", "Nodes 4", "Edges 4", "E 1 2 1", "E 2 3 2.5", "E 3 1 1", "E 3 4 7", "END", "", "Section Terminals", "Terminals 2", "T 1", "T 4", "End", "", "EOF"];

/** The tail of a presolved instance: a Presolve section with its scalar values and its mapping lines, the original instance's coordinates and terminals after it. */
const PRESOLVED = ["SECTION Presolve", "Fixed 963412", "Lower 963412", "Upper 1074705235", "Time 13.31", "OrgNodes 9", "OrgEdges 12", "OrgTerminals 3", "EA 1 2 5 1", "EC 3 4 5", "ED 5 6 7", "END", "", "SECTION Coordinates", "DD 1 10 20", "END", "", "SECTION Terminals", "T 7", "END"];

describe("the SteinLib parser", () => {
  it("reads the nodes with the terminals typed, the weighted edges and the Comment values", () => {
    expect(parseNative(bytes(...SMALL), steinlib)).toEqual({
      meta: { name: "small", creator: "Someone" },
      nodes: [
        { id: "1", type: "terminal" },
        { id: "2", type: "node" },
        { id: "3", type: "node" },
        { id: "4", type: "terminal" },
      ],
      edges: [
        { source: "1", target: "2", weight: 1 },
        { source: "2", target: "3", weight: 2.5 },
        { source: "3", target: "1", weight: 1 },
        { source: "3", target: "4", weight: 7 },
      ],
    });
  });

  it("reads a Presolve section's values and skips the original instance's mapping, coordinates and terminals", () => {
    const parsed = parseNative(bytes(...SMALL.slice(0, -1), ...PRESOLVED, "EOF"), steinlib);
    expect(parsed.meta).toEqual({ name: "small", creator: "Someone", fixed: 963412, lower: 963412, upper: 1074705235, presolveTime: 13.31, orgNodes: 9, orgEdges: 12, orgTerminals: 3 });
    expect(parsed.nodes).toEqual(parseNative(bytes(...SMALL), steinlib).nodes);
  });

  it("refuses a file that disagrees with the format", () => {
    expect(() => parseNative(bytes(...SMALL.slice(1)), steinlib)).toThrow(/line 2: expected the magic number line/);
    expect(() => parseNative(bytes(...SMALL.filter((line) => line !== "E 3 4 7")), steinlib)).toThrow(/line 14: expected 4 edges, found 3/);
    expect(() => parseNative(bytes(...SMALL.map((line) => (line === "T 4" ? "T 5" : line))), steinlib)).toThrow(/line 20: expected a node from 1 to 4, found 5/);
    expect(() => parseNative(bytes(...SMALL.map((line) => (line === "T 4" ? "T 1" : line))), steinlib)).toThrow(/line 20: node 1 is a terminal twice/);
    expect(() => parseNative(bytes(...SMALL.map((line) => (line === "E 3 4 7" ? "A 3 4 7" : line))), steinlib)).toThrow(/line 14: expected Nodes, Edges or an edge E U V WEIGHT/);
    expect(() => parseNative(bytes(...SMALL.map((line) => (line === "T 4" ? "Root 4" : line))), steinlib)).toThrow(/line 20: expected Terminals N or a terminal T V/);
    expect(() => parseNative(bytes(...SMALL.map((line) => (line === "SECTION Comment" ? "SECTION MaximumDegrees" : line))), steinlib)).toThrow(/line 3: the section "MaximumDegrees" is not one the parser reads/);
    expect(() => parseNative(bytes(...SMALL.slice(0, -1)), steinlib)).toThrow(/the file has no EOF line/);
    expect(() => parseNative(bytes(...SMALL, "E 1 2 3"), steinlib)).toThrow(/line 24: a line after EOF/);
  });

  it("refuses a file with no Terminals section rather than typing every node as a plain node", () => {
    const withoutTerminals = SMALL.slice(0, SMALL.indexOf("Section Terminals"));
    expect(() => parseNative(bytes(...withoutTerminals, "EOF"), steinlib)).toThrow(/steinlib.*the file has no complete Terminals section/);
  });

  it("refuses a Presolve section before the instance's own Terminals section instead of skipping that section", () => {
    const own = SMALL.indexOf("Section Terminals");
    const reordered = [...SMALL.slice(0, own), ...PRESOLVED.slice(0, PRESOLVED.indexOf("SECTION Coordinates")), ...SMALL.slice(own, -1), "EOF"];
    expect(() => parseNative(bytes(...reordered), steinlib)).toThrow(/a Presolve section before the instance's Terminals section/);
  });

  it("reads CRLF line endings", () => {
    const crlf = new TextEncoder().encode(`${SMALL.join("\r\n")}\r\n`);
    expect(parseNative(crlf, steinlib)).toEqual(parseNative(bytes(...SMALL), steinlib));
  });

  it("ignores # comment lines and trailing comments", () => {
    const commented = ["# a comment", ...SMALL.map((line) => (line === "E 3 4 7" ? "E 3 4 7 # heavy" : line)), "# after"];
    expect(parseNative(bytes(...commented), steinlib)).toEqual(parseNative(bytes(...SMALL), steinlib));
  });

  it("reads an edge weight written with an exponent", () => {
    const parsed = parseNative(bytes(...SMALL.map((line) => (line === "E 3 4 7" ? "E 3 4 1.5e+3" : line))), steinlib);
    expect(parsed.edges[3]).toEqual({ source: "3", target: "4", weight: 1500 });
  });
});
