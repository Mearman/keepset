import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { JsonScalar } from "../targets/json-scalar";
import { forEachLine, type NativeEdge, type NativeTypedNode } from "./native";

type CflpParser = Extract<Parser, { format: "cflp" }>;

const FORMAT = "cflp";

/** A number as a decimal literal with an optional sign, fraction and exponent; OR-Library writes whole numbers with a trailing point (`7500.`). `Number` alone would also read hex, an empty string and infinity. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The word OR-Library's capa, capb and capc files write in place of every facility's capacity, to be replaced by a value of the paper's Table 1 (OR-Library, capinfo.html). */
const CAPACITY_WORD = "capacity";

/** What separates the numbers: any run of whitespace. NUL is not whitespace, so a NUL is seen and handled as padding. */
const SEPARATOR = /\s+/;

const NUL = "\0";

/** The values every layout but simple starts with: the facility count and the customer count. */
const COUNTS = 2;

/** The values a simple file starts with after its FILE line: the facility count, the city count and a 0. */
const SIMPLE_HEADER = 3;

/** The values a simple row starts with before its connection costs: the facility's number and its opening cost. */
const SIMPLE_ROW_LEAD = 2;

/**
 * Where a facility's row of a simple file starts.
 * @param facility - The facility's 0-based position.
 * @param customers - The city count.
 * @returns The position of the row's facility number.
 */
const simpleRow = (facility: number, customers: number): number => SIMPLE_HEADER + facility * (customers + SIMPLE_ROW_LEAD);

/** The capacity the reader holds at first; it doubles as the file's numbers fill it. */
const INITIAL_CAPACITY = 1024;

/** A facility: its capacity (absent from an uncapacitated instance) and its fixed cost of opening. */
export interface NativeFacility extends NativeTypedNode {
  readonly capacity?: number;
  readonly fixedCost: number;
}

/** A customer: its demand (absent from an uncapacitated instance). */
export interface NativeCustomer extends NativeTypedNode {
  readonly demand?: number;
}

/** The edge from a facility to a customer: the cost of serving the customer from it, on the basis the instance's meta records. */
export interface NativeAssignment extends NativeEdge {
  readonly cost: number;
}

/** A facility location instance as a bipartite graph: the facilities `f:1` to `f:m` then the customers `c:1` to `c:n`, numbered in file order, and one edge per facility and customer pair in the order the file writes the costs, with the instance's own figures as `meta`. */
export interface NativeFacilityGraph {
  readonly meta: Readonly<Record<string, JsonScalar>>;
  readonly nodes: readonly (NativeFacility | NativeCustomer)[];
  readonly edges: readonly NativeAssignment[];
}

/** The numbers of a file as read: each value with the line it is on, `NaN` standing for the word `capacity`. */
interface Numbers {
  readonly values: Float64Array;
  readonly lines: Int32Array;
  readonly count: number;
  /** The file's last line, where a count that falls short is reported. */
  readonly lastLine: number;
  /** The name a simple file's FILE line gives. */
  readonly fileName: string | undefined;
}

/** A file read and checked against its layout: its counts, its numbers and where each part starts. */
interface Tables {
  readonly numbers: Numbers;
  readonly facilities: number;
  readonly customers: number;
  /** Whether every capacity is the word `capacity`. */
  readonly capacityWord: boolean;
  /** The line of the first word `capacity`, for the error that names it. */
  readonly wordLine: number;
}

/** An instance of a file that may be read as several, with the id it is filed under. */
export interface CflpInstance {
  readonly id: string;
  readonly native: NativeFacilityGraph;
}

/**
 * Reads the whitespace-separated numbers of a file: a token that is not a number ends the numbers when the recipe ignores trailing text and is refused otherwise, except the word `capacity` in a layout that writes it. A run of NUL characters (old file systems' padding) may end the file, after which nothing but more padding and whitespace may follow unless trailing text is ignored.
 * @param pieces - The file's text.
 * @param parser - The recipe's parser.
 * @returns The numbers.
 * @throws NativeParseError for a token that is not a number, a NUL followed by more of the file, and a simple file without its FILE line.
 */
function readNumbers(pieces: Readonly<Iterable<string>>, parser: CflpParser): Numbers {
  let values = new Float64Array(INITIAL_CAPACITY);
  let lines = new Int32Array(INITIAL_CAPACITY);
  let count = 0;
  let lastLine = 0;
  let fileName: string | undefined;
  let stopped = false;
  let padded = false;
  const ignoring = parser.trailingText === "ignore";
  const push = (value: number, line: number): void => {
    if (count === values.length) {
      const grownValues = new Float64Array(values.length * 2);
      grownValues.set(values);
      values = grownValues;
      const grownLines = new Int32Array(lines.length * 2);
      grownLines.set(lines);
      lines = grownLines;
    }
    values[count] = value;
    lines[count] = line;
    count += 1;
  };
  forEachLine(pieces, (text, number) => {
    lastLine = number;
    if (parser.layout === "simple" && number === 1) {
      const match = /^FILE:\s*(.*?)\s*$/.exec(text);
      if (match?.[1] === undefined) {
        throw new NativeParseError(FORMAT, number, "expected a FILE: line naming the instance");
      }
      fileName = match[1];

      return;
    }
    if (stopped) {
      return;
    }
    for (const field of text.split(SEPARATOR)) {
      if (field === "") {
        continue;
      }
      const nul = field.indexOf(NUL);
      const token = nul === -1 ? field : field.slice(0, nul);
      const rest = nul === -1 ? "" : field.slice(nul).replaceAll(NUL, "");
      if (padded && field.replaceAll(NUL, "") !== "") {
        if (ignoring) {
          stopped = true;

          return;
        }
        throw new NativeParseError(FORMAT, number, "NUL padding is followed by more of the file");
      }
      if (token !== "") {
        if (DECIMAL.test(token)) {
          push(Number(token), number);
        } else if (token === CAPACITY_WORD && parser.layout === "orlib-cap") {
          push(Number.NaN, number);
        } else if (ignoring) {
          stopped = true;

          return;
        } else {
          throw new NativeParseError(FORMAT, number, `${JSON.stringify(token)} is not a number`);
        }
      }
      if (nul !== -1) {
        padded = true;
        if (rest !== "") {
          if (ignoring) {
            stopped = true;

            return;
          }
          throw new NativeParseError(FORMAT, number, "NUL padding is followed by more of the file");
        }
      }
    }
  });
  if (parser.layout === "simple" && fileName === undefined) {
    throw new NativeParseError(FORMAT, 1, "expected a FILE: line naming the instance");
  }

  return { values, lines, count, lastLine, fileName };
}

/**
 * The line a value is on.
 * @param numbers - The file's numbers.
 * @param index - The value's position, inside the file.
 * @returns The 1-based line.
 */
function lineAt(numbers: Numbers, index: number): number {
  return numbers.lines[index] ?? numbers.lastLine;
}

/**
 * How many numbers a file of the layout holds for its counts, the counts included.
 * @param layout - The layout.
 * @param facilities - The facility count.
 * @param customers - The customer count.
 * @returns The number of values.
 */
function expectedCount(layout: CflpParser["layout"], facilities: number, customers: number): number {
  if (layout === "orlib-cap") {
    return 2 + 2 * facilities + customers * (facilities + 1);
  }
  if (layout === "simple") {
    return simpleRow(facilities, customers);
  }

  return 2 + 2 * facilities + customers + facilities * customers;
}

/**
 * Reads a count: a positive whole number.
 * @param numbers - The file's numbers.
 * @param index - Its position.
 * @param what - What it counts, for the error.
 * @returns The count.
 * @throws NativeParseError when the file holds no such value or it is not a positive whole number.
 */
function countAt(numbers: Numbers, index: number, what: string): number {
  if (index >= numbers.count) {
    throw new NativeParseError(FORMAT, Math.max(numbers.lastLine, 1), "the file holds no facility and customer counts");
  }
  const value = valueAt(numbers, index);
  if (!Number.isInteger(value) || value <= 0) {
    throw new NativeParseError(FORMAT, lineAt(numbers, index), `the ${what} count ${JSON.stringify(Number.isNaN(value) ? CAPACITY_WORD : String(value))} is not a positive whole number`);
  }

  return value;
}

/**
 * Reads a file into its numbers and checks them against the layout: the counts, the number of values they imply, the third header value of a simple file, each simple row's facility number and where the word `capacity` stands.
 * @param pieces - The file's text.
 * @param parser - The recipe's parser.
 * @returns The checked tables.
 * @throws NativeParseError for a file whose numbers do not fit its layout.
 */
function readTables(pieces: Readonly<Iterable<string>>, parser: CflpParser): Tables {
  const numbers = readNumbers(pieces, parser);
  const { layout } = parser;
  const simple = layout === "simple";
  let facilities = countAt(numbers, 0, "facility");
  let customers = countAt(numbers, 1, simple ? "city" : "customer");
  if (simple && numbers.values[2] !== 0) {
    const shown = [0, 1, 2].filter((index) => index < numbers.count).map((index) => String(numbers.values[index]));
    throw new NativeParseError(FORMAT, lineAt(numbers, 0), `expected the facility count, the city count and 0, found ${JSON.stringify(shown.join(" "))}`);
  }
  if (numbers.count !== expectedCount(layout, facilities, customers)) {
    if (parser.countOrder === "either" && numbers.count === expectedCount(layout, customers, facilities)) {
      [facilities, customers] = [customers, facilities];
    } else {
      const where = simple ? `after the FILE line for ${String(facilities)} facilities and ${String(customers)} cities` : `for ${String(facilities)} facilities and ${String(customers)} customers`;
      throw new NativeParseError(FORMAT, Math.max(numbers.lastLine, 1), `expected ${String(expectedCount(layout, facilities, customers))} numbers ${where}, found ${String(numbers.count)}`);
    }
  }
  if (simple) {
    for (let facility = 0; facility < facilities; facility += 1) {
      const row = simpleRow(facility, customers);
      if (numbers.values[row] !== facility + 1) {
        throw new NativeParseError(FORMAT, lineAt(numbers, row), `expected facility ${String(facility + 1)}, found ${JSON.stringify(String(numbers.values[row]))}`);
      }
    }
  }
  let words = 0;
  let wordLine = 0;
  for (let index = 0; index < numbers.count; index += 1) {
    if (!Number.isNaN(numbers.values[index])) {
      continue;
    }
    const line = lineAt(numbers, index);
    // The word stands only where a facility's capacity is: the first value of each facility's pair.
    if (index < 2 || index >= 2 + 2 * facilities || index % 2 !== 0) {
      throw new NativeParseError(FORMAT, line, `${JSON.stringify(CAPACITY_WORD)} is not a number`);
    }
    if (words === 0) {
      wordLine = line;
    }
    words += 1;
  }
  if (words > 0 && words < facilities && parser.uncapacitated !== true) {
    throw new NativeParseError(FORMAT, wordLine, "the file writes the word capacity for some facilities and a number for others");
  }

  return { numbers, facilities, customers, capacityWord: words > 0, wordLine };
}

/**
 * Reads a value of a checked file; the counts were checked against the number of values, so every position a layout names is inside the file.
 * @param numbers - The file's numbers.
 * @param index - The position.
 * @returns The value.
 */
function valueAt(numbers: Numbers, index: number): number {
  const value = numbers.values[index];
  if (value === undefined || index >= numbers.count) {
    throw new NativeParseError(FORMAT, numbers.lastLine, `the layout reads value ${String(index + 1)} of ${String(numbers.count)}`);
  }

  return value;
}

/**
 * Builds the graph of a checked file.
 * @param tables - The checked file.
 * @param parser - The recipe's parser.
 * @param capacity - The value the word `capacity` stands for in this instance, when the file writes it.
 * @returns The graph.
 */
function graphOf(tables: Tables, parser: CflpParser, capacity: number | undefined): NativeFacilityGraph {
  const { numbers, facilities, customers } = tables;
  const { layout } = parser;
  const at = (index: number): number => valueAt(numbers, index);
  const capacitated = layout !== "simple" && parser.uncapacitated !== true;
  // Where each part starts, as each layout orders them.
  const capacityAt = (facility: number): number => (layout === "demands-first" ? 2 + customers + facility : 2 + 2 * facility);
  const fixedCostAt = (facility: number): number => {
    if (layout === "demands-first") return 2 + customers + facilities + facility;
    if (layout === "simple") return simpleRow(facility, customers) + 1;

    return COUNTS + 1 + 2 * facility;
  };
  const demandAt = (customer: number): number => {
    if (layout === "orlib-cap") return 2 + 2 * facilities + customer * (facilities + 1);
    if (layout === "demands-first") return 2 + customer;

    return 2 + 2 * facilities + customer;
  };
  const costAt = (facility: number, customer: number): number => {
    if (layout === "orlib-cap") return demandAt(customer) + 1 + facility;
    if (layout === "simple") return simpleRow(facility, customers) + SIMPLE_ROW_LEAD + customer;

    return 2 + 2 * facilities + customers + facility * customers + customer;
  };
  const facilityIds = Array.from({ length: facilities }, (_, index) => `f:${String(index + 1)}`);
  const customerIds = Array.from({ length: customers }, (_, index) => `c:${String(index + 1)}`);
  const nodes: (NativeFacility | NativeCustomer)[] = [
    ...facilityIds.map((id, facility): NativeFacility => {
      const fixedCost = at(fixedCostAt(facility));

      return capacitated ? { id, type: "facility", capacity: capacity ?? at(capacityAt(facility)), fixedCost } : { id, type: "facility", fixedCost };
    }),
    ...customerIds.map((id, customer): NativeCustomer => (capacitated ? { id, type: "customer", demand: at(demandAt(customer)) } : { id, type: "customer" })),
  ];
  const edges: NativeAssignment[] = [];
  if (layout === "orlib-cap") {
    // Customer-major, as the file writes each customer's costs after its demand.
    for (const [customer, target] of customerIds.entries()) {
      for (const [facility, source] of facilityIds.entries()) {
        edges.push({ source, target, cost: at(costAt(facility, customer)) });
      }
    }
  } else {
    for (const [facility, source] of facilityIds.entries()) {
      for (const [customer, target] of customerIds.entries()) {
        edges.push({ source, target, cost: at(costAt(facility, customer)) });
      }
    }
  }
  const meta: Record<string, JsonScalar> = {
    layout,
    costBasis: parser.costBasis ?? "per-assignment",
    facilities,
    customers,
    ...(capacity === undefined ? {} : { capacity }),
    ...(parser.uncapacitated === true ? { uncapacitated: true } : {}),
    ...(numbers.fileName === undefined ? {} : { fileName: numbers.fileName }),
  };

  return { meta, nodes, edges };
}

/** Whether a checked file writes the word `capacity` for capacities the recipe must name values for. */
const substitutes = (tables: Tables, parser: CflpParser): boolean => tables.capacityWord && parser.uncapacitated !== true;

/**
 * Parses a facility location instance file into the instances it gives under the id a collection files it at: one, or, for an OR-Library file that writes the word `capacity` in place of every capacity, one for each value the recipe names for that id, filed at the id and the value joined by `/`, with the value as every facility's capacity and in `meta.capacity`.
 *
 * Every layout is whitespace-separated numbers whatever the line breaks (OR-Library wraps a customer's costs over several lines, the Gadegaard files put each count on a line of its own). The graph's nodes are the facilities `f:1` to `f:m` in file order, each `facility` with its `capacity` and `fixedCost`, then the customers `c:1` to `c:n`, each `customer` with its `demand`; an uncapacitated instance (the simple layout, or an `orlib-cap` file read as uncapacitated) carries no capacity or demand. Each facility and customer pair is an edge from the facility to the customer with its `cost`, in the order the file writes the costs: customer by customer in `orlib-cap`, facility by facility otherwise. `meta` records the layout, the cost basis (stated by the recipe for `pairs` and `demands-first`, and serving the whole demand for the formats that define it), the counts, a simple file's FILE name, the substituted capacity and whether the instance is read as uncapacitated. Costs are carried as the file writes them, never converted from one basis to another.
 * @param id - The id the collection files the file under, by which the recipe's capacity values name it.
 * @param pieces - The file's text.
 * @param parser - The recipe's parser.
 * @returns The instances, in the order of the recipe's values.
 * @throws NativeParseError for a file whose numbers do not fit the layout, a file that writes the word `capacity` with no values named for it, and values named for a file that writes no such word.
 */
export function parseCflpInstances(id: string, pieces: Readonly<Iterable<string>>, parser: CflpParser): readonly CflpInstance[] {
  const tables = readTables(pieces, parser);
  const values = parser.capacityValues?.find((file) => file.instance === id)?.values;
  if (values === undefined) {
    if (substitutes(tables, parser)) {
      throw new NativeParseError(FORMAT, tables.wordLine, "the file writes the word capacity in place of a capacity, and the recipe names no values for it");
    }

    return [{ id, native: graphOf(tables, parser, undefined) }];
  }
  if (!substitutes(tables, parser)) {
    throw new NativeParseError(FORMAT, 1, "the recipe names capacity values for this file, and it writes no word capacity");
  }

  return values.map((value) => ({ id: `${id}/${String(value)}`, native: graphOf(tables, parser, value) }));
}

/**
 * Parses a facility location instance file read as one document, as `parseCflpInstances` reads an instance; a file that writes the word `capacity` in place of its capacities is refused unless it is read as uncapacitated, as only a collection names values for it.
 * @param pieces - The file's text.
 * @param parser - The recipe's parser.
 * @returns The graph.
 * @throws NativeParseError as `parseCflpInstances` does.
 */
export function parseCflp(pieces: Readonly<Iterable<string>>, parser: CflpParser): NativeFacilityGraph {
  const tables = readTables(pieces, parser);
  if (substitutes(tables, parser)) {
    throw new NativeParseError(FORMAT, tables.wordLine, "the file writes the word capacity in place of a capacity, and the recipe names no values for it");
  }

  return graphOf(tables, parser, undefined);
}
