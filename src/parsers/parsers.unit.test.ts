import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** One byte per character, for files whose bytes are not utf-8: each character's code point below 256 is the byte. */
const bytesOf = (text: string): Uint8Array => Uint8Array.from(text, (char) => char.charCodeAt(0));

const edgeList = (options: Partial<Extract<Parser, { format: "edge-list" }>> = {}): Extract<Parser, { format: "edge-list" }> => ({
  format: "edge-list",
  encoding: "utf-8",
  delimiter: "whitespace",
  skipLines: 0,
  commentPrefixes: ["#", "%"],
  sourceColumn: 0,
  targetColumn: 1,
  ...options,
});

function parseError(run: () => unknown): NativeParseError {
  try {
    run();
  } catch (error) {
    if (error instanceof NativeParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a NativeParseError");
}

describe("the edge-list parser", () => {
  it("reads edges in file order and nodes in first-appearance order, skipping comments and blank lines", () => {
    const text = "# a comment\n% another\n\n2 1\r\n1\t3 0.5\n  # indented comment\n3 2\n";
    expect(parseNative(utf8(text), edgeList())).toEqual({
      nodes: [{ id: "2" }, { id: "1" }, { id: "3" }],
      edges: [
        { source: "2", target: "1" },
        { source: "1", target: "3" },
        { source: "3", target: "2" },
      ],
    });
  });

  it("honours the delimiter, header lines and column order", () => {
    const text = "count\n# source, target\na,b,9\nb,c,9\n";
    expect(parseNative(utf8(text), edgeList({ delimiter: "comma", skipLines: 1, sourceColumn: 1, targetColumn: 0 })).edges).toEqual([
      { source: "b", target: "a" },
      { source: "c", target: "b" },
    ]);
    expect(parseNative(utf8("x y\tz\n"), edgeList({ delimiter: "tab" })).edges).toEqual([{ source: "x y", target: "z" }]);
    expect(parseNative(utf8("x  y\n"), edgeList({ delimiter: "space", targetColumn: 2 })).edges).toEqual([{ source: "x", target: "y" }]);
  });

  it("detects the delimiter from the first data line: tab, then comma, then whitespace", () => {
    expect(parseNative(utf8("% header, with a comma\n1,2,.8\n2,3,1\n"), edgeList({ delimiter: "detect" })).edges).toEqual([
      { source: "1", target: "2" },
      { source: "2", target: "3" },
    ]);
    expect(parseNative(utf8("a b\tc\n"), edgeList({ delimiter: "detect" })).edges).toEqual([{ source: "a b", target: "c" }]);
    expect(parseNative(utf8("a  b\n"), edgeList({ delimiter: "detect" })).edges).toEqual([{ source: "a", target: "b" }]);
  });

  it("names the line of a row with too few fields or an empty endpoint", () => {
    expect(parseError(() => parseNative(utf8("1 2\n3\n"), edgeList())).line).toBe(2);
    expect(parseError(() => parseNative(utf8("1,2\n,4\n"), edgeList({ delimiter: "comma" }))).line).toBe(2);
  });

  it("rejects a file with no edges", () => {
    expect(() => parseNative(utf8("# only comments\n"), edgeList())).toThrow(NativeParseError);
  });
});

describe("the Matrix Market parser", () => {
  const mm = (header: string, body: string): Uint8Array => utf8(`%%MatrixMarket matrix coordinate ${header}\n% comment\n${body}`);

  it("reads a square matrix as nodes 1 to n with one edge per stored entry, isolated nodes included", () => {
    expect(parseNative(mm("pattern symmetric", "4 4 2\n2 1\n3 2\n"), { format: "matrix-market", encoding: "utf-8" })).toEqual({
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      edges: [
        { source: "2", target: "1" },
        { source: "3", target: "2" },
      ],
    });
  });

  it("reads a rectangular matrix as a bipartite graph of row and column nodes", () => {
    expect(parseNative(mm("real general", "2 3 2\n1 3 0.5\n2 1 -1\n"), { format: "matrix-market", encoding: "utf-8" })).toEqual({
      nodes: [{ id: "r1" }, { id: "r2" }, { id: "c1" }, { id: "c2" }, { id: "c3" }],
      edges: [
        { source: "r1", target: "c3" },
        { source: "r2", target: "c1" },
      ],
    });
  });

  it("rejects the array layout, an unknown field, a wrong token count, an out-of-range entry and a short file", () => {
    const parser: Extract<Parser, { format: "matrix-market" }> = { format: "matrix-market", encoding: "utf-8" };
    // mm() writes the header, a comment and the size line, so the first entry is line 4.
    const firstEntryLine = 4;
    expect(parseError(() => parseNative(utf8("%%MatrixMarket matrix array real general\n2 2\n1\n2\n3\n4\n"), parser)).line).toBe(1);
    expect(parseError(() => parseNative(mm("quaternion general", "1 1 1\n1 1 1\n"), parser)).line).toBe(1);
    expect(parseError(() => parseNative(mm("real general", "2 2 1\n1 2\n"), parser)).line).toBe(firstEntryLine);
    expect(parseError(() => parseNative(mm("pattern general", "2 2 1\n3 1\n"), parser)).line).toBe(firstEntryLine);
    expect(() => parseNative(mm("pattern general", "2 2 2\n1 2\n"), parser)).toThrow(/declares 2 entries but the file holds 1/);
    expect(() => parseNative(utf8("1 2\n"), parser)).toThrow(/MatrixMarket/);
  });
});

describe("the GML parser", () => {
  const gml: Extract<Parser, { format: "gml" }> = { format: "gml", encoding: "utf-8" };

  it("reads nodes by id and edges by source and target, ignoring other keys and comments", () => {
    const text = `Creator "a test"
# a comment line
graph [
  directed 0
  node [ id 0 label "zero [not a bracket]" value 1 graphics [ x 1.5 y -2e3 ] ]
  node [ id 1 label "one
spans lines" ]
  edge [ source 1 target 0 value 2.5 ]
]`;
    expect(parseNative(utf8(text), gml)).toEqual({ nodes: [{ id: "0" }, { id: "1" }], edges: [{ source: "1", target: "0" }] });
  });

  it("rejects a node without exactly one id, an edge without a target, an unclosed list and a second graph", () => {
    expect(() => parseNative(utf8("graph [ node [ label \"x\" ] ]"), gml)).toThrow(/exactly one scalar id/);
    expect(() => parseNative(utf8("graph [ node [ id 1 id 2 ] ]"), gml)).toThrow(/exactly one scalar id/);
    expect(() => parseNative(utf8("graph [ edge [ source 1 ] ]"), gml)).toThrow(/exactly one scalar target/);
    expect(parseError(() => parseNative(utf8("graph [\n node [ id 1 ]\n"), gml)).line).toBe(2);
    expect(() => parseNative(utf8("graph [ ] graph [ ]"), gml)).toThrow(/exactly one graph/);
    expect(() => parseNative(utf8('graph [ node [ id "1 ] ]'), gml)).toThrow(/never closed/);
  });
});

describe("the Pajek parser", () => {
  const pajek: Extract<Parser, { format: "pajek" }> = { format: "pajek", encoding: "utf-8" };

  it("reads vertices 1 to n, arcs, edges and adjacency lists, skipping labels and weights", () => {
    const text = `*Network demo
*Vertices 4
1 "one" 0.1 0.2
2 "two"
*Arcs
1 2 3.5
*Edges :2 "friends"
2 3
*Arcslist
3 1 2
`;
    expect(parseNative(utf8(text), pajek)).toEqual({
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }],
      edges: [
        { source: "1", target: "2" },
        { source: "2", target: "3" },
        { source: "3", target: "1" },
        { source: "3", target: "2" },
      ],
    });
  });

  it("reads keywords case-insensitively and abbreviated, as Pajek does", () => {
    const text = "*net cities\n*VERT 3\n*edge\n1 2\n*arcsl\n2 3\n";
    expect(parseNative(utf8(text), pajek).edges).toEqual([
      { source: "1", target: "2" },
      { source: "2", target: "3" },
    ]);
  });

  it("reads a two-mode matrix with rows as the first mode and columns as the second", () => {
    const text = "*Vertices 4 2\n*Matrix\n1 0\n0 2\n";
    expect(parseNative(utf8(text), pajek).edges).toEqual([
      { source: "1", target: "3" },
      { source: "2", target: "4" },
    ]);
  });

  it("skips partitions and vectors, including their own *Vertices lines", () => {
    const text = "*Vertices 2\n*Edges\n1 2\n*Partition groups\n*Vertices 2\n1\n2\n";
    expect(parseNative(utf8(text), pajek).edges).toEqual([{ source: "1", target: "2" }]);
  });

  it("rejects an out-of-range vertex, data before *Vertices, a second network and a malformed matrix row", () => {
    const arcLine = 3;
    expect(parseError(() => parseNative(utf8("*Vertices 2\n*Arcs\n1 3\n"), pajek)).line).toBe(arcLine);
    expect(() => parseNative(utf8("*Arcs\n1 2\n"), pajek)).toThrow(/before \*Vertices/);
    expect(() => parseNative(utf8("*Network a\n*Vertices 1\n*Network b\n"), pajek)).toThrow(/more than one network/);
    expect(() => parseNative(utf8("*Vertices 2\n*Matrix\n1 0 1\n"), pajek)).toThrow(/matrix rows/);
    expect(() => parseNative(utf8("*Vertices 2\n*Unknown\n"), pajek)).toThrow(/unknown section/);
  });
});

describe("decoding", () => {
  it("rejects bytes that are not valid utf-8 when the recipe says utf-8", () => {
    expect(() => parseNative(bytesOf("1 \u00e9\n"), edgeList())).toThrow(/not valid utf-8/);
  });

  it("reads latin1 bytes as ISO-8859-1, including the range windows-1252 reassigns", () => {
    expect(parseNative(bytesOf("a \u00e9\u0080\n"), edgeList({ encoding: "latin1" })).edges).toEqual([{ source: "a", target: "\u00e9\u0080" }]);
  });
});

describe("the solomon parser", () => {
  const solomon: Parser = { format: "solomon", encoding: "utf-8" };
  const original = "X101\r\n\r\nVEHICLE\r\nNUMBER     CAPACITY\r\n  3         100\r\n\r\nCUSTOMER\r\nCUST NO.  XCOORD.   YCOORD.    DEMAND   READY TIME  DUE DATE   SERVICE   TIME\r\n \r\n    0      10         20          0          0        500          0   \r\n    1      12         25          5         40         90         10   \r\n    2       8         31          7        120        180         10   \r\n \r\n";
  const tabbed = "demo-tw1\n\nVEHICLE\nNUMBER     CAPACITY\n2\t50\n\nCUSTOMER\nCUST NO.\tXCOORD.\tYCOORD.\tDEMAND\tREADY TIME\tDUE DATE\tSERVICE   TIME\n\n0\t28.0718\t-16.6220\t0\t0\t28800\t0\n661\t28.0519\t-16.7154\t20\t11400\t17400\t1200\n1235\t28.4450\t-16.3003\t20\t0\t9600\t600\n";

  it("reads the name, vehicles, capacity and customer rows of a CRLF file with padded spaces, skipping whitespace only lines", () => {
    expect(parseNative(utf8(original), solomon)).toEqual({
      meta: { name: "X101", vehicles: 3, capacity: 100 },
      nodes: [
        { id: "0", x: 10, y: 20, demand: 0, ready: 0, due: 500, service: 0 },
        { id: "1", x: 12, y: 25, demand: 5, ready: 40, due: 90, service: 10 },
        { id: "2", x: 8, y: 31, demand: 7, ready: 120, due: 180, service: 10 },
      ],
    });
  });

  it("reads a tab separated file with decimal positions and ids that are not consecutive", () => {
    expect(parseNative(utf8(tabbed), solomon)).toEqual({
      meta: { name: "demo-tw1", vehicles: 2, capacity: 50 },
      nodes: [
        { id: "0", x: 28.0718, y: -16.622, demand: 0, ready: 0, due: 28800, service: 0 },
        { id: "661", x: 28.0519, y: -16.7154, demand: 20, ready: 11400, due: 17400, service: 1200 },
        { id: "1235", x: 28.445, y: -16.3003, demand: 20, ready: 0, due: 9600, service: 600 },
      ],
    });
  });

  it("names the line of a row that is not seven numbers", () => {
    expect(parseError(() => parseNative(utf8(original.replace("   1      12         25          5         40         90         10   ", "1 12 25 5 40 90")), solomon)).message).toMatch(/solomon line 11: expected seven numbers/);
    expect(parseError(() => parseNative(utf8(original.replace("40         90         10", "40         90         ten")), solomon)).message).toMatch(/solomon line 11: expected the service time/);
  });

  it("rejects a repeated node id, a fractional id and a file without a customer", () => {
    expect(parseError(() => parseNative(utf8(`${original}2 1 1 1 1 1 1\n`), solomon)).message).toMatch(/node 2 appears twice/);
    expect(parseError(() => parseNative(utf8(original.replace("    1      12", "  1.5      12")), solomon)).message).toMatch(/whole number node id/);
    expect(parseError(() => parseNative(utf8("X\n\nVEHICLE\nH\n1 2\n\nCUSTOMER\nH\n"), solomon)).message).toMatch(/no rows/);
  });

  it("rejects a file missing its sections or its name, and text outside the sections", () => {
    expect(parseError(() => parseNative(utf8(""), solomon)).message).toMatch(/line 1: expected the instance name/);
    expect(parseError(() => parseNative(utf8("X\n\nCUSTOMER\nH\n0 1 1 0 0 1 0\n"), solomon)).message).toMatch(/expected a VEHICLE section/);
    expect(parseError(() => parseNative(utf8("X\n\nVEHICLE\nH\n1 2\n"), solomon)).message).toMatch(/expected a CUSTOMER section/);
    expect(parseError(() => parseNative(utf8("X\nstray\nVEHICLE\n"), solomon)).message).toMatch(/line 2: expected VEHICLE or CUSTOMER/);
    expect(parseError(() => parseNative(utf8("X\n\nVEHICLE\nH\n1 2 3\n"), solomon)).message).toMatch(/line 5: expected the vehicle count and capacity/);
  });
});

describe("the toptw parser", () => {
  const toptw: Parser = { format: "toptw", encoding: "utf-8" };
  const text = "4 10 3 1 \n0 200\n  0 40.00 50.00 0.00 0.00 0 0 0 1236\n  1 45.00 68.00 90.00 10.00 1 1 1 912 967\n  2 -30.664 5.463 7 8 1 4 1 2 4 8 98 438\r\n  3 42.00 66.00 90.00 10.00 1 1 1 65 146\n \n";

  it("reads the paths, customers and capacity, and each row's window around a list of any length, skipping whitespace only lines", () => {
    expect(parseNative(utf8(text), toptw)).toEqual({
      meta: { paths: 10, customers: 3, capacity: 200 },
      nodes: [
        { id: "0", x: 40, y: 50, service: 0, profit: 0, open: 0, close: 1236 },
        { id: "1", x: 45, y: 68, service: 90, profit: 10, open: 912, close: 967 },
        { id: "2", x: -30.664, y: 5.463, service: 7, profit: 8, open: 98, close: 438 },
        { id: "3", x: 42, y: 66, service: 90, profit: 10, open: 65, close: 146 },
      ],
    });
  });

  it("rejects a row whose length does not fit its list, and a count that is not the customers plus the depot", () => {
    expect(parseError(() => parseNative(utf8(text.replace("1 4 1 2 4 8 98 438", "1 4 1 2 4 98 438")), toptw)).message).toMatch(/toptw line 5: expected 13 numbers for a list of 4, found 12/);
    expect(parseError(() => parseNative(utf8(text.replace("4 10 3 1", "4 10 4 1")), toptw)).message).toMatch(/header gives 4 customers, so expected 5 rows with the depot, found 4/);
  });

  it("rejects a malformed header, a number that is not one and a repeated or fractional id", () => {
    expect(parseError(() => parseNative(utf8(text.replace("4 10 3 1 \n", "4 10 3\n")), toptw)).message).toMatch(/line 1: expected four numbers/);
    expect(parseError(() => parseNative(utf8(text.replace("90.00 10.00 1 1 1 912 967", "ninety 10.00 1 1 1 912 967")), toptw)).message).toMatch(/line 4: expected the service duration/);
    expect(parseError(() => parseNative(utf8(text.replace("  3 42.00", "  2 42.00")), toptw)).message).toMatch(/node 2 appears twice/);
    expect(parseError(() => parseNative(utf8(text.replace("  3 42.00", "  3.5 42.00")), toptw)).message).toMatch(/whole number node id/);
    expect(parseError(() => parseNative(utf8(""), toptw)).message).toMatch(/expected the two header lines/);
  });
});

describe("the top parser", () => {
  const top: Parser = { format: "top", encoding: "utf-8" };
  const text = "n 4\r\nm 2\r\ntmax 25.0\r\n18.190\t6.320\t0\r\n15.520\t28.030\t7\r\n9.000\t28.010\t5\r\n2.380\t18.260\t0\r\n";

  it("reads the points with row numbers as ids, the first as the start and the last as the end", () => {
    expect(parseNative(utf8(text), top)).toEqual({
      meta: { points: 4, paths: 2, budget: 25 },
      nodes: [
        { id: "0", x: 18.19, y: 6.32, score: 0, role: "start" },
        { id: "1", x: 15.52, y: 28.03, score: 7, role: "visit" },
        { id: "2", x: 9, y: 28.01, score: 5, role: "visit" },
        { id: "3", x: 2.38, y: 18.26, score: 0, role: "end" },
      ],
    });
  });

  it("rejects header lines out of order or malformed, a row that is not three numbers and a wrong row count", () => {
    expect(parseError(() => parseNative(utf8(text.replace("n 4", "points 4")), top)).message).toMatch(/line 1: expected "n <number>"/);
    expect(parseError(() => parseNative(utf8(text.replace("tmax 25.0", "tmax")), top)).message).toMatch(/line 3: expected "tmax <number>"/);
    expect(parseError(() => parseNative(utf8(text.replace("15.520\t28.030\t7", "15.520\t28.030")), top)).message).toMatch(/line 5: expected three numbers/);
    expect(parseError(() => parseNative(utf8(text.replace("n 4", "n 5")), top)).message).toMatch(/header gives 5 points, found 4 rows/);
    expect(parseError(() => parseNative(utf8("n 1\nm 1\ntmax 1\n0 0 0\n"), top)).message).toMatch(/at least a start and an end point/);
    expect(parseError(() => parseNative(utf8(""), top)).message).toMatch(/expected "n <number>"/);
  });
});

describe("the dtop parser", () => {
  const dtop: Parser = { format: "dtop", encoding: "utf-8" };
  const text = "n 4\nm 2\ntmax 25.0\n10.5\t14.4\t0\t0.0\n18.0\t15.9\t10\t16.9\n18.3\t13.3\t10\t6.7\n11.2\t14.1\t0\t0.0\n";

  it("reads the points of a team orienteering file with the time each becomes known", () => {
    expect(parseNative(utf8(text), dtop)).toEqual({
      meta: { points: 4, paths: 2, budget: 25 },
      nodes: [
        { id: "0", x: 10.5, y: 14.4, score: 0, arrival: 0, role: "start" },
        { id: "1", x: 18, y: 15.9, score: 10, arrival: 16.9, role: "visit" },
        { id: "2", x: 18.3, y: 13.3, score: 10, arrival: 6.7, role: "visit" },
        { id: "3", x: 11.2, y: 14.1, score: 0, arrival: 0, role: "end" },
      ],
    });
  });

  it("rejects a row without the arrival time or with a fifth number, and names itself in the error", () => {
    expect(parseError(() => parseNative(utf8(text.replace("18.0\t15.9\t10\t16.9", "18.0\t15.9\t10")), dtop)).message).toMatch(/dtop line 5: expected four numbers/);
    expect(parseError(() => parseNative(utf8(text.replace("18.0\t15.9\t10\t16.9", "18.0\t15.9\t10\t16.9\t1")), dtop)).message).toMatch(/dtop line 5: expected four numbers/);
    expect(parseError(() => parseNative(utf8(text.replace("n 4", "n 5")), dtop)).message).toMatch(/header gives 5 points, found 4 rows/);
  });

  it("is refused by the top parser, whose rows are three numbers", () => {
    expect(parseError(() => parseNative(utf8(text), { format: "top", encoding: "utf-8" })).message).toMatch(/top line 4: expected three numbers/);
  });
});

describe("the tsplib parser", () => {
  const tsplib: Parser = { format: "tsplib", encoding: "utf-8" };
  const pop = (weights: string, body: string, probabilities = "1 0 1.0\n2 45 0.31\n3 45 0.62\n"): string =>
    `NAME : demo\nCOMMENT : three towns    POP::[bound(TSP):400]\nTYPE : POP\nDIMENSION : 3\nTMAX : 100\nTPRIZE : 90\nORIGIN : 1\nDESTINATION : 1\n${weights}\n${body}NODE_PRIZE_PROBABILITY_SECTION\n${probabilities}`;
  const planar = pop("EDGE_WEIGHT_TYPE : CEIL_2D", "NODE_COORD_SECTION\n1 10 20\n2 30 25.5\n3 12 40\n");
  const geo = pop("EDGE_WEIGHT_TYPE : GEO\nDISPLAY_DATA_TYPE : COORD_DISPLAY", "NODE_COORD_SECTION\n1 48.23 10.53\n2 41.23 9.1\n3 -33.5 -5.21\n");
  const explicit = pop("EDGE_WEIGHT_TYPE : EXPLICIT\nEDGE_WEIGHT_FORMAT : LOWER_DIAG_ROW\nDISPLAY_DATA_TYPE : TWOD_DISPLAY", "EDGE_WEIGHT_SECTION\n0 \n7 0 \n9 11 0 \n");
  const cop = "NAME : demo4\nCOMMENT : COP::[overlap:10]\nTYPE : COP\nDIMENSION : 4\nTMAX : 40\nSETS : 2\nEDGE_WEIGHT_TYPE : EUC_2D\nNODE_COORD_SECTION\n1 0 0\n2 5 5\n3 9 1\n4 3.25 7.5\nCONSTRAINING_SET_SECTION : set_id set_prize id-vertex-list\n1 2 2 3\n2 87 3 4\nEOF\n";
  const unset = { x: null, y: null, lat: null, lon: null, prize: null, probability: null, clusters: null };

  it("reads a planar probabilistic file: positions as x and y, prizes and probabilities, the depot first", () => {
    expect(parseNative(utf8(planar), tsplib)).toEqual({
      meta: { name: "demo", type: "POP", budget: 100, edgeWeightType: "CEIL_2D", totalPrize: 90, setPrizes: null },
      nodes: [
        { ...unset, id: "1", x: 10, y: 20, prize: 0, probability: 1 },
        { ...unset, id: "2", x: 30, y: 25.5, prize: 45, probability: 0.31 },
        { ...unset, id: "3", x: 12, y: 40, prize: 45, probability: 0.62 },
      ],
    });
  });

  it("converts GEO coordinates from DDD.MM to decimal degrees, truncating degrees and reading a one digit fraction as tens of minutes", () => {
    /** Whole degrees and minutes of the file's coordinates, so the expected degrees are computed the way the format defines them. */
    const MINUTES = 60;
    const augsburg = { lat: { degrees: 48, minutes: 23 }, lon: { degrees: 10, minutes: 53 } } as const;
    const southWest = { lat: { degrees: 33, minutes: 50 }, lon: { degrees: 5, minutes: 21 } } as const;
    const tenMinutes = { lat: { degrees: 41, minutes: 23 }, lon: { degrees: 9, minutes: 10 } } as const;
    const decimal = (angle: { readonly degrees: number; readonly minutes: number }): number => angle.degrees + angle.minutes / MINUTES;
    const { nodes } = parseNative(utf8(geo), tsplib);
    const [first, second, third] = nodes;
    expect(first).toMatchObject({ lat: decimal(augsburg.lat), lon: decimal(augsburg.lon), x: null, y: null });
    expect(second).toMatchObject({ lat: decimal(tenMinutes.lat), lon: decimal(tenMinutes.lon) });
    expect(third).toMatchObject({ lat: -decimal(southWest.lat), lon: -decimal(southWest.lon) });
  });

  it("gives an EXPLICIT file's nodes only their prize data, skipping the weight matrix", () => {
    expect(parseNative(utf8(explicit), tsplib).nodes).toEqual([
      { ...unset, id: "1", prize: 0, probability: 1 },
      { ...unset, id: "2", prize: 45, probability: 0.31 },
      { ...unset, id: "3", prize: 45, probability: 0.62 },
    ]);
  });

  it("reads a clustered file with the sets as per node memberships and the set prizes as meta, inventing no node prize", () => {
    expect(parseNative(utf8(cop), tsplib)).toEqual({
      meta: { name: "demo4", type: "COP", budget: 40, edgeWeightType: "EUC_2D", totalPrize: null, setPrizes: "1:2,2:87" },
      nodes: [
        { ...unset, id: "1", x: 0, y: 0 },
        { ...unset, id: "2", x: 5, y: 5, clusters: "1" },
        { ...unset, id: "3", x: 9, y: 1, clusters: "1,2" },
        { ...unset, id: "4", x: 3.25, y: 7.5, clusters: "2" },
      ],
    });
  });

  it("rejects a GEO coordinate whose minutes are not whole or reach sixty", () => {
    expect(parseError(() => parseNative(utf8(geo.replace("48.23 10.53", "48.235 10.53")), tsplib)).message).toMatch(/tsplib line 12: expected a DDD.MM coordinate/);
    expect(parseError(() => parseNative(utf8(geo.replace("48.23 10.53", "48.60 10.53")), tsplib)).message).toMatch(/whole minutes below 60, found 48.6/);
  });

  it("rejects an unsupported type or weight type, and a missing or repeated key", () => {
    expect(parseError(() => parseNative(utf8(planar.replace("TYPE : POP", "TYPE : TSP")), tsplib)).message).toMatch(/expected TYPE POP or COP/);
    expect(parseError(() => parseNative(utf8(planar.replace("CEIL_2D", "MAX_2D")), tsplib)).message).toMatch(/expected EDGE_WEIGHT_TYPE/);
    expect(parseError(() => parseNative(utf8(planar.replace("TMAX : 100\n", "")), tsplib)).message).toMatch(/expected a TMAX line/);
    expect(parseError(() => parseNative(utf8(planar.replace("TMAX : 100", "TMAX : 100\nTMAX : 100")), tsplib)).message).toMatch(/TMAX appears twice/);
  });

  it("rejects a section that does not cover every node, a node outside the dimension and a stray row", () => {
    expect(parseError(() => parseNative(utf8(pop("EDGE_WEIGHT_TYPE : CEIL_2D", "NODE_COORD_SECTION\n1 10 20\n2 30 25\n3 12 40\n", "1 0 1.0\n2 45 0.31\n")), tsplib)).message).toMatch(/expected 3 prize rows, found 2/);
    expect(parseError(() => parseNative(utf8(planar.replace("3 12 40", "4 12 40")), tsplib)).message).toMatch(/node 4 is outside 1 to 3/);
    expect(parseError(() => parseNative(utf8(planar.replace("1 10 20\n", "1 10 20\n1 11 21\n")), tsplib)).message).toMatch(/node 1 has two coordinate rows/);
    expect(parseError(() => parseNative(utf8(`stray\n${planar}`), tsplib)).message).toMatch(/line 1: expected a KEY : value line or a section/);
    expect(parseError(() => parseNative(utf8(explicit.replace("EDGE_WEIGHT_SECTION", "NODE_COORD_SECTION\n1 1 1\nEDGE_WEIGHT_SECTION")), tsplib)).message).toMatch(/an EXPLICIT file has no NODE_COORD_SECTION/);
  });

  it("rejects a clustered file whose set count or members disagree with its header", () => {
    expect(parseError(() => parseNative(utf8(cop.replace("SETS : 2", "SETS : 3")), tsplib)).message).toMatch(/expected 3 sets, found 2/);
    expect(parseError(() => parseNative(utf8(cop.replace("2 87 3 4", "2 87 3 9")), tsplib)).message).toMatch(/node 9 is outside 1 to 4/);
    expect(parseError(() => parseNative(utf8(cop.replace("2 87 3 4", "1 87 3 4")), tsplib)).message).toMatch(/set 1 appears twice/);
  });
});

describe("the vrp-rep parser", () => {
  const vrpRep: Parser = { format: "vrp-rep", encoding: "utf-8" };
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<instance>
  <info><dataset>Example set</dataset><name>X101.100_25-5-5-5</name></info>
  <network>
    <nodes>
      <node id="0" type="0"><cx>50.0</cx><cy>50.0</cy></node>
      <node id="1" type="1"><cx>12.0</cx><cy>80.5</cy></node>
      <node id="26" type="2"><cx>33.0</cx><cy>41.0</cy></node>
      <node id="27" type="2"><cx>-3.25</cx><cy>41.0</cy></node>
    </nodes>
    <euclidean/><decimals>14</decimals>
  </network>
  <fleet>
    <vehicle_profile type="0" number="1"><departure_node>1</departure_node><arrival_node>1</arrival_node><fix_cost>0.0</fix_cost><cost_x_distance>1.0</cost_x_distance><resource id="1"><max>1.0</max></resource></vehicle_profile>
  </fleet>
  <requests>
    <request id="0" node="26"><skill>2</skill><resource id="6">1.0</resource><resource id="7">1.0</resource></request>
    <request id="1" node="27"><skill>3</skill></request>
  </requests>
  <resources><resource id="1" renewable="true" name="tool-1">INF</resource></resources>
  <drivers><driver_profile type="0"><compatible_vehicle_type>0</compatible_vehicle_type><skill id="2"/><skill id="4"/></driver_profile></drivers>
</instance>
`;

  it("reads the nodes with their type, position, the skills and resources their requests need, and the skills of the drivers based there", () => {
    expect(parseNative(utf8(xml), vrpRep)).toEqual({
      meta: { dataset: "Example set", name: "X101.100_25-5-5-5" },
      nodes: [
        { id: "0", x: 50, y: 50, type: "0", skill: null, skills: null, resources: null },
        { id: "1", x: 12, y: 80.5, type: "1", skill: null, skills: "2,4", resources: null },
        { id: "26", x: 33, y: 41, type: "2", skill: "2", skills: null, resources: "6,7" },
        { id: "27", x: -3.25, y: 41, type: "2", skill: "3", skills: null, resources: null },
      ],
    });
  });

  it("rejects a root that is not an instance, a missing element, a coordinate that is not a number and a repeated node", () => {
    expect(parseError(() => parseNative(utf8(xml.replace(/<\/?instance>/g, (tag) => tag.replace("instance", "problem"))), vrpRep)).message).toMatch(/expected the root element <instance>, found <problem>/);
    expect(parseError(() => parseNative(utf8(xml.replace("<network>", "<net>").replace("</network>", "</net>")), vrpRep)).message).toMatch(/expected one <network> in <instance>, found 0/);
    expect(parseError(() => parseNative(utf8(xml.replace("<cx>12.0</cx>", "<cx>twelve</cx>")), vrpRep)).message).toMatch(/expected <cx> to hold a number, found "twelve"/);
    expect(parseError(() => parseNative(utf8(xml.replace('<node id="27"', '<node id="26"')), vrpRep)).message).toMatch(/node 26 appears twice/);
    expect(parseError(() => parseNative(utf8(xml.replace('<node id="1" type="1">', '<node id="1">')), vrpRep)).message).toMatch(/expected <node> to have the attribute type/);
  });

  it("rejects a request or a vehicle at a node the network lacks", () => {
    expect(parseError(() => parseNative(utf8(xml.replace('node="27"', 'node="99"')), vrpRep)).message).toMatch(/request 1 is at node 99, which the network lacks/);
    expect(parseError(() => parseNative(utf8(xml.replace("<departure_node>1<", "<departure_node>99<")), vrpRep)).message).toMatch(/vehicle type 0 departs from node 99/);
  });
});

describe("the verolog-2019 parser", () => {
  const verolog: Parser = { format: "verolog-2019", encoding: "utf-8" };
  const header: readonly (readonly string[])[] = [
    ["DATASET", "=", "ORTEC", "Early", "VeRoLog", "2019"],
    ["NAME", "=", "Instance", "2"],
    ["DAYS", "=", "6"],
    ["TRUCK_CAPACITY", "=", "15"],
    ["TRUCK_MAX_DISTANCE", "=", "1000"],
    ["TRUCK_DISTANCE_COST", "=", "1"],
    ["TRUCK_DAY_COST", "=", "100"],
    ["TRUCK_COST", "=", "5000"],
    ["TECHNICIAN_DISTANCE_COST", "=", "2"],
    ["TECHNICIAN_DAY_COST", "=", "50"],
    ["TECHNICIAN_COST", "=", "900"],
  ];
  const body: readonly (readonly string[])[] = [
    ["MACHINES", "=", "2"],
    ["1", "6", "300"],
    ["2", "4", "120"],
    ["LOCATIONS", "=", "3"],
    ["1", "100", "200"],
    ["2", "310", "40"],
    ["3", "505", "260"],
    ["REQUESTS", "=", "3"],
    ["1", "2", "1", "3", "1", "2"],
    ["2", "3", "5", "6", "2", "1"],
    ["3", "2", "2", "2", "1", "3"],
    ["TECHNICIANS", "=", "2"],
    ["1", "1", "400", "6", "1", "0"],
    ["2", "3", "250", "5", "0", "1"],
  ];
  /** How wide the space padded layout right-aligns each field. */
  const COLUMN_WIDTH = 5;
  /** The three layouts the files come in: padded spaces with blank lines between sections, tabs with trailing tabs, and semicolons with trailing semicolons. */
  const layouts = {
    spaces: [...header, [], ...body.flatMap((row) => (row[1] === "=" ? [[], row] : [row.map((field) => field.padStart(COLUMN_WIDTH)) ]))].map((row) => (row[1] === "=" ? row.join(" ") : row.join(" "))).join("\r\n"),
    tabs: [...header, ...body].map((row) => `${row.join("\t")}\t\t\t\t`).join("\r\n"),
    semicolons: [...header, ...body].map((row) => `${row.join(";")};;;;`).join("\r\n"),
  } as const;
  const expected = {
    meta: { dataset: "ORTEC Early VeRoLog 2019", name: "Instance 2", days: 6, truckCapacity: 15, truckMaxDistance: 1000, truckDistanceCost: 1, truckDayCost: 100, truckCost: 5000, technicianDistanceCost: 2, technicianDayCost: 50, technicianCost: 900, technicians: 2 },
    nodes: [
      { id: "depot", x: 100, y: 200, kind: "depot", location: 1, fromDay: null, toDay: null, machine: null, amount: null },
      { id: "1", x: 310, y: 40, kind: "request", location: 2, fromDay: 1, toDay: 3, machine: "1", amount: 2 },
      { id: "2", x: 505, y: 260, kind: "request", location: 3, fromDay: 5, toDay: 6, machine: "2", amount: 1 },
      { id: "3", x: 310, y: 40, kind: "request", location: 2, fromDay: 2, toDay: 2, machine: "1", amount: 3 },
    ],
  };

  for (const [name, text] of Object.entries(layouts)) {
    it(`reads the ${name} layout: the depot, then a node per request at its location's position`, () => {
      expect(parseNative(utf8(text), verolog)).toEqual(expected);
    });
  }

  it("rejects a header line that is missing or out of order, and a section that is short or announced out of order", () => {
    const text = layouts.tabs;
    expect(parseError(() => parseNative(utf8(text.replace("DAYS\t=\t6", "DAY\t=\t6")), verolog)).message).toMatch(/expected "DAYS = <value>", found "DAY = 6"/);
    expect(parseError(() => parseNative(utf8(text.replace("DAYS\t=\t6", "DAYS\t=\tsix")), verolog)).message).toMatch(/expected a number for DAYS, found "six"/);
    expect(parseError(() => parseNative(utf8(text.replace("REQUESTS\t=\t3", "REQUESTS\t=\t4")), verolog)).message).toMatch(/REQUESTS announces 4 rows|expected "TECHNICIANS = <count>"/);
    expect(parseError(() => parseNative(utf8(text.replace("LOCATIONS\t=\t3", "SITES\t=\t3")), verolog)).message).toMatch(/expected "LOCATIONS = <count>", found "SITES = 3"/);
    expect(parseError(() => parseNative(utf8(`${text}\r\n9\t9`), verolog)).message).toMatch(/expected the end of the file after TECHNICIANS/);
  });

  it("rejects a row with the wrong id or length, and a request outside the file's locations, machines or days", () => {
    const text = layouts.tabs;
    expect(parseError(() => parseNative(utf8(text.replace("2\t310\t40", "5\t310\t40")), verolog)).message).toMatch(/expected LOCATIONS row 2 to start with that id, found "5"/);
    expect(parseError(() => parseNative(utf8(text.replace("2\t310\t40", "2\t310")), verolog)).message).toMatch(/expected 3 fields in a LOCATIONS row, found 2/);
    expect(parseError(() => parseNative(utf8(text.replace("1\t2\t1\t3\t1\t2", "1\t9\t1\t3\t1\t2")), verolog)).message).toMatch(/location 9 is outside 1 to 3/);
    expect(parseError(() => parseNative(utf8(text.replace("1\t2\t1\t3\t1\t2", "1\t2\t1\t3\t7\t2")), verolog)).message).toMatch(/machine 7 is outside 1 to 2/);
    expect(parseError(() => parseNative(utf8(text.replace("1\t2\t1\t3\t1\t2", "1\t2\t4\t3\t1\t2")), verolog)).message).toMatch(/the days 4 to 3 are not within 1 to 6/);
    expect(parseError(() => parseNative(utf8(text.replace("1\t2\t1\t3\t1\t2", "1\t2\t1\t7\t1\t2")), verolog)).message).toMatch(/the days 1 to 7 are not within 1 to 6/);
    expect(parseError(() => parseNative(utf8(text.replace("1\t2\t1\t3\t1\t2", "1\t2\t1\t3\t1\t0")), verolog)).message).toMatch(/expected an amount of at least 1, found 0/);
    expect(parseError(() => parseNative(utf8(text.replace("1\t1\t400\t6\t1\t0", "1\t1\t400\t6\t1")), verolog)).message).toMatch(/expected 6 fields in a TECHNICIANS row, found 5/);
  });
});

describe("the customer-points parser", () => {
  const points: Parser = { format: "customer-points", encoding: "utf-8" };
  const text = "customers 3\r\n\r\n0\t15.1234\t33.987\r\n1\t41.5\t18.0\r\n2\t41.5\t18.0\r\n";

  it("reads the announced customers with their planar positions, skipping blank lines", () => {
    expect(parseNative(utf8(text), points)).toEqual({
      meta: { customers: 3 },
      nodes: [
        { id: "0", x: 15.1234, y: 33.987 },
        { id: "1", x: 41.5, y: 18 },
        { id: "2", x: 41.5, y: 18 },
      ],
    });
  });

  it("rejects a first line that is not the count, a malformed row, a repeated id and a count that does not match", () => {
    expect(parseError(() => parseNative(utf8(text.replace("customers 3", "nodes 3")), points)).message).toMatch(/line 1: expected "customers <count>", found "nodes 3"/);
    expect(parseError(() => parseNative(utf8(""), points)).message).toMatch(/expected "customers <count>"/);
    expect(parseError(() => parseNative(utf8(text.replace("41.5\t18.0\r\n2", "41.5\r\n2")), points)).message).toMatch(/line 4: expected a customer id and two numbers/);
    expect(parseError(() => parseNative(utf8(text.replace("2\t41.5", "1\t41.5")), points)).message).toMatch(/customer 1 appears twice/);
    expect(parseError(() => parseNative(utf8(text.replace("customers 3", "customers 4")), points)).message).toMatch(/announces 4 customers, found 3/);
  });
});
