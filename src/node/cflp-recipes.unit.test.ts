import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCrosswalk, type Crosswalk } from "crossmap";
import { describe, expect, it } from "vitest";
import { createCatalogue, type Dataset } from "../catalogue";
import { RecipeError } from "../errors";
import { zip } from "../test-support/archives";
import { fixtureManifest } from "../test-support/entries";
import { fetchEntry, roundTripEntry, type FetchPort } from "./fetch-dataset";

/** The crosswalk files the catalogue ships for the cflp parser, read from where they are committed. */
const CROSSWALK_DIR = join(import.meta.dirname, "../../catalogue/crosswalks/graph-v1");
const crosswalkFiles: Record<string, Crosswalk> = Object.fromEntries(["facility-location", "facility-location-uncapacitated"].map((name) => [`crosswalks/graph-v1/${name}.json`, parseCrosswalk(JSON.parse(readFileSync(join(CROSSWALK_DIR, `${name}.json`), "utf8")))]));

const SOURCE = "https://example.org/data/warehouses";

/** An OR-Library file that states its capacities: two warehouses and two customers. */
const STATED = " 2 2\n 10 100.\n 20 200.\n 1\n 5 8\n 2\n 6 9\n";

/** The same file with the word OR-Library's capa, capb and capc write in place of every capacity. */
const WORDED = STATED.replace(" 10 100.", " capacity 100.").replace(" 20 200.", " capacity 200.");

/** Values the word capacity stands for, two as capa's four are, and a value for a file the download does not hold. */
const SMALLER = 8000;
const LARGER = 10000;
const OTHER = 5000;
const CAPACITY_VALUES = [SMALLER, LARGER];
const OTHER_VALUES = [OTHER];

const ORLIB = { format: "cflp", encoding: "utf-8", layout: "orlib-cap", capacityValues: [{ instance: "capa.txt", values: CAPACITY_VALUES }] } as const;

/** The dataset of an entry with one live source, the given recipe and crosswalk file. */
function datasetFor(recipe: unknown, crosswalk = "facility-location"): Dataset {
  const entry = { id: "warehouses", name: "Warehouses", tags: [], category: "graph/v1", sources: [{ url: SOURCE, retrieved: "2026-11-10", status: "live" }], licence: { kind: "unrecorded" }, citations: [], recipe, crosswalk: { file: `crosswalks/graph-v1/${crosswalk}.json` }, expectedCounts: {}, properties: {} };

  return createCatalogue({ manifest: fixtureManifest, crosswalks: crosswalkFiles, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the catalogue lists its one entry");
}

const serving = (body: Uint8Array | string): FetchPort => async () => Promise.resolve(new Response(body));

const download = zip([
  { path: "files/cap41.txt", text: STATED },
  { path: "files/capa.txt", text: WORDED },
  { path: "files/capinfo.html", text: "<p>not an instance</p>" },
]);

describe("a cflp collection", () => {
  const members = { status: "fetchable", source: 0, archive: { kind: "zip", members: { extensions: [".txt"] } }, parser: ORLIB };

  it("gives a file that writes the word capacity one instance for each value the recipe names for it, filed under the file's path and the value", async () => {
    const recipe = { ...members, parser: { ...ORLIB, capacityValues: [{ instance: "files/capa.txt", values: CAPACITY_VALUES }] } };
    const { data } = await fetchEntry(datasetFor(recipe), { fetch: serving(download) });
    expect("instances" in data ? data.instances.map((instance) => instance.id) : []).toEqual(["files/cap41.txt", ...CAPACITY_VALUES.map((value) => `files/capa.txt/${String(value)}`)]);
    expect(data).toMatchObject({
      meta: { id: "warehouses", name: "Warehouses" },
      instances: [
        { meta: { layout: "orlib-cap", facilities: 2, customers: 2 }, nodes: [{ id: "f:1", type: "facility", capacity: 10, fixedCost: 100 }, { id: "f:2" }, { id: "c:1", type: "customer", demand: 1 }, { id: "c:2" }], edges: [{ source: "f:1", target: "c:1", cost: 5 }, {}, {}, {}] },
        ...CAPACITY_VALUES.map((capacity) => ({ meta: { capacity }, nodes: [{ id: "f:1", capacity }, { capacity }, {}, {}] })),
      ],
    });
  });

  it("names the file a collection reads with no values for its word capacity", async () => {
    const failure = await fetchEntry(datasetFor({ ...members, parser: { ...ORLIB, capacityValues: [{ instance: "files/capb.txt", values: OTHER_VALUES }] } }), { fetch: serving(download) }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RecipeError);
    expect(String(failure)).toMatch(/member files\/capa\.txt: cflp line 2: the file writes the word capacity in place of a capacity, and the recipe names no values for it/);
  });

  it("expands a downloaded file of a files recipe by the file's own path, and round-trips through the committed crosswalk", async () => {
    const recipe = { status: "fetchable", files: [{ path: "capa.txt", source: 0, archive: { kind: "none" } }], parser: ORLIB };
    const dataset = datasetFor(recipe);
    const { data } = await fetchEntry(dataset, { fetch: serving(WORDED) });
    expect("instances" in data ? data.instances.map((instance) => instance.id) : []).toEqual(CAPACITY_VALUES.map((value) => `capa.txt/${String(value)}`));
    const report = await roundTripEntry(dataset, { fetch: serving(WORDED) });
    expect(report.holds).toBe(true);
    expect(report.counts.get("instances")).toBe(2);
  });

  it("reads an uncapacitated document through its own crosswalk, which carries no capacity or demand", async () => {
    const recipe = { status: "fetchable", source: 0, archive: { kind: "none" }, parser: { format: "cflp", encoding: "utf-8", layout: "orlib-cap", uncapacitated: true } };
    const dataset = datasetFor(recipe, "facility-location-uncapacitated");
    const { data } = await fetchEntry(dataset, { fetch: serving(WORDED) });
    expect(data).toMatchObject({ meta: { id: "warehouses", layout: "orlib-cap", uncapacitated: true }, nodes: [{ id: "f:1", type: "facility", fixedCost: 100 }, {}, { id: "c:1", type: "customer" }, {}] });
    expect("nodes" in data && data.nodes.some((node) => "capacity" in node || "demand" in node)).toBe(false);
    expect((await roundTripEntry(dataset, { fetch: serving(WORDED) })).holds).toBe(true);
  });
});
