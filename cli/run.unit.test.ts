import { createCatalogue, DatasetNotFoundError, RecipeError, type Dataset, type DatasetQuery } from "keepset";
import { captureRequestsFor, type DownloadProvenance, type FetchedDataset, type RoundTripReport } from "keepset/node";
import { describe, expect, it } from "vitest";
import { deadEntry, fixtureIndex, liveEntry, streamedCorpusEntry, streamedEntry } from "../src/test-support/entries";
import { EXIT_FAILED, EXIT_NO, EXIT_OK, formatNamespaces, formatSearch, formatShow, provenancePath, run, type CliIo, type CliLibrary } from "./run";

const catalogue = createCatalogue(fixtureIndex);
const karate = catalogue.getDataset("karate");
const walled = catalogue.getDataset("auth-walled");

/** A SHA-256 is 64 hex digits. */
const SHA256_DIGITS = 64;

/** The provenance of the fixture download. */
const provenance: DownloadProvenance = {
  entryId: "karate",
  catalogue: karate.catalogue,
  category: "graph/v1",
  source: { url: "https://example.org/data/karate.txt", status: "live" },
  fetchedUrl: "https://example.org/data/karate.txt",
  retrievedAt: "2026-10-18T12:00:00.000Z",
  sha256: "0".repeat(SHA256_DIGITS),
  byteLength: 4,
};

const fetched: FetchedDataset = {
  dataset: karate,
  data: { meta: { id: "karate", name: "Zachary Karate Club" }, nodes: [{ id: "1" }, { id: "2" }], edges: [{ source: "1", target: "2" }] },
  provenance,
  warnings: ["nodes: the entry records 34, the fetched result has 2"],
};

/** A library stand-in that records each call, so the tests exercise the command layer alone. */
function harness(overrides: Partial<CliLibrary> = {}) {
  const calls: unknown[][] = [];
  const library: CliLibrary = {
    listDatasets: (query: DatasetQuery) => {
      calls.push(["listDatasets", query]);

      return catalogue.listDatasets(query);
    },
    getDataset: (id: string): Dataset => {
      calls.push(["getDataset", id]);

      return catalogue.getDataset(id);
    },
    listNamespaces: (path?: string) => {
      calls.push(["listNamespaces", path]);

      return catalogue.listNamespaces(path);
    },
    validateDataset: () => [],
    fetchDataset: async (id) => {
      calls.push(["fetchDataset", id]);

      return Promise.resolve(fetched);
    },
    roundTripDataset: async (id): Promise<RoundTripReport> => {
      calls.push(["roundTripDataset", id]);

      return Promise.resolve({ holds: true, provenance: fetched.provenance, counts: new Map([["nodes", 2], ["edges", 1]]), warnings: [] });
    },
    streamDataset: async (id) => {
      calls.push(["streamDataset", id]);

      return Promise.reject(new Error("the fixture catalogue streams nothing"));
    },
    countTarget: () =>
      new Map([
        ["nodes", 2],
        ["edges", 1],
      ]),
    captureRequests: () => [],
    requestCapture: async (saveUrl) => {
      calls.push(["requestCapture", saveUrl]);

      return Promise.resolve();
    },
    ...overrides,
  };
  const out = { stdout: "", stderr: "", files: new Map<string, string>(), closed: [] as string[] };
  const io: CliIo = {
    writeStdout: (text) => {
      out.stdout += text;
    },
    writeStderr: (text) => {
      out.stderr += text;
    },
    writeFile: (path, text) => {
      out.files.set(path, text);
    },
    openFile: (path) => {
      out.files.set(path, "");

      return {
        write: async (text) => {
          out.files.set(path, `${out.files.get(path) ?? ""}${text}`);
          await Promise.resolve();
        },
        close: async () => {
          out.closed.push(path);
          await Promise.resolve();
        },
      };
    },
    version: "9.9.9",
  };

  return { library, io, out, calls };
}

describe("command parsing", () => {
  it("prints the version and the help", async () => {
    const version = harness();
    expect(await run(["--version"], version.library, version.io)).toBe(EXIT_OK);
    expect(version.out.stdout).toBe("9.9.9\n");
    const help = harness();
    expect(await run(["-h"], help.library, help.io)).toBe(EXIT_OK);
    expect(help.out.stdout).toMatch(/^Usage: keepset <command>/);
  });

  it.each([
    [[], /expected a command/],
    [["teleport", "x"], /unknown command teleport/],
    [["show"], /show takes exactly one dataset/],
    [["fetch", "a", "b"], /fetch takes exactly one dataset/],
    [["search", "a", "b"], /at most one text argument/],
    [["search", "--nope"], /Unknown option '--nope'/],
    [["fetch", "karate", "--out"], /argument missing/],
  ])("rejects %j with usage and exit status 2", async (args, message) => {
    const { library, io, out, calls } = harness();
    expect(await run(args, library, io)).toBe(EXIT_FAILED);
    expect(out.stderr).toMatch(message);
    expect(out.stderr).toMatch(/Usage: keepset/);
    expect(calls).toEqual([]);
  });
});

describe("search", () => {
  it("passes the text and every filter to listDatasets", async () => {
    const { library, io, calls } = harness();
    await run(["search", "elegans", "--kind", "graph", "--domain", "Ecology", "--category", "graph/v1"], library, io);
    expect(calls).toEqual([["listDatasets", { text: "elegans", kind: "graph", domain: "Ecology", category: "graph/v1" }]]);
  });

  it("passes a subject filter to listDatasets, and the bundled search honours it", async () => {
    const { library, io, calls, out } = harness();
    await run(["search", "--subject", "network-science"], library, io);
    expect(calls).toEqual([["listDatasets", { subject: "network-science" }]]);
    expect(out.stdout).toBe("karate\tZachary Karate Club\tgraph/v1\tfetchable\n");
  });

  it("prints one tab-separated line per dataset, or the entries as JSON", async () => {
    const human = harness();
    expect(await run(["search", "karate"], human.library, human.io)).toBe(EXIT_OK);
    expect(human.out.stdout).toBe("karate\tZachary Karate Club\tgraph/v1\tfetchable\n");
    const machine = harness();
    await run(["search", "--json"], machine.library, machine.io);
    expect(JSON.parse(machine.out.stdout)).toEqual(catalogue.listDatasets().map((dataset) => dataset.entry));
  });

  it("formats every dataset in the order given", () => {
    expect(formatSearch([walled, karate])).toBe("auth-walled\tC. elegans metabolic network behind a login\tgraph/v1\tnot-fetchable\nkarate\tZachary Karate Club\tgraph/v1\tfetchable\n");
  });
});

describe("show", () => {
  it("prints a pinned snapshot's checksum and length beside its timestamp", () => {
    const sha256 = "e".repeat(SHA256_DIGITS);
    const [source] = deadEntry.sources;
    const checksummed = createCatalogue({ ...fixtureIndex, entries: [{ ...deadEntry, sources: [{ ...source, snapshot: { ...source?.snapshot, sha256, byteLength: 4096 } }] }] }).getDataset("celegans-metabolic");
    expect(formatShow(checksummed)).toContain(`snapshot 20230601, sha256 ${sha256}, 4096 bytes)`);
  });

  it("prints the descriptor, sources, licence, citations, recipe and crosswalk", () => {
    const text = formatShow(karate);
    for (const line of [
      "Zachary Karate Club (karate)",
      "category: graph/v1 (kind graph)",
      "licence: not recorded by the source",
      "  [0] https://example.org/data/karate.txt (live, retrieved 2026-04-19)",
      "doi:10.1086/jar.33.4.3629752",
      "  archive: none",
      "  parser: edge-list",
      "crosswalk: edge-list -> graph/v1",
      "  move nodes[].id -> nodes[].id",
      "expected counts: nodes 34, edges 78",
      "  density: 0.139",
    ]) {
      expect(text).toContain(line);
    }
  });

  it("names the selector of an inner archive, the files of a files archive's inner one among them", () => {
    const corpus = createCatalogue({ ...fixtureIndex, entries: [streamedCorpusEntry] }).getDataset("library-texts");
    expect(formatShow(corpus)).toContain("  archive: zip, files texts.tar, inner tar, files matching texts/[0-9]+\\.txt\n");
  });

  it("names the entries that hold the same data", () => {
    const twins = createCatalogue({ ...fixtureIndex, entries: [{ ...liveEntry, sameDataAs: ["twin"] }, { ...liveEntry, id: "twin", name: "Entry twin", sameDataAs: [liveEntry.id] }] });
    expect(formatShow(twins.getDataset("karate"))).toContain("same data as: twin\n");
    expect(formatShow(karate)).not.toContain("same data as");
  });

  it("says why a dataset is not fetchable, and names a custom licence", () => {
    const text = formatShow(walled);
    expect(text).toContain("not fetchable: the source requires an account to download");
    expect(text).toContain("licence: Example data licence <https://example.com/licence>");
  });

  it("prints the dataset as JSON with --json, delegating to getDataset", async () => {
    const { library, io, out, calls } = harness();
    expect(await run(["show", "karate", "--json"], library, io)).toBe(EXIT_OK);
    expect(JSON.parse(out.stdout)).toEqual(JSON.parse(JSON.stringify(karate)));
    expect(calls).toEqual([["getDataset", "karate"]]);
  });

  it("turns an unknown id into exit status 2 with the library's message", async () => {
    const { library, io, out } = harness({
      getDataset: (id) => {
        throw new DatasetNotFoundError(id);
      },
    });
    expect(await run(["show", "missing"], library, io)).toBe(EXIT_FAILED);
    expect(out.stderr).toBe('no dataset "missing" in the catalogue\n');
  });
});

describe("fetch of a streamed entry", () => {
  const streamedCatalogue = createCatalogue({ ...fixtureIndex, entries: [streamedEntry] });
  const streamed = streamedCatalogue.getDataset("streamed-cases");
  const meta = { id: "streamed-cases", name: "Streamed cases" };
  const pages = [[{ id: "a1", status: "Open", territory: "Camden" }, { id: "a2", status: null }], [{ id: "a3", territory: "Hackney" }]];

  /** A library whose stream hands on the given pages. */
  const streaming = (handed: readonly (readonly { readonly id: string }[])[]): Partial<CliLibrary> => ({
    getDataset: () => streamed,
    fetchDataset: async () => Promise.reject(new Error("a streamed entry is not fetched whole")),
    streamDataset: async (_id, sink) => {
      await sink.meta(meta);
      await handed.reduce(async (previous, page) => {
        await previous;
        await sink.nodes(page);
      }, Promise.resolve());

      return { dataset: streamed, meta, provenance, counts: new Map([["nodes", handed.flat().length]]), warnings: ["nodes: the entry records 9, the fetched result has 3"] };
    },
  });

  it("writes the same text a held fetch of the same nodes writes, then the provenance, and says it streamed", async () => {
    const { library, io, out } = harness(streaming(pages));
    expect(await run(["fetch", "streamed-cases"], library, io)).toBe(EXIT_OK);
    expect(out.files.get("streamed-cases.json")).toBe(`${JSON.stringify({ meta, nodes: pages.flat() }, undefined, 2)}\n`);
    expect(out.closed).toEqual(["streamed-cases.json"]);
    expect(JSON.parse(out.files.get("streamed-cases.provenance.json") ?? "null")).toEqual(fetched.provenance);
    expect(out.stdout).toBe("wrote streamed-cases.json (nodes 3, streamed) and streamed-cases.provenance.json\n");
    expect(out.stderr).toBe("warning: nodes: the entry records 9, the fetched result has 3\n");
  });

  it("writes an empty node list as a held fetch would", async () => {
    const { library, io, out } = harness(streaming([]));
    await run(["fetch", "streamed-cases", "--out", "none.json"], library, io);
    expect(out.files.get("none.json")).toBe(`${JSON.stringify({ meta, nodes: [] }, undefined, 2)}\n`);
  });
});

describe("fetch", () => {
  it("writes the result and its provenance, prints the counts and the warnings", async () => {
    const { library, io, out, calls } = harness();
    expect(await run(["fetch", "karate"], library, io)).toBe(EXIT_OK);
    expect(calls).toEqual([["getDataset", "karate"], ["fetchDataset", "karate"]]);
    expect(JSON.parse(out.files.get("karate.json") ?? "null")).toEqual(fetched.data);
    expect(JSON.parse(out.files.get("karate.provenance.json") ?? "null")).toEqual(fetched.provenance);
    expect(out.stdout).toBe("wrote karate.json (nodes 2, edges 1) and karate.provenance.json\n");
    expect(out.stderr).toBe("warning: nodes: the entry records 34, the fetched result has 2\n");
  });

  it("asks the Archive to capture a source read live, after the files are written, and says so", async () => {
    const { library, io, out, calls } = harness({ captureRequests: captureRequestsFor });
    expect(await run(["fetch", "karate"], library, io)).toBe(EXIT_OK);
    expect(calls.at(-1)).toEqual(["requestCapture", "https://web.archive.org/save/https://example.org/data/karate.txt"]);
    expect(out.stderr).toContain("asking the Internet Archive to capture it (https://web.archive.org/save/https://example.org/data/karate.txt)");
  });

  it("sends no request with --no-archive, or for a source read from a snapshot", async () => {
    const off = harness({ captureRequests: captureRequestsFor });
    await run(["fetch", "karate", "--no-archive"], off.library, off.io);
    expect(off.calls.some(([name]) => name === "requestCapture")).toBe(false);

    const snapshot: FetchedDataset = { ...fetched, provenance: { ...provenance, fetchedUrl: "https://web.archive.org/web/20240101000000id_/https://example.org/data/karate.txt" } };
    const pinned = harness({ captureRequests: captureRequestsFor, fetchDataset: async () => Promise.resolve(snapshot) });
    await run(["fetch", "karate"], pinned.library, pinned.io);
    expect(pinned.calls.some(([name]) => name === "requestCapture")).toBe(false);
  });

  it("keeps the fetch's success when the capture request cannot be sent", async () => {
    const { library, io, out } = harness({ captureRequests: captureRequestsFor, requestCapture: async () => Promise.reject(new TypeError("fetch failed")) });
    expect(await run(["fetch", "karate"], library, io)).toBe(EXIT_OK);
    expect(out.stderr).toContain("warning: could not send the capture request: fetch failed");
  });

  it("writes to --out, with provenance beside it", async () => {
    const { library, io, out } = harness();
    await run(["fetch", "karate", "--out", "data/club.json"], library, io);
    expect([...out.files.keys()]).toEqual(["data/club.json", "data/club.provenance.json"]);
    expect(provenancePath("graph")).toBe("graph.provenance.json");
  });

  it("turns a failing recipe into exit status 2 naming the entry and step", async () => {
    const { library, io, out } = harness({
      fetchDataset: async () => Promise.reject(new RecipeError("karate", "download", "https://example.org answered 404 Not Found")),
    });
    expect(await run(["fetch", "karate"], library, io)).toBe(EXIT_FAILED);
    expect(out.stderr).toBe("karate: download failed: https://example.org answered 404 Not Found\n");
    expect(out.files.size).toBe(0);
  });

  it("lets an error that is not the library's own propagate", async () => {
    const { library, io } = harness({ fetchDataset: async () => Promise.reject(new TypeError("a bug")) });
    await expect(run(["fetch", "karate"], library, io)).rejects.toThrow("a bug");
  });
});

describe("validate", () => {
  it("prints that a valid dataset is valid", async () => {
    const { library, io, out } = harness();
    expect(await run(["validate", "karate"], library, io)).toBe(EXIT_OK);
    expect(out.stdout).toBe("karate is valid\n");
  });

  it("prints every issue of an invalid one and exits 1", async () => {
    const { library, io, out } = harness({ validateDataset: () => [{ path: "crosswalk.rules.0", message: "a wildcard mismatch" }] });
    expect(await run(["validate", "karate"], library, io)).toBe(EXIT_NO);
    expect(out.stdout).toBe("crosswalk.rules.0: a wildcard mismatch\n");
  });
});

describe("roundtrip", () => {
  it("reports a round trip that holds", async () => {
    const { library, io, out, calls } = harness();
    expect(await run(["roundtrip", "karate"], library, io)).toBe(EXIT_OK);
    expect(calls).toEqual([["getDataset", "karate"], ["roundTripDataset", "karate"]]);
    expect(out.stdout).toBe("karate: the round trip holds (nodes 2, edges 1)\n");
    expect(out.stderr).toBe("");
  });

  it("prints the warnings of a count the entry records differently to stderr, as fetch does", async () => {
    const { library, io, out } = harness({ roundTripDataset: async () => Promise.resolve({ holds: true, provenance: fetched.provenance, counts: new Map([["nodes", 2]]), warnings: ["nodes: the entry records 34, the fetched result has 2"] }) });
    expect(await run(["roundtrip", "karate"], library, io)).toBe(EXIT_OK);
    expect(out.stdout).toBe("karate: the round trip holds (nodes 2)\n");
    expect(out.stderr).toBe("warning: nodes: the entry records 34, the fetched result has 2\n");
  });

  it("reports where a round trip fails and exits 1", async () => {
    const { library, io, out } = harness({ roundTripDataset: async () => Promise.resolve({ holds: false, path: "", message: "records differ in keys", provenance: fetched.provenance, counts: new Map([["nodes", 2]]), warnings: [] }) });
    expect(await run(["roundtrip", "karate"], library, io)).toBe(EXIT_NO);
    expect(out.stdout).toBe("karate: the round trip does not hold at (root): records differ in keys (nodes 2)\n");
  });
});

describe("namespaces and aliases", () => {
  const nested = createCatalogue({
    ...fixtureIndex,
    entries: [
      { ...fixtureIndex.entries[0], id: "one-shared", name: "Entry one-shared", namespace: ["one", "inner"], aliases: ["shared"] },
      { ...fixtureIndex.entries[0], id: "two-shared", name: "Entry two-shared", namespace: ["two"], aliases: ["shared"] },
    ],
  });
  const nestedLibrary = (): ReturnType<typeof harness> => harness({ getDataset: (name) => nested.getDataset(name), listDatasets: (query) => nested.listDatasets(query), listNamespaces: (path) => nested.listNamespaces(path) });

  it("resolves a qualified name for fetch and writes under the entry's own id, never the typed name", async () => {
    const { library, io, out, calls } = nestedLibrary();
    expect(await run(["fetch", "one/inner/shared"], library, io)).toBe(EXIT_OK);
    expect(calls).toContainEqual(["fetchDataset", "one-shared"]);
    expect([...out.files.keys()]).toEqual(["one-shared.json", "one-shared.provenance.json"]);
  });

  it("reports the entry's own id for validate and roundtrip of an alias", async () => {
    const { library, io, out } = nestedLibrary();
    expect(await run(["validate", "inner/shared"], library, io)).toBe(EXIT_OK);
    expect(out.stdout).toBe("one-shared is valid\n");
    const second = nestedLibrary();
    expect(await run(["roundtrip", "two/shared"], second.library, second.io)).toBe(EXIT_OK);
    expect(second.out.stdout).toBe("two-shared: the round trip holds (nodes 2, edges 1)\n");
  });

  it("turns an ambiguous name into exit status 2 naming the entries it could mean", async () => {
    const { library, io, out } = nestedLibrary();
    expect(await run(["show", "shared"], library, io)).toBe(EXIT_FAILED);
    expect(out.stderr).toBe('"shared" could mean more than one dataset: one-shared, two-shared; use an id or a longer qualified name\n');
  });

  it("filters the search by --namespace", async () => {
    const { library, io, out } = nestedLibrary();
    expect(await run(["search", "--namespace", "one"], library, io)).toBe(EXIT_OK);
    expect(out.stdout).toContain("one-shared");
    expect(out.stdout).not.toContain("two-shared");
  });

  it("prints the namespace and aliases in show", () => {
    expect(formatShow(nested.getDataset("one-shared"))).toContain("namespace: one/inner\naliases: shared\n");
  });
});

describe("namespaces", () => {
  const nested = createCatalogue({
    ...fixtureIndex,
    entries: [
      { ...fixtureIndex.entries[0], id: "one-shared", name: "Entry one-shared", namespace: ["one", "inner"], aliases: ["two/shared"] },
      { ...fixtureIndex.entries[0], id: "other", name: "Entry other", namespace: ["one"] },
    ],
  });
  const nestedLibrary = (): ReturnType<typeof harness> => harness({ listDatasets: (query) => nested.listDatasets(query), listNamespaces: (path) => nested.listNamespaces(path) });

  it("lists the outermost namespaces with their counts, tab-separated", async () => {
    const { library, io, out } = nestedLibrary();
    expect(await run(["namespaces"], library, io)).toBe(EXIT_OK);
    expect(out.stdout).toBe("one\t2\ntwo\t1\n");
    expect(formatNamespaces(nested.listNamespaces())).toBe(out.stdout);
  });

  it("lists the namespaces directly beneath a path", async () => {
    const { library, io, out } = nestedLibrary();
    expect(await run(["namespaces", "one"], library, io)).toBe(EXIT_OK);
    expect(out.stdout).toBe("one/inner\t1\n");
  });

  it("prints the namespaces as JSON", async () => {
    const { library, io, out } = nestedLibrary();
    expect(await run(["namespaces", "--json"], library, io)).toBe(EXIT_OK);
    expect(JSON.parse(out.stdout)).toEqual([
      { path: "one", name: "one", count: 2 },
      { path: "two", name: "two", count: 1 },
    ]);
  });

  it("prints nothing and succeeds for a namespace with none beneath it", async () => {
    const { library, io, out } = nestedLibrary();
    expect(await run(["namespaces", "one/inner"], library, io)).toBe(EXIT_OK);
    expect(out.stdout).toBe("");
  });

  it("turns a path no entry sits in into exit status 2 naming it, and too many arguments into usage", async () => {
    const { library, io, out } = nestedLibrary();
    expect(await run(["namespaces", "nope"], library, io)).toBe(EXIT_FAILED);
    expect(out.stderr).toBe('no namespace "nope" in the catalogue\n');
    const second = nestedLibrary();
    expect(await run(["namespaces", "a", "b"], second.library, second.io)).toBe(EXIT_FAILED);
    expect(second.out.stderr).toMatch(/namespaces takes at most one path/);
  });
});
