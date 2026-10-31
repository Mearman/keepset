import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createCatalogue, type Dataset } from "./catalogue";
import { DatasetNotFoundError, KeepsetError, RecipeError, type RecipeStep } from "./errors";
import { gzip, tar, zip } from "./test-support/archives";
import { arcgisEntry, ckanEntry, deadEntry, filesCollectionEntry, fixtureIndex, liveEntry, notFetchableEntry, ogbEntry, openFemaEntry, taskCollectionEntry, taskEntry, graphCollectionEntry, socrataEntry } from "./test-support/entries";
import { fileStore } from "./node/file-store";
import { downloadUrl, fetchDataset, fetchEntry, roundTripDataset, roundTripEntry, type DownloadProvenance, type FetchPort, type Provenance } from "./fetch";

/**
 * The provenance of a result read from one download.
 * @param provenance - A provenance record.
 * @returns It, narrowed.
 */
const single = (provenance: Provenance): DownloadProvenance => ("files" in provenance ? expect.unreachable("the result is read from one download") : provenance);

/** The availability lookup a source with no usable pin is first sent, before its live URL. */
const availabilityOf = (url: string): string => `https://archive.org/wayback/available?${new URLSearchParams({ url }).toString()}`;

const karateText = "% karate excerpt\n1 2\n2 3\n3 1\n";

/** A network port that serves fixed bytes by URL and records every request, standing in for the platform fetch so no test touches the network. */
function servedBy(files: Readonly<Record<string, Uint8Array | string>>): { fetch: FetchPort; requested: string[] } {
  const requested: string[] = [];
  const fetch: FetchPort = async (url) => {
    requested.push(url);
    const body = Object.hasOwn(files, url) ? files[url] : undefined;

    return Promise.resolve(body === undefined ? new Response("missing", { status: 404, statusText: "Not Found" }) : new Response(body));
  };

  return { fetch, requested };
}

/** An epoch-millisecond date of the paged layer's features, which the parser writes as ISO 8601 text. */
const EPOCH_MILLISECONDS = 1_700_000_000_000;
/** What the paged layer's three features are: their fines, their positions (longitude first, as the file writes it) and the number of features. */
const FINES = { first: 50, third: 75.5 } as const;
const HERE = { longitude: -0.1, latitude: 51.5 } as const;
const THERE = { longitude: -1.5, latitude: 52 } as const;
const FEATURES = 3;
/** How many times the downloader requests a page before it gives up. */
const PAGE_ATTEMPTS = 3;

const now = (): Date => new Date("2026-10-18T12:00:00.000Z");

/** The store every options literal in these tests shares, so each reads as the ports it injects and nothing else: Node's own, which keeps each download in a temporary file and hashes it as it arrives, so every recipe here runs through the path a real fetch takes. */
const neverFetch = async (): Promise<Response> => await Promise.reject(new Error("nothing should be downloaded"));
const storePort = { store: fileStore(), fetch: neverFetch } as const;

const datasetWith = (entry: unknown): Dataset => createCatalogue({ ...fixtureIndex, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the fixture catalogue lists its one entry");

async function failure(run: Readonly<Promise<unknown>>): Promise<RecipeError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RecipeError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a RecipeError");
}

describe("fetchEntry", () => {
  it("downloads a live source, parses it, applies the crosswalk and resolves graph/v1", async () => {
    const { fetch, requested } = servedBy({ "https://example.org/data/karate.txt": karateText });
    const result = await fetchEntry(datasetWith(liveEntry), { ...storePort, fetch, now });
    expect(requested).toEqual([availabilityOf("https://example.org/data/karate.txt"), "https://example.org/data/karate.txt"]);
    expect(result.data).toEqual({
      meta: { id: "karate", name: "Zachary Karate Club", directed: false, weighted: false, density: 0.139 },
      nodes: [{ id: "1" }, { id: "2" }, { id: "3" }],
      edges: [
        { source: "1", target: "2" },
        { source: "2", target: "3" },
        { source: "3", target: "1" },
      ],
    });
    expect(result.provenance).toEqual({
      entryId: "karate",
      catalogue: { id: "fixture", version: "1.2.3" },
      category: "graph/v1",
      source: { url: "https://example.org/data/karate.txt", status: "live" },
      fetchedUrl: "https://example.org/data/karate.txt",
      retrievedAt: "2026-10-18T12:00:00.000Z",
      sha256: createHash("sha256").update(karateText).digest("hex"),
      byteLength: karateText.length,
    });
  });

  it("warns, without failing, when a fetched count differs from the one the entry records", async () => {
    const { fetch } = servedBy({ "https://example.org/data/karate.txt": karateText });
    const result = await fetchEntry(datasetWith(liveEntry), { ...storePort, fetch, now });
    expect(result.warnings).toEqual(["nodes: the entry records 34, the fetched result has 3", "edges: the entry records 78, the fetched result has 3"]);
    const exact = await fetchEntry(datasetWith({ ...liveEntry, expectedCounts: { nodes: 3, edges: 3 } }), { ...storePort, fetch, now });
    expect(exact.warnings).toEqual([]);
  });

  it("fetches a dead source from its pinned snapshot's raw form and records the archive member", async () => {
    const pajek = "*Vertices 2\n*Edges\n1 2\n";
    const archived = "https://web.archive.org/web/20230601id_/http://example.edu/~lab/data/celegans_metabolic.zip";
    const zipped = zip([{ path: "data/celegans_metabolic.net", text: pajek }]);
    const { fetch, requested } = servedBy({ [archived]: zipped });
    const result = await fetchEntry(datasetWith(deadEntry), { ...storePort, fetch, now });
    expect(requested).toEqual([archived]);
    expect("edges" in result.data && result.data.edges).toEqual([{ source: "1", target: "2" }]);
    expect(result.provenance).toMatchObject({ fetchedUrl: archived, member: "data/celegans_metabolic.net", source: { status: "dead", snapshot: { timestamp: "20230601" } } });
  });

  it("unpacks a tar.gz source before parsing", async () => {
    const entry = {
      ...liveEntry,
      recipe: { status: "fetchable", source: 0, archive: { kind: "tar.gz", member: { path: "karate/karate.mtx" } }, parser: { format: "matrix-market", encoding: "utf-8" } },
    };
    const mtx = "%%MatrixMarket matrix coordinate pattern symmetric\n3 3 2\n2 1\n3 1\n";
    const { fetch } = servedBy({ "https://example.org/data/karate.txt": gzip(tar([{ path: "karate/karate.mtx", text: mtx }])) });
    expect((await fetchEntry(datasetWith(entry), { ...storePort, fetch, now })).data).toMatchObject({ nodes: [{ id: "1" }, { id: "2" }, { id: "3" }] });
  });

  it("passes the abort signal to the network port", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const fetch: FetchPort = async (_url, init) => {
      seen = init.signal;

      return Promise.resolve(new Response(karateText));
    };
    await fetchEntry(datasetWith(liveEntry), { ...storePort, fetch, now, signal: controller.signal });
    expect(seen).toBe(controller.signal);
  });

  const failures: readonly { readonly step: RecipeStep; readonly entry: unknown; readonly body?: string | Uint8Array; readonly fetch?: FetchPort; readonly message: RegExp }[] = [
    { step: "recipe", entry: notFetchableEntry, message: /requires an account/ },
    { step: "download", entry: liveEntry, message: /answered 404 Not Found/ },
    {
      step: "download",
      entry: liveEntry,
      fetch: async () => Promise.reject(new TypeError("fetch failed")),
      message: /fetch failed/,
    },
    { step: "extract", entry: { ...liveEntry, recipe: { ...liveEntry.recipe, archive: { kind: "gzip" } } }, body: karateText, message: /not valid gzip/ },
    { step: "parse", entry: liveEntry, body: "1 2\nlonely\n", message: /line 2/ },
    {
      step: "crosswalk",
      entry: { ...liveEntry, crosswalk: { ...liveEntry.crosswalk, rules: [...liveEntry.crosswalk.rules, { op: "move", from: "absent", to: "present" }] } },
      body: karateText,
      message: /absent/,
    },
    {
      step: "validate",
      entry: { ...liveEntry, recipe: { ...liveEntry.recipe, parser: { format: "gml", encoding: "utf-8" } } },
      body: "graph [ node [ id 1 ] edge [ source 1 target 2 ] ]",
      message: /names no node/,
    },
  ];

  it.each(failures)("fails loudly at the $step step, naming the entry", async ({ step, entry, body, fetch, message }) => {
    const port = fetch ?? servedBy(body === undefined ? {} : { "https://example.org/data/karate.txt": body, "https://example.com/datasets/walled": body }).fetch;
    const error = await failure(fetchEntry(datasetWith(entry), { ...storePort, fetch: port, now }));
    expect(error.step).toBe(step);
    expect(error.entryId).toMatch(/^(karate|auth-walled)$/);
    expect(error.message).toMatch(message);
    expect(error).toBeInstanceOf(KeepsetError);
  });
});

describe("downloadUrl", () => {
  it("uses a live source's own URL even when it pins a snapshot", () => {
    expect(downloadUrl({ url: "https://example.org/a", retrieved: "2026-01-01", status: "live", snapshot: { url: "https://web.archive.org/web/20200101/https://example.org/a", timestamp: "20200101" } })).toBe("https://example.org/a");
  });
});

describe("fetchDataset", () => {
  it("resolves ids against the bundled catalogue, failing before anything is downloaded", async () => {
    const never = async (): Promise<Response> => await Promise.reject(new Error("nothing should be downloaded"));
    await expect(fetchDataset("no-such-entry", { ...storePort, fetch: never })).rejects.toThrow(DatasetNotFoundError);
  });
});

describe("roundTripEntry", () => {
  it("holds when the crosswalk preserves every path of the native document", async () => {
    const { fetch } = servedBy({ "https://example.org/data/karate.txt": karateText });
    const report = await roundTripEntry(datasetWith(liveEntry), { ...storePort, fetch, now });
    expect(report).toMatchObject({ holds: true, provenance: { entryId: "karate" } });
  });

  it("reports the first path a lossy crosswalk loses", async () => {
    const { fetch } = servedBy({ "https://example.org/data/karate.txt": karateText });
    const withoutMeta = { ...liveEntry, crosswalk: { ...liveEntry.crosswalk, rules: liveEntry.crosswalk.rules.filter((rule) => rule.from !== "meta") } };
    const report = await roundTripEntry(datasetWith(withoutMeta), { ...storePort, fetch, now });
    // crossmap names the record whose keys differ, here the document root.
    expect(report).toMatchObject({ holds: false, path: "" });
    expect(report.holds ? "" : report.message).toMatch(/records differ in keys: edges,meta,nodes against edges,nodes/);
  });

  it("fails loudly when the recipe fails before the comparison", async () => {
    const error = await failure(roundTripEntry(datasetWith(notFetchableEntry), { ...storePort, now }));
    expect(error.step).toBe("recipe");
  });

  it("resolves ids against the bundled catalogue, failing before anything is downloaded", async () => {
    const never = async (): Promise<Response> => await Promise.reject(new Error("nothing should be downloaded"));
    await expect(roundTripDataset("no-such-entry", { ...storePort, fetch: never })).rejects.toThrow(DatasetNotFoundError);
  });
});

describe("a tasks/v1 entry", () => {
  const csv = 'request_id,latitude,longitude,minutes,status,borough,private_note\na1,51.5,-0.1,2,Open,Camden,not shared\na2,,,3,Closed,,\n"a,3",52,-1.5,,Open,"Isle ""of"" Dogs",\n';
  const { fetch: port } = servedBy({ "https://example.org/data/requests.csv": csv });
  const dataset = datasetWith(taskEntry);

  it("downloads a table, parses it, applies the crosswalk and resolves tasks/v1 with only the mapped fields", async () => {
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: port, now });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toEqual({
      meta: { id: "service-requests", name: "Service requests", durationUnit: "seconds" },
      nodes: [
        { id: "a1", lat: 51.5, lon: -0.1, duration: 120, status: "Open", territory: "Camden" },
        { id: "a2", lat: null, lon: null, duration: 180, status: "Closed", territory: null },
        { id: "a,3", lat: 52, lon: -1.5, duration: null, status: "Open", territory: 'Isle "of" Dogs' },
      ],
    });
    expect(JSON.stringify(fetched.data)).not.toContain("not shared");
  });

  it("holds the round trip over the paths the crosswalk maps", async () => {
    expect(await roundTripEntry(dataset, { ...storePort, fetch: port, now })).toMatchObject({ holds: true });
  });

  it("fails at the validate step when a value is outside the target's range", async () => {
    const bad = servedBy({ "https://example.org/data/requests.csv": "request_id,latitude,longitude,minutes,status,borough\nx,95,0,1,Open,A\n" });
    const error = await failure(fetchEntry(dataset, { ...storePort, fetch: bad.fetch, now }));
    expect(error.step).toBe("validate");
    expect(error.message).toMatch(/lat/);
  });

  it("fails at the parse step, naming the line, when the table is malformed", async () => {
    const bad = servedBy({ "https://example.org/data/requests.csv": "request_id,latitude,longitude,minutes,status,borough\nx,1,0,notanumber,Open,A\n" });
    const error = await failure(fetchEntry(dataset, { ...storePort, fetch: bad.fetch, now }));
    expect(error.step).toBe("parse");
    expect(error.message).toMatch(/line 2/);
  });
});

describe("a tasks/v1 entry whose collection is files downloaded one by one", () => {
  const north = "customer,x,y,prize\n1,1,2,0\n";
  const south = "customer,x,y,prize\n1,3,4,5\n2,6,7,0\n";
  const more = zip([
    { path: "more/west.csv", text: "customer,x,y,prize\n9,0,0,1\n" },
    { path: "more/east.csv", text: "customer,x,y,prize\n8,1,1,2\n" },
    { path: "more/readme.txt", text: "not an instance" },
  ]);
  const served = (overrides: Readonly<Record<string, Uint8Array | string>> = {}): ReturnType<typeof servedBy> =>
    servedBy({
      "https://example.org/data/routes/north.csv": north,
      "https://web.archive.org/web/20240101000000id_/https://example.org/data/routes/south.csv": south,
      "https://example.org/data/routes/more.zip": more,
      ...overrides,
    });
  const dataset = datasetWith(filesCollectionEntry);

  it("downloads each file in turn, a dead one from its snapshot, and files every instance under its path", async () => {
    const { fetch, requested } = served();
    const fetched = await fetchEntry(dataset, { ...storePort, fetch, now });
    expect(requested).toEqual([
      availabilityOf("https://example.org/data/routes/north.csv"),
      "https://example.org/data/routes/north.csv",
      "https://web.archive.org/web/20240101000000id_/https://example.org/data/routes/south.csv",
      availabilityOf("https://example.org/data/routes/more.zip"),
      "https://example.org/data/routes/more.zip",
    ]);
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toEqual({
      meta: { id: "route-files", name: "Route files" },
      instances: [
        { id: "north.csv", meta: {}, nodes: [{ id: "1", x: 1, y: 2, prize: 0 }] },
        {
          id: "south.csv",
          meta: {},
          nodes: [
            { id: "1", x: 3, y: 4, prize: 5 },
            { id: "2", x: 6, y: 7, prize: 0 },
          ],
        },
        { id: "more.zip/more/east.csv", meta: {}, nodes: [{ id: "8", x: 1, y: 1, prize: 2 }] },
        { id: "more.zip/more/west.csv", meta: {}, nodes: [{ id: "9", x: 0, y: 0, prize: 1 }] },
      ],
    });
  });

  it("records each file's download, hash and the instances it gave", async () => {
    const { provenance } = await fetchEntry(dataset, { ...storePort, fetch: served().fetch, now });
    expect(provenance).toEqual({
      entryId: "route-files",
      catalogue: { id: "fixture", version: "1.2.3" },
      category: "tasks/v1",
      retrievedAt: "2026-10-18T12:00:00.000Z",
      files: [
        { path: "north.csv", instances: ["north.csv"], source: { url: "https://example.org/data/routes/north.csv", status: "live" }, fetchedUrl: "https://example.org/data/routes/north.csv", sha256: createHash("sha256").update(north).digest("hex"), byteLength: north.length },
        {
          path: "south.csv",
          instances: ["south.csv"],
          source: { url: "https://example.org/data/routes/south.csv", status: "dead", snapshot: filesCollectionEntry.sources[2].snapshot },
          fetchedUrl: "https://web.archive.org/web/20240101000000id_/https://example.org/data/routes/south.csv",
          sha256: createHash("sha256").update(south).digest("hex"),
          byteLength: south.length,
        },
        { path: "more.zip", instances: ["more.zip/more/east.csv", "more.zip/more/west.csv"], source: { url: "https://example.org/data/routes/more.zip", status: "live" }, fetchedUrl: "https://example.org/data/routes/more.zip", sha256: createHash("sha256").update(more).digest("hex"), byteLength: more.byteLength },
      ],
    });
  });

  it("holds the round trip over every instance", async () => {
    expect(await roundTripEntry(dataset, { ...storePort, fetch: served().fetch, now })).toMatchObject({ holds: true });
  });

  it("fails at the download step on a file that does not answer, after the files before it and before those after it", async () => {
    const { fetch, requested } = served({ "https://web.archive.org/web/20240101000000id_/https://example.org/data/routes/south.csv": new Uint8Array() });
    const missing = servedBy({ "https://example.org/data/routes/north.csv": north });
    const error = await failure(fetchEntry(dataset, { ...storePort, fetch: missing.fetch, now }));
    expect(error.step).toBe("download");
    expect(error.message).toMatch(/south\.csv answered 404/);
    expect(missing.requested).toEqual([
      availabilityOf("https://example.org/data/routes/north.csv"),
      "https://example.org/data/routes/north.csv",
      "https://web.archive.org/web/20240101000000id_/https://example.org/data/routes/south.csv",
      availabilityOf("https://example.org/data/routes/south.csv"),
    ]);
    const broken = await failure(fetchEntry(dataset, { ...storePort, fetch, now }));
    expect(broken.step).toBe("parse");
    expect(broken.message).toMatch(/member south\.csv: /);
    expect(requested).toEqual([availabilityOf("https://example.org/data/routes/north.csv"), "https://example.org/data/routes/north.csv", "https://web.archive.org/web/20240101000000id_/https://example.org/data/routes/south.csv"]);
  });
});

describe("a files recipe in the entry schema", () => {
  it("names sources the entry has and files with distinct paths", () => {
    expect(() => datasetWith({ ...filesCollectionEntry, recipe: { ...filesCollectionEntry.recipe, files: [{ path: "x.csv", source: 9, archive: { kind: "none" } }] } })).toThrow(/recipe\.files\.0\.source: names source 9 but the entry has 4/);
    expect(() => datasetWith({ ...filesCollectionEntry, recipe: { ...filesCollectionEntry.recipe, files: [filesCollectionEntry.recipe.files[0], filesCollectionEntry.recipe.files[0]] } })).toThrow(/each file's path must be unique/);
    expect(() => datasetWith({ ...filesCollectionEntry, expectedCounts: { nodes: 1 } })).toThrow(/collections count only instances/);
  });
});

describe("a tasks/v1 entry that is a collection", () => {
  const suite = (files: readonly { readonly path: string; readonly text: string }[]): ReturnType<typeof servedBy> => servedBy({ "https://example.org/data/suite.zip": zip(files) });
  const members = [
    { path: "suite/b.csv", text: "customer,x,y,prize\n1,0,0,0\n" },
    { path: "suite/a.csv", text: "customer,x,y,prize\n1,4,5,0\n2,6,7,3\n" },
    { path: "suite/readme.txt", text: "not an instance" },
  ];
  const dataset = datasetWith(taskCollectionEntry);

  it("reads every matching member as an instance, in path order, each numbering its own nodes", async () => {
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: suite(members).fetch, now });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toEqual({
      meta: { id: "route-suite", name: "Route suite" },
      instances: [
        {
          id: "suite/a.csv",
          meta: {},
          nodes: [
            { id: "1", x: 4, y: 5, prize: 0 },
            { id: "2", x: 6, y: 7, prize: 3 },
          ],
        },
        { id: "suite/b.csv", meta: {}, nodes: [{ id: "1", x: 0, y: 0, prize: 0 }] },
      ],
    });
  });

  it("records the members it read in the provenance", async () => {
    const { provenance } = await fetchEntry(dataset, { ...storePort, fetch: suite(members).fetch, now });
    expect(single(provenance).members).toEqual(["suite/a.csv", "suite/b.csv"]);
    expect(single(provenance).member).toBeUndefined();
  });

  it("warns when the instance count differs from the recorded one", async () => {
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: suite(members.slice(0, 2).slice(0, 1)).fetch, now });
    expect(fetched.warnings).toEqual(["instances: the entry records 2, the fetched result has 1"]);
  });

  it("holds the round trip over every member", async () => {
    expect(await roundTripEntry(dataset, { ...storePort, fetch: suite(members).fetch, now })).toMatchObject({ holds: true });
  });

  it("fails at the extract step when no member matches", async () => {
    const error = await failure(fetchEntry(dataset, { ...storePort, fetch: suite([{ path: "readme.txt", text: "none" }]).fetch, now }));
    expect(error.step).toBe("extract");
    expect(error.message).toMatch(/at least one member ending \.csv/);
  });

  it("fails at the parse step naming the member that does not parse, and returns nothing partial", async () => {
    const error = await failure(fetchEntry(dataset, { ...storePort, fetch: suite([members[1] ?? expect.unreachable("fixture"), { path: "suite/z.csv", text: "customer,x,y,prize\n1,a,5,0\n" }]).fetch, now }));
    expect(error.step).toBe("parse");
    expect(error.message).toMatch(/member suite\/z\.csv: .*line 2/);
  });

  it("fails at the crosswalk step naming the member the crosswalk cannot be applied to", async () => {
    const dropped = { ...taskCollectionEntry, crosswalk: { ...taskCollectionEntry.crosswalk, rules: [...taskCollectionEntry.crosswalk.rules, { op: "move", from: "nodes[].absent", to: "nodes[].prize" }] } };
    const error = await failure(fetchEntry(datasetWith({ ...dropped, crosswalk: { ...dropped.crosswalk, rules: dropped.crosswalk.rules.filter((rule) => rule.to !== "nodes[].prize" || rule.from === "nodes[].absent") } }), { ...storePort, fetch: suite(members).fetch, now }));
    expect(error.step).toBe("crosswalk");
    expect(error.message).toMatch(/member suite\/a\.csv/);
  });

  it("fails at the validate step naming the instance whose node ids repeat", async () => {
    const error = await failure(fetchEntry(dataset, { ...storePort, fetch: suite([{ path: "suite/a.csv", text: "customer,x,y,prize\n1,4,5,0\n1,6,7,3\n" }]).fetch, now }));
    expect(error.step).toBe("validate");
    expect(error.message).toMatch(/instances\.0\.nodes\.1\.id/);
  });
});

describe("a graph/v1 entry that is a collection", () => {
  const graphs = [
    { path: "graphs/b.edges", text: "1 2\n" },
    { path: "graphs/a.edges", text: "# a triangle\n1 2\n2 3\n3 1\n" },
    { path: "graphs/readme.txt", text: "not a graph" },
  ];
  const served = servedBy({ "https://example.org/data/graphs.tar": tar(graphs) });
  const dataset = datasetWith(graphCollectionEntry);

  it("resolves a collection of graphs through the same path as a collection of tasks, with no category of its own", async () => {
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: served.fetch, now });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toMatchObject({
      meta: { id: "graph-suite", name: "Graph suite" },
      instances: [
        { id: "graphs/a.edges", meta: {}, nodes: [{ id: "1" }, { id: "2" }, { id: "3" }], edges: [{ source: "1", target: "2" }, { source: "2", target: "3" }, { source: "3", target: "1" }] },
        { id: "graphs/b.edges", nodes: [{ id: "1" }, { id: "2" }], edges: [{ source: "1", target: "2" }] },
      ],
    });
  });

  it("holds the round trip for every member", async () => {
    expect(await roundTripEntry(dataset, { ...storePort, fetch: served.fetch, now })).toMatchObject({ holds: true });
  });
});

describe("a graph/v1 entry of a multi-file format", () => {
  const archive = zipSync({
    "dataset/raw/num-node-dict.csv.gz": gzip("paper,author\n2,1\n"),
    "dataset/raw/triplet-type-list.csv.gz": gzip("author,writes,paper\npaper,cites,paper\n"),
    "dataset/raw/relations/author___writes___paper/edge.csv.gz": gzip("0,1\n"),
    "dataset/raw/relations/author___writes___paper/num-edge-list.csv.gz": gzip("1\n"),
    "dataset/raw/relations/paper___cites___paper/edge.csv.gz": gzip("1,0\n"),
    "dataset/raw/relations/paper___cites___paper/num-edge-list.csv.gz": gzip("1\n"),
    "dataset/raw/node-feat/paper/node-feat.csv.gz": gzip("0.5\n0.25\n"),
    "dataset/split/time/paper/train.csv.gz": gzip("0\n"),
  });
  const served = servedBy({ "https://example.org/data/dataset.zip": archive });
  const dataset = datasetWith(ogbEntry);

  it("reads every selected file of the archive into one graph, recording them in the provenance", async () => {
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: served.fetch, now });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toEqual({
      meta: { id: "ogb-suite", name: "OGB dataset" },
      nodes: [{ id: "author:0" }, { id: "paper:0" }, { id: "paper:1" }],
      edges: [
        { source: "author:0", target: "paper:1" },
        { source: "paper:1", target: "paper:0" },
      ],
    });
    expect(single(fetched.provenance).members).toEqual([
      "dataset/raw/num-node-dict.csv.gz",
      "dataset/raw/relations/author___writes___paper/edge.csv.gz",
      "dataset/raw/relations/author___writes___paper/num-edge-list.csv.gz",
      "dataset/raw/relations/paper___cites___paper/edge.csv.gz",
      "dataset/raw/relations/paper___cites___paper/num-edge-list.csv.gz",
      "dataset/raw/triplet-type-list.csv.gz",
    ]);
  });

  it("holds the round trip", async () => {
    expect(await roundTripEntry(dataset, { ...storePort, fetch: served.fetch, now })).toMatchObject({ holds: true });
  });

  it("fails at the parse step when the files do not make one dataset", async () => {
    const broken = servedBy({ "https://example.org/data/dataset.zip": zipSync({ "dataset/raw/num-node-dict.csv.gz": gzip("paper\n1\n") }) });
    const error = await failure(fetchEntry(dataset, { ...storePort, fetch: broken.fetch, now }));
    expect(error.step).toBe("parse");
    expect(error.message).toMatch(/has no raw\/triplet-type-list\.csv\.gz/);
  });
});

describe("a tasks/v1 entry whose source is a paged ArcGIS layer", () => {
  const layer = "https://example.org/arcgis/rest/services/Violations/FeatureServer/0";
  const feature = (id: number, fine: number | null, kind: string | null, point: { readonly longitude: number; readonly latitude: number } | null): unknown => ({
    type: "Feature",
    id,
    geometry: point === null ? null : { type: "Point", coordinates: [point.longitude, point.latitude] },
    properties: { OBJECTID: id, FINE: fine, OPENED: EPOCH_MILLISECONDS + id, KIND: kind, PRIVATE: "not kept" },
  });
  const features = [feature(1, FINES.first, "Weeds", HERE), feature(2, null, "Parking", null), feature(FEATURES, FINES.third, null, THERE)];
  const dataset = datasetWith(arcgisEntry);

  /** A stand-in layer that answers its count and pages of `size` features by offset, the way a feature server does, and records every request. */
  function layerServing(all: readonly unknown[], size: number, overrides: Readonly<Record<string, Response>> = {}): { fetch: FetchPort; requested: string[] } {
    const requested: string[] = [];
    const fetch: FetchPort = async (url) => {
      requested.push(url);
      const override = Object.entries(overrides).find(([part]) => url.includes(part));
      if (override !== undefined) {
        return Promise.resolve(override[1].clone());
      }
      if (url.includes("returnCountOnly=true")) {
        return Promise.resolve(Response.json({ count: all.length }));
      }
      const offset = Number(/resultOffset=(\d+)/.exec(url)?.[1]);

      return Promise.resolve(Response.json({ type: "FeatureCollection", features: all.slice(offset, offset + size) }));
    };

    return { fetch, requested };
  }

  it("reads every page in order of the order-by field and resolves tasks/v1 from the one collection", async () => {
    const served = layerServing(features, 2);
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: served.fetch, now });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toEqual({
      meta: { id: "layer-violations", name: "Layer violations" },
      nodes: [
        { id: "1", lat: HERE.latitude, lon: HERE.longitude, prize: FINES.first, opened: "2023-11-14T22:13:20.001Z", skill: "Weeds" },
        { id: "2", lat: null, lon: null, prize: null, opened: "2023-11-14T22:13:20.002Z", skill: "Parking" },
        { id: "3", lat: THERE.latitude, lon: THERE.longitude, prize: FINES.third, opened: "2023-11-14T22:13:20.003Z", skill: null },
      ],
    });
    expect(JSON.stringify(fetched.data)).not.toContain("not kept");
    expect(served.requested).toHaveLength(FEATURES);
    expect(served.requested[1]).toContain("orderByFields=OBJECTID&resultOffset=0&f=geojson");
    expect(served.requested[2]).toContain("resultOffset=2");
    expect(single(fetched.provenance).fetchedUrl).toBe(layer);
    expect(single(fetched.provenance).byteLength).toBeGreaterThan(0);
  });

  it("holds the round trip over the paths the crosswalk maps", async () => {
    expect(await roundTripEntry(dataset, { ...storePort, fetch: layerServing(features, 2).fetch, now })).toMatchObject({ holds: true });
  });

  it("fails at the download step, and does not loop, when the layer ignores the offset", async () => {
    const stuck = layerServing(features, 2, { "resultOffset=2": Response.json({ type: "FeatureCollection", features: [] }) });
    const error = await failure(fetchEntry(dataset, { ...storePort, fetch: stuck.fetch, now }));
    expect(error.step).toBe("download");
    expect(error.message).toMatch(/gave no features at offset 2, before the 3 it reports/);
  });

  it("fails at the download step when the server answers an error in a 200 response, or reports no count", async () => {
    const refused = layerServing(features, 2, { returnCountOnly: Response.json({ error: { code: 499, message: "Token Required" } }) });
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: refused.fetch, now }))).message).toMatch(/Token Required/);
    const noCount = layerServing(features, 2, { returnCountOnly: Response.json({ unrelated: true }) });
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: noCount.fetch, now }))).message).toMatch(/did not report a feature count/);
  });
});

describe("a tasks/v1 entry whose source is a Socrata resource read in pages", () => {
  const resource = "https://data.example.org/resource/abcd-1234.csv";
  const header = "case_id,status,borough,note\n";
  const rows = ["a1,Open,Camden,x\n", 'a2,Closed,"Isle ""of"" Dogs","two\nlines"\n', "a3,Open,Hackney,\n"];
  const dataset = datasetWith(socrataEntry);

  /** A stand-in resource that answers its count and pages by offset, the way Socrata does, and records every request; `page` overrides what a page of a given offset says. */
  function resourceServing(all: readonly string[], overrides: { readonly page?: (offset: number, honest: string) => string; readonly count?: string } = {}): { fetch: FetchPort; requested: string[] } {
    const { page = (_offset: number, honest: string): string => honest, count = `"count"\n"${String(all.length)}"\n` } = overrides;
    const requested: string[] = [];
    const fetch: FetchPort = async (url) => {
      requested.push(url);
      if (url.includes("select=count")) {
        return Promise.resolve(new Response(count));
      }
      const offset = Number(/offset=(\d+)/.exec(url)?.[1]);
      const limit = Number(/limit=(\d+)/.exec(url)?.[1]);

      return Promise.resolve(new Response(page(offset, header + all.slice(offset, offset + limit).join(""))));
    };

    return { fetch, requested };
  }

  it("reads each page in order of the row ids and joins them under one header", async () => {
    const served = resourceServing(rows);
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: served.fetch, now });
    expect(fetched.data).toEqual({
      meta: { id: "resource-cases", name: "Resource cases" },
      nodes: [
        { id: "a1", status: "Open", territory: "Camden" },
        { id: "a2", status: "Closed", territory: 'Isle "of" Dogs' },
        { id: "a3", status: "Open", territory: "Hackney" },
      ],
    });
    expect(served.requested).toEqual([`${resource}?%24select=count(*)`, `${resource}?%24order=%3Aid&%24limit=2&%24offset=0`, `${resource}?%24order=%3Aid&%24limit=2&%24offset=2`]);
    expect(single(fetched.provenance).fetchedUrl).toBe(resource);
    expect(single(fetched.provenance).byteLength).toBe(new TextEncoder().encode(header + rows.join("")).length);
  });

  it("holds the round trip over the paths the crosswalk maps", async () => {
    expect(await roundTripEntry(dataset, { ...storePort, fetch: resourceServing(rows).fetch, now })).toMatchObject({ holds: true });
  });

  it("fails at the download step when a page holds fewer rows than it should, as a response cut short does", async () => {
    const cut = resourceServing(rows, { page: (offset, honest) => (offset === 2 ? header : honest) });
    const error = await failure(fetchEntry(dataset, { ...storePort, fetch: cut.fetch, now }));
    expect(error.step).toBe("download");
    expect(error.message).toMatch(/gave 0 rows at offset 2 where 1 of its 3 were due/);
  });

  it("asks a page again when one response is cut short or fails, and fails only when it keeps failing", async () => {
    const attempts = new Map<number, number>();
    const flaky = resourceServing(rows, {
      page: (offset, honest) => {
        const seen = (attempts.get(offset) ?? 0) + 1;
        attempts.set(offset, seen);

        return offset === 2 && seen < PAGE_ATTEMPTS ? header : honest;
      },
    });
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: flaky.fetch, now });
    expect(fetched.data).toMatchObject({ nodes: [{ id: "a1" }, { id: "a2" }, { id: "a3" }] });
    expect(attempts.get(2)).toBe(PAGE_ATTEMPTS);
    const hopeless = resourceServing(rows, { page: (offset, honest) => (offset === 2 ? header : honest) });
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: hopeless.fetch, now }))).message).toMatch(/gave 0 rows at offset 2/);
    expect(hopeless.requested.filter((url) => url.includes("offset=2"))).toHaveLength(PAGE_ATTEMPTS);
  });

  it("fails at the download step when a later page has a different header, or the resource reports no rows or no count", async () => {
    const changed = resourceServing(rows, { page: (offset, honest) => (offset === 2 ? honest.replace("status", "state") : honest) });
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: changed.fetch, now }))).message).toMatch(/different header at offset 2/);
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: resourceServing([]).fetch, now }))).message).toMatch(/has no rows/);
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: resourceServing(rows, { count: "unrelated" }).fetch, now }))).message).toMatch(/did not report a row count/);
  });
});

describe("a tasks/v1 entry whose source is a CKAN datastore dump read in pages", () => {
  const dump = "https://data.example.org/data/datastore/dump/0a1b2c3d-1111-2222-3333-444455556666";
  const header = "_id,status,borough,note\n";
  const rows = ["1,Open,Camden,x\n", "2,Closed,Hackney,y\n", "3,Open,Islington,z\n"];
  const dataset = datasetWith(ckanEntry);

  /** A stand-in portal that answers the datastore count and the dump's pages by offset, and records every request. */
  function portalServing(all: readonly string[], count: string = JSON.stringify({ success: true, result: { total: all.length } })): { fetch: FetchPort; requested: string[] } {
    const requested: string[] = [];
    const fetch: FetchPort = async (url) => {
      requested.push(url);
      if (url.includes("datastore_search")) {
        return Promise.resolve(new Response(count));
      }
      const offset = Number(/offset=(\d+)/.exec(url)?.[1]);
      const limit = Number(/limit=(\d+)/.exec(url)?.[1]);

      return Promise.resolve(new Response(header + all.slice(offset, offset + limit).join("")));
    };

    return { fetch, requested };
  }

  it("reads the count from the portal's own datastore API, then the dump's pages, and joins them", async () => {
    const served = portalServing(rows);
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: served.fetch, now });
    expect(fetched.data).toEqual({
      meta: { id: "datastore-cases", name: "Datastore cases" },
      nodes: [
        { id: "1", status: "Open", territory: "Camden" },
        { id: "2", status: "Closed", territory: "Hackney" },
        { id: "3", status: "Open", territory: "Islington" },
      ],
    });
    expect(served.requested).toEqual(["https://data.example.org/data/api/3/action/datastore_search?resource_id=0a1b2c3d-1111-2222-3333-444455556666&limit=0", `${dump}?format=csv&limit=2&offset=0`, `${dump}?format=csv&limit=2&offset=2`]);
  });

  it("fails at the download step when the count is missing or a page is short", async () => {
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: portalServing(rows, '{"success":false}').fetch, now }))).message).toMatch(/did not report a row count/);
    const wrongTotal = portalServing(rows, JSON.stringify({ success: true, result: { total: 5 } }));
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: wrongTotal.fetch, now }))).message).toMatch(/gave 1 rows at offset 2 where 2 of its 5 were due/);
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: portalServing(rows, "not json").fetch, now }))).message).toMatch(/did not answer JSON/);
  });
});

describe("a tasks/v1 entry whose source is an OpenFEMA entity read in pages", () => {
  const header = "id,state,county\n";
  const rows = ["1,WA,King\n", "2,OR,Lane\n", "3,WA,Pierce\n"];
  const dataset = datasetWith(openFemaEntry);

  /** A stand-in API that answers a one-row JSON request with the count in its metadata, and CSV pages by `$skip` and `$top`. */
  function apiServing(all: readonly string[], count: string = JSON.stringify({ metadata: { count: all.length } })): { fetch: FetchPort; requested: string[] } {
    const requested: string[] = [];
    const fetch: FetchPort = async (url) => {
      requested.push(url);
      if (url.includes("inlinecount")) {
        return Promise.resolve(new Response(count));
      }
      const skip = Number(/skip=(\d+)/.exec(url)?.[1]);
      const top = Number(/top=(\d+)/.exec(url)?.[1]);

      return Promise.resolve(new Response(header + all.slice(skip, skip + top).join("")));
    };

    return { fetch, requested };
  }

  it("reads the count from the API's metadata, then pages in order of the id with the source's own select kept, and joins them", async () => {
    const served = apiServing(rows);
    const fetched = await fetchEntry(dataset, { ...storePort, fetch: served.fetch, now });
    expect(fetched.data).toEqual({
      meta: { id: "entity-claims", name: "Entity claims" },
      nodes: [
        { id: "1", status: "WA", territory: "King" },
        { id: "2", status: "OR", territory: "Lane" },
        { id: "3", status: "WA", territory: "Pierce" },
      ],
    });
    expect(served.requested[0]).toContain("%24select=id%2Cstate%2Ccounty");
    expect(served.requested[0]).toContain("%24inlinecount=allpages");
    const first = new URL(served.requested[1] ?? "").searchParams;
    expect([first.get("$select"), first.get("$format"), first.get("$orderby"), first.get("$top"), first.get("$skip")]).toEqual(["id,state,county", "csv", "id", "2", "0"]);
    expect(new URL(served.requested[2] ?? "").searchParams.get("$skip")).toBe("2");
    expect(served.requested).toHaveLength(FEATURES);
  });

  it("fails at the download step when the count is missing, a page is short, or the source URL sets a paging parameter", async () => {
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: apiServing(rows, "{}").fetch, now }))).message).toMatch(/did not report a row count/);
    const wrongTotal = apiServing(rows, JSON.stringify({ metadata: { count: 5 } }));
    expect((await failure(fetchEntry(dataset, { ...storePort, fetch: wrongTotal.fetch, now }))).message).toMatch(/gave 1 rows at offset 2 where 2 of its 5 were due/);
    const setsTop = datasetWith({ ...openFemaEntry, sources: [{ url: "https://www.fema.gov/api/open/v3/Claims?$top=5", retrieved: "2026-10-19", status: "live" }] });
    expect((await failure(fetchEntry(setsTop, { ...storePort, fetch: apiServing(rows).fetch, now }))).message).toMatch(/sets \$top, which the download sets itself/);
  });
});
