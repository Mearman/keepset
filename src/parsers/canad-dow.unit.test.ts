import { describe, expect, it } from "vitest";
import { parseNative } from "./parse-native";

const dow = { format: "canad-dow", encoding: "utf-8" } as const;

const bytes = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

/** A small instance laid out as the CommaLAB C, C+ and R files are: the generator's name line, the counts, one line per arc (from, to, variable cost, capacity, fixed cost and two unused numbers) and one line per commodity (origin, destination, demand), in the files' right-aligned columns. */
const SMALL = [
  " MULTIGEN.DAT:",
  "       3       3       2",
  "       1       2     100     613     595       1       1",
  "       2       3      34      82    1172       1       2",
  "       3       1      27     514    1218       1       3",
  "       1       3      36",
  "       2       1      73",
];

describe("the Canad .dow parser", () => {
  it("reads the network nodes, the arcs with their costs and capacity, and each commodity as a node joined to its origin and destination", () => {
    expect(parseNative(bytes(...SMALL), dow)).toEqual({
      meta: {},
      nodes: [
        { id: "1", type: "node", demand: null },
        { id: "2", type: "node", demand: null },
        { id: "3", type: "node", demand: null },
        { id: "commodity-1", type: "commodity", demand: 36 },
        { id: "commodity-2", type: "commodity", demand: 73 },
      ],
      edges: [
        { source: "1", target: "2", type: "arc", cost: 100, capacity: 613, fixedCost: 595 },
        { source: "2", target: "3", type: "arc", cost: 34, capacity: 82, fixedCost: 1172 },
        { source: "3", target: "1", type: "arc", cost: 27, capacity: 514, fixedCost: 1218 },
        { source: "commodity-1", target: "1", type: "origin", cost: null, capacity: null, fixedCost: null },
        { source: "commodity-1", target: "3", type: "destination", cost: null, capacity: null, fixedCost: null },
        { source: "commodity-2", target: "2", type: "origin", cost: null, capacity: null, fixedCost: null },
        { source: "commodity-2", target: "1", type: "destination", cost: null, capacity: null, fixedCost: null },
      ],
    });
  });

  it("reads a file without the name line and with CRLF line ends and trailing blank lines alike", () => {
    const plain = new TextEncoder().encode(`${SMALL.slice(1).join("\r\n")}\r\n   \r\n`);
    expect(parseNative(plain, dow)).toEqual(parseNative(bytes(...SMALL), dow));
  });

  it("refuses a file whose lines disagree with its counts", () => {
    expect(() => parseNative(bytes(...SMALL.slice(0, -1)), dow)).toThrow(/expected 2 commodity lines, found 1/);
    expect(() => parseNative(bytes(...SMALL, "       1       2       5"), dow)).toThrow(/expected 2 commodity lines, found 3/);
    expect(() => parseNative(bytes(SMALL[0] ?? "", "3 3"), dow)).toThrow(/line 2: expected the node, arc and commodity counts/);
  });

  it("refuses an arc or commodity line of the wrong shape, a node outside 1 to n and a demand that is not positive", () => {
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("     595       1       1", "     595       1"))), dow)).toThrow(/line 3: expected an arc/);
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("       3       1      27", "       4       1      27"))), dow)).toThrow(/line 5: expected a node from 1 to 3, found 4/);
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("       2       1      73", "       2       1       0"))), dow)).toThrow(/line 7: expected the demand of at least 1/);
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("      36", "    36.5"))), dow)).toThrow(/line 6: expected the demand as a whole number/);
  });
});
