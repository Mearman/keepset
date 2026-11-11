import { NativeParseError } from "../errors";
import type { NativeAttributedEdge, NativeAttributedGraph, NativeRow } from "./native";
import { lines } from "./native";
import { SCIENTIFIC } from "./number-lines";

/** What every error from the network file names as its format. */
const NETWORK = "tntp network";
/** What every error from the trip table names as its format. */
const TRIPS = "tntp trips";

/** A metadata line, `<KEY> value`, the value possibly empty. */
const METADATA = /^<([^<>]+)>\s*(.*)$/;
/** The key that ends a file's metadata. */
const END_OF_METADATA = "END OF METADATA";
/** A whole number of at least one, as a node or zone number is written. */
const POSITIVE_INTEGER = /^\d+$/;
/** A column name of the harmonised header line, which the files write in lower snake case (`free_flow_time`). */
const COLUMN_NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
/** The first two columns of the harmonised header line, the link's ends, which every network file's links begin with. */
const ENDS = ["init_node", "term_node"] as const;
/** The field names a link's column must not take, since the edge already carries them. */
const RESERVED = new Set(["source", "target", "type"]);
/** An origin line of a trip table, `Origin N`. */
const ORIGIN = /^Origin\s+(\S+)$/;
/** One entry of a trip table's destination list, `D : FLOW`. */
const DESTINATION = /^(\S+)\s*:\s*(\S+)$/;

/** The network file's metadata that the parser reads as numbers. */
const NETWORK_COUNTS = { zones: "NUMBER OF ZONES", nodes: "NUMBER OF NODES", firstThruNode: "FIRST THRU NODE", links: "NUMBER OF LINKS" } as const;
/** The network file's metadata key that restates the source's own column header, carried as text. */
const ORIGINAL_HEADER = "ORIGINAL HEADER";
/** The trip table's zone count, which must be the network's. */
const TRIP_ZONES = "NUMBER OF ZONES";
/** The trip table's total flow, carried as a number. */
const TOTAL_OD_FLOW = "TOTAL OD FLOW";

/** The two files of one TNTP dataset, each decoded to text. */
export interface TntpFiles {
  readonly network: string;
  readonly trips: string;
}

/**
 * Turns a TNTP name (a metadata key in upper case words, or a column in lower snake case) into the camel case the catalogue's fields use: `FIRST THRU NODE` is `firstThruNode`, `free_flow_time` is `freeFlowTime`.
 * @param name - The name as the file writes it.
 * @returns The field name.
 */
function camel(name: string): string {
  const [first = "", ...rest] = name.toLowerCase().split(/[\s_]+/);

  return first + rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");
}

/** Reads the fields of one of the two files, naming the file and the line in every error. */
interface FieldReader {
  /**
   * Reads a field as a decimal number.
   * @param field - The field as written.
   * @param line - Its 1-based line.
   * @param what - What the field should be.
   * @returns The number.
   * @throws NativeParseError when the field is not a decimal number.
   */
  readonly decimal: (field: string, line: number, what: string) => number;
  /**
   * Reads a field as a number from 1 to `count`, a node or a zone.
   * @param field - The field as written.
   * @param line - Its 1-based line.
   * @param what - What the field numbers.
   * @param count - The largest number allowed.
   * @returns The number.
   * @throws NativeParseError when the field is not a whole number from 1 to `count`.
   */
  readonly numbered: (field: string, line: number, what: string, count: number) => number;
}

/**
 * Makes the field reader of one file.
 * @param format - The file's format, which every error names.
 * @returns The reader.
 */
function fieldReader(format: string): FieldReader {
  return {
    decimal(field, line, what) {
      if (!SCIENTIFIC.test(field)) {
        throw new NativeParseError(format, line, `expected ${what} as a number, found ${JSON.stringify(field)}`);
      }

      return Number(field);
    },
    numbered(field, line, what, count) {
      const value = Number(field);
      if (!POSITIVE_INTEGER.test(field) || value < 1 || value > count) {
        throw new NativeParseError(format, line, `expected a ${what} from 1 to ${String(count)}, found ${JSON.stringify(field)}`);
      }

      return value;
    },
  };
}

const networkField = fieldReader(NETWORK);
const tripsField = fieldReader(TRIPS);

/** A file's metadata and the 0-based index of the first line after it. */
interface Metadata {
  readonly values: ReadonlyMap<string, { readonly value: string; readonly line: number }>;
  readonly next: number;
}

/**
 * Reads the metadata lines that open a TNTP file, up to and including `<END OF METADATA>`.
 * @param format - The file's format, for errors.
 * @param all - The file's lines.
 * @returns The values by key and where the body starts.
 * @throws NativeParseError for a line before the end of the metadata that is not a metadata line, a key given twice, or a file with no end of metadata.
 */
function readMetadata(format: string, all: readonly string[]): Metadata {
  const values = new Map<string, { readonly value: string; readonly line: number }>();
  for (const [index, raw] of all.entries()) {
    const text = raw.trim();
    if (text === "") {
      continue;
    }
    const match = METADATA.exec(text);
    if (match === null) {
      throw new NativeParseError(format, index + 1, `expected a metadata line <KEY> value before <${END_OF_METADATA}>, found ${JSON.stringify(text)}`);
    }
    const [, key = "", value = ""] = match;
    if (key === END_OF_METADATA) {
      return { values, next: index + 1 };
    }
    if (values.has(key)) {
      throw new NativeParseError(format, index + 1, `the metadata key <${key}> is given twice`);
    }
    values.set(key, { value: value.trim(), line: index + 1 });
  }
  throw new NativeParseError(format, Math.max(all.length, 1), `the file has no <${END_OF_METADATA}> line`);
}

/**
 * Reads a metadata value as a whole number of at least `least`.
 * @param format - The file's format, for the error.
 * @param metadata - The file's metadata.
 * @param key - The key.
 * @param least - The smallest value it may take.
 * @returns The number.
 * @throws NativeParseError when the key is missing or its value is not such a number.
 */
function metadataCount(format: string, metadata: Metadata, key: string, least: number): number {
  const entry = metadata.values.get(key);
  if (entry === undefined) {
    throw new NativeParseError(format, metadata.next, `the metadata has no <${key}>`);
  }
  const value = Number(entry.value);
  if (!/^\d+$/.test(entry.value) || value < least) {
    throw new NativeParseError(format, entry.line, `expected <${key}> as a whole number of at least ${String(least)}, found ${JSON.stringify(entry.value)}`);
  }

  return value;
}

/**
 * Gives the metadata a parser does not read itself as text, each under its key in camel case, so no value the file states is dropped.
 * @param format - The file's format, for the error.
 * @param metadata - The file's metadata.
 * @param read - The keys the parser has read itself.
 * @param taken - The field names the instance's meta already has.
 * @returns The text fields.
 * @throws NativeParseError when a key's field name is one the meta already has.
 */
function textMetadata(format: string, metadata: Metadata, read: ReadonlySet<string>, taken: ReadonlySet<string>): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const [key, { value, line }] of metadata.values) {
    if (read.has(key)) {
      continue;
    }
    const name = camel(key);
    if (taken.has(name) || name in fields) {
      throw new NativeParseError(format, line, `the metadata key <${key}> gives the field ${name}, which the dataset already has`);
    }
    fields[name] = value;
  }

  return fields;
}

/**
 * Reads the harmonised column header line's names after `~`, checking that each further column can name a link field.
 * @param names - The names the line gives, the link's ends first.
 * @param line - Its 1-based line.
 * @returns The link field each further column is read into, in camel case.
 * @throws NativeParseError when a column is not a lower snake case name, takes a name the edge already carries, or is named twice.
 */
function linkFields(names: readonly string[], line: number): string[] {
  const columns = names.slice(ENDS.length);
  for (const name of columns) {
    if (!COLUMN_NAME.test(name) || RESERVED.has(camel(name))) {
      throw new NativeParseError(NETWORK, line, `the column header names a column ${JSON.stringify(name)} that is not a lower snake case name a link field can take`);
    }
  }
  const fields = columns.map(camel);
  if (new Set(fields).size !== fields.length) {
    throw new NativeParseError(NETWORK, line, "the column header names a column twice");
  }

  return fields;
}

/** The network a TNTP network file describes: its counts and the fields of its links. */
interface Network {
  readonly zones: number;
  readonly nodes: number;
  readonly columns: readonly string[];
  readonly edges: NativeAttributedEdge[];
  readonly meta: Record<string, string | number>;
}

/**
 * Reads a TNTP network file (`<network>_net.tntp`).
 * @param text - The file's text.
 * @returns The network.
 * @throws NativeParseError as `parseTntp` documents.
 */
function readNetwork(text: string): Network {
  const all = lines(text);
  const metadata = readMetadata(NETWORK, all);
  const zones = metadataCount(NETWORK, metadata, NETWORK_COUNTS.zones, 1);
  const nodes = metadataCount(NETWORK, metadata, NETWORK_COUNTS.nodes, 1);
  const firstThruNode = metadataCount(NETWORK, metadata, NETWORK_COUNTS.firstThruNode, 1);
  const links = metadataCount(NETWORK, metadata, NETWORK_COUNTS.links, 0);
  if (zones > nodes) {
    throw new NativeParseError(NETWORK, metadata.values.get(NETWORK_COUNTS.zones)?.line ?? 1, `the zone count ${String(zones)} is above the node count ${String(nodes)}`);
  }
  if (firstThruNode > nodes) {
    throw new NativeParseError(NETWORK, metadata.values.get(NETWORK_COUNTS.firstThruNode)?.line ?? 1, `the first through node ${String(firstThruNode)} is above the node count ${String(nodes)}`);
  }
  const originalHeader = metadata.values.get(ORIGINAL_HEADER);
  const counted: Record<string, string | number> = { zones, firstThruNode, ...(originalHeader === undefined ? {} : { originalHeader: originalHeader.value }) };
  const meta: Record<string, string | number> = { ...counted, ...textMetadata(NETWORK, metadata, new Set([...Object.values(NETWORK_COUNTS), ORIGINAL_HEADER]), new Set(Object.keys(counted))) };

  let header: { readonly names: readonly string[]; readonly fields: readonly string[] } | undefined;
  const edges: NativeAttributedEdge[] = [];
  for (let index = metadata.next; index < all.length; index += 1) {
    const line = index + 1;
    const raw = (all[index] ?? "").trim();
    if (raw === "") {
      continue;
    }
    if (raw.startsWith("~")) {
      const names = raw.slice(1).replace(/;\s*$/, "").trim().split(/\s+/);
      if (header === undefined && names[0] === ENDS[0] && names[1] === ENDS[1]) {
        header = { names, fields: linkFields(names, line) };
      }
      continue;
    }
    if (header === undefined) {
      throw new NativeParseError(NETWORK, line, `a link line before the column header line ~ ${ENDS.join(" ")} ...`);
    }
    if (!raw.endsWith(";")) {
      throw new NativeParseError(NETWORK, line, "expected a link line ending with ;");
    }
    const values = raw.slice(0, -1).trim().split(/\s+/);
    if (values.length !== header.names.length) {
      throw new NativeParseError(NETWORK, line, `expected a link line of the header's ${String(header.names.length)} columns, found ${String(values.length)} values`);
    }
    const [init = "", term = "", ...rest] = values;
    const source = String(networkField.numbered(init, line, "node", nodes));
    const target = String(networkField.numbered(term, line, "node", nodes));
    const fields: Record<string, number> = {};
    for (const [position, field] of header.fields.entries()) {
      fields[field] = networkField.decimal(rest[position] ?? "", line, `the link's ${header.names[position + ENDS.length] ?? field}`);
    }
    edges.push({ source, target, type: "link", ...fields });
  }
  if (header === undefined) {
    throw new NativeParseError(NETWORK, all.length, `the file has no column header line ~ ${ENDS.join(" ")} ...`);
  }
  if (edges.length !== links) {
    throw new NativeParseError(NETWORK, all.length, `expected ${String(links)} links, found ${String(edges.length)}`);
  }

  return { zones, nodes, columns: header.fields, edges, meta };
}

/**
 * Parses one dataset of Transportation Networks for Research in the TNTP format (https://github.com/bstabler/TransportationNetworks, "TNTP Data format"): its network file and its trip table, read together into one graph.
 *
 * The network file opens with `<KEY> value` metadata lines up to `<END OF METADATA>`, of which `<NUMBER OF ZONES>`, `<NUMBER OF NODES>`, `<FIRST THRU NODE>` and `<NUMBER OF LINKS>` are required whole numbers; then `~` comment lines, one of which is the harmonised column header `~ init_node term_node <column> ... ;`; then one link per line, its values separated by whitespace and the line ended by `;`. Nodes are `1` to the node count, those up to the zone count of type `zone` (the zones, which are also nodes of the road network) and the rest of type `node`; each link is a directed edge of type `link` from its init node to its term node, in file order, with one field per further column, named in camel case (`free_flow_time` is `freeFlowTime`) and read as a number. Parallel links are kept.
 *
 * The trip table opens with metadata whose `<NUMBER OF ZONES>` must equal the network's and whose `<TOTAL OD FLOW>` is a number; then `~` comment lines and one block per origin, `Origin N` followed by `D : FLOW;` entries on any number of lines. Each entry is a commodity, following the graph/v1 convention for commodities: a node `commodity-<origin>-<destination>` of type `commodity` with its `demand` (the flow as written, zero included), joined by an `origin` edge and a `destination` edge to the zones it runs between.
 *
 * Every node carries `demand` (null but for a commodity) and every edge every link field (null on the commodity edges), as a crosswalk needs. `meta` holds `zones`, `firstThruNode` and `totalOdFlow`, the network's `<ORIGINAL HEADER>` as `originalHeader`, and any other metadata of either file as text under its key in camel case.
 * @param files - The two files' text.
 * @returns The native graph.
 * @throws NativeParseError naming the file and line for a metadata line before the end of the metadata that is not one, a key given twice or missing, a count that is not a whole number, a zone or first through node count above the node count, a link before the column header or of another number of values, a link line without its `;`, a node or zone outside its range, a value that is not a number, a link count other than the metadata's, a trip table whose zone count is not the network's, an entry before any origin or not of the form `D : FLOW`, a negative flow, or an origin and destination pair given twice.
 */
export function parseTntp(files: TntpFiles): NativeAttributedGraph {
  const network = readNetwork(files.network);
  const all = lines(files.trips);
  const metadata = readMetadata(TRIPS, all);
  const zones = metadataCount(TRIPS, metadata, TRIP_ZONES, 1);
  if (zones !== network.zones) {
    throw new NativeParseError(TRIPS, metadata.values.get(TRIP_ZONES)?.line ?? 1, `the trip table has ${String(zones)} zones and the network ${String(network.zones)}`);
  }
  const total = metadata.values.get(TOTAL_OD_FLOW);
  if (total === undefined) {
    throw new NativeParseError(TRIPS, metadata.next, `the metadata has no <${TOTAL_OD_FLOW}>`);
  }
  const counted: Record<string, string | number> = { ...network.meta, totalOdFlow: tripsField.decimal(total.value, total.line, `<${TOTAL_OD_FLOW}>`) };
  const meta: Record<string, string | number> = { ...counted, ...textMetadata(TRIPS, metadata, new Set([TRIP_ZONES, TOTAL_OD_FLOW]), new Set(Object.keys(counted))) };

  const nulls = Object.fromEntries(network.columns.map((field) => [field, null]));
  const nodes: NativeRow[] = Array.from({ length: network.nodes }, (_, index) => ({ id: String(index + 1), type: index < network.zones ? "zone" : "node", demand: null }));
  const edges: NativeAttributedEdge[] = network.edges;
  const pairs = new Set<string>();
  let origin: number | undefined;
  for (let index = metadata.next; index < all.length; index += 1) {
    const line = index + 1;
    const raw = (all[index] ?? "").trim();
    if (raw === "" || raw.startsWith("~")) {
      continue;
    }
    const start = ORIGIN.exec(raw);
    if (start !== null) {
      origin = tripsField.numbered(start[1] ?? "", line, "zone", zones);
      continue;
    }
    if (origin === undefined) {
      throw new NativeParseError(TRIPS, line, `expected an origin line Origin N, found ${JSON.stringify(raw)}`);
    }
    for (const piece of raw.split(";")) {
      const entry = piece.trim();
      if (entry === "") {
        continue;
      }
      const match = DESTINATION.exec(entry);
      if (match === null) {
        throw new NativeParseError(TRIPS, line, `expected a destination entry D : FLOW, found ${JSON.stringify(entry)}`);
      }
      const destination = tripsField.numbered(match[1] ?? "", line, "zone", zones);
      const demand = tripsField.decimal(match[2] ?? "", line, "the flow");
      if (demand < 0) {
        throw new NativeParseError(TRIPS, line, `expected a flow of at least 0, found ${match[2] ?? ""}`);
      }
      const id = `commodity-${String(origin)}-${String(destination)}`;
      if (pairs.has(id)) {
        throw new NativeParseError(TRIPS, line, `the flow from zone ${String(origin)} to zone ${String(destination)} is given twice`);
      }
      pairs.add(id);
      nodes.push({ id, type: "commodity", demand });
      edges.push({ source: id, target: String(origin), type: "origin", ...nulls }, { source: id, target: String(destination), type: "destination", ...nulls });
    }
  }

  return { meta, nodes, edges };
}
