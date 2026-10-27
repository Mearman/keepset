/* The size and shape of a dataset as the listing shows it: node, edge and instance counts and the source's byte size, read from an entry's recorded counts and properties. Shared by the generator (the search index and the static table) and the client island, so both views of the listing agree on what is known and how it is written. */

import type { Entry } from "keepset";

/** The recorded dimensions of one entry; a field the entry does not record is absent, never zero. */
export interface Dimensions {
  readonly nodes?: number;
  readonly edges?: number;
  readonly instances?: number;
  readonly bytes?: number;
  /** True where the recipe reads the dataset a page at a time from a query, which has no whole download whose size could be stated. */
  readonly paged?: true;
  /** True where `nodes` is a count a probe read from a source that grows and not one the entry asserts, so it is shown as approximate. */
  readonly probed?: true;
}

/** The property key that records the size in bytes of the source's raw data, which the source catalogue states and is `0` where it stated none. */
export const BYTES_PROPERTY = "rawBytes";

/** The property key that records the size in bytes of the download the recipe fetches, as the collection's host reports it. */
export const DOWNLOAD_BYTES_PROPERTY = "downloadBytes";

/**
 * Whether a property records a size in bytes.
 * @param key - The property key.
 * @returns True for the raw size and the download size.
 */
export function isBytesProperty(key: string): boolean {
  return key === BYTES_PROPERTY || key === DOWNLOAD_BYTES_PROPERTY;
}

/** The property key that records how many instance files a collection holds, for an entry with no recipe to read them, as its publisher states or the files were counted. */
export const INSTANCE_COUNT_PROPERTY = "instanceCount";

/** The property key that records the node count a probe read from a source that grows, which a fetch does not assert. */
export const PROBED_NODES_PROPERTY = "probedNodes";

/**
 * Reads an entry's dimensions. The size is what a fetch downloads where the entry records it (`properties.downloadBytes`), else the raw size the source catalogue states (`properties.rawBytes`, `0` where it stated none, so a zero is no size and is left out). A recipe that pages a query has no download, so it is marked paged instead.
 * @param entry - The entry.
 * @returns The dimensions the entry records.
 */
export function dimensionsOf(entry: Entry): Dimensions {
  const { expectedCounts, properties } = entry;
  const bytes = [properties[DOWNLOAD_BYTES_PROPERTY], properties[BYTES_PROPERTY]].find((candidate): candidate is number => typeof candidate === "number" && candidate > 0);
  const probed = properties[PROBED_NODES_PROPERTY];
  const asserted = expectedCounts["nodes"];
  const stated = properties[INSTANCE_COUNT_PROPERTY];
  const instances = expectedCounts["instances"] ?? (typeof stated === "number" ? stated : undefined);
  const nodes: Dimensions = asserted !== undefined ? { nodes: asserted } : typeof probed === "number" ? { nodes: probed, probed: true } : {};

  return {
    ...nodes,
    ...(expectedCounts["edges"] === undefined ? {} : { edges: expectedCounts["edges"] }),
    ...(instances === undefined ? {} : { instances }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(entry.recipe.status === "fetchable" && "paging" in entry.recipe && entry.recipe.paging !== undefined ? { paged: true as const } : {}),
  };
}

/**
 * Writes a count with its digits grouped.
 * @param count - The count, or undefined where the entry records none.
 * @returns The text; empty for an unrecorded count.
 */
export function formatCount(count: number | undefined): string {
  return count === undefined ? "" : count.toLocaleString("en-GB");
}

/**
 * Writes a dataset's size as the listing shows it: the download's size, or "paged" where the recipe reads a query a page at a time and so has no download to measure.
 * @param dimensions - The recorded dimensions.
 * @returns The text; empty where the entry records no size and is not paged.
 */
export function sizeText(dimensions: Dimensions): string {
  return dimensions.bytes === undefined ? (dimensions.paged === true ? "paged" : "") : formatBytes(dimensions.bytes);
}

/** Bytes in the next unit up of the binary prefixes, and the units' names from the smallest. */
const BYTES_PER_UNIT = 1024;
const UNITS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/**
 * Writes a byte size in the largest binary unit it reaches, to one decimal place.
 * @param bytes - The size, or undefined where the entry records none.
 * @returns The text; empty for an unrecorded size.
 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) {
    return "";
  }
  const unit = Math.min(UNITS.length - 1, Math.floor(Math.log(Math.max(bytes, 1)) / Math.log(BYTES_PER_UNIT)));

  return `${(bytes / BYTES_PER_UNIT ** unit).toLocaleString("en-GB", { maximumFractionDigits: 1 })} ${UNITS[unit] ?? "B"}`;
}

/** The kinds of entity a dataset's recorded counts stand for, in the order they read, each with its singular and plural noun. A graph's entities are its nodes and edges, a collection's its instances. */
const ENTITIES = [
  { key: "nodes", singular: "node", plural: "nodes" },
  { key: "edges", singular: "edge", plural: "edges" },
  { key: "instances", singular: "instance", plural: "instances" },
] as const;

/**
 * Writes the entities a dataset holds as each recorded count with its noun.
 * @param dimensions - The recorded dimensions.
 * @returns The text, such as "34 nodes, 78 edges", or "about 1,200 nodes" where the node count is a probed one; empty where the entry records no count.
 */
export function entitiesText(dimensions: Dimensions): string {
  return ENTITIES.flatMap(({ key, singular, plural }) => {
    const count = dimensions[key];

    return count === undefined ? [] : [`${key === "nodes" && dimensions.probed === true ? "about " : ""}${formatCount(count)} ${count === 1 ? singular : plural}`];
  }).join(", ");
}

/**
 * The number of entities a dataset holds: the sum of its recorded counts, which is what the entities column sorts by.
 * @param dimensions - The recorded dimensions.
 * @returns The sum, or undefined where the entry records no count.
 */
export function entityTotal(dimensions: Dimensions): number | undefined {
  const counts = ENTITIES.flatMap(({ key }) => {
    const count = dimensions[key];

    return count === undefined ? [] : [count];
  });

  return counts.length === 0 ? undefined : counts.reduce((total, count) => total + count, 0);
}
