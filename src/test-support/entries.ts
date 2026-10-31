import { waybackUrl } from "../entry";

/** The shared topology crosswalk, as catalogue/crosswalks/graph-v1/topology.json holds it. */
export const topologyCrosswalk = {
  source: "keepset/topology",
  target: "graph/v1",
  rules: [
    { op: "move", from: "meta", to: "meta" },
    { op: "move", from: "nodes[].id", to: "nodes[].id" },
    { op: "move", from: "edges[].source", to: "edges[].source" },
    { op: "move", from: "edges[].target", to: "edges[].target" },
  ],
  oneWay: [],
};

/** A fetchable entry with a live source and an inline crosswalk. */
export const liveEntry = {
  id: "karate",
  name: "Zachary Karate Club",
  description: "Friendships between members of a university karate club.",
  domain: "Social network",
  subjects: ["network-science", "social-science"],
  tags: ["social", "small"],
  category: "graph/v1",
  sources: [{ url: "https://example.org/data/karate.txt", retrieved: "2026-04-19", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [{ text: "W. W. Zachary (1977). An information flow model for conflict and fission in small groups.", doi: "10.1086/jar.33.4.3629752" }],
  recipe: {
    status: "fetchable",
    source: 0,
    archive: { kind: "none" },
    parser: { format: "edge-list", encoding: "utf-8", delimiter: "whitespace", skipLines: 0, commentPrefixes: ["#", "%"], sourceColumn: 0, targetColumn: 1 },
  },
  crosswalk: {
    source: "edge-list",
    target: "graph/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      { op: "move", from: "edges[].source", to: "edges[].source" },
      { op: "move", from: "edges[].target", to: "edges[].target" },
    ],
    oneWay: [],
  },
  expectedCounts: { nodes: 34, edges: 78 },
  properties: { directed: false, weighted: false, density: 0.139 },
};

/** A fetchable entry whose dead source is pinned to a Wayback snapshot, with a crosswalk file reference. */
export const deadEntry = {
  id: "celegans-metabolic",
  name: "C. elegans metabolic network",
  tags: [],
  category: "graph/v1",
  sources: [
    {
      url: "http://example.edu/~lab/data/celegans_metabolic.zip",
      retrieved: "2026-04-19",
      status: "dead",
      snapshot: { url: waybackUrl("20230601", "http://example.edu/~lab/data/celegans_metabolic.zip"), timestamp: "20230601" },
    },
  ],
  licence: { kind: "spdx", id: "CC-BY-4.0" },
  citations: [],
  recipe: { status: "fetchable", source: 0, archive: { kind: "zip", member: { path: "celegans_metabolic.net" } }, parser: { format: "pajek", encoding: "latin1" } },
  crosswalk: { file: "crosswalks/graph-v1/topology.json" },
  expectedCounts: {},
  properties: {},
};

/** An entry with no declarative recipe yet. */
export const notFetchableEntry = {
  ...deadEntry,
  id: "auth-walled",
  name: "C. elegans metabolic network behind a login",
  sources: [{ url: "https://example.com/datasets/walled", retrieved: "2026-04-19", status: "live" }],
  licence: { kind: "custom", name: "Example data licence", url: "https://example.com/licence" },
  recipe: { status: "not-fetchable", reason: "the source requires an account to download" },
};

/** A fetchable tasks/v1 entry: a CSV table of cases whose columns an inline crosswalk maps onto the target's node fields, with minutes scaled to seconds by the parser. */
export const taskEntry = {
  id: "service-requests",
  name: "Service requests",
  tags: [],
  category: "tasks/v1",
  sources: [{ url: "https://example.org/data/requests.csv", retrieved: "2026-10-19", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [],
  recipe: {
    status: "fetchable",
    source: 0,
    archive: { kind: "none" },
    parser: {
      format: "csv-table",
      encoding: "utf-8",
      delimiter: "comma",
      skipLines: 0,
      idColumn: "request_id",
      numericColumns: [
        { column: "latitude", factor: 1 },
        { column: "longitude", factor: 1 },
        { column: "minutes", factor: 60 },
      ],
    },
  },
  crosswalk: {
    source: "csv-table",
    target: "tasks/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      { op: "move", from: "nodes[].latitude", to: "nodes[].lat" },
      { op: "move", from: "nodes[].longitude", to: "nodes[].lon" },
      { op: "move", from: "nodes[].minutes", to: "nodes[].duration" },
      { op: "move", from: "nodes[].status", to: "nodes[].status" },
      { op: "move", from: "nodes[].borough", to: "nodes[].territory" },
    ],
    oneWay: [{ op: "drop", from: "nodes[].private_note", direction: "encode" }],
  },
  expectedCounts: { nodes: 3 },
  properties: { durationUnit: "seconds" },
};

/** A fetchable tasks/v1 entry whose source is a paged ArcGIS feature layer: the point's position and three properties fill node fields, an epoch-millisecond date is written as text, and a property the crosswalk does not map is not kept. */
export const arcgisEntry = {
  id: "layer-violations",
  name: "Layer violations",
  tags: [],
  category: "tasks/v1",
  sources: [{ url: "https://example.org/arcgis/rest/services/Violations/FeatureServer/0", retrieved: "2026-10-19", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [],
  recipe: {
    status: "fetchable",
    source: 0,
    paging: { kind: "arcgis-query", orderBy: "OBJECTID" },
    archive: { kind: "none" },
    parser: {
      format: "geojson",
      encoding: "utf-8",
      idColumn: "OBJECTID",
      numericColumns: [
        { column: "geometry_latitude", factor: 1 },
        { column: "geometry_longitude", factor: 1 },
        { column: "FINE", factor: 1 },
      ],
      dateColumns: ["OPENED"],
      columns: ["geometry_latitude", "geometry_longitude", "FINE", "OPENED", "KIND"],
    },
  },
  crosswalk: {
    source: "geojson",
    target: "tasks/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      { op: "move", from: "nodes[].geometry_latitude", to: "nodes[].lat" },
      { op: "move", from: "nodes[].geometry_longitude", to: "nodes[].lon" },
      { op: "move", from: "nodes[].FINE", to: "nodes[].prize" },
      { op: "move", from: "nodes[].OPENED", to: "nodes[].opened" },
      { op: "move", from: "nodes[].KIND", to: "nodes[].skill" },
    ],
    oneWay: [],
  },
  expectedCounts: { nodes: 3 },
  properties: {},
};

/** A fetchable tasks/v1 entry whose source is a Socrata resource read two rows at a time: the table's status and borough fill node fields and every other column is left out by the parser. */
export const socrataEntry = {
  id: "resource-cases",
  name: "Resource cases",
  tags: [],
  category: "tasks/v1",
  sources: [{ url: "https://data.example.org/resource/abcd-1234.csv", retrieved: "2026-10-19", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [],
  recipe: {
    status: "fetchable",
    source: 0,
    paging: { kind: "socrata-resource", pageSize: 2 },
    archive: { kind: "none" },
    parser: { format: "csv-table", encoding: "utf-8", delimiter: "comma", skipLines: 0, idColumn: "case_id", numericColumns: [], columns: ["status", "borough"] },
  },
  crosswalk: {
    source: "csv-table",
    target: "tasks/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      { op: "move", from: "nodes[].status", to: "nodes[].status" },
      { op: "move", from: "nodes[].borough", to: "nodes[].territory" },
    ],
    oneWay: [],
  },
  expectedCounts: {},
  properties: {},
};

/** The Socrata entry with a streamed recipe: the same source, paging, parser and crosswalk, read a page at a time by `streamEntry` rather than held by `fetchEntry`. */
export const streamedEntry = { ...socrataEntry, id: "streamed-cases", name: "Streamed cases", recipe: { ...socrataEntry.recipe, stream: true } };

/** A fetchable tasks/v1 entry whose source is a CKAN datastore dump read two rows at a time, on a portal that serves CKAN under the path prefix `/data`. */
export const ckanEntry = {
  ...socrataEntry,
  id: "datastore-cases",
  name: "Datastore cases",
  sources: [{ url: "https://data.example.org/data/datastore/dump/0a1b2c3d-1111-2222-3333-444455556666", retrieved: "2026-10-19", status: "live" }],
  recipe: { ...socrataEntry.recipe, paging: { kind: "ckan-datastore", pageSize: 2 }, parser: { ...socrataEntry.recipe.parser, idColumn: "id", columns: ["status", "borough"] } },
};

/** A fetchable tasks/v1 entry whose source is an OpenFEMA entity read two rows at a time, with a `$select` in its source URL. */
export const openFemaEntry = {
  ...socrataEntry,
  id: "entity-claims",
  name: "Entity claims",
  sources: [{ url: "https://www.fema.gov/api/open/v3/Claims?$select=id,state,county", retrieved: "2026-10-19", status: "live" }],
  recipe: { ...socrataEntry.recipe, paging: { kind: "openfema", pageSize: 2 }, parser: { ...socrataEntry.recipe.parser, idColumn: "id", columns: ["state", "county"] } },
  crosswalk: { ...socrataEntry.crosswalk, rules: [{ op: "move", from: "meta", to: "meta" }, { op: "move", from: "nodes[].id", to: "nodes[].id" }, { op: "move", from: "nodes[].state", to: "nodes[].status" }, { op: "move", from: "nodes[].county", to: "nodes[].territory" }] },
};

/** One of each entry shape, for round-trip and schema-agreement tests. */
export const representativeEntries = [liveEntry, deadEntry, notFetchableEntry];

/** A fetchable tasks/v1 entry that is a collection: a zip of CSV files, one instance each, read through the `csv-table` parser. The crosswalk is the one a single table of the same columns would have, applied to each member; the archive's other files are not read. */
export const taskCollectionEntry = {
  id: "route-suite",
  name: "Route suite",
  tags: [],
  category: "tasks/v1",
  sources: [{ url: "https://example.org/data/suite.zip", retrieved: "2026-10-20", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [],
  recipe: {
    status: "fetchable",
    source: 0,
    archive: { kind: "zip", members: { extensions: [".csv"] } },
    parser: {
      format: "csv-table",
      encoding: "utf-8",
      delimiter: "comma",
      skipLines: 0,
      idColumn: "customer",
      numericColumns: [
        { column: "x", factor: 1 },
        { column: "y", factor: 1 },
        { column: "prize", factor: 1 },
      ],
    },
  },
  crosswalk: {
    source: "csv-table",
    target: "tasks/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      { op: "move", from: "nodes[].x", to: "nodes[].x" },
      { op: "move", from: "nodes[].y", to: "nodes[].y" },
      { op: "move", from: "nodes[].prize", to: "nodes[].prize" },
    ],
    oneWay: [],
  },
  expectedCounts: { instances: 2 },
  properties: {},
} as const;

/** A fetchable graph/v1 entry that is a collection: a tar of edge lists, one graph each. It shows a collection needs nothing of its category. */
export const graphCollectionEntry = {
  id: "graph-suite",
  name: "Graph suite",
  tags: [],
  category: "graph/v1",
  sources: [{ url: "https://example.org/data/graphs.tar", retrieved: "2026-10-20", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [],
  recipe: {
    status: "fetchable",
    source: 0,
    archive: { kind: "tar", members: { extensions: [".edges"] } },
    parser: { format: "edge-list", encoding: "utf-8", delimiter: "whitespace", skipLines: 0, commentPrefixes: ["#"], sourceColumn: 0, targetColumn: 1 },
  },
  crosswalk: { file: "crosswalks/graph-v1/topology.json" },
  expectedCounts: {},
  properties: {},
} as const;

/** A graph entry of a multi-file format: an Open Graph Benchmark zip whose raw directory's gzipped files are read together into one graph. */
export const ogbEntry = {
  id: "ogb-suite",
  name: "OGB dataset",
  tags: [],
  category: "graph/v1",
  sources: [{ url: "https://example.org/data/dataset.zip", retrieved: "2026-10-21", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [],
  recipe: {
    status: "fetchable",
    source: 0,
    archive: { kind: "zip", files: { pattern: "[^/]+/raw/(?:num-node-list|num-node-dict|edge|num-edge-list|triplet-type-list|relations/[^/]+/(?:edge|num-edge-list))\\.csv\\.gz" }, inner: { kind: "gzip" } },
    parser: { format: "ogb", encoding: "utf-8" },
  },
  crosswalk: { file: "crosswalks/graph-v1/topology.json" },
  expectedCounts: { nodes: 3, edges: 2 },
  properties: {},
} as const;

/** A fetchable tasks/v1 entry whose collection is files downloaded one by one rather than one archive: a live file, a dead file fetched from its pinned snapshot, and a zip whose matching members are instances of their own, all read with the collection fixture's parser and crosswalk. */
export const filesCollectionEntry = {
  ...taskCollectionEntry,
  id: "route-files",
  name: "Route files",
  sources: [
    { url: "https://example.org/data/routes", retrieved: "2026-10-21", status: "live" },
    { url: "https://example.org/data/routes/north.csv", retrieved: "2026-10-21", status: "live" },
    { url: "https://example.org/data/routes/south.csv", retrieved: "2026-10-21", status: "dead", snapshot: { timestamp: "20240101000000", url: "https://web.archive.org/web/20240101000000/https://example.org/data/routes/south.csv" } },
    { url: "https://example.org/data/routes/more.zip", retrieved: "2026-10-21", status: "live" },
  ],
  recipe: {
    status: "fetchable",
    files: [
      { path: "north.csv", source: 1, archive: { kind: "none" } },
      { path: "south.csv", source: 2, archive: { kind: "none" } },
      { path: "more.zip", source: 3, archive: { kind: "zip", members: { extensions: [".csv"] } } },
    ],
    parser: taskCollectionEntry.recipe.parser,
  },
  expectedCounts: { instances: 4 },
} as const;

/** A fetchable corpus/v1 entry streamed a file at a time: a zip holding one tar, as a library zips its whole collection, whose text files are the documents, each read verbatim by the `member-text` parser with its id from its path. */
export const streamedCorpusEntry = {
  id: "library-texts",
  name: "Library texts",
  tags: [],
  category: "corpus/v1",
  sources: [{ url: "https://example.org/data/texts.tar.zip", retrieved: "2026-10-31", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [],
  recipe: {
    status: "fetchable",
    source: 0,
    archive: { kind: "zip", files: { path: "texts.tar" }, inner: { kind: "tar", files: { pattern: "texts/[0-9]+\\.txt" } } },
    parser: { format: "member-text", encoding: "utf-8", idPattern: "texts\\.tar/texts/([0-9]+)\\.txt", verbatim: true },
    stream: true,
  },
  crosswalk: {
    source: "member-text",
    target: "corpus/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      { op: "move", from: "nodes[].text", to: "nodes[].text" },
    ],
    oneWay: [],
  },
  expectedCounts: {},
  properties: {},
} as const;

/** Every entry shape, one entry of each category as well: for the tests that check the entry schema, its generated JSON Schema and serialisation, which the catalogue fixtures (graph entries only) do not need to carry. */
export const everyEntryShape = [...representativeEntries, taskEntry, taskCollectionEntry, filesCollectionEntry, graphCollectionEntry, ogbEntry, arcgisEntry, socrataEntry, streamedEntry, ckanEntry, openFemaEntry, streamedCorpusEntry];

/** A catalogue manifest for fixture catalogues. */
export const fixtureManifest = {
  id: "fixture",
  name: "fixture catalogue",
  description: "Entries for tests.",
  version: "1.2.3",
  repository: "https://example.org/fixture",
};

/** A catalogue index over the representative entries, with the topology crosswalk file they reference. */
export const fixtureIndex = {
  manifest: fixtureManifest,
  crosswalks: { "crosswalks/graph-v1/topology.json": topologyCrosswalk },
  entries: representativeEntries,
};
