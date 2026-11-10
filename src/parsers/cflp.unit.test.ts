import { describe, expect, it } from "vitest";
import { ParserSchema, type Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseNative, parseNativeInstances } from "./parse-native";

type CflpParser = Extract<Parser, { format: "cflp" }>;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const cflp = (options: Omit<CflpParser, "format" | "encoding">): CflpParser => ({ format: "cflp", encoding: "utf-8", ...options });

/** Two facilities and three customers in OR-Library's capacitated warehouse layout: the counts, each facility's capacity and fixed cost, then each customer's demand followed by its cost from every facility, wrapped as the OR-Library files wrap long rows. */
const ORLIB = " 2 3 \n 10 100. \n 20 200. \n 1 \n 5 8 \n 2 \n 6 \n 9 \n 3 \n 7 1.0e1 \n";

/** The same instance in the pairs layout: the counts, each facility's capacity and fixed cost, the demands, then one row of costs per facility. */
const PAIRS = "2 3\n10 100\n20 200\n1 2 3\n5 6 7\n8 9 10\n";

/** The same instance in the demands-first layout: the counts, the demands, the capacities, the fixed costs, then one row of costs per facility. */
const DEMANDS_FIRST = "2\t3\n\n1\t2\t3\t\n10\t20\t\n100\t200\t\n5\t6\t7\t\n8\t9\t10\t\n";

/** The same costs in UflLib's simple layout: a FILE line, the facility and city counts and a 0, then one row per facility of its number, opening cost and connection costs. */
const SIMPLE = "FILE: example.txt\n2 3 0\n1 100 5 6 7\n2 200 8 9 10\n";

/** Values the word capacity stands for in a test file, two as capa's four are, and a value for another file. */
const SMALLER = 8000;
const LARGER = 10000;
const OTHER = 5000;
const CAPACITY_VALUES = [SMALLER, LARGER];
const OTHER_VALUES = [OTHER];

const FACILITIES = [
  { id: "f:1", type: "facility", capacity: 10, fixedCost: 100 },
  { id: "f:2", type: "facility", capacity: 20, fixedCost: 200 },
];
const CUSTOMERS = [
  { id: "c:1", type: "customer", demand: 1 },
  { id: "c:2", type: "customer", demand: 2 },
  { id: "c:3", type: "customer", demand: 3 },
];
const FACILITY_MAJOR = [
  { source: "f:1", target: "c:1", cost: 5 },
  { source: "f:1", target: "c:2", cost: 6 },
  { source: "f:1", target: "c:3", cost: 7 },
  { source: "f:2", target: "c:1", cost: 8 },
  { source: "f:2", target: "c:2", cost: 9 },
  { source: "f:2", target: "c:3", cost: 10 },
];

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

describe("the cflp parser", () => {
  describe("the orlib-cap layout", () => {
    const orlib = cflp({ layout: "orlib-cap" });

    it("reads typed facility and customer nodes and one edge per pair in the file's customer-major order", () => {
      expect(parseNative(utf8(ORLIB), orlib)).toEqual({
        meta: { layout: "orlib-cap", costBasis: "per-assignment", facilities: 2, customers: 3 },
        nodes: [...FACILITIES, ...CUSTOMERS],
        edges: [
          { source: "f:1", target: "c:1", cost: 5 },
          { source: "f:2", target: "c:1", cost: 8 },
          { source: "f:1", target: "c:2", cost: 6 },
          { source: "f:2", target: "c:2", cost: 9 },
          { source: "f:1", target: "c:3", cost: 7 },
          { source: "f:2", target: "c:3", cost: 10 },
        ],
      });
    });

    it("refuses a file that writes the word capacity when the recipe names no values for it", () => {
      const word = ORLIB.replace(" 10 100.", " capacity 100.").replace(" 20 200.", " capacity 200.");
      expect(parseError(() => parseNative(utf8(word), orlib)).message).toMatch(/cflp line 2: the file writes the word capacity in place of a capacity, and the recipe names no values for it/);
      expect(parseError(() => parseNativeInstances("capa.txt", utf8(word), cflp({ layout: "orlib-cap", capacityValues: [{ instance: "capb.txt", values: OTHER_VALUES }] }))).message).toMatch(/names no values for it/);
    });

    it("reads a file that writes the word capacity once for each value the recipe names for it, each an instance under the file's id", () => {
      const word = ORLIB.replace(" 10 100.", " capacity 100.").replace(" 20 200.", " capacity 200.");
      const instances = parseNativeInstances("capa.txt", utf8(word), cflp({ layout: "orlib-cap", capacityValues: [{ instance: "capa.txt", values: CAPACITY_VALUES }] }));
      expect(instances.map((instance) => instance.id)).toEqual(CAPACITY_VALUES.map((value) => `capa.txt/${String(value)}`));
      expect(instances[1]?.native).toMatchObject({
        meta: { layout: "orlib-cap", capacity: CAPACITY_VALUES[1], facilities: 2, customers: 3 },
        nodes: [{ id: "f:1", type: "facility", capacity: CAPACITY_VALUES[1], fixedCost: 100 }, { id: "f:2", type: "facility", capacity: CAPACITY_VALUES[1], fixedCost: 200 }, ...CUSTOMERS],
      });
    });

    it("reads a file that states its capacities as one instance under its own id, whatever values the recipe names for other files", () => {
      const instances = parseNativeInstances("cap41.txt", utf8(ORLIB), cflp({ layout: "orlib-cap", capacityValues: [{ instance: "capa.txt", values: OTHER_VALUES }] }));
      expect(instances.map((instance) => instance.id)).toEqual(["cap41.txt"]);
      expect(instances[0]?.native).toEqual(parseNative(utf8(ORLIB), orlib));
    });

    it("refuses values for a file that states its capacities, and a file that writes the word for only some", () => {
      expect(parseError(() => parseNativeInstances("cap41.txt", utf8(ORLIB), cflp({ layout: "orlib-cap", capacityValues: [{ instance: "cap41.txt", values: OTHER_VALUES }] }))).message).toMatch(/the recipe names capacity values for this file, and it writes no word capacity/);
      expect(parseError(() => parseNative(utf8(ORLIB.replace(" 10 100.", " capacity 100.")), cflp({ layout: "orlib-cap", capacityValues: [{ instance: "x", values: [1] }] }))).message).toMatch(/writes the word capacity for some facilities and a number for others/);
    });

    it("reads an uncapacitated instance without capacities or demands, accepting the word capacity", () => {
      const word = ORLIB.replace(" 10 100.", " capacity 100.");
      expect(parseNative(utf8(word), cflp({ layout: "orlib-cap", uncapacitated: true }))).toMatchObject({
        meta: { layout: "orlib-cap", uncapacitated: true },
        nodes: [{ id: "f:1", type: "facility", fixedCost: 100 }, { id: "f:2", type: "facility", fixedCost: 200 }, { id: "c:1", type: "customer" }, { id: "c:2", type: "customer" }, { id: "c:3", type: "customer" }],
      });
      const { nodes } = parseNative(utf8(word), cflp({ layout: "orlib-cap", uncapacitated: true }));
      expect(nodes.some((node) => "capacity" in node || "demand" in node)).toBe(false);
    });

    it("refuses a file cut short, a file with numbers to spare and a word that is not a number", () => {
      expect(parseError(() => parseNative(utf8(ORLIB.replace(" 7 1.0e1 \n", " 7 \n")), orlib)).message).toMatch(/expected 15 numbers for 2 facilities and 3 customers, found 14/);
      expect(parseError(() => parseNative(utf8(`${ORLIB} 11\n`), orlib)).message).toMatch(/expected 15 numbers for 2 facilities and 3 customers, found 16/);
      expect(parseError(() => parseNative(utf8(ORLIB.replace(" 6 \n", " six \n")), orlib)).message).toMatch(/cflp line 7: "six" is not a number/);
      expect(parseError(() => parseNative(utf8(ORLIB.replace(" 2 3 ", " 2.5 3 ")), orlib)).message).toMatch(/cflp line 1: the facility count "2.5" is not a positive whole number/);
      expect(parseError(() => parseNative(utf8(""), orlib)).message).toMatch(/the file holds no facility and customer counts/);
    });
  });

  describe("the pairs and demands-first layouts", () => {
    const pairs = cflp({ layout: "pairs", costBasis: "per-assignment" });

    it("reads the pairs layout facility-major, as its cost rows are written", () => {
      expect(parseNative(utf8(PAIRS), pairs)).toEqual({ meta: { layout: "pairs", costBasis: "per-assignment", facilities: 2, customers: 3 }, nodes: [...FACILITIES, ...CUSTOMERS], edges: FACILITY_MAJOR });
    });

    it("reads counts on lines of their own, as the Gadegaard files write them", () => {
      expect(parseNative(utf8("2\n3\n10 100\n20 200\n1 2 3\n\n5 6 7\n8 9 10\n"), pairs)).toEqual(parseNative(utf8(PAIRS), pairs));
    });

    it("reads the demands-first layout into the same graph, recording a per-unit cost basis without converting the costs", () => {
      expect(parseNative(utf8(DEMANDS_FIRST), cflp({ layout: "demands-first", costBasis: "per-unit" }))).toEqual({ meta: { layout: "demands-first", costBasis: "per-unit", facilities: 2, customers: 3 }, nodes: [...FACILITIES, ...CUSTOMERS], edges: FACILITY_MAJOR });
    });

    it("refuses counts in the wrong order unless the recipe accepts either order, and then reads the one order the file's numbers fit", () => {
      const swapped = DEMANDS_FIRST.replace("2\t3", "3\t2");
      expect(parseError(() => parseNative(utf8(swapped), cflp({ layout: "demands-first", costBasis: "per-unit" }))).message).toMatch(/expected 16 numbers for 3 facilities and 2 customers, found 15/);
      expect(parseNative(utf8(swapped), cflp({ layout: "demands-first", costBasis: "per-unit", countOrder: "either" }))).toEqual(parseNative(utf8(DEMANDS_FIRST), cflp({ layout: "demands-first", costBasis: "per-unit" })));
    });

    it("ignores NUL padding at the end of a file and refuses a NUL among the numbers", () => {
      expect(parseNative(utf8(`${PAIRS}\0\0\0\0`), pairs)).toEqual(parseNative(utf8(PAIRS), pairs));
      expect(parseError(() => parseNative(utf8(PAIRS.replace("5 6", "5\u00006")), pairs)).message).toMatch(/cflp line 5: NUL padding is followed by more of the file/);
    });

    it("refuses text after the numbers unless the recipe ignores it, and ignoring it still needs every number", () => {
      const mailed = `${PAIRS}From someone 1995\n1 2 3\n`;
      expect(parseError(() => parseNative(utf8(mailed), pairs)).message).toMatch(/cflp line 7: "From" is not a number/);
      const lenient = cflp({ layout: "pairs", costBasis: "per-assignment", trailingText: "ignore" });
      expect(parseNative(utf8(mailed), lenient)).toEqual(parseNative(utf8(PAIRS), pairs));
      expect(parseNative(utf8(`${PAIRS}\0\0\x0039. 336.\n`), lenient)).toEqual(parseNative(utf8(PAIRS), pairs));
      expect(parseError(() => parseNative(utf8(PAIRS.replace("8 9 10\n", "8 9\nFrom someone\n")), lenient)).message).toMatch(/expected 15 numbers for 2 facilities and 3 customers, found 14/);
    });

    it("refuses the word capacity, which only the OR-Library layout writes", () => {
      expect(parseError(() => parseNative(utf8(PAIRS.replace("10 100", "capacity 100")), pairs)).message).toMatch(/cflp line 2: "capacity" is not a number/);
    });
  });

  describe("the simple layout", () => {
    const simple = cflp({ layout: "simple" });

    it("reads uncapacitated facilities with their opening costs and cities with none, and the name the FILE line gives", () => {
      expect(parseNative(utf8(SIMPLE), simple)).toEqual({
        meta: { layout: "simple", costBasis: "per-assignment", facilities: 2, customers: 3, fileName: "example.txt" },
        nodes: [
          { id: "f:1", type: "facility", fixedCost: 100 },
          { id: "f:2", type: "facility", fixedCost: 200 },
          { id: "c:1", type: "customer" },
          { id: "c:2", type: "customer" },
          { id: "c:3", type: "customer" },
        ],
        edges: FACILITY_MAJOR,
      });
    });

    it("refuses a file without its FILE line, a header whose third value is not 0, a facility out of order and a row of the wrong length", () => {
      expect(parseError(() => parseNative(utf8(SIMPLE.replace("FILE: example.txt\n", "")), simple)).message).toMatch(/cflp line 1: expected a FILE: line/);
      expect(parseError(() => parseNative(utf8(SIMPLE.replace("2 3 0", "2 3 1")), simple)).message).toMatch(/cflp line 2: expected the facility count, the city count and 0, found "2 3 1"/);
      expect(parseError(() => parseNative(utf8(SIMPLE.replace("2 200", "3 200")), simple)).message).toMatch(/cflp line 4: expected facility 2, found "3"/);
      expect(parseError(() => parseNative(utf8(SIMPLE.replace("8 9 10", "8 9")), simple)).message).toMatch(/expected 13 numbers after the FILE line for 2 facilities and 3 cities, found 12/);
    });
  });

  describe("the recipe's options", () => {
    const valid = (options: Record<string, unknown>): boolean => ParserSchema.safeParse({ format: "cflp", encoding: "utf-8", ...options }).success;

    it("needs a cost basis for the layouts whose files do not state one, and takes none for the layouts that do", () => {
      expect(valid({ layout: "pairs" })).toBe(false);
      expect(valid({ layout: "demands-first", costBasis: "per-unit" })).toBe(true);
      expect(valid({ layout: "orlib-cap", costBasis: "per-unit" })).toBe(false);
      expect(valid({ layout: "simple", costBasis: "per-assignment" })).toBe(false);
    });

    it("takes count order and trailing text only for the pairs layouts, and capacity values or uncapacitated, not both, only for orlib-cap", () => {
      expect(valid({ layout: "simple", countOrder: "either" })).toBe(false);
      expect(valid({ layout: "orlib-cap", trailingText: "ignore" })).toBe(false);
      expect(valid({ layout: "pairs", costBasis: "per-unit", uncapacitated: true })).toBe(false);
      expect(valid({ layout: "orlib-cap", uncapacitated: true, capacityValues: [{ instance: "capa.txt", values: [1] }] })).toBe(false);
      expect(valid({ layout: "orlib-cap", capacityValues: [{ instance: "capa.txt", values: [1] }, { instance: "capa.txt", values: [2] }] })).toBe(false);
      expect(valid({ layout: "orlib-cap", capacityValues: [{ instance: "capa.txt", values: [1, 1] }] })).toBe(false);
      expect(valid({ layout: "orlib-cap", capacityValues: [{ instance: "capa.txt", values: CAPACITY_VALUES }] })).toBe(true);
    });
  });
});
