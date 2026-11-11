import { NativeParseError } from "../errors";
import type { NativeEdge, NativeGraph, NativeNode } from "./native";
import { fieldLines, numberReader } from "./number-lines";

const FORMAT = "dimacs-graph";

const read = numberReader(FORMAT);

/** How a file writes its edges: the DIMACS challenge graph format, `e U V` under a problem line `p edge N M` (the clique and colouring benchmarks), or the PACE challenge format, a bare `U V` under a problem line `p <problem> N M` naming the challenge's problem (`ds`, `td`, `vc`). */
export type DimacsGraphLayout = "dimacs" | "pace";

/**
 * Parses an undirected graph in the DIMACS challenge graph format or the PACE challenge format that derives from it: `c` comment lines anywhere, one problem line `p PROBLEM N M` before any edge (`p edge N M` in the DIMACS layout), then exactly M edge lines, `e U V` in the DIMACS layout or `U V` in the PACE layout. Nodes are `1` to `N`, so a vertex no edge touches is kept, which a maximum independent set or a minimum dominating set depends on; edges are emitted in file order, each once in the direction it is written.
 * @param text - The file text.
 * @param layout - Which of the two edge line forms the file uses.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a missing, repeated or misplaced problem line, a DIMACS problem other than `edge`, a line of another form, a node outside 1 to N, a self-loop, an edge given twice (in either direction), or an edge count that differs from the problem line's.
 */
export function parseDimacsGraph(text: string, layout: DimacsGraphLayout): NativeGraph {
  let problem: { readonly nodes: number; readonly edges: number } | undefined;
  const edges: NativeEdge[] = [];
  const seen = new Set<string>();
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
      const field = read.fields(line, ["designator", "problem", "nodes", "edges"], "the problem line p PROBLEM N M");
      if (layout === "dimacs" && field("problem") !== "edge") {
        throw new NativeParseError(FORMAT, line.line, `expected the problem line p edge N M, found ${JSON.stringify(line.fields.join(" "))}`);
      }
      problem = { nodes: read.count(field("nodes"), line.line, "the node count", 0), edges: read.count(field("edges"), line.line, "the edge count", 0) };
      continue;
    }
    const ends = layout === "dimacs" ? (designator === "e" ? line.fields.slice(1) : undefined) : line.fields;
    if (ends?.length !== 2) {
      throw new NativeParseError(FORMAT, line.line, `expected ${layout === "dimacs" ? "an edge line e U V" : "an edge line U V"} or a line starting c or p, found ${JSON.stringify(line.fields.join(" "))}`);
    }
    if (problem === undefined) {
      throw new NativeParseError(FORMAT, line.line, "an edge line before the problem line");
    }
    const count = problem.nodes;
    const node = (field: string): number => {
      const value = read.integer(field, line.line, "a node number");
      if (value < 1 || value > count) {
        throw new NativeParseError(FORMAT, line.line, `expected a node from 1 to ${String(count)}, found ${field}`);
      }

      return value;
    };
    const [first, second] = ends;
    const u = node(first ?? "");
    const v = node(second ?? "");
    if (u === v) {
      throw new NativeParseError(FORMAT, line.line, `an edge from node ${String(u)} to itself`);
    }
    const key = u < v ? `${String(u)} ${String(v)}` : `${String(v)} ${String(u)}`;
    if (seen.has(key)) {
      throw new NativeParseError(FORMAT, line.line, `the edge between nodes ${String(u)} and ${String(v)} is given twice`);
    }
    seen.add(key);
    edges.push({ source: String(u), target: String(v) });
  }
  if (problem === undefined) {
    throw new NativeParseError(FORMAT, last, "the file has no problem line");
  }
  if (edges.length !== problem.edges) {
    throw new NativeParseError(FORMAT, last, `expected ${String(problem.edges)} edges, found ${String(edges.length)}`);
  }
  const nodes: NativeNode[] = Array.from({ length: problem.nodes }, (_, index) => ({ id: String(index + 1) }));

  return { nodes, edges };
}
