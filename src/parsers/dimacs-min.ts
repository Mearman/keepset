import { NativeParseError } from "../errors";
import type { NativeAttributedEdge, NativeAttributedGraph, NativeRow } from "./native";
import { fieldLines, numberReader } from "./number-lines";

const FORMAT = "dimacs-min";

const read = numberReader(FORMAT);

/** The fields of the problem line, `p min NODES ARCS`. */
const PROBLEM_FIELDS = ["designator", "problem", "nodes", "arcs"] as const;
/** The fields of a node descriptor, `n ID FLOW`. */
const NODE_FIELDS = ["designator", "id", "flow"] as const;
/** The fields of an arc descriptor, `a SRC DST LOW CAP COST`. */
const ARC_FIELDS = ["designator", "source", "target", "low", "capacity", "cost"] as const;

/** The flow value of a node with no descriptor: the specification lists only supply and demand nodes, so every other node is a transshipment node, whose flow value is zero. */
const TRANSSHIPMENT = 0;

/**
 * Reads a node number, which the format numbers from 1 to n.
 * @param field - The field.
 * @param line - Its 1-based line, for the error.
 * @param count - The node count.
 * @returns The node number.
 * @throws NativeParseError when the field is not a node number from 1 to n.
 */
function nodeNumber(field: string, line: number, count: number): number {
  const value = read.integer(field, line, "a node number");
  if (value < 1 || value > count) {
    throw new NativeParseError(FORMAT, line, `expected a node from 1 to ${String(count)}, found ${field}`);
  }

  return value;
}

/**
 * Parses a minimum-cost flow problem in the DIMACS `.min` format (the first DIMACS Implementation Challenge's network flow specification, https://archive.dimacs.rutgers.edu/pub/netflow/general-info/specs.tex): `c` comment lines anywhere, one problem line `p min NODES ARCS` before any descriptor, a node descriptor `n ID FLOW` for each node whose flow value is not zero (positive for supply, negative for demand), all before the arc descriptors `a SRC DST LOW CAP COST`, one per arc, of which there are exactly ARCS. Nodes are `1` to `n`, each with its `supply` (the flow value, zero for a node with no descriptor); arcs are directed edges in file order with their `low` bound, `capacity` and `cost`, parallel arcs kept as the specification allows; a negative capacity is the specification's mark of an uncapacitated arc, carried as a null `capacity`. Every value is a whole number, as the specification requires.
 * @param text - The file text.
 * @returns The native graph, with an empty `meta`.
 * @throws NativeParseError naming the line for a missing, repeated or misplaced problem line, a problem other than `min`, a line of another designator, a descriptor of the wrong shape, a node outside 1 to n or described twice, a node descriptor after an arc, a self-arc, a lower bound below zero or above the capacity, or an arc count that differs from the problem line's.
 */
export function parseDimacsMin(text: string): NativeAttributedGraph {
  let problem: { readonly nodes: number; readonly arcs: number } | undefined;
  const supply = new Map<number, number>();
  const edges: NativeAttributedEdge[] = [];
  let last = 1;
  for (const line of fieldLines(text)) {
    last = line.line;
    const [designator] = line.fields;
    if (designator === "c") {
      continue;
    }
    if (designator === "p") {
      if (problem !== undefined) {
        throw new NativeParseError(FORMAT, line.line, "a second problem line");
      }
      const field = read.fields(line, PROBLEM_FIELDS, "the problem line p min NODES ARCS");
      if (field("problem") !== "min") {
        throw new NativeParseError(FORMAT, line.line, `expected the problem line p min NODES ARCS, found ${JSON.stringify(line.fields.join(" "))}`);
      }
      problem = { nodes: read.count(field("nodes"), line.line, "the node count", 1), arcs: read.count(field("arcs"), line.line, "the arc count", 0) };
      continue;
    }
    if (designator !== "n" && designator !== "a") {
      throw new NativeParseError(FORMAT, line.line, `expected a line starting c, p, n or a, found ${JSON.stringify(line.fields.join(" "))}`);
    }
    if (problem === undefined) {
      throw new NativeParseError(FORMAT, line.line, `a ${designator === "n" ? "node" : "arc"} descriptor before the problem line`);
    }
    if (designator === "n") {
      if (edges.length > 0) {
        throw new NativeParseError(FORMAT, line.line, "a node descriptor after an arc descriptor");
      }
      const field = read.fields(line, NODE_FIELDS, "a node descriptor n ID FLOW");
      const id = nodeNumber(field("id"), line.line, problem.nodes);
      if (supply.has(id)) {
        throw new NativeParseError(FORMAT, line.line, `node ${String(id)} is described twice`);
      }
      supply.set(id, read.integer(field("flow"), line.line, "the node flow"));
      continue;
    }
    const field = read.fields(line, ARC_FIELDS, "an arc descriptor a SRC DST LOW CAP COST");
    const source = nodeNumber(field("source"), line.line, problem.nodes);
    const target = nodeNumber(field("target"), line.line, problem.nodes);
    if (source === target) {
      throw new NativeParseError(FORMAT, line.line, `an arc from node ${String(source)} to itself`);
    }
    const low = read.count(field("low"), line.line, "the lower bound", 0);
    const capacity = read.integer(field("capacity"), line.line, "the capacity");
    if (capacity >= 0 && low > capacity) {
      throw new NativeParseError(FORMAT, line.line, `the lower bound ${String(low)} is above the capacity ${String(capacity)}`);
    }
    edges.push({ source: String(source), target: String(target), low, capacity: capacity < 0 ? null : capacity, cost: read.integer(field("cost"), line.line, "the cost") });
  }
  if (problem === undefined) {
    throw new NativeParseError(FORMAT, last, "the file has no problem line");
  }
  if (edges.length !== problem.arcs) {
    throw new NativeParseError(FORMAT, last, `expected ${String(problem.arcs)} arcs, found ${String(edges.length)}`);
  }
  const nodes: NativeRow[] = Array.from({ length: problem.nodes }, (_, index) => ({ id: String(index + 1), supply: supply.get(index + 1) ?? TRANSSHIPMENT }));

  return { meta: {}, nodes, edges };
}
