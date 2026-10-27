import { CrosswalkSchema, validateCrosswalk, type Crosswalk } from "crossmap";
import { parseEntry, waybackUrl, type Entry } from "../../src/entry";
import { columnNames } from "../../src/parsers/csv-table";
import { POINT_COLUMNS } from "../../src/parsers/geojson";
import { INSTANCE_SHAPES } from "../../src/parsers/instance-shapes";
import { assertMachineReadableRead, licenceOf } from "./licence";
import { CurationSchema, TARGET_FIELD_NAMES, TARGET_FIELDS, type FetchableOutcome, type InstanceFilesOutcome, type Curation, type CurationItem, type SurveyEntry, type SurveySource, type TableOutcome, type TargetField } from "./or-survey";

/** The shared crosswalk of an entry with no recipe yet: the document's meta and node ids, all that is known of a dataset whose columns have not been read into a mapping. */
export const OR_NODES_CROSSWALK = "crosswalks/tasks-v1/nodes.json";

/** The most cells (rows times the cells each row keeps, its id included) a table may have to be held as one document. A held fetch keeps every kept cell of the table at once, in the parsed rows, the crosswalk's result and the validated document, so memory grows with the cells and not with the file's size. Measured on whole fetches: a table of about five million cells needed a heap of between 512 and 768 MiB, one of about eleven million cells (1.6 million rows) between 1 and 1.5 GiB, and one of about fourteen million cells (2.7 million rows) between 2 and 3 GiB, so this stays within Node's default heap of 4 GiB on a machine with the memory for it. A table of more cells is streamed when its source is paged, and has no recipe when it is not, as one file is downloaded whole before it is read. */
export const MAX_CELLS = 14_000_000;

/** How many rows a page of a paged CSV source holds. A response is a CSV of every column, so a page is a few tens of megabytes for a table of up to a kilobyte a row, short enough that a response is not cut off in transit and long enough that a table of millions of rows is a few dozen requests. */
export const PAGE_ROWS = 50_000;

/** The path of a Socrata resource endpoint: a four-by-four dataset id and an output format. */
const SOCRATA_RESOURCE_CSV = /^\/resource\/[a-z0-9]{4}-[a-z0-9]{4}\.csv$/;

/** The path of an OpenFEMA entity: `/api/open/v<n>/<Entity>`. */
const OPENFEMA_ENTITY = /^\/api\/open\/v\d+\/[A-Za-z]+$/;

/** The path of a CKAN datastore dump: the resource's UUID after `/datastore/dump/`, on a portal that may serve CKAN under a prefix. */
const CKAN_DATASTORE_DUMP = /\/datastore\/dump\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * How a recipe pages a source URL. A Socrata resource endpoint returns a small fixed number of rows unless it is given a limit, and a long download of a large CKAN datastore dump or Socrata table can be cut short in transit, so each is read a page at a time; every other URL is one file.
 * @param url - The URL the survey or the curation gives for the table.
 * @returns The paging of a Socrata resource endpoint or a CKAN datastore dump with no query, or of an OpenFEMA entity (whose `$select` stays in the URL), and undefined for any other URL.
 */
export function pagingOf(url: string): { readonly kind: "socrata-resource" | "ckan-datastore" | "openfema"; readonly pageSize: number } | undefined {
  const parsed = new URL(url);
  if (parsed.hostname === "www.fema.gov" && OPENFEMA_ENTITY.test(parsed.pathname)) {
    return { kind: "openfema", pageSize: PAGE_ROWS };
  }
  if (parsed.search !== "") {
    return undefined;
  }
  if (SOCRATA_RESOURCE_CSV.test(parsed.pathname)) {
    return { kind: "socrata-resource", pageSize: PAGE_ROWS };
  }

  return CKAN_DATASTORE_DUMP.test(parsed.pathname) ? { kind: "ckan-datastore", pageSize: PAGE_ROWS } : undefined;
}

/** The subject every entry of the survey is filed under: the survey is of operations research datasets, whichever theme an item sits in. */
export const SUBJECT = "operations-research";

/** The short label each survey theme is filed under as the entry's domain, matched against the theme text because the survey's own wording is long and uses dashes. Every theme the survey uses must match exactly one. */
const THEMES: readonly (readonly [RegExp, string])[] = [
  [/permits, inspections, prosecutions/, "Case records"],
  [/technician & home-care routing/, "Technician and home-care routing"],
  [/emergency dispatch/, "Emergency dispatch"],
  [/VRPTW family/, "Vehicle routing with time windows"],
  [/civic & environmental monitoring/, "Civic and environmental monitoring"],
  [/orienteering family/, "Orienteering"],
  [/last-mile logistics/, "Last-mile logistics"],
  [/real-world risk\/outcome proxies/, "Risk and outcome records"],
  [/insurance claims & unclaimed money/, "Claims and unclaimed money"],
  [/generated logs/, "Synthetic logs"],
  [/cash-collection clustering/, "Cash collection"],
];

/** The fields whose values a recipe may scale: durations and travel times are put in seconds, and every other number is the source's own. */
const SCALABLE_FIELDS: ReadonlySet<TargetField> = new Set(["duration", "travelTime"]);

/** How one surveyed dataset was imported. */
export interface OrOutcome {
  readonly surveyId: string;
  readonly id: string;
  readonly recipe: "fetchable" | "not-fetchable";
  readonly reason?: string;
  readonly flags: readonly string[];
}

/** The import's report: where its inputs came from and how every surveyed dataset was imported. */
export interface OrReport {
  readonly source: { readonly survey: string; readonly surveyed: string; readonly probedOn: string };
  readonly outcomes: readonly OrOutcome[];
}

/**
 * The domain a survey theme is filed under.
 * @param item - The surveyed item.
 * @returns The domain label.
 * @throws Error when the theme matches no label, or more than one.
 */
function domainOf(item: SurveyEntry): string {
  const labels = THEMES.filter(([pattern]) => pattern.test(item.theme)).map(([, label]) => label);
  const [label] = labels;
  if (label === undefined || labels.length > 1) {
    throw new Error(`${item.id}: the theme ${JSON.stringify(item.theme)} matches ${String(labels.length)} domain labels, not one`);
  }

  return label;
}

/**
 * The parser's names for a table outcome's columns, and the columns it emits, which are those names without the id column. A table's are derived from its header cells; an ArcGIS layer's are its property names as written, then the position columns of a point layer.
 * @param id - The surveyed item's id, for errors.
 * @param outcome - The outcome.
 * @returns Every name, and the columns of a row other than its id.
 * @throws Error naming the item when two columns get the same name.
 */
function columnsOf(id: string, outcome: TableOutcome): { readonly names: readonly string[]; readonly columns: readonly string[] } {
  try {
    const names = outcome.status !== "fetchable-arcgis" ? columnNames(outcome.header, outcome.idColumn, 1) : [...outcome.header, ...(outcome.point ? [POINT_COLUMNS.latitude, POINT_COLUMNS.longitude] : [])];
    if (new Set(names).size !== names.length) {
      throw new Error("two columns have the same name");
    }

    return { names, columns: names.filter((name) => name !== outcome.idColumn) };
  } catch (error) {
    throw new Error(`${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** The columns a recipe's parser keeps: those a field is mapped from, in the order of the fields. */
const keptColumns = (outcome: TableOutcome): string[] => TARGET_FIELD_NAMES.flatMap((field) => outcome.map[field] ?? []);

/**
 * The cells a table outcome's recipe keeps: its rows times the mapped columns and the id. A collection of table files records no row count, as each file is its own document.
 * @param outcome - The outcome.
 * @returns The cells, zero where no row count is recorded.
 */
function cellsOf(outcome: TableOutcome): number {
  const rowCount = outcome.status === "fetchable-table-collection" ? undefined : outcome.rowCount;

  return (rowCount ?? 0) * (keptColumns(outcome).length + 1);
}

/**
 * Whether a table outcome's recipe streams: a table of more cells than a fetch holds is streamed when it is one table read from a CSV paged source.
 * @param outcome - The outcome.
 * @param url - The URL the table is read from.
 * @returns True to stream, false to hold, or undefined for a table too long to hold whose source cannot be streamed.
 */
function streams(outcome: TableOutcome, url: string): boolean | undefined {
  if (cellsOf(outcome) <= MAX_CELLS) {
    return false;
  }

  return outcome.status === "fetchable" && outcome.archive === undefined && pagingOf(url) !== undefined ? true : undefined;
}

/**
 * The Socrata fields a recipe selects: the raw header cells of its id column and of the columns its parser keeps, so the columns it drops are never transferred. A resource names each field in the header as the API names it, and a field is selected by that name, so a kept column whose parser name is not its header cell cannot be selected and is refused.
 * @param id - The surveyed item's id, for errors.
 * @param outcome - A table read from one file.
 * @returns The fields, the id column's first.
 * @throws Error naming the item when a kept column's header cell is not its parser name.
 */
function socrataSelection(id: string, outcome: FetchableOutcome): string[] {
  const names = columnNames(outcome.header, outcome.idColumn, 1);

  return [...(outcome.idColumn === null ? [] : [outcome.idColumn]), ...keptColumns(outcome)].map((column) => {
    const cell = outcome.header[names.indexOf(column)];
    if (cell !== column) {
      throw new Error(`${id}: the column ${column} has the header cell ${JSON.stringify(cell)}, which a Socrata selection cannot name as it is`);
    }

    return cell;
  });
}

/**
 * Checks a fetchable outcome against the rules that keep a recipe sound: the columns it names exist, a field is filled by one column and a column fills one field, a number field reads a numeric column and a text field does not, only durations and travel times are scaled, and a table too long to hold is read from a source that can be streamed.
 * @param id - The surveyed item's id, for errors.
 * @param outcome - The outcome.
 * @param url - The URL the table is read from.
 * @throws Error naming the item and the rule it breaks.
 */
function checkFetchable(id: string, outcome: TableOutcome, url: string): void {
  const fail = (message: string): never => {
    throw new Error(`${id}: ${message}`);
  };
  const named = columnsOf(id, outcome);
  if (outcome.idColumn !== null && !named.names.includes(outcome.idColumn)) {
    fail(`the id column ${outcome.idColumn} is not one of the parser's column names for this header`);
  }
  const columns = new Set(named.columns);
  const numeric = new Map(outcome.numericColumns.map((entry) => [entry.column, entry.factor]));
  const used = new Set<string>();
  const mapped = TARGET_FIELD_NAMES.flatMap((field) => {
    const column = outcome.map[field];

    return column === undefined ? [] : [[field, column] as const];
  });
  if (mapped.length === 0) {
    fail("the map fills no field, so a fetch would carry nothing beyond ids");
  }
  if (streams(outcome, url) === undefined) {
    fail(`the table has ${String(outcome.status === "fetchable-table-collection" ? undefined : outcome.rowCount)} rows of ${String(mapped.length + 1)} kept cells, ${String(cellsOf(outcome))} cells, more than ${String(MAX_CELLS)}, and its source is one file and not paged, so it can neither be held nor streamed`);
  }
  if (outcome.status === "fetchable-arcgis") {
    for (const column of outcome.dateColumns) {
      if (!columns.has(column)) {
        fail(`dateColumns names ${column}, which the layer does not have`);
      }
      if (numeric.has(column)) {
        fail(`${column} is both a date and numeric`);
      }
      const filled = mapped.find(([, mappedColumn]) => mappedColumn === column);
      if (filled !== undefined && TARGET_FIELDS[filled[0]] === "number") {
        fail(`${filled[0]} is a number but ${column} is a date, written as text`);
      }
    }
  }
  for (const [field, column] of mapped) {
    if (!columns.has(column)) {
      fail(`${field} maps the column ${column}, which the table does not have`);
    }
    if (used.has(column)) {
      fail(`the column ${column} fills more than one field`);
    }
    used.add(column);
    const kind = TARGET_FIELDS[field];
    const factor = numeric.get(column);
    if (kind === "number" && factor === undefined) {
      fail(`${field} is a number but ${column} is not declared numeric`);
    }
    if (kind === "text" && factor !== undefined) {
      fail(`${field} is text but ${column} is declared numeric`);
    }
    if (factor !== undefined && factor !== 1 && !SCALABLE_FIELDS.has(field)) {
      fail(`${field} takes the source's own number, but ${column} has the factor ${String(factor)}`);
    }
  }
  for (const column of numeric.keys()) {
    if (!columns.has(column)) {
      fail(`numericColumns names ${column}, which the table does not have`);
    }
    if (!used.has(column)) {
      fail(`${column} is declared numeric but fills no field, so a stray cell would fail a fetch for nothing`);
    }
  }
}

/**
 * The crosswalk of a fetchable outcome: the document's meta and node ids and each mapped column onto its field. The recipe's parser keeps only the mapped columns, so there is nothing left to drop and the round trip holds.
 * @param outcome - The outcome.
 * @returns The crosswalk document.
 * @throws Error when crossmap finds the crosswalk structurally invalid.
 */
function crosswalkOf(outcome: TableOutcome): Crosswalk {
  const crosswalk = {
    source: outcome.status === "fetchable-arcgis" ? "geojson" : "csv-table",
    target: "tasks/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      ...TARGET_FIELD_NAMES.flatMap((field) => {
        const column = outcome.map[field];

        return column === undefined ? [] : [{ op: "move", from: `nodes[].${column}`, to: `nodes[].${field}` }];
      }),
    ],
  };
  const parsed = CrosswalkSchema.parse(crosswalk);
  const issues = validateCrosswalk(parsed);
  if (issues.length > 0) {
    throw new Error(`the crosswalk is invalid: ${issues.map((issue) => issue.message).join("; ")}`);
  }

  return parsed;
}

/**
 * Whether an instance files outcome reads a collection of files (separate downloads, or an archive that selects `members`) and not one file.
 * @param outcome - The outcome.
 * @returns True for a collection.
 */
const readsCollection = (outcome: InstanceFilesOutcome): boolean => outcome.files !== undefined || (outcome.archive !== undefined && "members" in outcome.archive);

/**
 * Checks an instance files outcome against the rules that keep a recipe sound: the columns and header keys it names are ones its parser emits, a column is mapped or kept at most once, a kept column does not take the name of a tasks/v1 node field (a column that fills a field of its own name is mapped, so what fills each field is written in one place), every column of an instance file is a number so none fills a text field, and the counts it records fit its shape (instances for a collection, nodes for a single file).
 * @param id - The surveyed item's id, for errors.
 * @param outcome - The outcome.
 * @throws Error naming the item and the rule it breaks.
 */
function checkInstanceFiles(id: string, outcome: InstanceFilesOutcome): void {
  const fail = (message: string): never => {
    throw new Error(`${id}: ${message}`);
  };
  const shape = INSTANCE_SHAPES[outcome.parser.format];
  const columns: readonly string[] = shape.columns;
  const used = new Set<string>();
  const mapped = TARGET_FIELD_NAMES.flatMap((field) => {
    const column = outcome.map[field];

    return column === undefined ? [] : [[field, column] as const];
  });
  for (const [field, column] of mapped) {
    if (!columns.includes(column)) {
      fail(`${field} maps the column ${column}, which the ${outcome.parser.format} parser does not emit (it emits ${columns.join(", ")})`);
    }
    const isText = shape.text.some((text) => text === column);
    if (TARGET_FIELDS[field] === "text" && !isText) {
      fail(`${field} is text but ${column} is a number`);
    }
    if (TARGET_FIELDS[field] === "number" && isText) {
      fail(`${field} is a number but ${column} is text`);
    }
    if (used.has(column)) {
      fail(`the column ${column} fills more than one field`);
    }
    used.add(column);
  }
  for (const column of outcome.keep) {
    if (!columns.includes(column)) {
      fail(`keep names ${column}, which the ${outcome.parser.format} parser does not emit (it emits ${columns.join(", ")})`);
    }
    if (TARGET_FIELD_NAMES.some((field) => field === column)) {
      fail(`keep names ${column}, which is a tasks/v1 field: map it instead`);
    }
    if (used.has(column)) {
      fail(`the column ${column} is mapped or kept more than once`);
    }
    used.add(column);
  }
  if (used.size === 0) {
    fail("the outcome maps and keeps no column, so a fetch would carry nothing beyond ids");
  }
  for (const field of ["duration", "travelTime"] as const) {
    const factor = outcome.factors?.[field];
    if (factor !== undefined && outcome.map[field] === undefined) {
      fail(`factors scales ${field}, which the map does not fill (factor ${String(factor)})`);
    }
  }
  if (!readsCollection(outcome) && outcome.expectedInstances !== undefined) {
    fail("a single file is one instance and has no expectedInstances");
  }
  if (readsCollection(outcome) && outcome.expectedNodes !== undefined) {
    fail("a collection counts instances, not nodes");
  }
}

/**
 * The crosswalk of an instance files outcome, which is the same for a single file and for each member of a collection: the document's meta (the file's header values and, for a single file, the entry's) moves whole, and each node column is mapped onto its field (scaled by its factor into seconds where the curation gives one), kept under its own name or dropped by a one-way rule, so the round trip holds.
 * @param outcome - The outcome.
 * @returns The crosswalk document.
 * @throws Error when crossmap finds the crosswalk structurally invalid.
 */
function instanceFilesCrosswalkOf(outcome: InstanceFilesOutcome): Crosswalk {
  const shape = INSTANCE_SHAPES[outcome.parser.format];
  const mapped = new Map(TARGET_FIELD_NAMES.flatMap((field) => (outcome.map[field] === undefined ? [] : [[outcome.map[field], field] as const])));
  const crosswalk = {
    source: outcome.parser.format,
    target: "tasks/v1",
    rules: [
      { op: "move", from: "meta", to: "meta" },
      { op: "move", from: "nodes[].id", to: "nodes[].id" },
      ...TARGET_FIELD_NAMES.flatMap((field) => {
        const column = outcome.map[field];
        const factor = field === "duration" || field === "travelTime" ? outcome.factors?.[field] : undefined;
        if (column === undefined) {
          return [];
        }

        return [factor === undefined ? { op: "move", from: `nodes[].${column}`, to: `nodes[].${field}` } : { op: "scale", from: `nodes[].${column}`, to: `nodes[].${field}`, factor }];
      }),
      ...outcome.keep.map((column) => ({ op: "move", from: `nodes[].${column}`, to: `nodes[].${column}` })),
    ],
    oneWay: shape.columns.filter((column) => !mapped.has(column) && !outcome.keep.includes(column)).map((column) => ({ op: "drop", from: `nodes[].${column}`, direction: "encode" })),
  };
  const parsed = CrosswalkSchema.parse(crosswalk);
  const issues = validateCrosswalk(parsed);
  if (issues.length > 0) {
    throw new Error(`the crosswalk is invalid: ${issues.map((issue) => issue.message).join("; ")}`);
  }

  return parsed;
}

/**
 * The recipe of an outcome. A table read from a Socrata resource selects only the fields its parser reads, and a table too long to hold is streamed.
 * @param id - The surveyed item's id, for errors.
 * @param outcome - The outcome.
 * @param where - Where the recipe reads: the index of the entry's source it downloads and that source's URL, and the index of the source the first of an instance files outcome's separate files is, the rest following in order.
 * @returns The recipe, fetchable or not.
 */
function recipeOf(id: string, outcome: CurationItem["outcome"], where: Readonly<{ source: number; url: string; firstFile: number }>): unknown {
  const { source, url, firstFile } = where;
  if (outcome.status === "not-fetchable") {
    return { status: "not-fetchable", reason: outcome.reason };
  }
  if (outcome.status === "fetchable-instance-files") {
    return outcome.files === undefined ? { status: "fetchable", source, archive: outcome.archive, parser: outcome.parser } : { status: "fetchable", files: outcome.files.map((file, index) => ({ path: file.path, source: firstFile + index, archive: file.archive })), parser: outcome.parser };
  }
  if (outcome.status === "fetchable-arcgis") {
    const kept = new Set(keptColumns(outcome));

    return {
      status: "fetchable",
      source,
      paging: { kind: "arcgis-query", orderBy: outcome.orderBy },
      archive: { kind: "none" },
      parser: { format: "geojson", encoding: "utf-8", idColumn: outcome.idColumn, numericColumns: outcome.numericColumns, dateColumns: outcome.dateColumns.filter((column) => kept.has(column)), columns: [...kept] },
    };
  }

  const paged = pagingOf(url);
  const paging = paged?.kind === "socrata-resource" && outcome.status === "fetchable" ? { ...paged, select: socrataSelection(id, outcome) } : paged;

  return {
    status: "fetchable",
    source,
    ...(paging === undefined ? {} : { paging }),
    ...(streams(outcome, url) === true ? { stream: true } : {}),
    archive: outcome.archive ?? { kind: "none" },
    parser: { format: "csv-table", encoding: outcome.encoding, delimiter: outcome.delimiter, skipLines: outcome.skipLines, idColumn: outcome.idColumn, numericColumns: outcome.numericColumns, columns: keptColumns(outcome), ...(outcome.nullValues === undefined ? {} : { nullValues: outcome.nullValues }) },
  };
}

/**
 * The counts an entry expects of a fetched result: the nodes of a table or the instances of a collection whose source does not change, and none otherwise.
 * @param outcome - The outcome.
 * @returns The expected counts.
 */
function expectedCountsOf(outcome: CurationItem["outcome"]): Record<string, number> {
  if (outcome.status === "fetchable-instance-files" && !readsCollection(outcome)) {
    return outcome.expectedNodes === undefined ? {} : { nodes: outcome.expectedNodes };
  }
  if (outcome.status === "fetchable-instance-files" || outcome.status === "fetchable-table-collection") {
    return outcome.expectedInstances === undefined ? {} : { instances: outcome.expectedInstances };
  }
  if (outcome.status === "not-fetchable" || outcome.expectedNodes === undefined) {
    return {};
  }

  return { nodes: outcome.expectedNodes };
}

/**
 * The node count of a table that grows, as the curation's probe read it: a figure for the listing to show, which a fetch does not assert (that is what `expectedCounts` is for, and a table that grows would warn on every fetch).
 * @param outcome - The outcome.
 * @returns The `probedNodes` property, or nothing where the table has an expected count or the probe recorded no rows.
 */
function probedNodesOf(outcome: CurationItem["outcome"]): { readonly probedNodes?: number } {
  if ((outcome.status !== "fetchable" && outcome.status !== "fetchable-arcgis") || outcome.expectedNodes !== undefined || outcome.rowCount === undefined) {
    return {};
  }

  return { probedNodes: outcome.rowCount };
}

/**
 * The figures a dataset with no recipe records from its publisher: the places or tasks it holds, as a count a probe read (`probedNodes`, shown as approximate), the instance files a collection holds, and the size of what the publisher offers for download.
 * @param outcome - The outcome.
 * @returns The properties, none where the outcome records no figure.
 */
function statedFiguresOf(outcome: CurationItem["outcome"]): { readonly probedNodes?: number; readonly instanceCount?: number; readonly downloadBytes?: number } {
  if (outcome.status !== "not-fetchable") {
    return {};
  }

  return {
    ...(outcome.nodes === undefined ? {} : { probedNodes: outcome.nodes }),
    ...(outcome.instances === undefined ? {} : { instanceCount: outcome.instances }),
    ...(outcome.downloadBytes === undefined ? {} : { downloadBytes: outcome.downloadBytes }),
  };
}

/**
 * Builds the entry and the outcome for one surveyed dataset.
 * @param item - The surveyed item.
 * @param curation - Its curation.
 * @param probedOn - The date the curation's facts were read.
 * @returns The entry and how it was imported.
 * @throws Error naming the item and the problem when the curation does not make a sound entry.
 */
export function convertItem(item: SurveyEntry, curation: CurationItem, probedOn: string): { readonly entry: Entry; readonly outcome: OrOutcome } {
  const { outcome } = curation;
  const givenUrl = curation.downloadUrl ?? item.url;
  if (outcome.status === "fetchable-arcgis" && curation.downloadUrl === undefined) {
    throw new Error(`${item.id}: an ArcGIS recipe needs the layer's URL as the downloadUrl`);
  }
  const dataUrl = givenUrl === item.url ? undefined : givenUrl;
  const files = outcome.status === "fetchable-instance-files" ? outcome.files : undefined;
  const sources = [
    ...[item.url, ...(dataUrl === undefined ? [] : [dataUrl])].map((url) => ({ url, retrieved: probedOn, status: "live" })),
    ...(files === undefined ? [] : files.map((file) => ({ url: file.url, retrieved: probedOn, ...(file.snapshot === undefined ? { status: "live" } : { status: "dead", snapshot: { timestamp: file.snapshot, url: waybackUrl(file.snapshot, file.url) } }) }))),
  ];
  const prefix = `${curation.namespace}-`;
  const alias = curation.id.startsWith(prefix) ? curation.id.slice(prefix.length) : "";
  if (outcome.status === "fetchable-instance-files") {
    checkInstanceFiles(item.id, outcome);
  } else if (outcome.status !== "not-fetchable") {
    checkFetchable(item.id, outcome, givenUrl);
  }
  assertMachineReadableRead(curation.id, item.url, curation.licence);
  const entry = parseEntry({
    id: curation.id,
    namespace: [curation.namespace],
    ...(alias === "" ? {} : { aliases: [alias] }),
    name: curation.name,
    description: curation.description,
    domain: domainOf(item),
    subjects: [SUBJECT],
    tags: [...new Set(item.fields)],
    category: "tasks/v1",
    sources,
    licence: licenceOf(curation.licence),
    citations: curation.citations ?? [],
    recipe: recipeOf(item.id, outcome, { source: dataUrl === undefined ? 0 : 1, url: givenUrl, firstFile: dataUrl === undefined ? 1 : 2 }),
    crosswalk: outcome.status === "not-fetchable" ? { file: OR_NODES_CROSSWALK } : outcome.status === "fetchable-instance-files" ? instanceFilesCrosswalkOf(outcome) : crosswalkOf(outcome),
    expectedCounts: expectedCountsOf(outcome),
    properties: { surveyId: item.id, ...probedNodesOf(outcome), ...statedFiguresOf(outcome), ...((outcome.status === "fetchable-instance-files" || outcome.status === "fetchable-table-collection") && outcome.timeUnit !== undefined ? { timeUnit: outcome.timeUnit } : {}) },
  });

  return {
    entry,
    outcome: { surveyId: item.id, id: curation.id, recipe: outcome.status === "not-fetchable" ? "not-fetchable" : "fetchable", ...(outcome.status === "not-fetchable" ? { reason: outcome.reason } : {}), flags: curation.flags },
  };
}

/** Compares survey ids by their number, so or-9 comes before or-10. */
function bySurveyNumber(left: string, right: string): number {
  return Number(left.slice("or-".length)) - Number(right.slice("or-".length));
}

/**
 * Converts the surveyed datasets with their curation into entries and a report. Every surveyed item must have exactly one curation and every curation must name a surveyed item, so a dataset cannot be dropped or invented silently; entry ids must be unique and not taken by an entry already in the catalogue.
 * @param survey - The survey.
 * @param curationDocument - The curation, as parsed JSON.
 * @param takenIds - The ids of entries the catalogue already holds from other sources.
 * @returns The entries in id order and the report, outcomes in survey order.
 * @throws Error naming the item and the problem on any inconsistency.
 */
export function convertSurvey(survey: SurveySource, curationDocument: unknown, takenIds: ReadonlySet<string>): { readonly entries: readonly Entry[]; readonly report: OrReport } {
  const curation: Curation = CurationSchema.parse(curationDocument);
  const byId = new Map<string, CurationItem>();
  for (const item of curation.items) {
    if (byId.has(item.surveyId)) {
      throw new Error(`${item.surveyId} has more than one curation`);
    }
    byId.set(item.surveyId, item);
  }
  const surveyIds = new Set(survey.entries.map((item) => item.id));
  for (const id of byId.keys()) {
    if (!surveyIds.has(id)) {
      throw new Error(`the curation names ${id}, which the survey does not have`);
    }
  }
  const entries: Entry[] = [];
  const outcomes: OrOutcome[] = [];
  const ids = new Map<string, string>();
  for (const item of [...survey.entries].sort((left, right) => bySurveyNumber(left.id, right.id))) {
    const curated = byId.get(item.id);
    if (curated === undefined) {
      throw new Error(`${item.id} has no curation`);
    }
    const clash = ids.get(curated.id);
    if (clash !== undefined || takenIds.has(curated.id)) {
      throw new Error(`${item.id}: the entry id ${curated.id} is already ${clash === undefined ? "an entry of another source" : `the id of ${clash}`}`);
    }
    ids.set(curated.id, item.id);
    const converted = convertItem(item, curated, curation.probedOn);
    entries.push(converted.entry);
    outcomes.push(converted.outcome);
  }

  return {
    entries: entries.sort((left, right) => (left.id < right.id ? -1 : 1)),
    report: { source: { survey: survey.survey, surveyed: survey.surveyed, probedOn: curation.probedOn }, outcomes },
  };
}
