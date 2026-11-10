import { describe, expect, it } from "vitest";
import { parseNative } from "./parse-native";

const lrp = { format: "lrp", encoding: "utf-8" } as const;

const crlf = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\r\n")}\r\n`);

/** A small instance laid out as the Prins-Prodhon files are (CRLF line ends, tab-separated coordinates, blank lines between the sections): customers, depots, depot coordinates, customer coordinates, vehicle capacity, depot capacities, customer demands, depot opening costs, route opening cost, cost flag. */
const PRODHON = ["3", "2", "", "6\t7", "19\t44", "", "20\t35", "8\t31", "29\t43", "", "70", "", "140", "150", "", "17", "18", "13", "", "10841", "11961", "", "1000", "", "0", ""];

describe("the location-routing parser", () => {
  it("reads the depots then the customers as nodes, with the vehicle, route and cost data in meta", () => {
    expect(parseNative(crlf(...PRODHON), lrp)).toEqual({
      meta: { customers: 3, depots: 2, vehicleCapacity: 70, routeCost: 1000, realCosts: false },
      nodes: [
        { id: "depot-1", role: "depot", x: 6, y: 7, demand: null, capacity: 140, openingCost: 10841 },
        { id: "depot-2", role: "depot", x: 19, y: 44, demand: null, capacity: 150, openingCost: 11961 },
        { id: "customer-1", role: "customer", x: 20, y: 35, demand: 17, capacity: null, openingCost: null },
        { id: "customer-2", role: "customer", x: 8, y: 31, demand: 18, capacity: null, openingCost: null },
        { id: "customer-3", role: "customer", x: 29, y: 43, demand: 13, capacity: null, openingCost: null },
      ],
    });
  });

  it("reads decimal coordinates with trailing tabs, sections without blank lines and the real cost flag (the Tuzun-Burke layout)", () => {
    const tuzun = ["3", "2", "46.000000\t99.599998\t", "99.199997\t14.400000\t", "20.6\t7.7\t", "23.299999\t22.200001\t", "80.6\t51.7\t", "70", "140", "150", "17", "18", "13", "10841.5", "11961", "1000", "1"];
    const parsed = parseNative(crlf(...tuzun), lrp);
    expect(parsed.meta).toEqual({ customers: 3, depots: 2, vehicleCapacity: 70, routeCost: 1000, realCosts: true });
    expect(parsed.nodes[0]).toEqual({ id: "depot-1", role: "depot", x: 46, y: 99.599998, demand: null, capacity: 140, openingCost: 10841.5 });
  });

  it("reads a coordinate line whose further fields are all zero, as Barreto's Or117 depot lines are, and refuses one whose further fields are not", () => {
    const or117 = PRODHON.map((line) => (line === "6\t7" ? "  1180       962     0        0.000" : line === "19\t44" ? "   1182       970    .0        0.000" : line));
    expect(parseNative(crlf(...or117), lrp).nodes.slice(0, 2).map((node) => ({ x: node["x"], y: node["y"] }))).toEqual([
      { x: 1180, y: 962 },
      { x: 1182, y: 970 },
    ]);
    expect(() => parseNative(crlf(...PRODHON.map((line) => (line === "6\t7" ? "6\t7\t3" : line))), lrp)).toThrow(/line 4: expected x and y/);
  });

  it("refuses a file with lines missing or left over, a flag other than 0 or 1 and a section line of the wrong shape", () => {
    expect(() => parseNative(crlf(...PRODHON.slice(0, PRODHON.lastIndexOf("0"))), lrp)).toThrow(/the file ends before the cost flag/);
    expect(() => parseNative(crlf(...PRODHON, "5"), lrp)).toThrow(/line 27: the file goes on after the cost flag/);
    expect(() => parseNative(crlf(...PRODHON.map((line, index) => (index === PRODHON.lastIndexOf("0") ? "2" : line))), lrp)).toThrow(/expected the cost flag 0 or 1, found "2"/);
    expect(() => parseNative(crlf(...PRODHON.map((line) => (line === "70" ? "70 80" : line))), lrp)).toThrow(/line 11: expected the vehicle capacity/);
    expect(() => parseNative(crlf(""), lrp)).toThrow(/the file ends before the customer count/);
  });
});
