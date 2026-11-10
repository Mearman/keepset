/** A node as every parser emits it: an id and nothing else, so one crosswalk serves every parser. */
export interface NativeNode {
  readonly id: string;
}

/** An edge as every parser emits it: source and target node ids, in the file's own direction. */
export interface NativeEdge {
  readonly source: string;
  readonly target: string;
}

/** A node of a bipartite graph whose two sets are told apart by a type, as the ratings parser emits it. */
export interface NativeTypedNode extends NativeNode {
  readonly type: string;
}

/** An edge that is one rating: the user it runs from, the item it runs to, its weight (the rating over the scale's maximum) and when it was given, in the source's own unit. */
export interface NativeRating extends NativeEdge {
  readonly type: string;
  readonly weight: number;
  readonly timestamp: number;
}

/** An edge of a typed relation, as the triples and HGB parsers emit it: its type is the relation's name as the source writes it. */
export interface NativeTypedEdge extends NativeEdge {
  readonly type: string;
}

/** A typed edge that also says which split of the source it came from (`train`, `valid`, `test`), as the triples parser emits it for a download of several split files. */
export interface NativeSplitEdge extends NativeTypedEdge {
  readonly split: string;
}

/** A typed edge whose weight is a count, such as how many times a user listened to an artist. */
export interface NativeCountEdge extends NativeTypedEdge {
  readonly weight: number;
}

/** The native shape every parser in this version emits: the graph's topology, nodes in a deterministic order (each parser documents which) and edges in file order. */
export interface NativeGraph {
  readonly nodes: readonly NativeNode[];
  readonly edges: readonly NativeEdge[];
}

/** A row of a table as the table parser emits it: an id and every column of the file, each a string, a number where the recipe declares the column numeric, or null for an empty cell. Every row carries every column, because a crossmap rule fails on a path absent from any element. */
export interface NativeRow {
  readonly id: string;
  readonly [column: string]: string | number | null;
}

/** The native shape the table parsers emit: a table's rows as nodes, in file order. */
export interface NativeTable {
  readonly nodes: readonly NativeRow[];
}

/** The native shape the instance file parsers emit: the instance's nodes, and a `meta` of its own header values (its name, a vehicle count) that the fetch flow merges beneath the entry's own metadata. */
export interface NativeInstance {
  readonly meta: Readonly<Record<string, string | number | boolean | null>>;
  readonly nodes: readonly NativeRow[];
}

/** An edge that carries fields of its own beside its ends, as an instance file of a network gives them (a cost, a capacity). Every edge of a graph carries every field, null where the edge has no value, because a crossmap rule fails on a path absent from any element. */
export type NativeAttributedEdge = NativeEdge & Readonly<Record<string, string | number | null>>;

/** The native shape the network instance parsers emit: nodes and edges that carry the fields the file gives them, every element of a kind carrying the same fields, and a `meta` of the instance's own header values that the fetch flow merges beneath the entry's own metadata, as it does an instance file's. */
export interface NativeAttributedGraph {
  readonly meta: Readonly<Record<string, string | number | boolean | null>>;
  readonly nodes: readonly NativeRow[];
  readonly edges: readonly NativeAttributedEdge[];
}

/** What a parser emits: the native shape of its category family, to which the fetch flow adds `meta`. */
export type NativeDocument = NativeGraph | NativeTable | NativeInstance | NativeAttributedGraph;

/**
 * Collects node ids in order of first appearance, so a parser that learns its nodes from its edges emits them deterministically.
 */
export class NodeOrder {
  /** Each id, keyed by itself, so that `intern` can hand back the one string held for it. */
  readonly #ids = new Map<string, string>();

  /**
   * Records an id; a repeat keeps its first position.
   * @param id - The node id.
   */
  add(id: string): void {
    this.intern(id);
  }

  /**
   * Records an id and returns the string held for it, so that every edge naming a node shares one string instead of each holding a copy cut from its own line.
   * @param id - The node id.
   * @returns The first string recorded with this value.
   */
  intern(id: string): string {
    const held = this.#ids.get(id);
    if (held !== undefined) {
      return held;
    }
    this.#ids.set(id, id);

    return id;
  }

  /** @returns Whether the id has been recorded. */
  has(id: string): boolean {
    return this.#ids.has(id);
  }

  /** @returns The nodes, in first-appearance order. */
  nodes(): NativeNode[] {
    return [...this.#ids.keys()].map((id) => ({ id }));
  }
}

/**
 * Collects the nodes of a bipartite graph whose two sets a source numbers independently, giving each set's ids its own prefix (`u:1` and `m:1` are a user and a movie) and type. Nodes are kept in order of first appearance across both sets, and each distinct id is held once however many edges name it.
 */
export class BipartiteNodes {
  readonly #nodes: NativeTypedNode[] = [];

  /**
   * Opens one of the graph's node sets.
   * @param prefix - The prefix its node ids take.
   * @param type - Its nodes' type.
   * @returns A function from an id as the source writes it to the node id, adding the node the first time the id appears in this set.
   */
  set(prefix: string, type: string): (raw: string) => string {
    const known = new Map<string, string>();

    return (raw) => {
      let id = known.get(raw);
      if (id === undefined) {
        id = `${prefix}${raw}`;
        known.set(raw, id);
        this.#nodes.push({ id, type });
      }

      return id;
    };
  }

  /** @returns The nodes, in first-appearance order. */
  nodes(): NativeTypedNode[] {
    return this.#nodes;
  }
}

/**
 * Splits text into lines, accepting both LF and CRLF endings.
 * @param text - The file text.
 * @returns The lines, without their terminators.
 */
export function lines(text: string): string[] {
  return text.split(/\r?\n/);
}

const CARRIAGE_RETURN = 0x0d;

/**
 * Visits the lines of a file read in pieces, accepting both LF and CRLF endings, holding only the unfinished end of a piece between pieces so a file larger than one string can be read.
 * @param pieces - The file's text, in order, split anywhere (even between a carriage return and its line feed).
 * @param visit - Called with each line, without its terminator, and its 1-based number. A final line without a terminator is visited; the empty text after a final terminator is not a line.
 */
export function forEachLine(pieces: Readonly<Iterable<string>>, visit: (line: string, number: number) => void): void {
  let carry = "";
  let number = 0;
  const emit = (text: string, start: number, end: number): void => {
    number += 1;
    visit(end > start && text.charCodeAt(end - 1) === CARRIAGE_RETURN ? text.slice(start, end - 1) : text.slice(start, end), number);
  };
  for (const piece of pieces) {
    const text = carry + piece;
    let start = 0;
    for (let end = text.indexOf("\n", start); end !== -1; end = text.indexOf("\n", start)) {
      emit(text, start, end);
      start = end + 1;
    }
    carry = text.slice(start);
  }
  if (carry !== "") {
    emit(carry, 0, carry.length);
  }
}
