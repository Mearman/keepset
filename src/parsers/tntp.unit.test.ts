import { describe, expect, it } from "vitest";
import { parseNativeParts } from "./parse-native";

const tntp = { format: "tntp", encoding: "utf-8" } as const;

const bytes = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

/** A small network laid out as the repository's network files are: metadata, blank lines, the harmonised column header and tab-separated links ended by `;`. */
const NETWORK = [
  "<NUMBER OF ZONES> 2\t\t",
  "<NUMBER OF NODES> 3",
  "<FIRST THRU NODE> 3",
  "<NUMBER OF LINKS> 3\t",
  "<ORIGINAL HEADER>~ \tInit node \tTerm node \tCapacity \tFree Flow Time \t;",
  "<END OF METADATA>\t",
  "",
  "",
  "~\tinit_node\tterm_node\tcapacity\tfree_flow_time\t;",
  "\t1\t3\t25900.20064\t6\t;",
  "\t3\t2\t4958.180928\t5\t;",
  "\t3\t2\t1.5e+003\t7\t;",
];

/** A trip table laid out as the repository's are: metadata, comments, and each origin's destination entries over one or more lines. */
const TRIPS = ["<NUMBER OF ZONES> 2", "<TOTAL OD FLOW> 1.5e+002", "<LOCATION> \"Somewhere\"", "<END OF METADATA>", "~ a comment", "", "Origin \t1 ", "    1 :      0.0;     2 :    100.0; ", "", "Origin \t2 ", "    1 :     50.0; "];

const parse = (network: readonly string[], trips: readonly string[]): ReturnType<typeof parseNativeParts> =>
  parseNativeParts(
    [
      { name: "network", bytes: bytes(...network) },
      { name: "trips", bytes: bytes(...trips) },
    ],
    tntp,
  );

describe("the TNTP parser", () => {
  it("reads the zones, nodes and links of the network and each origin and destination pair as a commodity joined to its zones", () => {
    expect(parse(NETWORK, TRIPS)).toEqual({
      meta: { zones: 2, firstThruNode: 3, originalHeader: "~ \tInit node \tTerm node \tCapacity \tFree Flow Time \t;", totalOdFlow: 150, location: "\"Somewhere\"" },
      nodes: [
        { id: "1", type: "zone", demand: null },
        { id: "2", type: "zone", demand: null },
        { id: "3", type: "node", demand: null },
        { id: "commodity-1-1", type: "commodity", demand: 0 },
        { id: "commodity-1-2", type: "commodity", demand: 100 },
        { id: "commodity-2-1", type: "commodity", demand: 50 },
      ],
      edges: [
        { source: "1", target: "3", type: "link", capacity: 25900.20064, freeFlowTime: 6 },
        { source: "3", target: "2", type: "link", capacity: 4958.180928, freeFlowTime: 5 },
        { source: "3", target: "2", type: "link", capacity: 1500, freeFlowTime: 7 },
        { source: "commodity-1-1", target: "1", type: "origin", capacity: null, freeFlowTime: null },
        { source: "commodity-1-1", target: "1", type: "destination", capacity: null, freeFlowTime: null },
        { source: "commodity-1-2", target: "1", type: "origin", capacity: null, freeFlowTime: null },
        { source: "commodity-1-2", target: "2", type: "destination", capacity: null, freeFlowTime: null },
        { source: "commodity-2-1", target: "2", type: "origin", capacity: null, freeFlowTime: null },
        { source: "commodity-2-1", target: "1", type: "destination", capacity: null, freeFlowTime: null },
      ],
    });
  });

  it("reads CRLF line ends alike", () => {
    const crlf = (lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);
    expect(
      parseNativeParts(
        [
          { name: "network", bytes: crlf(NETWORK) },
          { name: "trips", bytes: crlf(TRIPS) },
        ],
        tntp,
      ),
    ).toEqual(parse(NETWORK, TRIPS));
  });

  it("refuses a network whose metadata or links disagree with the format", () => {
    expect(() => parse(NETWORK.filter((line) => !line.startsWith("<FIRST THRU NODE>")), TRIPS)).toThrow(/tntp network line \d+: the metadata has no <FIRST THRU NODE>/);
    expect(() => parse(NETWORK.slice(0, -1), TRIPS)).toThrow(/expected 3 links, found 2/);
    expect(() => parse(NETWORK.map((line) => line.replace("\t3\t2\t4958.180928\t5\t;", "\t3\t2\t4958.180928\t5\t1;")), TRIPS)).toThrow(/tntp network line 11: expected a link line of the header's 4 columns, found 5 values/);
    expect(() => parse(NETWORK.map((line) => line.replace("\t1\t3\t25900.20064\t6\t;", "\t1\t4\t25900.20064\t6\t;")), TRIPS)).toThrow(/line 10: expected a node from 1 to 3, found "4"/);
    expect(() => parse(NETWORK.map((line) => line.replace("\t1\t3\t25900.20064\t6\t;", "\t1\t3\t25900.20064\t6")), TRIPS)).toThrow(/line 10: expected a link line ending with ;/);
    expect(() => parse(NETWORK.filter((line) => !line.startsWith("~")), TRIPS)).toThrow(/line 9: a link line before the column header line/);
    expect(() => parse(NETWORK.map((line) => line.replace("<END OF METADATA>", "END")), TRIPS)).toThrow(/line 6: expected a metadata line/);
  });

  it("refuses a trip table that disagrees with the network or the format", () => {
    expect(() => parse(NETWORK, TRIPS.map((line) => line.replace("<NUMBER OF ZONES> 2", "<NUMBER OF ZONES> 3")))).toThrow(/tntp trips line 1: the trip table has 3 zones and the network 2/);
    expect(() => parse(NETWORK, TRIPS.map((line) => line.replace("    1 :     50.0; ", "    3 :     50.0; ")))).toThrow(/tntp trips line 11: expected a zone from 1 to 2, found "3"/);
    expect(() => parse(NETWORK, [...TRIPS, "    1 :     5.0; "])).toThrow(/line 12: the flow from zone 2 to zone 1 is given twice/);
    expect(() => parse(NETWORK, TRIPS.map((line) => line.replace("2 :    100.0", "2 :   -100.0")))).toThrow(/line 8: expected a flow of at least 0/);
    expect(() => parse(NETWORK, TRIPS.filter((line) => !line.startsWith("Origin \t1")))).toThrow(/line 7: expected an origin line Origin N/);
    expect(() => parse(NETWORK, TRIPS.map((line) => line.replace("2 :    100.0", "2 =    100.0")))).toThrow(/line 8: expected a destination entry D : FLOW/);
  });
});
