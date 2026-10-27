import { describe, expect, it } from "vitest";
import { getDataset, getManifest, listDatasets } from "./bundled";
import { CatalogueIndexSchema, createCatalogue } from "./catalogue";
import { CatalogueSyntaxError, DatasetAmbiguousError, DatasetNotFoundError } from "./errors";
import { deadEntry, fixtureIndex, liveEntry, representativeEntries, topologyCrosswalk } from "./test-support/entries";

const catalogue = createCatalogue(fixtureIndex);

describe("createCatalogue", () => {
  it("filters by subject, exactly, and finds an entry by a subject in a text search", () => {
    expect(catalogue.listDatasets({ subject: "network-science" }).map((dataset) => dataset.entry.id)).toEqual(["karate"]);
    expect(catalogue.listDatasets({ subject: "social-science" }).map((dataset) => dataset.entry.id)).toEqual(["karate"]);
    expect(catalogue.listDatasets({ subject: "network" })).toEqual([]);
    expect(catalogue.listDatasets({ subject: "operations-research" })).toEqual([]);
    expect(catalogue.listDatasets({ text: "social-science" }).map((dataset) => dataset.entry.id)).toEqual(["karate"]);
    expect(catalogue.listDatasets({ subject: "network-science", kind: "tasks" })).toEqual([]);
  });

  it("lists every dataset in entry id order when no filter is given", () => {
    expect(catalogue.listDatasets().map((dataset) => dataset.entry.id)).toEqual(["auth-walled", "celegans-metabolic", "karate"]);
  });

  it("filters by kind, category, domain and text, all of which must match", () => {
    expect(catalogue.listDatasets({ kind: "graph" })).toHaveLength(representativeEntries.length);
    expect(catalogue.listDatasets({ kind: "table" })).toEqual([]);
    expect(catalogue.listDatasets({ category: "graph/v1" })).toHaveLength(representativeEntries.length);
    expect(catalogue.listDatasets({ category: "graph/v2" })).toEqual([]);
    expect(catalogue.listDatasets({ domain: "Social network" }).map((dataset) => dataset.entry.id)).toEqual(["karate"]);
    expect(catalogue.listDatasets({ domain: "social network" })).toEqual([]);
    expect(catalogue.listDatasets({ text: "KARATE" }).map((dataset) => dataset.entry.id)).toEqual(["karate"]);
    expect(catalogue.listDatasets({ text: "small" }).map((dataset) => dataset.entry.id)).toEqual(["karate"]);
    expect(catalogue.listDatasets({ text: "elegans" }).map((dataset) => dataset.entry.id)).toEqual(["auth-walled", "celegans-metabolic"]);
    expect(catalogue.listDatasets({ text: "karate", domain: "Ecology" })).toEqual([]);
  });

  it("returns an entry's metadata, recipe and crosswalk, resolving a crosswalk file reference", () => {
    const dataset = catalogue.getDataset("celegans-metabolic");
    expect(dataset.entry).toEqual(deadEntry);
    expect(dataset.kind).toBe("graph");
    expect(dataset.crosswalk).toEqual(topologyCrosswalk);
    expect(dataset.catalogue).toEqual({ id: "fixture", version: "1.2.3" });
    expect(catalogue.getDataset("karate").crosswalk).toEqual(liveEntry.crosswalk);
  });

  it("throws DatasetNotFoundError for an unknown id, including a prototype name", () => {
    expect(() => catalogue.getDataset("missing")).toThrow(DatasetNotFoundError);
    expect(() => catalogue.getDataset("constructor")).toThrow(DatasetNotFoundError);
  });

  it("rejects duplicate entry ids", () => {
    expect(() => createCatalogue({ ...fixtureIndex, entries: [liveEntry, liveEntry] })).toThrow(CatalogueSyntaxError);
  });

  it("rejects two entries whose names a listing could not tell apart, ignoring case and spacing", () => {
    const twin = { ...liveEntry, id: "karate-copy", name: liveEntry.name };
    expect(() => createCatalogue({ ...fixtureIndex, entries: [liveEntry, twin] })).toThrow(/is also the name of entry karate/);
    expect(() => createCatalogue({ ...fixtureIndex, entries: [liveEntry, { ...twin, name: `  ${liveEntry.name.toUpperCase().replace(" ", "   ")} ` }] })).toThrow(CatalogueSyntaxError);
    expect(() => createCatalogue({ ...fixtureIndex, entries: [liveEntry, { ...twin, name: `${liveEntry.name} (another source)` }] })).not.toThrow();
  });

  it("rejects a crosswalk file reference that does not resolve, including a prototype name", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, crosswalks: {} })).toBe(false);
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [{ ...deadEntry, crosswalk: { file: "constructor.json" } }] })).toBe(false);
  });

  it("rejects a crosswalk file whose target is not the entry's category", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, crosswalks: { "crosswalks/graph-v1/topology.json": { ...topologyCrosswalk, target: "graph/v2" } } })).toBe(false);
  });

  it("rejects a crosswalk that fails crossmap's structural validation", () => {
    const duplicateTarget = { ...topologyCrosswalk, rules: [...topologyCrosswalk.rules, { op: "move", from: "extra", to: "meta" }] };
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, crosswalks: { "crosswalks/graph-v1/topology.json": duplicateTarget } })).toBe(false);
  });
});

/** Entries in two collections that share leaf names, so the short forms of a name can be ambiguous: `shared` is in `one/inner` and in `two`, and `lone` is only in `one/inner`. */
const inOne = { ...liveEntry, id: "one-shared", name: "Entry one-shared", namespace: ["one", "inner"], aliases: ["shared"] };
const inTwo = { ...liveEntry, id: "two-shared", name: "Entry two-shared", namespace: ["two"], aliases: ["shared"] };
const onlyInOne = { ...liveEntry, id: "one-lone", name: "Entry one-lone", namespace: ["one", "inner"], aliases: ["lone"] };
const namespaced = createCatalogue({ ...fixtureIndex, entries: [inOne, inTwo, onlyInOne] });

describe("namespaces and aliases", () => {
  it("resolves an entry's own id", () => {
    expect(namespaced.getDataset("one-shared").entry.id).toBe("one-shared");
  });

  it("resolves an alias, and every qualified form of it, to the entry when the name is unambiguous", () => {
    for (const name of ["lone", "inner/lone", "one/inner/lone", "one-lone", "inner/one-lone", "one/inner/one-lone"]) {
      expect(namespaced.getDataset(name).entry.id).toBe("one-lone");
    }
  });

  it("resolves a name that is ambiguous at its short forms once it is qualified far enough", () => {
    expect(namespaced.getDataset("one/inner/shared").entry.id).toBe("one-shared");
    expect(namespaced.getDataset("inner/shared").entry.id).toBe("one-shared");
    expect(namespaced.getDataset("two/shared").entry.id).toBe("two-shared");
  });

  it("refuses an ambiguous name, naming the entries it could mean", () => {
    expect(() => namespaced.getDataset("shared")).toThrow(DatasetAmbiguousError);
    expect(() => namespaced.getDataset("shared")).toThrow(/one-shared, two-shared/);
    expect(() => namespaced.getDataset("shared")).toThrow(expect.objectContaining({ requested: "shared", candidateIds: ["one-shared", "two-shared"] }));
  });

  it("answers an entry's own id ahead of an alias or a short form that another entry also answers to", () => {
    const wins = createCatalogue({ ...fixtureIndex, entries: [{ ...liveEntry, id: "g53" }, { ...liveEntry, id: "ss-gset-g53", name: "Entry ss-gset-g53", namespace: ["suitesparse", "gset"], aliases: ["g53"] }] });
    expect(wins.getDataset("g53").entry.id).toBe("g53");
    expect(wins.getDataset("gset/g53").entry.id).toBe("ss-gset-g53");
  });

  it("does not resolve a name that no entry answers to, including part of a path and a prototype name", () => {
    for (const name of ["inner", "one/inner", "one/shared", "nope/lone", "/lone", "lone/", "constructor", "__proto__"]) {
      expect(() => namespaced.getDataset(name)).toThrow(DatasetNotFoundError);
    }
  });

  it("filters by a namespace and everything beneath it, on whole segments", () => {
    const ids = (namespace: string): string[] => namespaced.listDatasets({ namespace }).map((dataset) => dataset.entry.id);
    expect(ids("one")).toEqual(["one-lone", "one-shared"]);
    expect(ids("one/inner")).toEqual(["one-lone", "one-shared"]);
    expect(ids("two")).toEqual(["two-shared"]);
    expect(ids("on")).toEqual([]);
    expect(ids("one/in")).toEqual([]);
  });

  it("finds an entry by an alias or its namespace in a text search", () => {
    expect(namespaced.listDatasets({ text: "lone" }).map((dataset) => dataset.entry.id)).toEqual(["one-lone"]);
    expect(namespaced.listDatasets({ text: "inner" }).map((dataset) => dataset.entry.id)).toEqual(["one-lone", "one-shared"]);
  });

  it("rejects two entries whose fully qualified names are the same", () => {
    const twin = { ...liveEntry, id: "twin", name: "Entry twin", namespace: ["one", "inner"], aliases: ["lone"] };
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [onlyInOne, twin] })).toBe(false);
  });

  it("rejects an alias that is another entry's id, which a lookup would reach instead", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [liveEntry, { ...deadEntry, aliases: ["karate"] }] })).toBe(false);
  });

  it("accepts the same alias under different namespaces, and under none beside a namespaced entry's alias", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [inOne, inTwo] })).toBe(true);
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [inOne, { ...deadEntry, aliases: ["shared"] }] })).toBe(true);
  });
});

describe("entries that hold the same data", () => {
  const first = { ...liveEntry, id: "first", name: "Entry first", sameDataAs: ["second"] };
  const second = { ...liveEntry, id: "second", name: "Entry second", sameDataAs: ["first"] };

  it("accepts entries that name each other", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [first, second] })).toBe(true);
  });

  it("rejects a name that is not an entry of the catalogue", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [first] })).toBe(false);
  });

  it("rejects an entry the other does not name back", () => {
    const bare = Object.fromEntries(Object.entries(second).filter(([key]) => key !== "sameDataAs"));
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [first, bare] })).toBe(false);
  });
});

/** Entries for grouping: `bar` is in `home/deep`, listed also under `foo/graphs` and `one` by path aliases, and `baz` is in `foo/graphs` only, so the tree has three depths and an entry in two branches. */
const bar = { ...liveEntry, id: "bar", name: "Entry bar", namespace: ["home", "deep"], aliases: ["foo/graphs/bar", "one/bar"] };
const baz = { ...liveEntry, id: "baz", name: "Entry baz", namespace: ["foo", "graphs"] };
const grouped = createCatalogue({ ...fixtureIndex, manifest: { ...fixtureIndex.manifest, namespaceAliases: { foo: ["f"], graphs: ["g"] } }, entries: [bar, baz] });

describe("grouped aliases", () => {
  it("resolves a path alias and each trailing form of it to the entry", () => {
    for (const name of ["bar", "graphs/bar", "foo/graphs/bar", "one/bar", "deep/bar", "home/deep/bar"]) {
      expect(grouped.getDataset(name).entry.id).toBe("bar");
    }
  });

  it("does not drop a middle segment of a path alias", () => {
    expect(() => grouped.getDataset("foo/bar")).toThrow(DatasetNotFoundError);
    expect(() => grouped.getDataset("home/bar")).toThrow(DatasetNotFoundError);
  });

  it("refuses a short form that a grouped alias makes ambiguous, and resolves it once qualified", () => {
    const clash = createCatalogue({ ...fixtureIndex, entries: [bar, { ...baz, id: "bar2", namespace: ["other", "graphs"], aliases: ["bar"] }] });
    expect(() => clash.getDataset("graphs/bar")).toThrow(DatasetAmbiguousError);
    expect(clash.getDataset("foo/graphs/bar").entry.id).toBe("bar");
    expect(clash.getDataset("other/graphs/bar").entry.id).toBe("bar2");
  });

  it("lists an entry under every group it is in, and every group above", () => {
    const ids = (namespace: string): string[] => grouped.listDatasets({ namespace }).map((dataset) => dataset.entry.id);
    expect(ids("home")).toEqual(["bar"]);
    expect(ids("home/deep")).toEqual(["bar"]);
    expect(ids("foo")).toEqual(["bar", "baz"]);
    expect(ids("foo/graphs")).toEqual(["bar", "baz"]);
    expect(ids("one")).toEqual(["bar"]);
    expect(ids("foo/graphs/bar")).toEqual([]);
  });

  it("finds an entry by a group a path alias files it in, in a text search", () => {
    expect(grouped.listDatasets({ text: "one" }).map((dataset) => dataset.entry.id)).toEqual(["bar"]);
  });

  it("rejects an entry whose path alias gives a name another entry already has", () => {
    expect(CatalogueIndexSchema.is({ ...fixtureIndex, entries: [bar, { ...baz, id: "bar3", namespace: ["x"], aliases: ["foo/graphs/bar"] }] })).toBe(false);
  });
});

describe("namespace segment aliases", () => {
  it("resolves a name with an alias in a segment's place, and a segment alias anywhere in the path", () => {
    expect(grouped.getDataset("f/graphs/bar").entry.id).toBe("bar");
    expect(grouped.getDataset("f/g/bar").entry.id).toBe("bar");
    expect(grouped.getDataset("g/bar").entry.id).toBe("bar");
    expect(grouped.getDataset("f/g/baz").entry.id).toBe("baz");
  });

  it("accepts a segment alias in the namespace filter and in listNamespaces", () => {
    expect(grouped.listDatasets({ namespace: "f/g" }).map((dataset) => dataset.entry.id)).toEqual(["bar", "baz"]);
    expect(grouped.listNamespaces("f").map((node) => node.path)).toEqual(["foo/graphs"]);
  });

  it("rejects an alias for a segment no entry has, and an alias that is already a segment", () => {
    const withAliases = (namespaceAliases: Record<string, string[]>) => ({ ...fixtureIndex, manifest: { ...fixtureIndex.manifest, namespaceAliases }, entries: [bar, baz] });
    expect(CatalogueIndexSchema.is(withAliases({ nothing: ["n"] }))).toBe(false);
    expect(CatalogueIndexSchema.is(withAliases({ foo: ["home"] }))).toBe(false);
    expect(CatalogueIndexSchema.is(withAliases({ foo: ["f"] }))).toBe(true);
  });
});

describe("listNamespaces", () => {
  it("lists the outermost namespaces in path order, each with the entries at or beneath it", () => {
    expect(grouped.listNamespaces()).toEqual([
      { path: "foo", name: "foo", count: 2 },
      { path: "home", name: "home", count: 1 },
      { path: "one", name: "one", count: 1 },
    ]);
  });

  it("lists the namespaces directly beneath a path, at any depth", () => {
    expect(grouped.listNamespaces("foo")).toEqual([{ path: "foo/graphs", name: "graphs", count: 2 }]);
    expect(grouped.listNamespaces("home")).toEqual([{ path: "home/deep", name: "deep", count: 1 }]);
  });

  it("lists nothing beneath a leaf or a path that does not exist, and for a catalogue with no namespaces", () => {
    expect(grouped.listNamespaces("home/deep")).toEqual([]);
    expect(grouped.listNamespaces("nope")).toEqual([]);
    expect(grouped.listNamespaces("constructor")).toEqual([]);
    expect(catalogue.listNamespaces()).toEqual([]);
  });

  it("counts an entry once however many of a namespace's groups it is in", () => {
    const twice = createCatalogue({ ...fixtureIndex, entries: [{ ...liveEntry, id: "twice", name: "Entry twice", namespace: ["a", "x"], aliases: ["a/y/twice"] }] });
    expect(twice.listNamespaces()).toEqual([{ path: "a", name: "a", count: 1 }]);
    expect(twice.listNamespaces("a")).toEqual([
      { path: "a/x", name: "x", count: 1 },
      { path: "a/y", name: "y", count: 1 },
    ]);
  });
});

describe("the bundled catalogue", () => {
  it("is the keepset catalogue", () => {
    expect(getManifest()).toMatchObject({ id: "keepset", repository: "https://github.com/Mearman/keepset" });
  });

  it("answers listDatasets and getDataset consistently", () => {
    for (const dataset of listDatasets()) {
      expect(getDataset(dataset.entry.id)).toBe(dataset);
    }
    expect(() => getDataset("no-such-entry")).toThrow(DatasetNotFoundError);
  });
});
