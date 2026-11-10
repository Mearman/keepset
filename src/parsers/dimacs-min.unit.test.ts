import { describe, expect, it } from "vitest";
import { parseNative } from "./parse-native";

const min = { format: "dimacs-min", encoding: "utf-8" } as const;

const bytes = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

/** A small instance laid out as a NETGEN `.min` file is: comment lines, the problem line, node descriptors for the supply and demand nodes only, then one arc descriptor per arc. */
const SMALL = ["c NETGEN flow network generator", "c  Random seed:          13502460", "p min 4 5", "n 1 10", "n 4 -10", "a 1 2 0 8 3", "a 1 3 0 -1 5", "c a comment between arcs", "a 2 4 2 9 1", "a 3 4 0 12 0", "a 2 3 0 4 -2"];

/** The opening of the DIMACS benchmark t1.min (NETGEN problem 26, https://archive.dimacs.rutgers.edu/pub/netflow/benchmarks/fortran/t1.min): its last comment lines, the problem line with the arc count cut to the arcs kept here, every node descriptor, and its first arcs. */
const T1_HEAD = ["c", "c  *** Minimum cost flow ***", "c", "p min 400 4", "n 1 62286", "n 2 100000", "n 3 20605", "n 4 217109", "n 389 -22188", "n 390 -56715", "n 391 -89234", "n 392 -27206", "n 393 -44987", "n 394 -3019", "n 395 -6633", "n 396 -39838", "n 397 -31739", "n 398 -12935", "n 399 -17385", "n 400 -48121", "a 1 190 0 62286 194", "a 1 258 0 400000 8577", "a 5 93 0 62286 10000", "a 5 373 0 69839 8240"];

describe("the DIMACS minimum-cost flow parser", () => {
  it("reads every node with its supply (zero where it has no descriptor) and every arc with its lower bound, capacity and cost, an uncapacitated arc's capacity as null", () => {
    expect(parseNative(bytes(...SMALL), min)).toEqual({
      meta: {},
      nodes: [
        { id: "1", supply: 10 },
        { id: "2", supply: 0 },
        { id: "3", supply: 0 },
        { id: "4", supply: -10 },
      ],
      edges: [
        { source: "1", target: "2", low: 0, capacity: 8, cost: 3 },
        { source: "1", target: "3", low: 0, capacity: null, cost: 5 },
        { source: "2", target: "4", low: 2, capacity: 9, cost: 1 },
        { source: "3", target: "4", low: 0, capacity: 12, cost: 0 },
        { source: "2", target: "3", low: 0, capacity: 4, cost: -2 },
      ],
    });
  });

  it("reads a NETGEN benchmark file: supplies balance to zero and only supply and demand nodes are described (the head of t1.min)", () => {
    const graph = parseNative(bytes(...T1_HEAD), min);
    // The problem line names the node count, and only the supply and demand nodes have descriptors.
    expect(graph.nodes.map((node) => node.id)).toEqual(Array.from({ length: Number(T1_HEAD[3]?.split(" ")[2]) }, (_, index) => String(index + 1)));
    expect(graph.nodes.filter((node) => node["supply"] !== 0)).toHaveLength(T1_HEAD.filter((line) => line.startsWith("n ")).length);
    expect(graph.nodes.reduce((sum, node) => sum + Number(node["supply"]), 0)).toBe(0);
    expect(graph.edges[1]).toEqual({ source: "1", target: "258", low: 0, capacity: 400000, cost: 8577 });
  });

  it("keeps parallel arcs, which the specification allows", () => {
    expect(parseNative(bytes("p min 2 2", "a 1 2 0 5 1", "a 1 2 0 3 4"), min).edges).toHaveLength(2);
  });

  it("refuses what the specification rules out", () => {
    expect(() => parseNative(bytes("p max 4 5"), min)).toThrow(/line 1: expected the problem line p min/);
    expect(() => parseNative(bytes("n 1 10", "p min 4 5"), min)).toThrow(/line 1: a node descriptor before the problem line/);
    expect(() => parseNative(bytes(...SMALL, "p min 4 5"), min)).toThrow(/line 12: a second problem line/);
    expect(() => parseNative(bytes(...SMALL.slice(0, -1)), min)).toThrow(/expected 5 arcs, found 4/);
    expect(() => parseNative(bytes("p min 2 1", "a 1 2 0 5 1", "n 1 3"), min)).toThrow(/line 3: a node descriptor after an arc/);
    expect(() => parseNative(bytes("p min 2 0", "n 1 3", "n 1 -3"), min)).toThrow(/line 3: node 1 is described twice/);
    expect(() => parseNative(bytes("p min 2 1", "a 2 2 0 5 1"), min)).toThrow(/line 2: an arc from node 2 to itself/);
    expect(() => parseNative(bytes("p min 2 1", "a 1 3 0 5 1"), min)).toThrow(/line 2: expected a node from 1 to 2, found 3/);
    expect(() => parseNative(bytes("p min 2 1", "a 1 2 6 5 1"), min)).toThrow(/line 2: the lower bound 6 is above the capacity 5/);
    expect(() => parseNative(bytes("p min 2 1", "a 1 2 0 5"), min)).toThrow(/line 2: expected an arc/);
    expect(() => parseNative(bytes("p min 2 1", "x 1 2"), min)).toThrow(/line 2: expected a line starting c, p, n or a/);
    expect(() => parseNative(bytes("c only"), min)).toThrow(/the file has no problem line/);
  });
});
