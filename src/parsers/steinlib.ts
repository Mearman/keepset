import { NativeParseError } from "../errors";
import type { NativeAttributedEdge, NativeAttributedGraph, NativeRow } from "./native";
import { lines } from "./native";
import { numberReader } from "./number-lines";

const FORMAT = "steinlib";

const read = numberReader(FORMAT);

/** The magic number that opens every SteinLib file, which the files write in either case. */
const MAGIC = "33d32945";
/** A section header, `SECTION <name>`, which the files write in upper or title case. */
const SECTION = /^section\s+(\S+)$/i;
/** The keys of a Comment section, each one string; the files quote it or not. */
const COMMENT_KEYS: ReadonlyMap<string, string> = new Map([
  ["name", "name"],
  ["date", "date"],
  ["creator", "creator"],
  ["remark", "remark"],
  ["problem", "problem"],
]);
/** The scalar keys of a Presolve section and the meta field and kind each is read as: the value to add to the optimum of the reduced instance to get the original's, the bounds, the processing time in seconds and the original instance's counts. */
const PRESOLVE_KEYS: ReadonlyMap<string, { readonly field: string; readonly integer: boolean }> = new Map([
  ["fixed", { field: "fixed", integer: false }],
  ["lower", { field: "lower", integer: false }],
  ["upper", { field: "upper", integer: false }],
  ["time", { field: "presolveTime", integer: false }],
  ["orgnodes", { field: "orgNodes", integer: true }],
  ["orgedges", { field: "orgEdges", integer: true }],
  ["orgterminals", { field: "orgTerminals", integer: true }],
]);
/** The Presolve section's lines that describe how the original instance maps onto the reduced one (aggregated, chosen, deleted and upper-bound edges), which are not read. */
const PRESOLVE_EDGE_LINES: ReadonlySet<string> = new Set(["ea", "ec", "ed", "es"]);

/** The fields of an edge line, `E U V WEIGHT`. */
const EDGE_FIELDS = ["E", "U", "V", "WEIGHT"] as const;

/** Which section a line is in, and for a Terminals section whether it is the instance's own or the original instance's after a Presolve section. */
type Section = "comment" | "graph" | "terminals" | "original-terminals" | "presolve" | "coordinates";

/**
 * Parses a Steiner tree problem in graphs in the SteinLib STP format (https://steinlib.zib.de/format.php): the magic number line `33D32945 STP File, STP Format Version 1.0`, then sections from `SECTION <name>` to `END` (either in upper or title case), then `EOF`; `#` starts a comment on a line holding no quoted string. The Comment sections give `meta` their `Name`, `Date`, `Creator`, `Remark` and `Problem` as text, unquoted. The Graph section's `Nodes` and `Edges` counts and `E U V WEIGHT` lines give the nodes `1` to `n` and one undirected edge per line with its `weight`, in file order. The first Terminals section's `Terminals` count and `T V` lines make those nodes of type `terminal` and the rest of type `node`. A Presolve section, which says the instance is the reduced form of an original one, gives `meta` its `fixed` value (added to the reduced optimum to give the original's), `lower` and `upper` bounds, `presolveTime` and the original's `orgNodes`, `orgEdges` and `orgTerminals`; its EA, EC, ED and ES lines, which map the reduced instance back onto the original, are not read, nor is the Terminals section after it, which lists the original's terminals. Coordinates sections are not read, as graph/v1 carries no positions.
 * @param text - The file text.
 * @returns The native graph.
 * @throws NativeParseError naming the line for a file without the magic number, a line outside a section, an unknown section or key, a directed (`Arcs`), obstacle, root, prize or degree-constrained instance, a line of the wrong shape, a key given twice, a node outside 1 to n, a terminal given twice, a count that disagrees with its lines, a missing Graph section or text after `EOF`.
 */
export function parseSteinlib(text: string): NativeAttributedGraph {
  const all = lines(text);
  const meta: Record<string, string | number> = {};
  const edges: NativeAttributedEdge[] = [];
  const terminals = new Set<number>();
  const counts: { nodes?: number; edges?: number; terminals?: number } = {};
  let section: Section | undefined;
  let started = false;
  let ended = false;
  let presolved = false;
  let graphRead = false;
  let terminalsRead = false;
  let last = 1;
  const node = (field: string, line: number): number => {
    if (counts.nodes === undefined) {
      throw new NativeParseError(FORMAT, line, "a node before the Nodes count");
    }
    const value = read.integer(field, line, "a node number");
    if (value < 1 || value > counts.nodes) {
      throw new NativeParseError(FORMAT, line, `expected a node from 1 to ${String(counts.nodes)}, found ${field}`);
    }

    return value;
  };
  for (const [index, raw] of all.entries()) {
    const line = index + 1;
    const stripped = raw.includes('"') ? raw : raw.replace(/#.*$/, "");
    const content = stripped.trim();
    if (content === "") {
      continue;
    }
    last = line;
    if (!started) {
      if (!content.toLowerCase().startsWith(MAGIC)) {
        throw new NativeParseError(FORMAT, line, `expected the magic number line 33D32945 STP File, found ${JSON.stringify(content)}`);
      }
      started = true;
      continue;
    }
    if (ended) {
      throw new NativeParseError(FORMAT, line, `a line after EOF: ${JSON.stringify(content)}`);
    }
    const fields = content.split(/\s+/);
    const keyword = (fields[0] ?? "").toLowerCase();
    if (section === undefined) {
      if (keyword === "eof") {
        ended = true;
        continue;
      }
      const header = SECTION.exec(content);
      const name = header?.[1]?.toLowerCase();
      if (name === "comment" || name === "coordinates") {
        section = name;
      } else if (name === "graph") {
        if (graphRead) {
          throw new NativeParseError(FORMAT, line, "a second Graph section");
        }
        section = "graph";
      } else if (name === "terminals") {
        if (presolved) {
          section = "original-terminals";
        } else if (terminalsRead) {
          throw new NativeParseError(FORMAT, line, "a second Terminals section before any Presolve section");
        } else {
          section = "terminals";
        }
      } else if (name === "presolve") {
        if (presolved) {
          throw new NativeParseError(FORMAT, line, "a second Presolve section");
        }
        section = "presolve";
      } else {
        throw new NativeParseError(FORMAT, line, header === null ? `expected SECTION <name> or EOF, found ${JSON.stringify(content)}` : `the section ${JSON.stringify(header[1] ?? "")} is not one the parser reads (Comment, Graph, Terminals, Presolve or Coordinates)`);
      }
      continue;
    }
    if (keyword === "end" && fields.length === 1) {
      if (section === "graph") {
        if (counts.nodes === undefined || counts.edges === undefined) {
          throw new NativeParseError(FORMAT, line, "the Graph section has no Nodes or Edges count");
        }
        if (edges.length !== counts.edges) {
          throw new NativeParseError(FORMAT, line, `expected ${String(counts.edges)} edges, found ${String(edges.length)}`);
        }
        graphRead = true;
      }
      if (section === "terminals") {
        if (counts.terminals === undefined) {
          throw new NativeParseError(FORMAT, line, "the Terminals section has no Terminals count");
        }
        if (terminals.size !== counts.terminals) {
          throw new NativeParseError(FORMAT, line, `expected ${String(counts.terminals)} terminals, found ${String(terminals.size)}`);
        }
        terminalsRead = true;
      }
      if (section === "presolve") {
        presolved = true;
      }
      section = undefined;
      continue;
    }
    if (section === "coordinates" || section === "original-terminals") {
      continue;
    }
    if (section === "comment") {
      const field = COMMENT_KEYS.get(keyword);
      if (field === undefined) {
        throw new NativeParseError(FORMAT, line, `expected a Comment key (Name, Date, Creator, Remark or Problem), found ${JSON.stringify(fields[0] ?? "")}`);
      }
      if (field in meta) {
        throw new NativeParseError(FORMAT, line, `the Comment key ${fields[0] ?? ""} is given twice`);
      }
      const value = content.slice((fields[0] ?? "").length).trim();
      meta[field] = value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
      continue;
    }
    if (section === "presolve") {
      if (PRESOLVE_EDGE_LINES.has(keyword)) {
        continue;
      }
      const key = PRESOLVE_KEYS.get(keyword);
      if (key === undefined || fields.length !== 2) {
        throw new NativeParseError(FORMAT, line, `expected a Presolve line (Fixed, Lower, Upper, Time, OrgNodes, OrgEdges, OrgTerminals, EA, EC, ED or ES), found ${JSON.stringify(content)}`);
      }
      if (key.field in meta) {
        throw new NativeParseError(FORMAT, line, `the Presolve key ${fields[0] ?? ""} is given twice`);
      }
      const value = fields[1] ?? "";
      meta[key.field] = key.integer ? read.count(value, line, fields[0] ?? "", 0) : read.decimal(value, line, fields[0] ?? "");
      continue;
    }
    if (section === "graph") {
      if (keyword === "nodes" || keyword === "edges") {
        if (fields.length !== 2) {
          throw new NativeParseError(FORMAT, line, `expected ${fields[0] ?? ""} N, found ${JSON.stringify(content)}`);
        }
        if (counts[keyword] !== undefined) {
          throw new NativeParseError(FORMAT, line, `the ${fields[0] ?? ""} count is given twice`);
        }
        counts[keyword] = read.count(fields[1] ?? "", line, `the ${keyword} count`, keyword === "nodes" ? 1 : 0);
        continue;
      }
      if (keyword === "e") {
        if (fields.length !== EDGE_FIELDS.length) {
          throw new NativeParseError(FORMAT, line, `expected an edge E U V WEIGHT, found ${JSON.stringify(content)}`);
        }
        edges.push({ source: String(node(fields[1] ?? "", line)), target: String(node(fields[2] ?? "", line)), weight: read.decimal(fields[3] ?? "", line, "the edge weight") });
        continue;
      }
      throw new NativeParseError(FORMAT, line, `expected Nodes, Edges or an edge E U V WEIGHT in the Graph section (directed and obstacle-avoiding instances are not read), found ${JSON.stringify(content)}`);
    }
    if (keyword === "terminals") {
      if (fields.length !== 2 || counts.terminals !== undefined) {
        throw new NativeParseError(FORMAT, line, `expected one Terminals N line, found ${JSON.stringify(content)}`);
      }
      counts.terminals = read.count(fields[1] ?? "", line, "the terminal count", 1);
      continue;
    }
    if (keyword !== "t" || fields.length !== 2) {
      throw new NativeParseError(FORMAT, line, `expected Terminals N or a terminal T V in the Terminals section (rooted and prize-collecting instances are not read), found ${JSON.stringify(content)}`);
    }
    const terminal = node(fields[1] ?? "", line);
    if (terminals.has(terminal)) {
      throw new NativeParseError(FORMAT, line, `node ${String(terminal)} is a terminal twice`);
    }
    terminals.add(terminal);
  }
  if (!graphRead || counts.nodes === undefined) {
    throw new NativeParseError(FORMAT, last, "the file has no complete Graph section");
  }
  if (section !== undefined) {
    throw new NativeParseError(FORMAT, last, "the file ends inside a section");
  }
  if (!ended) {
    throw new NativeParseError(FORMAT, last, "the file has no EOF line");
  }
  const nodes: NativeRow[] = Array.from({ length: counts.nodes }, (_, index) => ({ id: String(index + 1), type: terminals.has(index + 1) ? "terminal" : "node" }));

  return { meta, nodes, edges };
}
