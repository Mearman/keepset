import { describe, expect, it } from "vitest";
import { parseNative } from "./parse-native";

const pmedcap = { format: "orlib-pmedcap", encoding: "utf-8" } as const;

const bytes = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

/** Two problems laid out as pmedcap1.txt lays out its problems: the problem count, then each problem's number and best value, its customer count, median count and median capacity, and one line per customer (number, x, y, demand). */
const TWO = [" 2", " 1 713", " 3 1 120", " 1 2 62 3", " 2 80 25 14", " 3 36 88 1", " 2 740", " 2 1 100", " 1 57 23 14", " 2 33 17 19"];

describe("the OR-Library capacitated p-median parser", () => {
  it("reads every problem's customers as nodes named by problem and customer, each carrying its problem's median count, capacity and best value", () => {
    expect(parseNative(bytes(...TWO), pmedcap)).toEqual({
      meta: { problems: 2 },
      nodes: [
        { id: "1-1", problem: 1, x: 2, y: 62, demand: 3, medians: 1, medianCapacity: 120, bestValue: 713 },
        { id: "1-2", problem: 1, x: 80, y: 25, demand: 14, medians: 1, medianCapacity: 120, bestValue: 713 },
        { id: "1-3", problem: 1, x: 36, y: 88, demand: 1, medians: 1, medianCapacity: 120, bestValue: 713 },
        { id: "2-1", problem: 2, x: 57, y: 23, demand: 14, medians: 1, medianCapacity: 100, bestValue: 740 },
        { id: "2-2", problem: 2, x: 33, y: 17, demand: 19, medians: 1, medianCapacity: 100, bestValue: 740 },
      ],
    });
  });

  it("refuses a file that holds more or fewer problems or customers than it counts, a customer out of order and a repeated problem", () => {
    expect(() => parseNative(bytes(...TWO.slice(0, -1)), pmedcap)).toThrow(/the file ends before customer 2 of problem 2/);
    expect(() => parseNative(bytes(...TWO, " 9 1"), pmedcap)).toThrow(/line 11: the file counts 2 problems/);
    expect(() => parseNative(bytes(...TWO.map((line) => line.replace(" 2 80 25 14", " 3 80 25 14"))), pmedcap)).toThrow(/line 5: expected customer 2, found 3/);
    expect(() => parseNative(bytes(...TWO.map((line) => line.replace(" 2 740", " 1 740"))), pmedcap)).toThrow(/line 7: problem 1 is given twice/);
    expect(() => parseNative(bytes(" 1", " 1 713", " 1 2 120", " 1 2 62 3"), pmedcap)).toThrow(/line 3: 2 medians for 1 customers/);
  });
});
