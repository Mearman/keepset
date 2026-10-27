import { parseEntry } from "keepset";
import { describe, expect, it } from "vitest";
import { liveEntry, socrataEntry, taskCollectionEntry } from "../src/test-support/entries";
import { dimensionsOf, entitiesText, entityTotal, formatBytes, formatCount, sizeText } from "./dimensions";

const KARATE_NODES = 34;
const KARATE_EDGES = 78;
const KIBIBYTE = 1024;
const BYTES_IN_A_FILE = 2048;
const MILLIONS = 1_234_567;
const HALF_KIBIBYTE = 512;
const KIBIBYTE_AND_A_HALF = 1536;
const GIBIBYTE = KIBIBYTE * KIBIBYTE * KIBIBYTE;

describe("dimensionsOf", () => {
  it("reads the recorded counts, and a byte size only where it is not the placeholder zero", () => {
    expect(dimensionsOf(parseEntry({ ...liveEntry, properties: { rawBytes: BYTES_IN_A_FILE } }))).toEqual({ nodes: KARATE_NODES, edges: KARATE_EDGES, bytes: BYTES_IN_A_FILE });
    expect(dimensionsOf(parseEntry({ ...liveEntry, properties: { rawBytes: 0 } }))).not.toHaveProperty("bytes");
  });

  it("prefers the size of the download over the raw size the source states", () => {
    expect(dimensionsOf(parseEntry({ ...liveEntry, properties: { rawBytes: BYTES_IN_A_FILE, downloadBytes: KIBIBYTE } }))).toHaveProperty("bytes", KIBIBYTE);
    expect(dimensionsOf(parseEntry({ ...liveEntry, properties: { rawBytes: 0, downloadBytes: KIBIBYTE } }))).toHaveProperty("bytes", KIBIBYTE);
    expect(dimensionsOf(parseEntry({ ...liveEntry, properties: { rawBytes: BYTES_IN_A_FILE } }))).toHaveProperty("bytes", BYTES_IN_A_FILE);
  });

  it("marks a recipe that reads a query a page at a time as paged, and no other", () => {
    expect(dimensionsOf(parseEntry(socrataEntry))).toHaveProperty("paged", true);
    expect(dimensionsOf(parseEntry(liveEntry))).not.toHaveProperty("paged");
  });

  it("reads a collection's instance count", () => {
    expect(dimensionsOf(parseEntry(taskCollectionEntry))).toEqual({ instances: 2 });
  });

  it("reads a probed node count as approximate, and never over an asserted one", () => {
    const probedEntry = parseEntry({ ...liveEntry, expectedCounts: {}, properties: { probedNodes: KARATE_NODES } });
    expect(dimensionsOf(probedEntry)).toEqual({ nodes: KARATE_NODES, probed: true });
    expect(dimensionsOf(parseEntry({ ...liveEntry, properties: { probedNodes: 1 } }))).toEqual({ nodes: KARATE_NODES, edges: KARATE_EDGES });
  });

  it("reads the instance count and download size an entry with no recipe records from its publisher", () => {
    const stated = parseEntry({ ...taskCollectionEntry, expectedCounts: {}, properties: { instanceCount: 310, downloadBytes: 2048 } });
    expect(dimensionsOf(stated)).toEqual({ instances: 310, bytes: 2048 });
  });

  it("leaves out what an entry does not record", () => {
    expect(dimensionsOf(parseEntry({ ...liveEntry, expectedCounts: {}, properties: {} }))).toEqual({});
  });
});

describe("formatCount and formatBytes", () => {
  it("groups digits and writes nothing for an unrecorded value", () => {
    expect(formatCount(MILLIONS)).toBe("1,234,567");
    expect(formatCount(undefined)).toBe("");
    expect(formatBytes(undefined)).toBe("");
  });

  it("uses the largest binary unit reached", () => {
    expect(formatBytes(HALF_KIBIBYTE)).toBe("512 B");
    expect(formatBytes(KIBIBYTE_AND_A_HALF)).toBe("1.5 KiB");
    expect(formatBytes(GIBIBYTE)).toBe("1 GiB");
  });
});

describe("sizeText", () => {
  it("writes the download's size, says paged where there is no download, and writes nothing where neither holds", () => {
    expect(sizeText({ bytes: KIBIBYTE })).toBe("1 KiB");
    expect(sizeText({ paged: true })).toBe("paged");
    expect(sizeText({})).toBe("");
  });
});

describe("entitiesText and entityTotal", () => {
  it("writes each recorded count with its noun and sums them", () => {
    expect(entitiesText({ nodes: KARATE_NODES, edges: KARATE_EDGES })).toBe("34 nodes, 78 edges");
    expect(entityTotal({ nodes: KARATE_NODES, edges: KARATE_EDGES })).toBe(KARATE_NODES + KARATE_EDGES);
  });

  it("uses the singular for a count of one and groups digits", () => {
    expect(entitiesText({ instances: 1 })).toBe("1 instance");
    expect(entitiesText({ nodes: MILLIONS })).toBe("1,234,567 nodes");
  });

  it("writes a probed node count as approximate and counts it in the total", () => {
    expect(entitiesText({ nodes: KARATE_NODES, probed: true })).toBe("about 34 nodes");
    expect(entityTotal({ nodes: KARATE_NODES, probed: true })).toBe(KARATE_NODES);
  });

  it("writes nothing, and no total, where no count is recorded", () => {
    expect(entitiesText({ bytes: BYTES_IN_A_FILE })).toBe("");
    expect(entityTotal({ bytes: BYTES_IN_A_FILE })).toBeUndefined();
  });

  it("counts a recorded zero as a count", () => {
    expect(entityTotal({ nodes: 0 })).toBe(0);
  });
});
