import { NativeParseError } from "../errors";
import type { NativeAttributedEdge, NativeAttributedGraph, NativeRow } from "./native";
import { fieldLines, numberReader } from "./number-lines";

const FORMAT = "orlib-pmed";

const read = numberReader(FORMAT);

/** The fields of the first line. */
const HEADER_FIELDS = ["vertices", "edges", "p"] as const;
/** The fields of an edge line: its two end vertices and its cost. */
const EDGE_FIELDS = ["source", "target", "cost"] as const;

/**
 * Reads a vertex number, which the format numbers from 1 to n.
 * @param field - The field.
 * @param line - Its 1-based line, for the error.
 * @param count - The vertex count.
 * @returns The vertex id as text.
 * @throws NativeParseError when the field is not a vertex number from 1 to n.
 */
function vertex(field: string, line: number, count: number): string {
  const value = read.integer(field, line, "a vertex number");
  if (value < 1 || value > count) {
    throw new NativeParseError(FORMAT, line, `expected a vertex from 1 to ${String(count)}, found ${field}`);
  }

  return String(value);
}

/**
 * Parses an OR-Library uncapacitated p-median file (J. E. Beasley, https://people.brunel.ac.uk/~mastjjb/jeb/orlib/pmedinfo.html): the vertex count n, the edge count and p on the first line, then one line per edge with its two end vertices and its cost. The page defines a pair listed more than once as taking the cost of its last line (each line sets the cost of both directions in turn), and the files do list pairs more than once with different costs, so the graph has one edge per vertex pair, in the direction and at the position of the pair's first line, with the cost of its last; the edge count of the first line counts lines, and so can exceed the edges. Nodes are the vertices `1` to `n`, isolated ones included. The graph is undirected, and the allocation costs a p-median solver uses are its shortest-path distances, which the consumer computes, as the page says.
 * @param text - The file text.
 * @returns The native graph, with `p` in `meta`.
 * @throws NativeParseError naming the line for a first line that is not three whole numbers, a p of more than n vertices, an edge line that is not three whole numbers, a vertex outside 1 to n, or a file that does not hold exactly the edge lines its first line counts.
 */
export function parseOrlibPmed(text: string): NativeAttributedGraph {
  const [header, ...rest] = fieldLines(text);
  if (header === undefined) {
    throw new NativeParseError(FORMAT, 1, "expected the vertex count, edge count and p");
  }
  const counts = read.fields(header, HEADER_FIELDS, "the vertex count, edge count and p");
  const vertexCount = read.count(counts("vertices"), header.line, "the vertex count", 1);
  const lineCount = read.count(counts("edges"), header.line, "the edge count", 0);
  const p = read.count(counts("p"), header.line, "p", 1);
  if (p > vertexCount) {
    throw new NativeParseError(FORMAT, header.line, `p is ${String(p)}, more than the ${String(vertexCount)} vertices`);
  }
  if (rest.length !== lineCount) {
    throw new NativeParseError(FORMAT, rest.at(-1)?.line ?? header.line, `expected ${String(lineCount)} edge lines, found ${String(rest.length)}`);
  }
  // Keyed by the pair's two vertices in ascending order, so a pair is one edge whichever way round a line lists it.
  const byPair = new Map<string, { source: string; target: string; cost: number }>();
  for (const edge of rest) {
    const field = read.fields(edge, EDGE_FIELDS, "an edge: two end vertices and the cost");
    const source = vertex(field("source"), edge.line, vertexCount);
    const target = vertex(field("target"), edge.line, vertexCount);
    const cost = read.integer(field("cost"), edge.line, "the edge cost");
    const key = Number(source) < Number(target) ? `${source} ${target}` : `${target} ${source}`;
    const known = byPair.get(key);
    if (known === undefined) {
      byPair.set(key, { source, target, cost });
    } else {
      known.cost = cost;
    }
  }
  const nodes: NativeRow[] = Array.from({ length: vertexCount }, (_, index) => ({ id: String(index + 1) }));
  const edges: NativeAttributedEdge[] = [...byPair.values()];

  return { meta: { p }, nodes, edges };
}
