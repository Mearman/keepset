import { NativeParseError } from "../errors";
import type { NativeAttributedEdge, NativeAttributedGraph, NativeRow } from "./native";
import { lines } from "./native";
import { numberReader } from "./number-lines";

const FORMAT = "matpower";

const read = numberReader(FORMAT);

/** The bus table's columns in MATPOWER's order (the MATPOWER manual, appendix B, "caseformat"). `type` is read as `busType`, since a node's `type` says what the node is. */
const BUS_COLUMNS = ["bus_i", "busType", "Pd", "Qd", "Gs", "Bs", "area", "Vm", "Va", "baseKV", "zone", "Vmax", "Vmin"] as const;
/** The generator table's columns: the ten every case has, then the eleven of the capability curve, ramp rates and participation factor that a case may add. `bus` is the edge to the generator's bus. */
const GEN_COLUMNS = ["bus", "Pg", "Qg", "Qmax", "Qmin", "Vg", "mBase", "status", "Pmax", "Pmin", "Pc1", "Pc2", "Qc1min", "Qc1max", "Qc2min", "Qc2max", "ramp_agc", "ramp_10", "ramp_30", "ramp_q", "apf"] as const;
/** How many generator columns every case has; the rest are optional as a block. */
const GEN_REQUIRED = 10;
/** The branch table's columns. `status` is read as `branchStatus`, as the generator's `status` is a node field and a crossmap path names one field. */
const BRANCH_COLUMNS = ["fbus", "tbus", "r", "x", "b", "rateA", "rateB", "rateC", "ratio", "angle", "branchStatus", "angmin", "angmax"] as const;
/** The generator cost table's columns for the one form read: a polynomial (model 2) of three coefficients, highest order first. */
const GENCOST_COLUMNS = ["model", "startup", "shutdown", "n", "c2", "c1", "c0"] as const;
/** MATPOWER's code for a polynomial cost. */
const POLYNOMIAL = 2;
/** The number of polynomial coefficients the parser accepts, a quadratic cost: a cost row of any other model or coefficient count is refused. */
const COEFFICIENTS = 3;

/** A matrix assignment's opening line, `mpc.NAME = [`. */
const MATRIX_START = /^mpc\.(\w+)\s*=\s*\[\s*$/;
/** A scalar assignment, `mpc.NAME = VALUE;`, the value a number or a quoted string. */
const SCALAR = /^mpc\.(\w+)\s*=\s*(?:'([^']*)'|([^;\s]+))\s*;$/;
/** The function line that names the case. */
const FUNCTION = /^function\s+mpc\s*=\s*(\w+)$/;
/** The tables the parser reads. */
const TABLES: ReadonlySet<string> = new Set(["bus", "gen", "gencost", "branch", "areas"]);

/** A table's rows, each with its 1-based line. */
interface Table {
  readonly rows: readonly { readonly line: number; readonly fields: readonly string[] }[];
  readonly line: number;
}

/**
 * Splits a case file into its scalar assignments, the case's function name and its matrix tables, dropping `%` comments.
 * @param text - The file text.
 * @returns The scalars by name, the function name and the tables by name.
 * @throws NativeParseError for a line outside a table that is not a comment, the function line or a scalar assignment, a table the parser does not read, a value given twice, or a table that is not closed.
 */
function split(text: string): { scalars: Map<string, { readonly value: string; readonly line: number }>; name: string | undefined; tables: Map<string, Table> } {
  const scalars = new Map<string, { readonly value: string; readonly line: number }>();
  const tables = new Map<string, Table>();
  let name: string | undefined;
  let open: { readonly name: string; readonly line: number; readonly rows: { readonly line: number; readonly fields: readonly string[] }[] } | undefined;
  for (const [index, raw] of lines(text).entries()) {
    const line = index + 1;
    const content = raw.replace(/%.*$/, "").trim();
    if (content === "") {
      continue;
    }
    if (open !== undefined) {
      if (content === "];") {
        tables.set(open.name, { rows: open.rows, line: open.line });
        open = undefined;
        continue;
      }
      if (!content.endsWith(";")) {
        throw new NativeParseError(FORMAT, line, `expected a row of mpc.${open.name} ending with ;, found ${JSON.stringify(content)}`);
      }
      open.rows.push({ line, fields: content.slice(0, -1).trim().split(/\s+/) });
      continue;
    }
    const start = MATRIX_START.exec(content);
    if (start !== null) {
      const table = start[1] ?? "";
      if (!TABLES.has(table)) {
        throw new NativeParseError(FORMAT, line, `the table mpc.${table} is not one the parser reads (bus, gen, gencost, branch, areas)`);
      }
      if (tables.has(table)) {
        throw new NativeParseError(FORMAT, line, `the table mpc.${table} is given twice`);
      }
      open = { name: table, line, rows: [] };
      continue;
    }
    const scalar = SCALAR.exec(content);
    if (scalar !== null) {
      const key = scalar[1] ?? "";
      if (scalars.has(key)) {
        throw new NativeParseError(FORMAT, line, `mpc.${key} is given twice`);
      }
      scalars.set(key, { value: scalar[2] ?? scalar[3] ?? "", line });
      continue;
    }
    const fn = FUNCTION.exec(content);
    if (fn !== null && name === undefined) {
      name = fn[1];
      continue;
    }
    throw new NativeParseError(FORMAT, line, `expected a comment, the function line, mpc.NAME = VALUE; or mpc.NAME = [, found ${JSON.stringify(content)}`);
  }
  if (open !== undefined) {
    throw new NativeParseError(FORMAT, open.line, `the table mpc.${open.name} is not closed with ];`);
  }

  return { scalars, name, tables };
}

/**
 * Reads a table's rows as numbers, each row of one of the widths allowed.
 * @param tables - The case's tables.
 * @param table - The table's name.
 * @param widths - The numbers of columns a row may have.
 * @returns The rows, each its numbers with its line.
 * @throws NativeParseError when the table is missing, a row has another width or the rows differ in width, or a field is not a number.
 */
function numbers(tables: ReadonlyMap<string, Table>, table: string, widths: readonly number[]): { readonly line: number; readonly values: readonly number[] }[] {
  return numbersOf(table, requireTable(tables, table), widths);
}

/**
 * Finds a table the case must have.
 * @param tables - The case's tables.
 * @param table - The table's name.
 * @returns The table.
 * @throws NativeParseError when the table is missing.
 */
function requireTable(tables: ReadonlyMap<string, Table>, table: string): Table {
  const found = tables.get(table);
  if (found === undefined) {
    throw new NativeParseError(FORMAT, 1, `the case has no mpc.${table} table`);
  }

  return found;
}

/**
 * Reads a found table's rows as numbers, each row of one of the widths allowed.
 * @param table - The table's name, for errors.
 * @param found - The table.
 * @param widths - The numbers of columns a row may have.
 * @returns The rows, each its numbers with its line.
 * @throws NativeParseError when a row has another width or the rows differ in width, or a field is not a number.
 */
function numbersOf(table: string, found: Table, widths: readonly number[]): { readonly line: number; readonly values: readonly number[] }[] {
  const width = found.rows[0]?.fields.length;

  return found.rows.map(({ line, fields }) => {
    if (!widths.includes(fields.length) || fields.length !== width) {
      throw new NativeParseError(FORMAT, line, `expected a row of mpc.${table} of ${widths.join(" or ")} columns, the same in every row, found ${String(fields.length)}`);
    }

    return { line, values: fields.map((field) => read.scientific(field, line, `a value of mpc.${table}`)) };
  });
}

/**
 * Parses a power system case in the MATPOWER case format, version 2 (the MATPOWER manual, appendix B), as the PGLib optimal power flow library distributes it: `%` comments, the `function mpc = NAME` line, `mpc.version = '2';`, `mpc.baseMVA = N;`, and the matrices `mpc.bus`, `mpc.gen`, `mpc.gencost` and `mpc.branch` (and the legacy `mpc.areas`), one row per line ended by `;`.
 *
 * Each bus is a node of type `bus`, its id the bus number, with the bus table's columns as fields (`type` as `busType`). Each generator is a node `generator-<k>` (its 1-based row) of type `generator` with the generator table's columns (the eleven optional ones null when the case gives ten) and its cost row's `startup`, `shutdown`, `c2`, `c1` and `c0`, joined to its bus by an edge of type `generator`. Each branch is an undirected edge of type `branch` from its `fbus` to its `tbus` with the branch table's columns (`status` as `branchStatus`), parallel branches kept. Every node carries every node field and every edge every edge field, null where it has none. `meta` holds the case's `name`, `version` and `baseMVA`, and the area table, where there is one, as `areas`: each row's area and reference bus, joined by `;`.
 * @param text - The file text.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a line of another form, a table or value given twice or missing, a version other than 2, a row of another width, a value that is not a number, a bus number given twice or not a whole number, a generator or branch at a bus the case does not list, a cost row count other than the generator count, or a cost other than a quadratic polynomial.
 */
export function parseMatpower(text: string): NativeAttributedGraph {
  const { scalars, name, tables } = split(text);
  const version = scalars.get("version");
  if (version?.value !== "2") {
    throw new NativeParseError(FORMAT, version?.line ?? 1, `expected mpc.version = '2', found ${JSON.stringify(version?.value ?? "none")}`);
  }
  const base = scalars.get("baseMVA");
  if (base === undefined) {
    throw new NativeParseError(FORMAT, 1, "the case has no mpc.baseMVA");
  }
  for (const [key, { line }] of scalars) {
    if (key !== "version" && key !== "baseMVA") {
      throw new NativeParseError(FORMAT, line, `mpc.${key} is not a value the parser reads (version, baseMVA)`);
    }
  }
  const areas = tables.get("areas");
  const meta: Record<string, string | number> = {
    ...(name === undefined ? {} : { name }),
    version: version.value,
    baseMVA: read.scientific(base.value, base.line, "mpc.baseMVA"),
    ...(areas === undefined ? {} : { areas: numbers(tables, "areas", [2]).map(({ values }) => values.join(" ")).join("; ") }),
  };

  const busNulls = Object.fromEntries(BUS_COLUMNS.slice(1).map((column) => [column, null]));
  const genNulls = Object.fromEntries([...GEN_COLUMNS.slice(1), ...GENCOST_COLUMNS.filter((column) => column !== "model" && column !== "n")].map((column) => [column, null]));
  const edgeNulls = Object.fromEntries(BRANCH_COLUMNS.slice(2).map((column) => [column, null]));

  const nodes: NativeRow[] = [];
  const buses = new Set<number>();
  for (const { line, values } of numbers(tables, "bus", [BUS_COLUMNS.length])) {
    const [id, ...rest] = values;
    if (id === undefined || !Number.isSafeInteger(id) || buses.has(id)) {
      throw new NativeParseError(FORMAT, line, `the bus number ${String(id)} is not a whole number or is given twice`);
    }
    buses.add(id);
    nodes.push({ id: String(id), type: "bus", ...Object.fromEntries(BUS_COLUMNS.slice(1).map((column, position) => [column, rest[position] ?? null])), ...genNulls });
  }
  const atBus = (bus: number | undefined, line: number, what: string): string => {
    if (bus === undefined || !buses.has(bus)) {
      throw new NativeParseError(FORMAT, line, `${what} at bus ${String(bus)}, which the case does not list`);
    }

    return String(bus);
  };

  const gens = numbers(tables, "gen", [GEN_REQUIRED, GEN_COLUMNS.length]);
  const costTable = requireTable(tables, "gencost");
  const costs = numbersOf("gencost", costTable, [GENCOST_COLUMNS.length]);
  if (costs.length !== gens.length) {
    throw new NativeParseError(FORMAT, costTable.line, `expected one cost row per generator (${String(gens.length)}), found ${String(costs.length)}`);
  }
  const edges: NativeAttributedEdge[] = [];
  for (const [index, { line, values }] of gens.entries()) {
    const cost = costs[index];
    if (cost === undefined) {
      throw new NativeParseError(FORMAT, line, "the generator has no cost row");
    }
    const [model, startup, shutdown, n, ...coefficients] = cost.values;
    if (model !== POLYNOMIAL || n !== COEFFICIENTS) {
      throw new NativeParseError(FORMAT, cost.line, `expected a quadratic polynomial cost (model ${String(POLYNOMIAL)}, n ${String(COEFFICIENTS)}), found model ${String(model)} with n ${String(n)}`);
    }
    const [bus, ...rest] = values;
    const id = `generator-${String(index + 1)}`;
    const [c2 = null, c1 = null, c0 = null] = coefficients;
    nodes.push({ id, type: "generator", ...busNulls, ...Object.fromEntries(GEN_COLUMNS.slice(1).map((column, position) => [column, rest[position] ?? null])), startup: startup ?? null, shutdown: shutdown ?? null, c2, c1, c0 });
    edges.push({ source: id, target: atBus(bus, line, "a generator"), type: "generator", ...edgeNulls });
  }
  for (const { line, values } of numbers(tables, "branch", [BRANCH_COLUMNS.length])) {
    const [fbus, tbus, ...rest] = values;
    edges.push({ source: atBus(fbus, line, "a branch"), target: atBus(tbus, line, "a branch"), type: "branch", ...Object.fromEntries(BRANCH_COLUMNS.slice(2).map((column, position) => [column, rest[position] ?? null])) });
  }

  return { meta, nodes, edges };
}
