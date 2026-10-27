import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseCrosswalk } from "crossmap";
import { describe, expect, it } from "vitest";
import { createCatalogue } from "../../src/catalogue";
import { fetchEntry, roundTripEntry } from "../../src/node/fetch-dataset";
import { zip } from "../../src/test-support/archives";
import { fixtureManifest } from "../../src/test-support/entries";
import { convertItem, convertSurvey, MAX_CELLS, PAGE_ROWS, pagingOf, SUBJECT } from "./convert-or";
import { licenceMetadata } from "./licence";
import { CurationItemSchema, NotFetchableOutcomeSchema, SurveySourceSchema, TARGET_FIELD_NAMES, TARGET_FIELDS } from "./or-survey";

const STATED = { licence: { kind: "spdx", id: "CC-BY-4.0" }, statedAt: "https://example.org/requests", statement: "The page says the data are licensed under CC BY 4.0." };
const UNSTATED = { readAt: ["https://example.org/about"], reason: "The page states no licence." };

const survey = SurveySourceSchema.parse({
  survey: "a survey",
  surveyed: "2026-07-23",
  entries: [
    { id: "or-10", title: "Service requests", url: "https://example.org/requests", theme: "case lifecycle records: permits, inspections, prosecutions & enforcement", fields: ["location", "lifecycle"] },
    { id: "or-2", title: "Classic instances", url: "https://example.org/instances", theme: "selection + prize + travel — orienteering family", fields: ["prize", "location"] },
  ],
});

/** The file's header cells as it writes them: the parser names the last one Private_note and the one called id column_8, since id is the row's id. */
const header = ["request_id", "status", "latitude", "longitude", "minutes", "district", "Private note", "id"];
const fetchable = {
  status: "fetchable",
  encoding: "utf-8",
  delimiter: "comma",
  skipLines: 0,
  idColumn: "request_id",
  numericColumns: [
    { column: "latitude", factor: 1 },
    { column: "longitude", factor: 1 },
    { column: "minutes", factor: 60 },
  ],
  header,
  map: { status: "status", lat: "latitude", lon: "longitude", duration: "minutes", territory: "district" },
};
const curation = {
  probedOn: "2026-10-19",
  items: [
    { surveyId: "or-10", id: "example-service-requests", namespace: "example", name: "Service requests", description: "Requests raised with a city.", licence: STATED, downloadUrl: "https://example.org/requests.csv", flags: ["personal data in one column, not mapped"], outcome: fetchable },
    { surveyId: "or-2", id: "classic-instances", namespace: "example", name: "Classic instances", description: "Benchmark instances from a classic paper.", citations: [{ text: "A. Author (1990). Classic instances. Journal of Examples 1." }], licence: UNSTATED, flags: [], outcome: { status: "not-fetchable", reason: "the instances are in a text format with no parser yet" } },
  ],
};

/** The cells each row of the fixture table keeps: its five mapped columns and its id. */
const CELLS_PER_ROW = 6;

const none: ReadonlySet<string> = new Set();

/** The curation with the first item's fetchable outcome changed by a patch. */
function withFirst(patch: Readonly<Record<string, unknown>>): unknown {
  return { ...curation, items: [{ ...curation.items[0], outcome: { ...fetchable, ...patch } }, curation.items[1]] };
}

/** The message of the error converting a curation raises. */
function problem(document: unknown, taken: ReadonlySet<string> = none): string {
  try {
    convertSurvey(survey, document, taken);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the conversion to fail");
}

describe("convertSurvey", () => {
  const { entries, report } = convertSurvey(survey, curation, none);
  const requests = entries.find((entry) => entry.id === "example-service-requests");
  const instances = entries.find((entry) => entry.id === "classic-instances");

  it("files every entry under the operations-research subject, whichever theme its item sits in", () => {
    expect(entries.map((entry) => entry.subjects)).toEqual([[SUBJECT], [SUBJECT]]);
  });

  it("carries a curation's description and citations into the entry, and no citations where the source names none", () => {
    expect(requests?.description).toBe("Requests raised with a city.");
    expect(requests?.citations).toEqual([]);
    expect(instances?.description).toBe("Benchmark instances from a classic paper.");
    expect(instances?.citations).toEqual([{ text: "A. Author (1990). Classic instances. Journal of Examples 1." }]);
  });

  it("refuses an item without a description, or with a blank one", () => {
    const undescribed = Object.fromEntries(Object.entries(curation.items[0] ?? {}).filter(([key]) => key !== "description"));
    expect(problem({ ...curation, items: [undescribed, curation.items[1]] })).toMatch(/"description"[^]*expected string, received undefined/);
    expect(problem({ ...curation, items: [{ ...curation.items[0], description: "  " }, curation.items[1]] })).toMatch(/must not be blank/);
  });

  it("makes an entry for every surveyed item, in id order, and reports each once in survey order", () => {
    expect(entries.map((entry) => entry.id)).toEqual(["classic-instances", "example-service-requests"]);
    expect(report.outcomes.map((outcome) => outcome.surveyId)).toEqual(["or-2", "or-10"]);
    expect(report.source).toEqual({ survey: "a survey", surveyed: "2026-07-23", probedOn: "2026-10-19" });
  });

  it("describes a fetchable item from the survey and its curation: namespace, alias, domain, tags, sources, licence and recipe", () => {
    expect(requests).toMatchObject({
      namespace: ["example"],
      aliases: ["service-requests"],
      domain: "Case records",
      tags: ["location", "lifecycle"],
      category: "tasks/v1",
      licence: { kind: "spdx", id: "CC-BY-4.0" },
      properties: { surveyId: "or-10" },
      expectedCounts: {},
      sources: [
        { url: "https://example.org/requests", retrieved: "2026-10-19", status: "live" },
        { url: "https://example.org/requests.csv", retrieved: "2026-10-19", status: "live" },
      ],
      recipe: { status: "fetchable", source: 1, archive: { kind: "none" }, parser: { format: "csv-table", idColumn: "request_id", delimiter: "comma" } },
    });
  });

  it("records a source's own node count as the entry's expected count, and none when the curation gives none", () => {
    const counted = convertSurvey(survey, withFirst({ expectedNodes: 7 }), none).entries.find((entry) => entry.id === "example-service-requests");
    expect(counted?.expectedCounts).toEqual({ nodes: 7 });
    expect(requests?.expectedCounts).toEqual({});
  });

  it("records the rows a probe read as a probed node count only where the source is not asserted to hold a fixed count", () => {
    const entryOf = (change: Record<string, unknown>) => convertSurvey(survey, withFirst(change), none).entries.find((entry) => entry.id === "example-service-requests");
    expect(entryOf({ rowCount: 5 })?.properties).toEqual({ surveyId: "or-10", probedNodes: 5 });
    expect(entryOf({ rowCount: 5 })?.expectedCounts).toEqual({});
    expect(entryOf({ rowCount: 5, expectedNodes: 5 })?.properties).toEqual({ surveyId: "or-10" });
    expect(entryOf({})?.properties).toEqual({ surveyId: "or-10" });
  });

  it("builds a crosswalk that moves meta, ids and each mapped column, and a parser that keeps only the mapped columns", () => {
    expect(requests?.crosswalk).toEqual({
      source: "csv-table",
      target: "tasks/v1",
      rules: [
        { op: "move", from: "meta", to: "meta" },
        { op: "move", from: "nodes[].id", to: "nodes[].id" },
        { op: "move", from: "nodes[].minutes", to: "nodes[].duration" },
        { op: "move", from: "nodes[].latitude", to: "nodes[].lat" },
        { op: "move", from: "nodes[].longitude", to: "nodes[].lon" },
        { op: "move", from: "nodes[].status", to: "nodes[].status" },
        { op: "move", from: "nodes[].district", to: "nodes[].territory" },
      ],
      oneWay: [],
    });
    expect(requests?.recipe).toMatchObject({ parser: { columns: ["minutes", "latitude", "longitude", "status", "district"] } });
  });

  it("gives an item with no recipe the not-fetchable reason, one source and the shared nodes crosswalk, and no alias when its id does not start with its namespace", () => {
    expect(instances).toMatchObject({ recipe: { status: "not-fetchable", reason: "the instances are in a text format with no parser yet" }, crosswalk: { file: "crosswalks/tasks-v1/nodes.json" }, domain: "Orienteering" });
    expect(instances?.sources).toHaveLength(1);
    expect(instances?.aliases).toBeUndefined();
    expect(report.outcomes[0]).toEqual({ surveyId: "or-2", id: "classic-instances", recipe: "not-fetchable", reason: "the instances are in a text format with no parser yet", flags: [] });
    expect(report.outcomes[1]).toEqual({ surveyId: "or-10", id: "example-service-requests", recipe: "fetchable", flags: ["personal data in one column, not mapped"] });
  });

  it("records the figures a no-recipe item's publisher states, as properties", () => {
    const outcome = { status: "not-fetchable", reason: "the instances are in a text format with no parser yet", nodes: 653, instances: 9, downloadBytes: 2048, evidence: "The files API lists the zip's size." };
    const [first, second] = curation.items;
    const figured = convertSurvey(survey, { ...curation, items: [first, { ...second, outcome }] }, none).entries.find((entry) => entry.id === "classic-instances");
    expect(figured?.properties).toMatchObject({ probedNodes: 653, instanceCount: 9, downloadBytes: 2048 });
    expect(instances?.properties).not.toHaveProperty("downloadBytes");
  });

  it("refuses figures without the evidence they were read from, and evidence without figures", () => {
    const base = { status: "not-fetchable", reason: "x" };
    expect(NotFetchableOutcomeSchema.safeParse({ ...base, nodes: 1 }).success).toBe(false);
    expect(NotFetchableOutcomeSchema.safeParse({ ...base, evidence: "x" }).success).toBe(false);
    expect(NotFetchableOutcomeSchema.safeParse({ ...base, nodes: 1, evidence: "x" }).success).toBe(true);
  });

  it("builds a fetchable entry that fetches, maps only the mapped columns, and holds the round trip", async () => {
    const nodes = parseCrosswalk(JSON.parse(readFileSync(join(import.meta.dirname, "../../catalogue/crosswalks/tasks-v1/nodes.json"), "utf8")));
    const dataset = createCatalogue({ manifest: fixtureManifest, crosswalks: { "crosswalks/tasks-v1/nodes.json": nodes }, entries }).getDataset("example-service-requests");
    const port = async (): Promise<Response> => Promise.resolve(new Response("request_id,status,latitude,longitude,minutes,district,Private note,id\nr1,Open,51.5,-0.1,2,Camden,secret,x1\nr2,Closed,,,,,,\n"));
    const fetched = await fetchEntry(dataset, { fetch: port });
    expect(fetched.data).toEqual({
      meta: { id: "example-service-requests", name: "Service requests", surveyId: "or-10" },
      nodes: [
        { id: "r1", status: "Open", lat: 51.5, lon: -0.1, duration: 120, territory: "Camden" },
        { id: "r2", status: "Closed", lat: null, lon: null, duration: null, territory: null },
      ],
    });
    expect(JSON.stringify(fetched.data)).not.toContain("secret");
    expect(await roundTripEntry(dataset, { fetch: port })).toMatchObject({ holds: true });
  });
});

describe("convertSurvey refuses an inconsistent curation", () => {
  const [requests, instances] = curation.items;

  it("an item with no curation, a curation for no surveyed item, and a surveyed item curated twice", () => {
    expect(problem({ ...curation, items: curation.items.slice(1) })).toMatch(/or-10 has no curation/);
    expect(problem({ ...curation, items: [...curation.items, { ...instances, surveyId: "or-99", id: "other" }] })).toMatch(/names or-99, which the survey does not have/);
    expect(problem({ ...curation, items: [...curation.items, requests] })).toMatch(/or-10 has more than one curation/);
  });

  it("entry ids that clash within the curation or with an entry another import holds", () => {
    expect(problem({ ...curation, items: [requests, { ...instances, id: "example-service-requests" }] })).toMatch(/the entry id example-service-requests is already the id of or-2/);
    expect(problem(curation, new Set(["classic-instances"]))).toMatch(/classic-instances is already an entry of another source/);
  });

  it("a theme that matches no domain label", () => {
    const odd = SurveySourceSchema.parse({ ...survey, entries: [{ ...survey.entries[1], theme: "something else entirely" }] });
    expect(() => convertSurvey(odd, { probedOn: "2026-10-19", items: [instances] }, none)).toThrow(/matches 0 domain labels/);
  });

  it("a table read from one file with more cells than a fetch holds, and one exactly at the limit", () => {
    const longest = Math.floor(MAX_CELLS / CELLS_PER_ROW);
    expect(problem(withFirst({ rowCount: longest + 1 }))).toMatch(new RegExp(`${String(longest + 1)} rows of ${String(CELLS_PER_ROW)} kept cells.*source is one file and not paged, so it can neither be held nor streamed`));
    expect(() => convertSurvey(survey, withFirst({ rowCount: longest }), none)).not.toThrow();
  });

  it("a header whose cells get the same name, an id column the header does not have, a mapping to a missing column, one column filling two fields, and an empty map", () => {
    expect(problem(withFirst({ header: [...header, "status "] }))).toMatch(/both become the column status/);
    expect(problem(withFirst({ idColumn: "nope" }))).toMatch(/id column nope is not one of the parser's column names/);
    expect(problem(withFirst({ map: { ...fetchable.map, skill: "nowhere" } }))).toMatch(/skill maps the column nowhere/);
    expect(problem(withFirst({ map: { ...fetchable.map, skill: "status" } }))).toMatch(/the column status fills more than one field/);
    expect(problem(withFirst({ map: {} }))).toMatch(/fills no field/);
  });

  it("a number field on a column that is not numeric, a text field on one that is, and a factor on a field that takes the source's own number", () => {
    expect(problem(withFirst({ map: { ...fetchable.map, prize: "district" } }))).toMatch(/prize is a number but district is not declared numeric/);
    expect(problem(withFirst({ numericColumns: [...fetchable.numericColumns, { column: "Private_note", factor: 1 }], map: { ...fetchable.map, skill: "Private_note" } }))).toMatch(/skill is text but Private_note is declared numeric/);
    expect(problem(withFirst({ numericColumns: [{ column: "latitude", factor: 2 }, ...fetchable.numericColumns.slice(1)] }))).toMatch(/lat takes the source's own number, but latitude has the factor 2/);
  });

  it("a numeric column that fills no field or is not in the table", () => {
    expect(problem(withFirst({ numericColumns: [...fetchable.numericColumns, { column: "Private_note", factor: 1 }] }))).toMatch(/Private_note is declared numeric but fills no field/);
    expect(problem(withFirst({ numericColumns: [...fetchable.numericColumns, { column: "elsewhere", factor: 1 }] }))).toMatch(/numericColumns names elsewhere/);
  });

  it("prose with a dash as punctuation", () => {
    expect(() => convertSurvey(survey, { ...curation, items: [{ ...requests, name: "A \u2014 B" }, instances] }, none)).toThrow(/must not use a dash/);
  });
});

describe("the survey's themes and the target fields", () => {
  const real = SurveySourceSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/or-datasets-survey.json"), "utf8")));

  it("every theme of the committed survey files under exactly one domain label", () => {
    for (const item of real.entries) {
      const only = { probedOn: "2026-10-19", items: [{ surveyId: item.id, id: "x", namespace: "x", name: "x", description: "A fixture dataset.", licence: { readAt: [licenceMetadata(item.url)?.url ?? "https://example.org/about"], reason: "x" }, flags: [], outcome: { status: "not-fetchable", reason: "x" } }] };
      expect(() => convertSurvey({ ...real, entries: [item] }, only, none), item.id).not.toThrow();
    }
  });

  it("lists the target fields in code-unit order, with a kind for each", () => {
    expect([...TARGET_FIELD_NAMES]).toEqual([...TARGET_FIELD_NAMES].sort());
    expect(Object.keys(TARGET_FIELDS).sort()).toEqual([...TARGET_FIELD_NAMES]);
  });
});

describe("pagingOf", () => {
  it("pages a Socrata resource endpoint, and a CKAN datastore dump on a portal with or without a path prefix, when the URL has no query", () => {
    expect(pagingOf("https://data.example.org/resource/abcd-1234.csv")).toEqual({ kind: "socrata-resource", pageSize: PAGE_ROWS });
    expect(pagingOf("https://data.example.org/datastore/dump/0a1b2c3d-1111-2222-3333-444455556666")).toEqual({ kind: "ckan-datastore", pageSize: PAGE_ROWS });
    expect(pagingOf("https://data.example.org/data/datastore/dump/0a1b2c3d-1111-2222-3333-444455556666")).toEqual({ kind: "ckan-datastore", pageSize: PAGE_ROWS });
    expect(pagingOf("https://www.fema.gov/api/open/v3/NfipClaims?$select=id,state")).toEqual({ kind: "openfema", pageSize: PAGE_ROWS });
  });

  it("leaves every other URL as one file", () => {
    for (const url of ["https://data.example.org/resource/abcd-1234.csv?$limit=50", "https://data.example.org/datastore/dump/0a1b2c3d-1111-2222-3333-444455556666?format=csv", "https://data.example.org/datastore/dump/not-a-uuid", "https://data.example.org/api/views/abcd-1234/rows.csv?accessType=DOWNLOAD", "https://data.example.org/dataset/x/resource/0a1b2c3d/download/x.csv", "https://data.example.org/resource/abcd-1234.json", "https://www.fema.gov/about/openfema/terms-conditions", "https://other.example.org/api/open/v3/NfipClaims"]) {
      expect(pagingOf(url)).toBeUndefined();
    }
  });

  it("makes a paged recipe, at the resource's own URL, for a table read from a Socrata resource", () => {
    const [item] = survey.entries;
    const curated = CurationItemSchema.parse({ ...curation.items[0], downloadUrl: "https://data.example.org/resource/abcd-1234.csv" });
    const { entry } = convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated, "2026-10-19");
    expect(entry.sources.map((source) => source.url)).toEqual(["https://example.org/requests", "https://data.example.org/resource/abcd-1234.csv"]);
    expect(entry.recipe).toMatchObject({ status: "fetchable", source: 1, paging: { kind: "socrata-resource", pageSize: PAGE_ROWS, select: ["request_id", "minutes", "latitude", "longitude", "status", "district"] } });
    expect(entry.recipe).not.toHaveProperty("stream");
  });

  it("streams a paged table of more cells than a fetch holds, and holds one exactly at the limit", () => {
    const [item] = survey.entries;
    const longest = Math.floor(MAX_CELLS / CELLS_PER_ROW);
    const paged = (rowCount: number): ReturnType<typeof CurationItemSchema.parse> => CurationItemSchema.parse({ ...curation.items[0], downloadUrl: "https://data.example.org/resource/abcd-1234.csv", outcome: { ...fetchable, rowCount } });
    const recipe = (rowCount: number): unknown => convertItem(item ?? expect.unreachable("the fixture survey has an item"), paged(rowCount), "2026-10-19").entry.recipe;
    expect(recipe(longest + 1)).toMatchObject({ status: "fetchable", stream: true, paging: { kind: "socrata-resource" } });
    expect(recipe(longest)).not.toHaveProperty("stream");
  });

  it("refuses a Socrata selection of a kept column whose header cell is not its parser name", () => {
    const [item] = survey.entries;
    const curated = CurationItemSchema.parse({ ...curation.items[0], downloadUrl: "https://data.example.org/resource/abcd-1234.csv", outcome: { ...fetchable, map: { ...fetchable.map, skill: "Private_note" } } });
    expect(() => convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated, "2026-10-19")).toThrow(/Private_note has the header cell "Private note"/);
  });
});

describe("convertItem for a paged ArcGIS layer", () => {
  const [item] = survey.entries;
  const layer = "https://example.org/arcgis/rest/services/Violations/FeatureServer/0";
  const arcgis = {
    status: "fetchable-arcgis",
    orderBy: "OBJECTID",
    point: true,
    idColumn: "OBJECTID",
    numericColumns: [
      { column: "geometry_latitude", factor: 1 },
      { column: "geometry_longitude", factor: 1 },
      { column: "FINE", factor: 1 },
    ],
    dateColumns: ["OPENED", "UNMAPPED_DATE"],
    header: ["OBJECTID", "FINE", "OPENED", "UNMAPPED_DATE", "KIND", "OWNER"],
    map: { lat: "geometry_latitude", lon: "geometry_longitude", prize: "FINE", opened: "OPENED", skill: "KIND" },
  };
  const curated = (outcome: Record<string, unknown>, downloadUrl: string | null = layer): Parameters<typeof convertItem>[1] =>
    CurationItemSchema.parse({ surveyId: "or-10", id: "example-violations", namespace: "example", name: "Violations", description: "A fixture dataset.", licence: UNSTATED, ...(downloadUrl === null ? {} : { downloadUrl }), flags: [], outcome });
  const failure = (outcome: Record<string, unknown>, downloadUrl: string | null = layer): string => {
    try {
      convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(outcome, downloadUrl), "2026-10-19");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the conversion to fail");
  };

  it("makes a paged geojson recipe that keeps only the mapped columns, and a crosswalk that moves each onto its field", () => {
    const { entry } = convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(arcgis), "2026-10-19");
    expect(entry.sources.map((source) => source.url)).toEqual(["https://example.org/requests", layer]);
    expect(entry.recipe).toEqual({
      status: "fetchable",
      source: 1,
      paging: { kind: "arcgis-query", orderBy: "OBJECTID" },
      archive: { kind: "none" },
      parser: {
        format: "geojson",
        encoding: "utf-8",
        idColumn: "OBJECTID",
        numericColumns: arcgis.numericColumns,
        dateColumns: ["OPENED"],
        columns: ["geometry_latitude", "geometry_longitude", "OPENED", "FINE", "KIND"],
      },
    });
    expect(entry.crosswalk).toMatchObject({ source: "geojson", target: "tasks/v1", oneWay: [] });
  });

  it("refuses a layer with no URL, a date written onto a number field, a date column the layer lacks, and a property named like a point column", () => {
    expect(failure(arcgis, null)).toMatch(/needs the layer's URL as the downloadUrl/);
    expect(failure({ ...arcgis, map: { lat: "geometry_latitude", lon: "geometry_longitude", skill: "KIND", prize: "OPENED" }, numericColumns: arcgis.numericColumns.filter((numeric) => numeric.column !== "FINE") })).toMatch(/prize is a number but OPENED is a date/);
    expect(failure({ ...arcgis, dateColumns: ["MISSING"] })).toMatch(/dateColumns names MISSING/);
    expect(failure({ ...arcgis, header: [...arcgis.header, "geometry_latitude"] })).toMatch(/two columns have the same name/);
  });
});

describe("convertItem for a collection of separate files", () => {
  const item = survey.entries[0];
  const tasks = (rows: readonly string[]): string => ["Technicians:", 'Technician id 1, skills ["A"], time window [2020-02-01T09:00:00, 2020-02-01T17:00:00], investment option false', "Tasks:", ...rows, "Travel time: ", "task1task2: 1.5", ""].join("\n");
  /** The minutes the fixture tasks take, and the seconds a factor of sixty makes of them. */
  const MINUTES = { first: 30, second: 2, third: 5 } as const;
  const SECONDS_PER_MINUTE = 60;
  const task = (id: number, minutes: number): string => `Task id ${String(id)}, skills ["A"], duration ${String(minutes)}, time window [2020-02-01T09:00:00, 2020-02-01T10:00:00], priority 1, penalty 50.0, created 2020-01-01T00:00:00, modified nothing, cancelled false, relevant technician ids [1]`;
  const outcome = {
    status: "fetchable-instance-files",
    files: [
      { path: "one.txt", url: "https://example.org/files/one.txt", archive: { kind: "none" } },
      { path: "two.zip", url: "https://example.org/gone/two.zip", snapshot: "20240101000000", archive: { kind: "zip", member: { path: "two.txt" } } },
    ],
    parser: { format: "tdc", encoding: "utf-8" },
    map: { duration: "durationMinutes", skill: "skills", deadline: "latest" },
    keep: ["penalty"],
    factors: { duration: 60 },
    timeUnit: "seconds",
    expectedInstances: 2,
  };
  const curated = (patch: Readonly<Record<string, unknown>> = {}): Parameters<typeof convertItem>[1] => CurationItemSchema.parse({ surveyId: "or-10", id: "example-files", namespace: "example", name: "Files", description: "A fixture dataset.", licence: UNSTATED, flags: [], outcome: { ...outcome, ...patch } });
  const convert = (patch: Readonly<Record<string, unknown>> = {}): ReturnType<typeof convertItem> => convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(patch), "2026-10-19");

  it("makes each file a source after the item's own, a captured one dead with its snapshot, and a files recipe naming them", () => {
    const { entry } = convert();
    expect(entry.sources.slice(1)).toEqual([
      { url: "https://example.org/files/one.txt", retrieved: "2026-10-19", status: "live" },
      { url: "https://example.org/gone/two.zip", retrieved: "2026-10-19", status: "dead", snapshot: { timestamp: "20240101000000", url: "https://web.archive.org/web/20240101000000/https://example.org/gone/two.zip" } },
    ]);
    expect(entry.recipe).toEqual({ status: "fetchable", files: [{ path: "one.txt", source: 1, archive: { kind: "none" } }, { path: "two.zip", source: 2, archive: { kind: "zip", member: { path: "two.txt" } } }], parser: outcome.parser });
    expect(entry.expectedCounts).toEqual({ instances: 2 });
  });

  it("fetches each file, scales minutes to seconds and holds the round trip", async () => {
    const { entry } = convert();
    const dataset = createCatalogue({ manifest: fixtureManifest, crosswalks: {}, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the catalogue lists the entry");
    const served: Readonly<Record<string, Uint8Array | string>> = {
      "https://example.org/files/one.txt": tasks([task(1, MINUTES.first)]),
      "https://web.archive.org/web/20240101000000id_/https://example.org/gone/two.zip": zip([{ path: "two.txt", text: tasks([task(1, MINUTES.second), task(2, MINUTES.third)]) }]),
    };
    const fetch = async (url: string): Promise<Response> => Promise.resolve(Object.hasOwn(served, url) ? new Response(served[url]) : new Response("missing", { status: 404 }));
    const fetched = await fetchEntry(dataset, { fetch });
    expect("instances" in fetched.data && fetched.data.instances.map((instance) => [instance.id, instance.nodes.map((node) => node.duration)])).toEqual([
      ["one.txt", [MINUTES.first * SECONDS_PER_MINUTE]],
      ["two.zip/two.txt", [MINUTES.second * SECONDS_PER_MINUTE, MINUTES.third * SECONDS_PER_MINUTE]],
    ]);
    expect(await roundTripEntry(dataset, { fetch })).toMatchObject({ holds: true });
  });

  it("refuses both an archive and files, neither, and a factor on a field the map does not fill", () => {
    expect(() => curated({ archive: { kind: "none" } })).toThrow(/reads one download \(archive\) or separate downloads \(files\), not both or neither/);
    expect(() => curated({ files: undefined })).toThrow(/not both or neither/);
    expect(() => convert({ factors: { travelTime: 60 } })).toThrow(/factors scales travelTime, which the map does not fill/);
  });
});

describe("convertItem for a collection of instance files", () => {
  const item = survey.entries[0];
  const collection = {
    status: "fetchable-instance-files",
    archive: { kind: "zip", members: { extensions: [".txt"] } },
    parser: { format: "solomon", encoding: "utf-8" },
    map: { x: "x", y: "y", deadline: "due" },
    keep: ["demand", "service"],
    timeUnit: "abstract units",
    expectedInstances: 2,
  };
  const curated = (outcome: Record<string, unknown>): Parameters<typeof convertItem>[1] => CurationItemSchema.parse({ surveyId: "or-10", id: "example-suite", namespace: "example", name: "Suite", description: "A fixture dataset.", licence: UNSTATED, flags: [], outcome });
  const failure = (outcome: Record<string, unknown>): string => {
    try {
      convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(outcome), "2026-10-19");
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the conversion to fail");
  };
  const text = (name: string, rows: readonly string[]): string => `${name}\r\n\r\nVEHICLE\r\nNUMBER     CAPACITY\r\n 3  100\r\n\r\nCUSTOMER\r\nCUST NO.  XCOORD.\r\n\r\n${rows.join("\r\n")}\r\n \r\n`;
  const archive = zip([
    { path: "suite/B1.txt", text: text("B1", ["0 1 2 0 0 90 0", "1 3 4 5 10 20 7"]) },
    { path: "suite/A1.txt", text: text("A1", ["0 5 6 0 0 90 0"]) },
    { path: "suite/notes.md", text: "not an instance" },
  ]);

  it("makes a tasks/v1 entry whose recipe selects the members, with the fixed count and the time unit recorded", () => {
    const { entry, outcome } = convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(collection), "2026-10-19");
    expect(entry.category).toBe("tasks/v1");
    expect(entry.recipe).toEqual({ status: "fetchable", source: 0, archive: collection.archive, parser: collection.parser });
    expect(entry.expectedCounts).toEqual({ instances: 2 });
    expect(entry.properties).toEqual({ surveyId: "or-10", timeUnit: "abstract units" });
    expect(outcome.recipe).toBe("fetchable");
  });

  it("records no time unit for a source that has no time quantities", () => {
    const untimed = Object.fromEntries(Object.entries(collection).filter(([key]) => key !== "timeUnit"));
    const { entry } = convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(untimed), "2026-10-19");
    expect(entry.properties).toEqual({ surveyId: "or-10" });
  });

  it("maps, keeps and drops every column of the parser so the crosswalk says what the entry leaves out", () => {
    const { entry } = convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(collection), "2026-10-19");
    expect(entry.crosswalk).toMatchObject({
      source: "solomon",
      target: "tasks/v1",
      oneWay: [{ op: "drop", from: "nodes[].ready", direction: "encode" }],
    });
    const { crosswalk } = entry;
    const rules = "rules" in crosswalk ? crosswalk.rules : expect.unreachable("the entry carries its crosswalk inline");
    expect(rules).toContainEqual({ op: "move", from: "nodes[].due", to: "nodes[].deadline" });
    expect(rules).toContainEqual({ op: "move", from: "nodes[].demand", to: "nodes[].demand" });
  });

  it("fetches the members as instances and holds the round trip", async () => {
    const { entry } = convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(collection), "2026-10-19");
    const dataset = createCatalogue({ manifest: fixtureManifest, crosswalks: {}, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the catalogue lists its entry");
    const fetch = async (): Promise<Response> => Promise.resolve(new Response(archive));
    const fetched = await fetchEntry(dataset, { fetch });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toEqual({
      meta: { id: "example-suite", name: "Suite", surveyId: "or-10", timeUnit: "abstract units" },
      instances: [
        { id: "suite/A1.txt", meta: { name: "A1", vehicles: 3, capacity: 100 }, nodes: [{ id: "0", x: 5, y: 6, deadline: 90, demand: 0, service: 0 }] },
        {
          id: "suite/B1.txt",
          meta: { name: "B1", vehicles: 3, capacity: 100 },
          nodes: [
            { id: "0", x: 1, y: 2, deadline: 90, demand: 0, service: 0 },
            { id: "1", x: 3, y: 4, deadline: 20, demand: 5, service: 7 },
          ],
        },
      ],
    });
    expect(await roundTripEntry(dataset, { fetch })).toMatchObject({ holds: true });
  });

  it("refuses a column the parser does not emit, a text field, a column used twice, a field-named kept column and no column at all", () => {
    expect(failure({ ...collection, map: { x: "x", y: "latitude" } })).toMatch(/y maps the column latitude, which the solomon parser does not emit \(it emits x, y, demand, ready, due, service\)/);
    expect(failure({ ...collection, map: { x: "x", status: "due" } })).toMatch(/status is text but due is a number/);
    expect(failure({ ...collection, parser: { format: "tsplib", encoding: "utf-8" }, map: { x: "x", prize: "clusters" }, keep: [] })).toMatch(/prize is a number but clusters is text/);
    expect(failure({ ...collection, keep: ["x"], map: { y: "y" } })).toMatch(/keep names x, which is a tasks\/v1 field: map it instead/);
    expect(failure({ ...collection, keep: ["demand", "demand"] })).toMatch(/demand is mapped or kept more than once/);
    expect(failure({ ...collection, map: { x: "x", y: "x" } })).toMatch(/the column x fills more than one field/);
    expect(failure({ ...collection, map: {}, keep: [] })).toMatch(/maps and keeps no column/);
    expect(failure({ ...collection, keep: ["weight"] })).toMatch(/keep names weight, which the solomon parser does not emit/);
  });

  it("refuses a parser that is not an instance file parser, and a meta list, which the header values no longer need", () => {
    expect(() => curated({ ...collection, parser: { format: "gml", encoding: "utf-8" } })).toThrow(/must be an instance file parser/);
    expect(() => curated({ ...collection, meta: ["name"] })).toThrow(/unrecognized/i);
  });
});

describe("convertItem for a collection of table files", () => {
  const item = survey.entries[0];
  const tables = {
    status: "fetchable-table-collection",
    archive: { kind: "zip", members: { pattern: "Coordinates_\\d+\\.txt" } },
    encoding: "utf-8",
    delimiter: "comma",
    skipLines: 0,
    idColumn: "ID",
    numericColumns: [
      { column: "Longitude", factor: 1 },
      { column: "Latitude", factor: 1 },
      { column: "ServiceTime_min", factor: 60 },
    ],
    header: ["ID", "Longitude", "Latitude", "ServiceTime (min)"],
    map: { lon: "Longitude", lat: "Latitude", duration: "ServiceTime_min" },
    timeUnit: "seconds",
    expectedInstances: 2,
  };
  const curated = (outcome: Record<string, unknown>): Parameters<typeof convertItem>[1] => CurationItemSchema.parse({ surveyId: "or-10", id: "example-coordinates", namespace: "example", name: "Coordinates", description: "A fixture dataset.", licence: UNSTATED, flags: [], outcome });
  const entryOf = (outcome: Record<string, unknown>): ReturnType<typeof convertItem>["entry"] => convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(outcome), "2026-10-19").entry;
  const csv = (rows: readonly string[]): string => `"ID","Longitude","Latitude","ServiceTime (min)"\r\n${rows.join("\r\n")}\r\n`;
  const archive = zip([
    { path: "Coordinates_2.txt", text: csv(["0,4.5,49.8,2"]) },
    { path: "Coordinates_10.txt", text: csv(["7,4.6,49.9,2", "8,0,0,3"]) },
    { path: "readme.txt", text: "not a table" },
  ]);

  it("makes a tasks/v1 entry that reads each matching file as a table and moves each member's columns onto the node fields", () => {
    const entry = entryOf(tables);
    expect(entry.category).toBe("tasks/v1");
    expect(entry.recipe).toMatchObject({ status: "fetchable", archive: tables.archive, parser: { format: "csv-table", idColumn: "ID", columns: ["ServiceTime_min", "Latitude", "Longitude"] } });
    expect(entry.expectedCounts).toEqual({ instances: 2 });
    expect(entry.properties).toEqual({ surveyId: "or-10", timeUnit: "seconds" });
    expect(entry.crosswalk).toMatchObject({ source: "csv-table", target: "tasks/v1", oneWay: [] });
  });

  it("fetches the files as instances in path order, scales minutes to seconds and holds the round trip", async () => {
    const dataset = createCatalogue({ manifest: fixtureManifest, crosswalks: {}, entries: [entryOf(tables)] }).listDatasets()[0] ?? expect.unreachable("the catalogue lists its entry");
    const fetch = async (): Promise<Response> => Promise.resolve(new Response(archive));
    const fetched = await fetchEntry(dataset, { fetch });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toMatchObject({
      instances: [
        { id: "Coordinates_10.txt", meta: {}, nodes: [{ id: "7", lon: 4.6, lat: 49.9, duration: 120 }, { id: "8", lon: 0, lat: 0, duration: 180 }] },
        { id: "Coordinates_2.txt", meta: {}, nodes: [{ id: "0", lon: 4.5, lat: 49.8, duration: 120 }] },
      ],
    });
    expect(await roundTripEntry(dataset, { fetch })).toMatchObject({ holds: true });
  });

  it("applies the table checks: a mapped column the header lacks and a number field filled from a column not declared numeric", () => {
    const failure = (outcome: Record<string, unknown>): string => {
      try {
        entryOf(outcome);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("expected the conversion to fail");
    };
    expect(failure({ ...tables, map: { lon: "Longitude", lat: "Elevation" } })).toMatch(/lat maps the column Elevation, which the table does not have/);
    expect(failure({ ...tables, numericColumns: [{ column: "Longitude", factor: 1 }, { column: "Latitude", factor: 1 }] })).toMatch(/duration is a number but ServiceTime_min is not declared numeric/);
  });
});

describe("convertItem for one instance file", () => {
  const item = survey.entries[0];
  const single = {
    status: "fetchable-instance-files",
    archive: { kind: "zip", member: { path: "customers.txt" } },
    parser: { format: "customer-points", encoding: "utf-8" },
    map: { x: "x", y: "y" },
    keep: [],
    expectedNodes: 2,
  };
  const curated = (outcome: Record<string, unknown>): Parameters<typeof convertItem>[1] => CurationItemSchema.parse({ surveyId: "or-10", id: "example-customers", namespace: "example", name: "Customers", description: "A fixture dataset.", licence: UNSTATED, flags: [], outcome });
  const entryOf = (outcome: Record<string, unknown>): ReturnType<typeof convertItem>["entry"] => convertItem(item ?? expect.unreachable("the fixture survey has an item"), curated(outcome), "2026-10-19").entry;
  const failure = (outcome: Record<string, unknown>): string => {
    try {
      entryOf(outcome);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the conversion to fail");
  };

  it("makes a tasks/v1 entry that selects the one file, with the node count and the whole header in the meta", async () => {
    const entry = entryOf(single);
    expect(entry.category).toBe("tasks/v1");
    expect(entry.recipe).toEqual({ status: "fetchable", source: 0, archive: single.archive, parser: single.parser });
    expect(entry.expectedCounts).toEqual({ nodes: 2 });
    expect(entry.crosswalk).toMatchObject({ source: "customer-points", target: "tasks/v1", oneWay: [] });
    const dataset = createCatalogue({ manifest: fixtureManifest, crosswalks: {}, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the catalogue lists its entry");
    const fetch = async (): Promise<Response> => Promise.resolve(new Response(zip([{ path: "Instance/customers.txt", text: "customers 2\r\n\r\n0\t1.5\t2.5\r\n1\t3\t4\r\n" }, { path: "Instance/network.txt", text: "ignored" }])));
    const fetched = await fetchEntry(dataset, { fetch });
    expect(fetched.warnings).toEqual([]);
    expect(fetched.data).toEqual({
      meta: { id: "example-customers", name: "Customers", surveyId: "or-10", customers: 2 },
      nodes: [
        { id: "0", x: 1.5, y: 2.5 },
        { id: "1", x: 3, y: 4 },
      ],
    });
    expect(await roundTripEntry(dataset, { fetch })).toMatchObject({ holds: true });
  });

  it("refuses instance counts on a single file and node counts on a collection", () => {
    expect(failure({ ...single, expectedInstances: 1 })).toMatch(/a single file is one instance and has no expectedInstances/);
    expect(failure({ ...single, archive: { kind: "zip", members: { extensions: [".txt"] } } })).toMatch(/a collection counts instances, not nodes/);
  });
});

describe("the licence an item's curation records", () => {
  const socrata = SurveySourceSchema.parse({ survey: "s", surveyed: "2026-07-23", entries: [{ id: "or-1", title: "Evictions", url: "https://data.example.gov/Housing/Evictions/abcd-1234", theme: "case lifecycle records: permits, inspections, prosecutions & enforcement", fields: ["lifecycle"] }] }).entries[0];
  if (socrata === undefined) {
    throw new Error("the fixture has one item");
  }
  const curatedWith = (licence: unknown): Parameters<typeof convertItem>[1] => CurationItemSchema.parse({ surveyId: "or-1", id: "example-evictions", namespace: "example", name: "Evictions", description: "A fixture dataset.", licence, flags: [], outcome: { status: "not-fetchable", reason: "x" } });

  it("carries the licence of stated terms into the entry and unrecorded for a source that states none", () => {
    expect(convertItem(socrata, curatedWith(STATED), "2026-10-19").entry.licence).toEqual({ kind: "spdx", id: "CC-BY-4.0" });
    const record = { readAt: ["https://data.example.gov/api/views/abcd-1234.json"], reason: "The record's licence field is empty." };
    expect(convertItem(socrata, curatedWith(record), "2026-10-19").entry.licence).toEqual({ kind: "unrecorded" });
  });

  it("refuses an item on a platform that keeps each dataset's licence in a record, recorded as stating none without the record having been read", () => {
    expect(() => convertItem(socrata, curatedWith(UNSTATED), "2026-10-19")).toThrow(/example-evictions.*socrata keeps each dataset's licence.*abcd-1234\.json/);
  });

  it("requires every curated item to say where its licence, or the lack of one, was read", () => {
    expect(CurationItemSchema.safeParse({ surveyId: "or-1", id: "example-evictions", namespace: "example", name: "Evictions", description: "A fixture dataset.", licence: { kind: "unrecorded" }, flags: [], outcome: { status: "not-fetchable", reason: "x" } }).success).toBe(false);
  });
});
