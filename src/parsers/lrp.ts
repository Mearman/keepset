import { NativeParseError } from "../errors";
import type { NativeInstance, NativeRow } from "./native";
import { fieldLines, LineCursor, numberReader, type FieldLine } from "./number-lines";

/** The columns of a node: whether it is a `depot` or a `customer`, its planar position, a customer's demand, and a depot's capacity and opening cost. A column a node has no value for is null, so every row has every column. */
export const LRP_COLUMNS = ["role", "x", "y", "demand", "capacity", "openingCost"] as const;

/** The columns whose values are text; the others are numbers. */
export const LRP_TEXT_COLUMNS = ["role"] as const;

/** The metadata keys the parser reads: the customer and depot counts, the capacity of a vehicle, the cost of opening a route (a vehicle), and whether costs are real (true) or the distance times 100 truncated to a whole number (false). */
export const LRP_META = ["customers", "depots", "vehicleCapacity", "routeCost", "realCosts"] as const;

const FORMAT = "lrp";

const read = numberReader(FORMAT);

/**
 * Reads the next line as one number.
 * @param cursor - The file's lines.
 * @param what - What the number is, for the error.
 * @returns The number.
 * @throws NativeParseError when the file has no more lines or the line is not one number.
 */
function single(cursor: LineCursor, what: string): number {
  const line = cursor.take(what);

  return read.decimal(read.fields(line, ["value"], what)("value"), line.line, what);
}

/**
 * Reads a coordinate line: x and y, followed by nothing or only by fields that are zero (Barreto's Or117 file writes two such fields after each depot's coordinates, which hold no value).
 * @param line - The line.
 * @param what - Whose coordinates they are, for the error.
 * @returns The position.
 * @throws NativeParseError when the line has fewer than two fields, a field is not a number, or a further field is not zero.
 */
function coordinates(line: FieldLine, what: string): { readonly x: number; readonly y: number } {
  const [x, y, ...further] = line.fields;
  if (x === undefined || y === undefined || further.some((field) => read.decimal(field, line.line, "a further field") !== 0)) {
    throw new NativeParseError(FORMAT, line.line, `expected x and y of ${what}, found ${JSON.stringify(line.fields.join(" "))}`);
  }

  return { x: read.decimal(x, line.line, "x"), y: read.decimal(y, line.line, "y") };
}

/**
 * Parses a capacitated location-routing instance in the `.dat` layout C. Prodhon distributes the Prins-Prodhon, Tuzun-Burke and Barreto sets in (http://prodhonc.free.fr/Instances/Format.txt): the number of customers n and of depots m, the depots' coordinates (m lines of x and y), the customers' coordinates (n lines), the vehicle capacity, the depots' capacities (m lines), the customers' demands (n lines), the depots' opening costs (m lines), the cost of opening a route, and a flag that is 0 when costs are the Euclidean distance times 100 truncated to a whole number and 1 when they are the real distance. Blank lines between the sections are optional and fields may be separated by any run of spaces and tabs. Nodes are the depots `depot-1` to `depot-m` and then the customers `customer-1` to `customer-n`, each with its `role`, `x` and `y`, a depot's `capacity` and `openingCost` and a customer's `demand`; the counts, vehicle capacity, route cost and the flag (as `realCosts`) are `meta`. Costs are derived from the coordinates, so no arcs are lost.
 * @param text - The file text.
 * @returns The instance.
 * @throws NativeParseError naming the line for a count, capacity, demand, cost or flag line that is not one number, a coordinate line that is not x and y, a flag other than 0 or 1, a file that ends early, or lines after the flag.
 */
export function parseLrp(text: string): NativeInstance {
  const cursor = new LineCursor(FORMAT, fieldLines(text));
  const count = (what: string): number => {
    const line = cursor.take(what);

    return read.count(read.fields(line, ["value"], what)("value"), line.line, what, 1);
  };
  const customers = count("the customer count");
  const depots = count("the depot count");
  // Each section gives one value per depot or per customer in turn, so a node is filled in as its section is read.
  const depotNodes = Array.from({ length: depots }, (_, index) => ({ id: `depot-${String(index + 1)}`, role: "depot", ...coordinates(cursor.take(`the coordinates of depot ${String(index + 1)}`), `depot ${String(index + 1)}`), demand: null, capacity: 0, openingCost: 0 }));
  const customerNodes = Array.from({ length: customers }, (_, index) => ({ id: `customer-${String(index + 1)}`, role: "customer", ...coordinates(cursor.take(`the coordinates of customer ${String(index + 1)}`), `customer ${String(index + 1)}`), demand: 0, capacity: null, openingCost: null }));
  const vehicleCapacity = single(cursor, "the vehicle capacity");
  for (const depot of depotNodes) {
    depot.capacity = single(cursor, `the capacity of ${depot.id}`);
  }
  for (const customer of customerNodes) {
    customer.demand = single(cursor, `the demand of ${customer.id}`);
  }
  for (const depot of depotNodes) {
    depot.openingCost = single(cursor, `the opening cost of ${depot.id}`);
  }
  const routeCost = single(cursor, "the route opening cost");
  const flagLine = cursor.take("the cost flag");
  const flag = read.fields(flagLine, ["flag"], "the cost flag")("flag");
  if (flag !== "0" && flag !== "1") {
    throw new NativeParseError(FORMAT, flagLine.line, `expected the cost flag 0 or 1, found ${JSON.stringify(flag)}`);
  }
  const extra = cursor.rest();
  if (extra !== undefined) {
    throw new NativeParseError(FORMAT, extra.line, "the file goes on after the cost flag");
  }
  const nodes: NativeRow[] = [...depotNodes, ...customerNodes];

  return { meta: { customers, depots, vehicleCapacity, routeCost, realCosts: flag === "1" }, nodes };
}
