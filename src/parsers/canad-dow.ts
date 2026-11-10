import { NativeParseError } from "../errors";
import type { NativeAttributedEdge, NativeAttributedGraph, NativeRow } from "./native";
import { fieldLines, numberReader } from "./number-lines";

const FORMAT = "canad-dow";

/** The name line the Mulgen generator writes before the counts, which every CommaLAB `.dow` file starts with; it holds no data. */
const GENERATOR_LINE = /^MULTIGEN\.DAT:$/;

const read = numberReader(FORMAT);

/** The fields of the counts line. */
const COUNT_FIELDS = ["nodes", "arcs", "commodities"] as const;
/** The fields of an arc line: from, to, variable cost, capacity, fixed cost, and two numbers the format leaves unused. */
const ARC_FIELDS = ["from", "to", "cost", "capacity", "fixedCost", "unused", "unusedToo"] as const;
/** The fields of a commodity line. */
const COMMODITY_FIELDS = ["origin", "destination", "demand"] as const;

/**
 * Reads a node number, which the format numbers from 1 to n.
 * @param field - The field.
 * @param line - Its 1-based line, for the error.
 * @param count - The declared node count.
 * @returns The node id as text.
 * @throws NativeParseError when the field is not a node number from 1 to n.
 */
function node(field: string, line: number, count: number): string {
  const value = read.integer(field, line, "a node number");
  if (value < 1 || value > count) {
    throw new NativeParseError(FORMAT, line, `expected a node from 1 to ${String(count)}, found ${field}`);
  }

  return String(value);
}

/**
 * Parses a multicommodity capacitated fixed-charge network design instance in the `.dow` format of Gendron's C, C+ and R sets (https://commalab.di.unipi.it/datasets/mmcf/): an optional generator name line `MULTIGEN.DAT:`, then the node, arc and commodity counts, one line per arc (from node, to node, variable cost per unit of flow, capacity, fixed cost of opening the arc, and two further numbers the format leaves unused, which are not carried), and one line per commodity (origin, destination, demand). Nodes are numbered from 1. This is not the "Canad" format of the Bipart and Mulgen generators' `Format` file, which gives each arc a cost and capacity per commodity.
 *
 * The result is a graph/v1 native graph: the network nodes `1` to `n` of type `node`, then each commodity `h` as a node `commodity-<h>` of type `commodity` carrying its `demand`; the arcs as directed edges of type `arc` from their from node to their to node, carrying `cost` (the variable cost), `capacity` and `fixedCost`, in file order; then for each commodity an edge of type `origin` from the commodity's node to its origin and one of type `destination` to its destination. Every node carries `demand` (null on a network node) and every edge carries `cost`, `capacity` and `fixedCost` (null on a commodity's edges). The counts are what the file holds, so `meta` is empty.
 * @param text - The file text.
 * @returns The native graph.
 * @throws NativeParseError naming the line for counts that are not three whole numbers of at least one, an arc line that is not seven whole numbers, a commodity line that is not three, a node outside 1 to n, a demand below one, or a file that does not hold exactly the arc and commodity lines its counts give.
 */
export function parseCanadDow(text: string): NativeAttributedGraph {
  const all = fieldLines(text);
  const [first] = all;
  const start = first?.fields.length === 1 && first.fields.every((field) => GENERATOR_LINE.test(field)) ? 1 : 0;
  const header = all[start];
  if (header === undefined) {
    throw new NativeParseError(FORMAT, 1, "expected the node, arc and commodity counts");
  }
  const counts = read.fields(header, COUNT_FIELDS, "the node, arc and commodity counts");
  const nodeCount = read.count(counts("nodes"), header.line, "the node count", 1);
  const arcCount = read.count(counts("arcs"), header.line, "the arc count", 1);
  const commodityCount = read.count(counts("commodities"), header.line, "the commodity count", 1);
  const arcLines = all.slice(start + 1, start + 1 + arcCount);
  const commodityLines = all.slice(start + 1 + arcCount);
  const last = all.at(-1)?.line ?? header.line;
  if (arcLines.length < arcCount) {
    throw new NativeParseError(FORMAT, last, `expected ${String(arcCount)} arc lines, found ${String(arcLines.length)}`);
  }
  if (commodityLines.length !== commodityCount) {
    throw new NativeParseError(FORMAT, last, `expected ${String(commodityCount)} commodity lines, found ${String(commodityLines.length)}`);
  }
  const nodes: NativeRow[] = Array.from({ length: nodeCount }, (_, index) => ({ id: String(index + 1), type: "node", demand: null }));
  const edges: NativeAttributedEdge[] = arcLines.map((arc) => {
    const field = read.fields(arc, ARC_FIELDS, "an arc: from, to, variable cost, capacity, fixed cost and two unused numbers");

    return {
      source: node(field("from"), arc.line, nodeCount),
      target: node(field("to"), arc.line, nodeCount),
      type: "arc",
      cost: read.integer(field("cost"), arc.line, "the variable cost"),
      capacity: read.integer(field("capacity"), arc.line, "the capacity"),
      fixedCost: read.integer(field("fixedCost"), arc.line, "the fixed cost"),
    };
  });
  for (const [index, commodity] of commodityLines.entries()) {
    const field = read.fields(commodity, COMMODITY_FIELDS, "a commodity: origin, destination and demand");
    const id = `commodity-${String(index + 1)}`;
    nodes.push({ id, type: "commodity", demand: read.count(field("demand"), commodity.line, "the demand", 1) });
    edges.push(
      { source: id, target: node(field("origin"), commodity.line, nodeCount), type: "origin", cost: null, capacity: null, fixedCost: null },
      { source: id, target: node(field("destination"), commodity.line, nodeCount), type: "destination", cost: null, capacity: null, fixedCost: null },
    );
  }

  return { meta: {}, nodes, edges };
}
