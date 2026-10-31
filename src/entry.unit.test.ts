import { describe, expect, it } from "vitest";
import { EntrySchema, parseEntry, SourceSchema, waybackUrl } from "./entry";
import { CatalogueSyntaxError } from "./errors";
import { serialise } from "./serialise";
import { arcgisEntry, deadEntry, everyEntryShape, graphCollectionEntry, liveEntry, ogbEntry, taskCollectionEntry, taskEntry } from "./test-support/entries";

const requiredFields = ["id", "name", "tags", "category", "sources", "licence", "citations", "recipe", "crosswalk", "expectedCounts", "properties"] as const;

function without(doc: Readonly<Record<string, unknown>>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(doc).filter(([key]) => key !== field));
}

describe("the entry format", () => {
  it("round-trips representative entries through parse and serialise", () => {
    for (const doc of everyEntryShape) {
      const text = serialise(parseEntry(doc));
      const parsed = parseEntry(JSON.parse(text));
      expect(parsed).toEqual(doc);
      expect(serialise(parsed)).toBe(text);
      expect(EntrySchema.is(doc)).toBe(true);
    }
  });

  it.each(requiredFields)("rejects an entry missing %s", (field) => {
    expect(() => parseEntry(without(liveEntry, field))).toThrow(CatalogueSyntaxError);
  });

  it("accepts an entry without the optional description and domain", () => {
    expect(EntrySchema.is(without(without(liveEntry, "description"), "domain"))).toBe(true);
  });

  it("rejects an entry whose category names no known category, at the category path", () => {
    let caught: unknown;
    try {
      parseEntry({ ...liveEntry, category: "graph/v9" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(CatalogueSyntaxError);
    expect(caught instanceof CatalogueSyntaxError ? caught.issues.map((issue) => issue.path) : []).toContain("category");
  });

  it("rejects an inline crosswalk whose target is not the entry's category", () => {
    expect(EntrySchema.is({ ...liveEntry, crosswalk: { ...liveEntry.crosswalk, target: "graph/v2" } })).toBe(false);
  });

  it("rejects a recipe naming a source the entry does not have", () => {
    expect(EntrySchema.is({ ...liveEntry, recipe: { ...liveEntry.recipe, source: 1 } })).toBe(false);
  });

  it("rejects an edge-list parser whose source and target columns coincide", () => {
    expect(EntrySchema.is({ ...liveEntry, recipe: { ...liveEntry.recipe, parser: { ...liveEntry.recipe.parser, targetColumn: 0 } } })).toBe(false);
  });

  it("accepts a paged geojson recipe, and rejects a geojson parser whose columns contradict each other", () => {
    expect(EntrySchema.is(arcgisEntry)).toBe(true);
    const withParser = (parser: Record<string, unknown>): unknown => ({ ...arcgisEntry, recipe: { ...arcgisEntry.recipe, parser: { ...arcgisEntry.recipe.parser, ...parser } } });
    expect(EntrySchema.is(withParser({ columns: ["FINE", "FINE"] }))).toBe(false);
    expect(EntrySchema.is(withParser({ columns: ["geometry_latitude", "geometry_longitude", "OPENED", "KIND", "OBJECTID"] }))).toBe(false);
    expect(EntrySchema.is(withParser({ columns: ["geometry_latitude", "geometry_longitude", "OPENED", "KIND"] }))).toBe(false);
    expect(EntrySchema.is(withParser({ dateColumns: ["FINE"] }))).toBe(false);
    expect(EntrySchema.is(withParser({ columns: [] }))).toBe(false);
  });

  it("rejects a paging that is not a known kind or orders by something that is not a field name", () => {
    expect(EntrySchema.is({ ...arcgisEntry, recipe: { ...arcgisEntry.recipe, paging: { kind: "offset", orderBy: "OBJECTID" } } })).toBe(false);
    expect(EntrySchema.is({ ...arcgisEntry, recipe: { ...arcgisEntry.recipe, paging: { kind: "arcgis-query", orderBy: "OBJECTID; DROP" } } })).toBe(false);
  });

  it("rejects archive member and crosswalk paths that climb out of their directory", () => {
    expect(EntrySchema.is({ ...deadEntry, recipe: { ...deadEntry.recipe, archive: { kind: "zip", member: { path: "../outside.net" } } } })).toBe(false);
    expect(EntrySchema.is({ ...deadEntry, crosswalk: { file: "/etc/crosswalk.json" } })).toBe(false);
  });

  it("rejects record keys Object.prototype would react to", () => {
    const properties: unknown = JSON.parse('{"__proto__": 1}');
    expect(EntrySchema.is({ ...liveEntry, properties })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, properties: { constructor: 1 } })).toBe(true);
  });

  it("rejects expected counts for a collection the category does not count", () => {
    expect(EntrySchema.is({ ...liveEntry, expectedCounts: { meta: 1 } })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, expectedCounts: { constructor: 1 } })).toBe(false);
  });

  it("rejects properties that would overwrite the id or name a fetched result's meta takes from the entry", () => {
    expect(EntrySchema.is({ ...liveEntry, properties: { id: "other" } })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, properties: { name: "other" } })).toBe(false);
  });

  it("accepts an http URL on an address or a single-label host", () => {
    expect(EntrySchema.is({ ...liveEntry, sources: [{ ...liveEntry.sources[0], url: "http://127.0.0.1:8080/net.txt" }] })).toBe(true);
    expect(EntrySchema.is({ ...liveEntry, sources: [{ ...liveEntry.sources[0], url: "http://datastore/net.txt" }] })).toBe(true);
  });

  it("rejects a download URL that is not http or https", () => {
    expect(EntrySchema.is({ ...liveEntry, sources: [{ ...liveEntry.sources[0], url: "file:///scratch/cache.zip" }] })).toBe(false);
  });
});

/** A SHA-256 is 64 hex digits. */
const SHA256_DIGITS = 64;

describe("a source's snapshot", () => {
  const url = "http://example.edu/data/net.zip";

  it("is required when the source is dead", () => {
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "dead" }).success).toBe(false);
  });

  it("may pin a live source", () => {
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "live", snapshot: { url: waybackUrl("20061110114126", url), timestamp: "20061110114126" } }).success).toBe(true);
  });

  it("records its checksum as a SHA-256 and a length, together or not at all", () => {
    const snapshot = { url: waybackUrl("20061110114126", url), timestamp: "20061110114126" };
    const hash = "a".repeat(SHA256_DIGITS);
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "live", snapshot: { ...snapshot, sha256: hash, byteLength: 0 } }).success).toBe(true);
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "live", snapshot: { ...snapshot, sha256: hash } }).success).toBe(false);
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "live", snapshot: { ...snapshot, byteLength: 4 } }).success).toBe(false);
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "live", snapshot: { ...snapshot, sha256: "A".repeat(SHA256_DIGITS), byteLength: 4 } }).success).toBe(false);
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "live", snapshot: { ...snapshot, sha256: "a".repeat(SHA256_DIGITS - 1), byteLength: 4 } }).success).toBe(false);
  });

  it("must be the Wayback URL of this source at its own timestamp", () => {
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "dead", snapshot: { url: waybackUrl("20230601", url), timestamp: "20230602" } }).success).toBe(false);
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "dead", snapshot: { url: waybackUrl("20230601", "http://example.edu/other.zip"), timestamp: "20230601" } }).success).toBe(false);
  });

  it("rejects a timestamp that is not a Wayback timestamp", () => {
    expect(SourceSchema.safeParse({ url, retrieved: "2026-04-19", status: "dead", snapshot: { url: waybackUrl("2023-06-01", url), timestamp: "2023-06-01" } }).success).toBe(false);
  });
});

describe("an entry's namespace and aliases", () => {
  it("accepts a namespace and aliases, and round-trips them through parse and serialise", () => {
    const doc = { ...liveEntry, namespace: ["suitesparse", "gset"], aliases: ["g53"] };
    expect(parseEntry(JSON.parse(serialise(parseEntry(doc))))).toEqual(parseEntry(doc));
  });

  it("refuses a namespace segment that is not an id, so none can contain the separator", () => {
    for (const bad of ["a/b", "", "_x", "has space"]) {
      expect(EntrySchema.is({ ...liveEntry, namespace: [bad] })).toBe(false);
    }
  });

  it("accepts an alias that is an id or a path of ids, and refuses any other", () => {
    for (const good of ["short", "a/b", "foo/graphs/bar", "a.b/c_d-e"]) {
      expect(EntrySchema.is({ ...liveEntry, aliases: [good] })).toBe(true);
    }
    for (const bad of ["", "_x", "has space", "/a", "a/", "a//b", "a/_b", "a/b/"]) {
      expect(EntrySchema.is({ ...liveEntry, aliases: [bad] })).toBe(false);
    }
  });

  it("refuses an id and aliases that give the same fully qualified name twice", () => {
    expect(EntrySchema.is({ ...liveEntry, namespace: ["a", "b"], aliases: [`a/b/${liveEntry.id}`] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, namespace: ["a", "b"], aliases: ["a/b/x", "x"] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, namespace: ["a", "b"], aliases: ["a/x", "x"] })).toBe(true);
  });

  it("refuses an empty namespace and an empty alias list, so absence has one form", () => {
    expect(EntrySchema.is({ ...liveEntry, namespace: [] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, aliases: [] })).toBe(false);
  });

  it("refuses a repeated alias and an alias equal to the entry's own id", () => {
    expect(EntrySchema.is({ ...liveEntry, aliases: ["short", "short"] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, aliases: [liveEntry.id] })).toBe(false);
  });
});

describe("an entry's sameDataAs", () => {
  it("accepts the ids of other entries and round-trips them through parse and serialise", () => {
    const doc = { ...liveEntry, sameDataAs: ["other-one", "other-two"] };
    expect(parseEntry(JSON.parse(serialise(parseEntry(doc))))).toEqual(parseEntry(doc));
  });

  it("refuses an empty list, a repeated id, the entry's own id and a name that is not an id", () => {
    expect(EntrySchema.is({ ...liveEntry, sameDataAs: [] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, sameDataAs: ["other", "other"] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, sameDataAs: [liveEntry.id] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, sameDataAs: ["has space"] })).toBe(false);
  });
});

describe("an archive that selects one file or every file", () => {
  const withArchive = (base: typeof taskEntry | typeof taskCollectionEntry, archive: unknown): unknown => ({ ...base, recipe: { ...base.recipe, archive } });
  const issues = (doc: unknown): string => {
    try {
      parseEntry(doc);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }

    return "";
  };

  it("accepts a recipe that selects one member and a recipe that selects its members, for any category", () => {
    expect(issues(withArchive(taskEntry, { kind: "zip", member: { extensions: [".csv"] } }))).toBe("");
    expect(issues(taskCollectionEntry)).toBe("");
    expect(issues(graphCollectionEntry)).toBe("");
    expect(issues({ ...withArchive(taskEntry, { kind: "zip", members: { extensions: [".csv"] } }) as object, expectedCounts: {} })).toBe("");
  });

  it("limits the counts a collection records to its instances and a document's to its own arrays", () => {
    expect(issues({ ...taskCollectionEntry, expectedCounts: { nodes: 3 } })).toMatch(/tasks\/v1 collections count only instances/);
    expect(issues({ ...taskEntry, expectedCounts: { instances: 3 } })).toMatch(/tasks\/v1 counts only nodes/);
    expect(issues({ ...graphCollectionEntry, expectedCounts: { instances: 4 } })).toBe("");
  });

  it("accepts a pattern selector and refuses one that is not a regular expression", () => {
    expect(issues(withArchive(taskCollectionEntry, { kind: "zip", members: { pattern: "suite/data_\\d+\\.txt" } }))).toBe("");
    expect(issues(withArchive(taskCollectionEntry, { kind: "zip", members: { pattern: "suite/(data" } }))).toMatch(/must be a valid regular expression/);
    expect(issues(withArchive(taskCollectionEntry, { kind: "zip", members: { pattern: "" } }))).not.toBe("");
  });

  it("accepts one member unpacked by an inner archive, and refuses an inner archive anywhere else or nested deeper", () => {
    const inner = { kind: "zip", member: { path: "challenge/prob1.gd4" } };
    expect(issues(withArchive(taskEntry, { kind: "zip", member: { extensions: [".zip"] }, inner }))).toBe("");
    expect(issues(withArchive(taskEntry, { kind: "tar.gz", member: { path: "net.txt.gz" }, inner: { kind: "gzip" } }))).toBe("");
    expect(issues(withArchive(taskCollectionEntry, { kind: "zip", members: { extensions: [".zip"] }, inner }))).not.toBe("");
    expect(issues(withArchive(taskEntry, { kind: "gzip", inner }))).not.toBe("");
    expect(issues(withArchive(taskEntry, { kind: "zip", member: { extensions: [".zip"] }, inner: { ...inner, inner } }))).not.toBe("");
    expect(issues(withArchive(taskEntry, { kind: "zip", member: { extensions: [".zip"] }, inner: { kind: "none" } }))).not.toBe("");
  });

  it("gives a files archive only to a multi-file parser, and a multi-file parser only a files archive", () => {
    expect(issues(ogbEntry)).toBe("");
    expect(issues({ ...ogbEntry, recipe: { ...ogbEntry.recipe, parser: liveEntry.recipe.parser } })).toMatch(/a files archive is read by a multi-file parser \(ogb, member-text, nxt-words, eaf, textgrid, option-list, chat\)/);
    expect(issues({ ...ogbEntry, recipe: { ...ogbEntry.recipe, archive: { kind: "zip", member: { path: "raw/edge.csv.gz" }, inner: { kind: "gzip" } } } })).toMatch(/a files archive is read by a multi-file parser/);
    expect(issues({ ...ogbEntry, recipe: { ...ogbEntry.recipe, archive: { kind: "zip", members: { extensions: [".gz"] } } } })).toMatch(/a files archive is read by a multi-file parser/);
    expect(issues({ ...ogbEntry, recipe: { ...ogbEntry.recipe, archive: { ...ogbEntry.recipe.archive, inner: { kind: "zip", member: { path: "x" } } } } })).not.toBe("");
    const memberText = { format: "member-text", encoding: "utf-8", idPattern: "(?:.*/)?([^/]+)\\.txt" };
    expect(issues({ ...ogbEntry, recipe: { ...ogbEntry.recipe, parser: memberText, archive: { kind: "tar.gz", files: { pattern: ".*\\.txt" } } } })).toBe("");
    expect(issues({ ...ogbEntry, recipe: { ...ogbEntry.recipe, parser: { ...memberText, idPattern: "(" }, archive: { kind: "tar.gz", files: { pattern: ".*\\.txt" } } } })).not.toBe("");
  });

  it("accepts a files archive whose members are archives in their turn, with a selector for the files inside", () => {
    const textGrid = { format: "textgrid", encoding: "utf-8", idPattern: "(?:.*/)?([^/]+)\\.TextGrid", tier: "words" };
    const nested = { kind: "tar.gz", files: { extensions: [".zip"] }, inner: { kind: "zip", files: { extensions: [".TextGrid"] } } };
    const entry = (parser: unknown, archive: unknown): unknown => ({ ...ogbEntry, recipe: { ...ogbEntry.recipe, parser, archive } });
    expect(issues(entry(textGrid, nested))).toBe("");
    expect(issues(entry(textGrid, { ...nested, inner: { kind: "zip" } }))).not.toBe("");
    expect(issues(entry(textGrid, { ...nested, inner: { kind: "gzip", files: { extensions: [".TextGrid"] } } }))).not.toBe("");
    expect(issues(entry(textGrid, { ...nested, inner: { kind: "zip", files: { extensions: [".TextGrid"] }, inner: { kind: "gzip" } } }))).not.toBe("");
    expect(issues(entry({ ...textGrid, tier: "" }, nested))).not.toBe("");
    expect(issues(entry({ ...textGrid, encoding: "utf-16" }, nested))).not.toBe("");
  });

  it("gives a files recipe's multi-file parser only files archives, and its single-file parser none", () => {
    const filesEntry = (parser: unknown, archive: unknown): unknown => ({ ...ogbEntry, expectedCounts: {}, recipe: { status: "fetchable", files: [{ path: "split", source: 0, archive }], parser } });
    const textGrid = { format: "textgrid", encoding: "utf-8", idPattern: "(?:.*/)?([^/]+)\\.TextGrid" };
    expect(issues(filesEntry(textGrid, { kind: "tar.gz", files: { pattern: "near/[^/]+\\.TextGrid" } }))).toBe("");
    expect(issues(filesEntry({ ...textGrid, tier: "c1" }, { kind: "tar.gz", files: { pattern: "near/[^/]+\\.TextGrid" } }))).toBe("");
    expect(issues(filesEntry(textGrid, { kind: "tar.gz", members: { pattern: "near/[^/]+\\.TextGrid" } }))).toMatch(/a files archive is read by/);
    expect(issues(filesEntry(liveEntry.recipe.parser, { kind: "tar.gz", files: { pattern: ".*" } }))).toMatch(/a files archive is read by/);
  });

  it("gives a nested json-table layout levels and no id field, and any other layout an id field and no levels", () => {
    const table = { format: "json-table", encoding: "utf-8", layout: "nested", levels: ["class", "file"], fields: ["speakerID"] };
    const entry = (parser: unknown): unknown => ({ ...liveEntry, recipe: { ...liveEntry.recipe, parser } });
    expect(issues(entry(table))).toBe("");
    expect(issues(entry({ ...table, idField: "id" }))).toMatch(/names a record by its keys/);
    expect(issues(entry({ ...table, layout: "array", idField: "id" }))).toMatch(/levels name the keys above the records of a nested layout/);
    expect(issues(entry({ ...table, layout: "array", levels: undefined }))).toMatch(/names a record by its keys/);
    expect(issues(entry({ ...table, levels: undefined }))).toMatch(/levels name the keys/);
    expect(issues(entry({ ...table, levels: ["class", "class"] }))).toMatch(/must not repeat another level/);
    expect(issues(entry({ ...table, levels: ["class", "speakerID"] }))).toMatch(/must not repeat another level/);
    expect(issues(entry({ ...table, levels: ["id"] }))).toMatch(/must not repeat another level/);
  });

  it("accepts edge-list where conditions, and refuses an empty list or an empty value", () => {
    const withWhere = (where: unknown): unknown => ({ ...liveEntry, recipe: { ...liveEntry.recipe, parser: { ...liveEntry.recipe.parser, where } } });
    expect(issues(withWhere([{ column: 12, equals: "physical" }]))).toBe("");
    expect(issues(withWhere([]))).not.toBe("");
    expect(issues(withWhere([{ column: 12, equals: "" }]))).not.toBe("");
    expect(issues(withWhere([{ column: -1, equals: "physical" }]))).not.toBe("");
  });

  it("rejects an archive that names both a member and members, or an unknown kind", () => {
    expect(issues(withArchive(taskCollectionEntry, { kind: "zip", member: { extensions: [".csv"] }, members: { extensions: [".csv"] } }))).not.toBe("");
    expect(issues(withArchive(taskCollectionEntry, { kind: "rar", members: { extensions: [".csv"] } }))).not.toBe("");
  });
});

describe("an entry's subjects", () => {
  it("accepts one or more subject slugs, and none", () => {
    expect(EntrySchema.is({ ...liveEntry, subjects: ["operations-research"] })).toBe(true);
    expect(EntrySchema.is({ ...liveEntry, subjects: ["network-science", "social-science"] })).toBe(true);
    expect(EntrySchema.is(without(liveEntry, "subjects"))).toBe(true);
  });

  it("refuses a subject that is not a lowercase slug, an empty list and a repeated subject", () => {
    for (const bad of ["Operations Research", "operations_research", "-operations", "operations-", "operations--research", "1research", ""]) {
      expect(EntrySchema.is({ ...liveEntry, subjects: [bad] })).toBe(false);
    }
    expect(EntrySchema.is({ ...liveEntry, subjects: [] })).toBe(false);
    expect(EntrySchema.is({ ...liveEntry, subjects: ["network-science", "network-science"] })).toBe(false);
  });
});
