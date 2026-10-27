import { z } from "zod";
import { ArchiveSchema, CitationSchema, CollectionArchiveSchema, ColumnNameSchema, HttpUrlSchema, IdSchema, ParserSchema, RelativePathSchema, WaybackTimestampSchema } from "../../src/entry";
import { isInstanceParser } from "../../src/parsers/instance-shapes";
import { LicenceTermsSchema, prose } from "./licence";

/* The operations-research survey the seed import reads (scripts/seed/sources/or-datasets-survey.json) and the curation that turns each surveyed item into a catalogue entry. The survey says what each item is and which fields of the routing-with-rewards node model it carries; the curation records, per item, what a download actually gives and how its columns map onto the tasks/v1 node, because that takes reading each source and is a judgement the survey cannot make. */

/** One surveyed dataset: an id, a title, the URL the survey recorded, the theme it was filed under and the node-model fields it carries. */
export const SurveyEntrySchema = z.looseObject({
  id: z.string().regex(/^or-\d+$/, { message: "must be or- and a number" }),
  title: z.string().min(1),
  url: z.string().min(1),
  theme: z.string().min(1),
  fields: z.array(z.string().min(1)),
});
export type SurveyEntry = z.infer<typeof SurveyEntrySchema>;

/** The survey document. */
export const SurveySourceSchema = z.looseObject({
  survey: z.string(),
  surveyed: z.string(),
  entries: z.array(SurveyEntrySchema),
});
export type SurveySource = z.infer<typeof SurveySourceSchema>;

/** How a target field's values read in a table: a number, text, or either (a deadline is a time of day as a number in a routing instance and a date as text in a case record). */
export type FieldKind = "number" | "text" | "either";

/** The tasks/v1 node fields a column can map onto, in the order a crosswalk lists them, so its rules do not depend on key order. */
export const TARGET_FIELD_NAMES = ["closed", "deadline", "duration", "lat", "lon", "opened", "prize", "prizeProbability", "skill", "status", "territory", "travelTime", "x", "y"] as const;
export type TargetField = (typeof TARGET_FIELD_NAMES)[number];

/** The kind of value each target field holds. */
export const TARGET_FIELDS: Readonly<Record<TargetField, FieldKind>> = {
  closed: "text",
  deadline: "either",
  duration: "number",
  lat: "number",
  lon: "number",
  opened: "text",
  prize: "number",
  prizeProbability: "number",
  skill: "text",
  status: "text",
  territory: "text",
  travelTime: "number",
  x: "number",
  y: "number",
};

/** The columns of a table by the target field each fills; a field is mapped at most once and a column fills at most one field. */
const FieldMapSchema = z
  .object({
    lat: ColumnNameSchema.optional(),
    lon: ColumnNameSchema.optional(),
    x: ColumnNameSchema.optional(),
    y: ColumnNameSchema.optional(),
    prize: ColumnNameSchema.optional(),
    prizeProbability: ColumnNameSchema.optional(),
    duration: ColumnNameSchema.optional(),
    travelTime: ColumnNameSchema.optional(),
    skill: ColumnNameSchema.optional(),
    territory: ColumnNameSchema.optional(),
    status: ColumnNameSchema.optional(),
    opened: ColumnNameSchema.optional(),
    closed: ColumnNameSchema.optional(),
    deadline: ColumnNameSchema.optional(),
  })
  .strict();
export type FieldMap = z.infer<typeof FieldMapSchema>;

/** A dataset whose download has a recipe: how to read the table, the file's header cells exactly as it writes them, and which of its columns fill the node's fields. The parser's column names follow from the header cells and the id column, and every column not mapped is dropped by a one-way rule, so what an entry leaves out is written down. Column names in the map, the numeric columns and the id column are the parser's names (`columnNames`), not the raw cells. */
export const FetchableOutcomeSchema = z
  .object({
    status: z.literal("fetchable"),
    encoding: z.enum(["utf-8", "latin1"]),
    delimiter: z.enum(["comma", "tab", "semicolon"]),
    skipLines: z.int().min(0),
    /** Cell texts, besides the empty cell, that the source writes for a missing value, such as `NA`. */
    nullValues: z.array(z.string().min(1)).optional(),
    /** How the download unpacks into the table's file, when it is an archive: a zip with the member to read, or a spreadsheet (xlsx, xls or ods, alone or as a zip member's inner layout) with the sheet (then `skipLines` counts the sheet's rows above the header, and `encoding` and `delimiter` describe the CSV the sheet is turned into: utf-8 and comma). */
    archive: ArchiveSchema.optional(),
    idColumn: ColumnNameSchema.nullable(),
    numericColumns: z.array(z.object({ column: ColumnNameSchema, factor: z.number().positive() }).strict()),
    header: z.array(z.string()).min(1),
    rowCount: z.int().min(0).optional(),
    /** The node count of a source that does not change, such as a file committed to a repository or a published dataset. The entry records it as `expectedCounts`, so a fetch warns when the result differs. Open-data tables that grow are left without one, and their `rowCount` is recorded as the entry's `probedNodes` property, a figure the listing shows as approximate and a fetch does not assert. */
    expectedNodes: z.int().min(0).optional(),
    map: FieldMapSchema,
  })
  .strict();
export type FetchableOutcome = z.infer<typeof FetchableOutcomeSchema>;

/** A dataset whose source is a paged ArcGIS feature layer: the layer's URL is the curation's `downloadUrl`, its feature properties are named in `header` verbatim (each already a valid column name), a point layer also has the position columns `geometry_latitude` and `geometry_longitude`, and the epoch-millisecond date properties that fill a text field are `dateColumns`. Everything else is as for a table. */
export const ArcgisOutcomeSchema = z
  .object({
    status: z.literal("fetchable-arcgis"),
    orderBy: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: "must be a field name of the layer" }),
    point: z.boolean(),
    idColumn: ColumnNameSchema.nullable(),
    numericColumns: z.array(z.object({ column: ColumnNameSchema, factor: z.number().positive() }).strict()),
    dateColumns: z.array(ColumnNameSchema),
    header: z.array(ColumnNameSchema).min(1),
    rowCount: z.int().min(0).optional(),
    expectedNodes: z.int().min(0).optional(),
    map: FieldMapSchema,
  })
  .strict();
export type ArcgisOutcome = z.infer<typeof ArcgisOutcomeSchema>;

/** A dataset that is a collection of tables in an archive, one table file per instance: every member the archive selector matches is read as a table with the same header and options, as for a single table, and becomes an instance of the set. `timeUnit` says what the source's time quantities are measured in, since the tasks/v1 `duration` is seconds (a column in minutes is scaled by a factor of sixty), and is left out for a source that has none. */
export const TableCollectionOutcomeSchema = z
  .object({
    status: z.literal("fetchable-table-collection"),
    archive: CollectionArchiveSchema,
    encoding: z.enum(["utf-8", "latin1"]),
    delimiter: z.enum(["comma", "tab", "semicolon"]),
    skipLines: z.int().min(0),
    nullValues: z.array(z.string().min(1)).optional(),
    idColumn: ColumnNameSchema.nullable(),
    numericColumns: z.array(z.object({ column: ColumnNameSchema, factor: z.number().positive() }).strict()),
    header: z.array(z.string()).min(1),
    map: FieldMapSchema,
    timeUnit: z.enum(["seconds", "abstract units"]).optional(),
    expectedInstances: z.int().min(0).optional(),
  })
  .strict();
export type TableCollectionOutcome = z.infer<typeof TableCollectionOutcomeSchema>;

/** An outcome with a recipe that reads a table: one file, a paged ArcGIS layer, or every table file of an archive. */
export type TableOutcome = FetchableOutcome | ArcgisOutcome | TableCollectionOutcome;

/** A dataset whose download is made of instance files read by an instance file parser: either one file (`archive` selects it with `member`, or the download is the file itself, and the entry is a tasks/v1 document), or every file of an archive that a `members` selector matches (a collection, one instance per file). `map` says which of the parser's node columns fill the tasks/v1 node's fields, `keep` which pass through under their own names, and a node column in neither is dropped by a one-way rule, so what an entry leaves out is written down. The file's header values are all carried in the document's meta (for a collection, in each instance's). `timeUnit` says what the source's time quantities are measured in, since the tasks/v1 `duration` is seconds, and is left out for a source that has none. */
/** One file of a collection whose files are separate downloads, as a curation records it: its path in the collection, the URL it is downloaded from, the Wayback timestamp of the capture it is read from when that URL no longer serves it (the entry then records the source as dead and pins the snapshot), and how its bytes unpack. */
export const CurationFileSchema = z.object({ path: RelativePathSchema, url: HttpUrlSchema, snapshot: WaybackTimestampSchema.optional(), archive: ArchiveSchema }).strict();
export type CurationFile = z.infer<typeof CurationFileSchema>;

export const InstanceFilesOutcomeSchema = z
  .object({
    status: z.literal("fetchable-instance-files"),
    /** How the download unpacks, for a dataset that is one download. */
    archive: ArchiveSchema.optional(),
    /** The files of a collection that are separate downloads, each its own source. */
    files: z.array(CurationFileSchema).min(1).optional(),
    parser: ParserSchema.refine(isInstanceParser, { message: "must be an instance file parser" }),
    map: FieldMapSchema,
    keep: z.array(ColumnNameSchema),
    /** What a mapped duration or travel time column is multiplied by to put it in seconds, for a source that gives minutes. */
    factors: z.object({ duration: z.number().positive().optional(), travelTime: z.number().positive().optional() }).strict().optional(),
    timeUnit: z.enum(["seconds", "abstract units"]).optional(),
    expectedInstances: z.int().min(0).optional(),
    expectedNodes: z.int().min(0).optional(),
  })
  .strict()
  .refine((outcome) => (outcome.archive === undefined) !== (outcome.files === undefined), { message: "an instance files outcome reads one download (archive) or separate downloads (files), not both or neither" });
export type InstanceFilesOutcome = z.infer<typeof InstanceFilesOutcomeSchema>;

/** A dataset with no recipe yet, and why. Where the publisher's own API, headers or documentation state how much the dataset holds, or the files were counted, the outcome records the figures and where they were read (`evidence` is required with any of them): `nodes` is the number of places or tasks, `instances` the number of instance files a collection holds, and `downloadBytes` the size of everything the publisher offers for download, so the listing can still state them. */
export const NotFetchableOutcomeSchema = z
  .object({
    status: z.literal("not-fetchable"),
    reason: prose(),
    nodes: z.int().min(0).optional(),
    instances: z.int().min(0).optional(),
    downloadBytes: z.int().positive().optional(),
    evidence: prose().optional(),
  })
  .strict()
  .refine((outcome) => (outcome.nodes === undefined && outcome.instances === undefined && outcome.downloadBytes === undefined) === (outcome.evidence === undefined), { message: "figures and the evidence they were read from come together" });

/** The prose that says what a dataset is: the same text as other prose in the catalogue, and not blank, since an entry with nothing to read in a listing cannot be told from its neighbours. */
const description = (): z.ZodString => prose().refine((text) => text.trim() !== "", { message: "must not be blank" });

/** The curation of one surveyed item. A description is required: the importer refuses an item without one, so a new entry cannot be added undescribed. `citations` lists the works the dataset's source names for it (a paper, a data descriptor, the deposit itself), and is absent where the source names none. */
export const CurationItemSchema = z
  .object({
    surveyId: z.string().regex(/^or-\d+$/, { message: "must be or- and a number" }),
    id: IdSchema,
    namespace: IdSchema,
    name: prose(),
    description: description(),
    licence: LicenceTermsSchema,
    citations: z.array(CitationSchema).min(1).optional(),
    downloadUrl: HttpUrlSchema.optional(),
    flags: z.array(prose()),
    outcome: z.discriminatedUnion("status", [FetchableOutcomeSchema, ArcgisOutcomeSchema, TableCollectionOutcomeSchema, InstanceFilesOutcomeSchema, NotFetchableOutcomeSchema]),
  })
  .strict();
export type CurationItem = z.infer<typeof CurationItemSchema>;

/** The curation document: the date its facts were read from the sources, and one item for each surveyed dataset. */
export const CurationSchema = z
  .object({
    probedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date, YYYY-MM-DD" }),
    items: z.array(CurationItemSchema),
  })
  .strict();
export type Curation = z.infer<typeof CurationSchema>;
