import { CrosswalkSchema } from "crossmap";
import { z } from "zod";
import { CategoryIdSchema, countedKeys, isStreamable, type CategoryId } from "./categories";
import { define } from "./define";
import { namesOf } from "./names";
import { CatalogueSyntaxError, type SyntaxIssue } from "./errors";
import { readTemplate, templateColumns } from "./parsers/column-template";
import { recordOf } from "./record";
import { JsonScalarSchema } from "./targets/json-scalar";

/** A stable identifier: an entry id, a catalogue id. It starts with a letter or digit, so no id can be `__proto__` or any other name that begins with an underscore. Entry ids stay the same across forks, which is what lets two catalogues be compared entry by entry. */
export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, {
  message: "must start with a letter or digit and contain only letters, digits, '.', '_' and '-'",
});

/** A key of an entry's `properties` or `expectedCounts` record: an identifier that starts with a letter, so it can never be `__proto__` or another name Object.prototype reacts to on assignment. */
/** A subject: the field of study a dataset is relevant to, as a lowercase slug of words joined by hyphens, such as `operations-research`. It is separate from the entry's domain (its topic), its tags (the node fields it carries) and its namespace (the source it comes from), and it is the value a search filters by. */
export const SubjectSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, { message: "must be a lowercase slug of words joined by hyphens, such as operations-research" });

/** An alias: an id, or a path of ids joined by `/` such as `foo/graphs/bar`. A bare id is a name inside the entry's own namespace; a path is a name of its own, in the group its leading segments name. The segment pattern repeats the one in `IdSchema` so that each part of a path is an id. */
export const AliasSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/, {
  message: "must be an id, or ids joined by '/', each starting with a letter or digit and containing only letters, digits, '.', '_' and '-'",
});

/** The path a dataset sits under in a collection, outermost segment first, such as `["suitesparse", "gset"]`. Each segment is an id, so a segment can never contain the `/` that joins a namespace to a name. */
export const NamespaceSchema = z.array(IdSchema).min(1);
export type Namespace = z.infer<typeof NamespaceSchema>;

const RecordKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/, { message: "must be a letter followed by letters or digits" });

/** A calendar date, `YYYY-MM-DD`. */
const IsoDateSchema = z.iso.date();

/** An http or https URL: the only schemes a recipe may download from. Any host is allowed, an address or a single-label name included, so a fork can point a recipe at a server on its own network. */
export const HttpUrlSchema = z.url({ protocol: /^https?$/ });

/** A Wayback Machine timestamp, `YYYYMMDD` or `YYYYMMDDhhmmss`: the moment the snapshot is pinned to. */
export const WaybackTimestampSchema = z.string().regex(/^\d{8}(?:\d{6})?$/, { message: "must be a Wayback timestamp, YYYYMMDD or YYYYMMDDhhmmss" });

/**
 * The Wayback Machine URL of a snapshot of `url` at `timestamp`: the page form a person follows. The raw bytes a recipe downloads come from the `id_` form, which `fetchDataset` derives from this one.
 * @param timestamp - A Wayback timestamp.
 * @param url - The original URL.
 * @returns The snapshot URL.
 */
export function waybackUrl(timestamp: string, url: string): string {
  return `https://web.archive.org/web/${timestamp}/${url}`;
}

/**
 * The raw form of a snapshot: the bytes as they were captured, without the archive's page chrome. A recipe downloads a dead source from this URL.
 * @param timestamp - A Wayback timestamp.
 * @param url - The original URL.
 * @returns The raw snapshot URL.
 */
export function rawSnapshotUrl(timestamp: string, url: string): string {
  return `https://web.archive.org/web/${timestamp}id_/${url}`;
}

/** The SHA-256 of a snapshot's raw bytes, as 64 lower-case hex digits. */
const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, { message: "must be a lower-case hex SHA-256" });

/** A pinned Wayback Machine snapshot of a source. The timestamp is part of the recipe's reproducibility, not incidental metadata, so it travels with the URL and the two are checked against each other. The checksum, once the archiver has read the snapshot's raw form, names the exact bytes the pin stands for: their SHA-256 and length, recorded together or not at all, so a caller can check a download against the entry without fetching through this package. */
export const SnapshotSchema = z
  .object({
    url: HttpUrlSchema,
    timestamp: WaybackTimestampSchema,
    sha256: Sha256Schema.optional(),
    byteLength: z.int().min(0).optional(),
  })
  .strict()
  .refine((snapshot) => (snapshot.sha256 === undefined) === (snapshot.byteLength === undefined), { message: "sha256 and byteLength are recorded together", path: ["sha256"] });
export type Snapshot = z.infer<typeof SnapshotSchema>;

/**
 * Where a dataset's bytes come from. A `dead` source no longer serves the bytes the recipe was written against and must carry the snapshot the recipe fetches instead; a `live` source may also carry one, as the pinned record of what it served. The snapshot URL must be exactly `waybackUrl(timestamp, url)`.
 */
export const SourceSchema = z
  .object({
    url: HttpUrlSchema,
    retrieved: IsoDateSchema,
    status: z.enum(["live", "dead"]),
    snapshot: SnapshotSchema.optional(),
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.status === "dead" && source.snapshot === undefined) {
      ctx.addIssue({ code: "custom", path: ["snapshot"], message: "a dead source must pin the Wayback snapshot its recipe fetches" });
    }
    if (source.snapshot !== undefined && source.snapshot.url !== waybackUrl(source.snapshot.timestamp, source.url)) {
      ctx.addIssue({ code: "custom", path: ["snapshot", "url"], message: `must be ${waybackUrl(source.snapshot.timestamp, source.url)}, the snapshot of this source's url at this timestamp` });
    }
  });
export type Source = z.infer<typeof SourceSchema>;

/** The licence a dataset is published under: an SPDX identifier, a named licence with the URL of its terms, or a statement that the source records none. A licence the source does not state is recorded as unrecorded rather than guessed. */
export const LicenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("spdx"), id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/, { message: "must be an SPDX licence identifier" }) }).strict(),
  z.object({ kind: z.literal("custom"), name: z.string().min(1), url: HttpUrlSchema }).strict(),
  z.object({ kind: z.literal("unrecorded") }).strict(),
]);
export type Licence = z.infer<typeof LicenceSchema>;

/** A work to cite for the dataset: a formatted reference, with its DOI or URL where the source records one. */
export const CitationSchema = z
  .object({
    text: z.string().min(1),
    doi: z
      .string()
      .regex(/^10\.\d{4,9}\/\S+$/, { message: "must be a bare DOI, 10.<registrant>/<suffix>" })
      .optional(),
    url: HttpUrlSchema.optional(),
  })
  .strict();
export type Citation = z.infer<typeof CitationSchema>;

/** A relative path inside an archive or a catalogue: `/`-separated segments, none empty, `.` or `..`, so it can never climb out of the directory it is resolved against. */
export const RelativePathSchema = z.string().refine((path) => path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."), {
  message: "must be a relative path of non-empty segments with no '.' or '..'",
});

/** A regular expression a member path must match in full, in JavaScript syntax; it must compile, so a recipe with a malformed pattern is refused when the entry is parsed and not when it runs. */
const MemberPatternSchema = z.string().min(1).refine(
  (pattern) => {
    try {
      new RegExp(`^(?:${pattern})$`, "u");

      return true;
    } catch {
      return false;
    }
  },
  { message: "must be a valid regular expression" },
);

/** Which file of an archive to read: a member path, matched against a member's whole path or its trailing segments (so `net.gml` finds `net/net.gml`), the member whose name ends with one of a list of extensions (a format can have several, such as Pajek's `.net` and `.paj`), or the member whose whole path matches a regular expression (for an archive whose instance files cannot be told from its readmes and solutions by extension). A `member` selector must match exactly one member when the recipe runs, a `members` selector at least one; macOS resource-fork members (`__MACOSX/` and `._` files) never match. */
export const ArchiveMemberSchema = z.union([
  z.object({ path: RelativePathSchema }).strict(),
  z.object({ extensions: z.array(z.string().regex(/^\.[A-Za-z0-9][A-Za-z0-9.]*$/, { message: "must be a file extension such as .mtx" })).min(1) }).strict(),
  z.object({ pattern: MemberPatternSchema }).strict(),
]);
export type ArchiveMember = z.infer<typeof ArchiveMemberSchema>;

/** The archive kinds that hold several files, from which a recipe selects one (`member`) or every one a selector matches (`members`). */
const FileArchiveKindSchema = z.enum(["zip", "tar", "tar.gz", "tar.bz2", "7z", "tar.xz"]);

/** An archive a collection is read from: every file a selector matches, at least one. With `inner` of kind `xlsx`, every matched member is a workbook and each of its sheets, in the workbook's order, is one file of the collection: the sheet's CSV, at the path of the member and the sheet's name joined by `/`, for an instance format laid out on a sheet. `sheets` is a regular expression a sheet's whole name must match for the sheet to be read (every sheet when it is absent), and it must match at least one sheet of every workbook. With `inner` of a file archive kind and its own `members` selector, every matched member is an archive in its turn and each file that selector matches, at least one in each, is one file of the collection, at the member's path and the file's path joined by `/` (a download whose one wanted member is a tarball of the instance files). */
export const CollectionArchiveSchema = z
  .object({
    kind: FileArchiveKindSchema,
    members: ArchiveMemberSchema,
    inner: z.union([z.object({ kind: z.literal("xlsx"), sheets: MemberPatternSchema.optional() }).strict(), z.object({ kind: FileArchiveKindSchema, members: ArchiveMemberSchema }).strict()]).optional(),
  })
  .strict();

/** An archive whose dataset is spread over several of its files, which a parser of a multi-file format (`ogb`, `member-text`, `nxt-words`, `eaf`, `textgrid`, `option-list`, `chat`, `mtedx`, `stm`, `musan-annotations`, `word-text`) reads together into one document: every file the `files` selector matches, at least one, in path order, each gunzipped first when `inner` is `gzip` (an OGB dataset zip holds its tables as `.csv.gz` files). When `inner` is a file archive kind with its own `files` selector, each matched member is an archive in its turn and the files are those its selector matches, at least one in each, filed under the member's path and the file's path joined by `/` (a tarball that holds its annotations as one zip). With `concatenate`, the files are instead one file for a parser that reads one: their texts one after another in path order, a line break added after a file that does not end with one, so a transcript table split over a file for each chapter is read as the one table it is. */
export const FilesArchiveSchema = z
  .object({
    kind: FileArchiveKindSchema,
    files: ArchiveMemberSchema,
    inner: z.union([z.object({ kind: z.literal("gzip") }).strict(), z.object({ kind: FileArchiveKindSchema, files: ArchiveMemberSchema }).strict()]).optional(),
    concatenate: z.literal(true).optional(),
  })
  .strict();

/** A spreadsheet read as the CSV of one of its sheets (the sheet's name, as the workbook gives it): an Excel workbook (`xlsx`), a legacy binary Excel 97 to 2003 workbook (`xls`, BIFF8) or an OpenDocument spreadsheet (`ods`, whose sheets are its tables). The three give the same text for the same cells. */
export const SheetArchiveSchema = z.object({ kind: z.enum(["xlsx", "xls", "ods"]), sheet: z.string().min(1) }).strict();
export type SheetArchive = z.infer<typeof SheetArchiveSchema>;

/** How a member that is itself an archive unpacks into the file the parser reads: gunzipped, one member of it selected, or one sheet of it read when it is a spreadsheet. It nests one level, which is as deep as any source in the catalogue goes. */
export const InnerArchiveSchema = z.union([z.object({ kind: z.literal("gzip") }).strict(), z.object({ kind: FileArchiveKindSchema, member: ArchiveMemberSchema }).strict(), SheetArchiveSchema]);
export type InnerArchive = z.infer<typeof InnerArchiveSchema>;

/** The name of a part of a document read from several files, which the parser gives its meaning: the split a triples file holds (`train`, `valid`, `test`), or which of an HGB dataset's files it is (`nodes`, `links`). */
export const PartNameSchema = z.string().regex(/^[a-z][a-z0-9]*$/, { message: "must be a lowercase name of letters and digits, such as train" });

/** An archive one document is read from several files of: each part names the one member it is read from, and the parser reads the parts together in the order given. */
export const PartsArchiveSchema = z
  .object({
    kind: FileArchiveKindSchema,
    parts: z
      .array(z.object({ name: PartNameSchema, member: ArchiveMemberSchema }).strict())
      .min(1)
      .refine((parts) => new Set(parts.map((part) => part.name)).size === parts.length, { message: "each part must have its own name" }),
  })
  .strict();
export type PartsArchive = z.infer<typeof PartsArchiveSchema>;

/** How the downloaded bytes unpack into the file the parser reads, the named files a parser of a parts format reads together into one document (`parts`, such as the split files of a triples download or an HGB dataset's nodes and links), the files a parser of a multi-file format reads together into one document (`files`, such as an OGB raw directory), or for a collection the files it reads one by one. A `members` selector gives every member it matches, at least one, in path order. `gzip`, `bzip2` and `xz` are one compressed file, `tar.gz`, `tar.bz2` and `tar.xz` a tar archive compressed with them, and `7z` a 7z archive, solid or not, which is decoded once from its start for every member selected; xz and 7z are read only where the platform gives a decoder or reader (Node does, the browser does not). A member that is an archive in its turn (a contest bundle that ships its problems as a zip inside the zip, a spreadsheet inside a zip) is unpacked by `inner`. A spreadsheet (`xlsx`, `xls` or `ods`) is read as the CSV of its named sheet, with dates as ISO 8601 text, for the `csv-table` or `edge-list` parser. A point shapefile (`shapefile`) is a zip whose `member` selects the `.shp`, read with the `.dbf`, `.prj` and `.cpg` of the same name beside it as the CSV of its attribute table with each point's stored coordinates and its WGS84 position, for the `csv-table` parser. */
export const ArchiveSchema = z.union([
  z.object({ kind: z.literal("none") }).strict(),
  z.object({ kind: z.literal("gzip") }).strict(),
  z.object({ kind: z.literal("bzip2") }).strict(),
  z.object({ kind: z.literal("xz") }).strict(),
  z.object({ kind: FileArchiveKindSchema, member: ArchiveMemberSchema, inner: InnerArchiveSchema.optional() }).strict(),
  CollectionArchiveSchema,
  PartsArchiveSchema,
  FilesArchiveSchema,
  SheetArchiveSchema,
  z.object({ kind: z.literal("shapefile"), member: ArchiveMemberSchema }).strict(),
]);
export type Archive = z.infer<typeof ArchiveSchema>;
/** An archive that gives the one file a document is read from. */
export type DocumentArchive = Exclude<Archive, { readonly members: ArchiveMember } | PartsArchive | { readonly files: ArchiveMember }>;
/** An archive that gives every file a collection is read from. */
export type CollectionArchive = z.infer<typeof CollectionArchiveSchema>;
/** An archive that gives the several files one document of a multi-file format is read from. */
export type FilesArchive = z.infer<typeof FilesArchiveSchema>;

const ColumnSchema = z.int().min(0);

/** The text encoding of the unpacked file. Decoding is strict: bytes that are not valid in the stated encoding fail the recipe rather than turning into replacement characters. */
const EncodingSchema = z.enum(["utf-8", "latin1"]);

/** A column of a table as the table parser names it: the header with every run of characters outside letters, digits and underscore replaced by one underscore, so it is a valid segment of a crossmap path. */
export const ColumnNameSchema = z.string().regex(/^[A-Za-z](?:[A-Za-z0-9_]*[A-Za-z0-9])?$/, { message: "must be a column name as the parser spells it: letters, digits and underscores, starting with a letter and not ending with an underscore" });

/** A column a table parser derives: its name, the template its cells are built from, and optionally the one value of another column the rows must hold for it to have a value. */
const DerivedColumnSchema = z
  .object({
    name: ColumnNameSchema,
    template: z.string().min(1),
    /** Set on a column that only some rows can have, such as the address of a file only one kind of record has: a row whose `column` cell is not exactly `equals` has null for the derived column. */
    when: z.object({ column: ColumnNameSchema, equals: z.string().min(1) }).strict().optional(),
  })
  .strict();

/**
 * Reports the ways a table parser's derived columns are wrong without its table: a name given twice or taken by the row's id, a template that is not one, a placeholder that is not a column name and, when the recipe names the header's columns itself, a placeholder or condition naming none of them. Against a file's own header the parser checks the rest.
 * @param derived - The recipe's derived columns.
 * @param headerNames - The recipe's names for a file with no header row, if it gives them.
 * @param ctx - Where the issues are added.
 */
function addDerivedColumnIssues(derived: readonly z.infer<typeof DerivedColumnSchema>[], headerNames: readonly string[] | undefined, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const [index, { name, template, when }] of derived.entries()) {
    if (name === "id" || seen.has(name)) {
      ctx.addIssue({ code: "custom", path: ["derivedColumns", index, "name"], message: name === "id" ? "id is the row's id, so no derived column is named it" : `the derived column ${name} is given twice` });
    }
    seen.add(name);
    if (when !== undefined && headerNames !== undefined && !headerNames.includes(when.column)) {
      ctx.addIssue({ code: "custom", path: ["derivedColumns", index, "when"], message: `the condition of ${name} names the column ${when.column}, which the recipe's header names do not include` });
    }
    const reading = readTemplate(template);
    if (reading.problem !== undefined) {
      ctx.addIssue({ code: "custom", path: ["derivedColumns", index, "template"], message: `the template of ${name} has ${reading.problem}` });
      continue;
    }
    for (const column of templateColumns(reading.parts)) {
      if (!ColumnNameSchema.safeParse(column).success) {
        ctx.addIssue({ code: "custom", path: ["derivedColumns", index, "template"], message: `the template of ${name} has the placeholder ${JSON.stringify(column)}, which is not a column name` });
      } else if (headerNames !== undefined && !headerNames.includes(column)) {
        ctx.addIssue({ code: "custom", path: ["derivedColumns", index, "template"], message: `the template of ${name} names the column ${column}, which the recipe's header names do not include` });
      }
    }
  }
}

/** The parser that reads the unpacked file into the dataset's native JSON shape, with the options that format needs. Every option is stated in the entry, so a recipe reads the same way wherever it runs. */
export const ParserSchema = z.discriminatedUnion("format", [
  z
    .object({
      format: z.literal("edge-list"),
      encoding: EncodingSchema,
      delimiter: z.enum(["detect", "whitespace", "tab", "comma", "space"]),
      skipLines: z.int().min(0),
      commentPrefixes: z.array(z.string().min(1)),
      sourceColumn: ColumnSchema,
      targetColumn: ColumnSchema,
      /** Keep only the lines whose `column` holds one of `values`, so a table that lists several relations side by side (a connectome's synapse types) gives the graph of the ones named. */
      keep: z
        .object({ column: ColumnSchema, values: z.array(z.string().min(1)).min(1) })
        .strict()
        .optional(),
      /** The column holding how many edges a line stands for, a whole number, for a table that lists each pair once with its count; a line that stands for none adds neither an edge nor a node. */
      multiplicityColumn: ColumnSchema.optional(),
      /** The table lists every undirected edge twice, once in each direction and with the same multiplicity: each pair's edges are emitted once, in the direction it is first listed, a self-loop's once, and a line whose mirror is missing is an error. graph/v1 records direction in `meta` and never by duplicating edges, so an undirected graph read from such a table needs this. */
      mirrored: z.literal(true).optional(),
      /** The conditions a data line must meet to be an edge, each a column whose trimmed field equals a value; a file whose rows are of several kinds (an interaction file listing genetic beside physical interactions, or interactions with another organism's proteins) is read for the rows the dataset is made of. Without it every data line is an edge. */
      where: z
        .array(z.object({ column: ColumnSchema, equals: z.string().min(1) }).strict())
        .min(1)
        .optional(),
    })
    .strict()
    .refine((parser) => parser.sourceColumn !== parser.targetColumn, { message: "sourceColumn and targetColumn must differ", path: ["targetColumn"] })
    .refine((parser) => [parser.keep?.column, parser.multiplicityColumn, ...(parser.where ?? []).map((condition) => condition.column)].every((column) => column === undefined || (column !== parser.sourceColumn && column !== parser.targetColumn)), { message: "the keep, multiplicity and where columns must not be an endpoint column", path: ["keep"] }),
  z.object({ format: z.literal("matrix-market"), encoding: EncodingSchema }).strict(),
  z
    .object({
      format: z.literal("user-item-ratings"),
      encoding: z.literal("utf-8"),
      /** What separates the fields of a line: a comma, a tab, or the two colons of MovieLens's `ratings.dat`. */
      delimiter: z.enum(["comma", "tab", "double-colon"]),
      /** The header lines before the first rating, counted as the file's lines. */
      skipLines: z.int().min(0),
      /** What the rated items are, which is their node type and fixes the prefix of their ids. */
      itemType: z.enum(["movie", "product"]),
      /** The top of the rating scale: a rating is divided by it to give the edge's weight, and a rating above it is refused. */
      maxRating: z.number().positive(),
    })
    .strict(),
  z
    .object({
      format: z.literal("konect"),
      encoding: z.literal("utf-8"),
      /** Whether the third column is read as the edge's weight; the file's own weight type must agree. */
      weighted: z.boolean(),
      /** Whether the fourth column is read as the edge's time. */
      timestamped: z.boolean(),
    })
    .strict(),
  z
    .object({
      format: z.literal("user-item-counts"),
      encoding: z.literal("utf-8"),
      /** What separates the fields of a line. */
      delimiter: z.enum(["tab"]),
      /** The header lines before the first count, counted as the file's lines. */
      skipLines: z.int().min(0),
      /** What the counted items are, which is their node type and fixes the prefix of their ids. */
      itemType: z.enum(["artist"]),
    })
    .strict(),
  z
    .object({
      format: z.literal("kg-triples"),
      encoding: EncodingSchema,
      /** What separates the three fields of a line. */
      delimiter: z.enum(["tab", "space"]),
      /** Which field holds the relation: the middle one, or the last, as OpenKE's id files write it. */
      order: z.enum(["head-relation-tail", "head-tail-relation"]),
      /** What each file's first line is: a triple, a header naming the columns (skipped), or the number of triples the file holds (checked). */
      header: z.enum(["none", "names", "count"]),
      /** Whether every field is wrapped in double quotes, which are not part of the id. */
      quoted: z.boolean(),
    })
    .strict(),
  z
    .object({
      format: z.literal("hgb"),
      encoding: z.literal("utf-8"),
      /** The names of the node types, in the order of their codes in `node.dat`, as the dataset's `info.dat` gives them. */
      nodeTypes: z.array(z.string().min(1)).min(1),
      /** The link types, in the order of their codes in `link.dat`, each with its name and the node types its links run from and to, as `info.dat` gives them. */
      linkTypes: z.array(z.object({ name: z.string().min(1), source: z.string().min(1), target: z.string().min(1) }).strict()).min(1),
    })
    .strict()
    .refine((parser) => new Set(parser.nodeTypes).size === parser.nodeTypes.length, { message: "each node type must have its own name", path: ["nodeTypes"] })
    .refine((parser) => parser.linkTypes.every((link) => parser.nodeTypes.includes(link.source) && parser.nodeTypes.includes(link.target)), { message: "a link type's source and target must be node types the recipe names", path: ["linkTypes"] }),
  z.object({ format: z.literal("gml"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("pajek"), encoding: EncodingSchema }).strict(),
  z
    .object({
      format: z.literal("ucinet-dl"),
      encoding: EncodingSchema,
      /** Which of the file's `NM` matrices is the graph, by its 1-based position: a DL file often holds several relations over the same actors, and the recipe reads one. */
      matrix: z.int().min(1),
    })
    .strict(),
  z.object({ format: z.literal("gd-contest"), encoding: EncodingSchema }).strict(),
  /** The synapse files of Witvliet et al.'s developmental connectomes (`DatasetN_synapses.json` in github.com/dwitvliet/nature2021): a JSON array of chemical synapses, each a presynaptic neuron (`pre`) and the neurons it contacts (`post`). */
  z.object({ format: z.literal("witvliet-synapses"), encoding: z.literal("utf-8") }).strict(),
  /** An Open Graph Benchmark dataset's raw directory, read from the several files a `files` archive selects. */
  z.object({ format: z.literal("ogb"), encoding: z.literal("utf-8") }).strict(),
  z.object({ format: z.literal("nxt-words"), encoding: EncodingSchema, idPattern: MemberPatternSchema }).strict(),
  z.object({ format: z.literal("eaf"), encoding: z.literal("utf-8"), idPattern: MemberPatternSchema }).strict(),
  /** CHAT files (the TalkBank transcript format), which are always UTF-8: each main line is a turn, read from the several files a `files` archive selects. */
  z.object({ format: z.literal("chat"), encoding: z.literal("utf-8"), idPattern: MemberPatternSchema }).strict(),
  /** A Multilingual TEDx (mTEDx) language directory: each split's line-aligned `segments`, `<split>.yaml` and `<split>.<language>` files, read from the several files a `files` archive selects. */
  z.object({ format: z.literal("mtedx"), encoding: z.literal("utf-8") }).strict(),
  /** NIST STM files, which are UTF-8 in the corpora that use them: each segment line is a row, read from the several files a `files` archive selects. */
  z.object({ format: z.literal("stm"), encoding: z.literal("utf-8"), idPattern: MemberPatternSchema }).strict(),
  /** The `ANNOTATIONS` files of the MUSAN corpus, read from the several files a `files` archive selects. */
  z.object({ format: z.literal("musan-annotations"), encoding: z.literal("utf-8") }).strict(),
  /** Word documents, `.docx` packages (whose XML is UTF-8) and legacy `.doc` files (Word 97 to 2003, which state their own character encoding), one document per file: each file's main text as plain text, read from the files a `files` archive selects. */
  z.object({ format: z.literal("word-text"), encoding: z.literal("utf-8"), idPattern: MemberPatternSchema }).strict(),
  z
    .object({
      format: z.literal("option-list"),
      encoding: EncodingSchema,
      /** The options kept besides the id, by the column name the parser gives them (the option's name with its hyphens as underscores: `--rir-id` is `rir_id`); an option a line lacks is null in its row, and any other option is left out. */
      fields: z.array(ColumnNameSchema).min(1),
    })
    .strict()
    .refine((parser) => new Set([...parser.fields, "id"]).size === parser.fields.length + 1, { message: "a field may be listed once and must not be the id", path: ["fields"] }),
  z
    .object({
      format: z.literal("textgrid"),
      /** The encoding of a file that starts with no byte order mark; a file that starts with one (Praat writes UTF-16 with one) is read in the encoding the mark names. */
      encoding: EncodingSchema,
      /** A regular expression the file's whole path matches, with one capture group: the recording's id. */
      idPattern: MemberPatternSchema,
      /** The name of the tier whose annotations are the rows, as the file spells it; every file must have a tier of the name, and where several share it all are read. At most one of `tier` and `tierPattern` is given. */
      tier: z.string().min(1).optional(),
      /** A regular expression a tier's whole name matches, for a corpus whose tiers are named for the speakers and so differ from file to file: every tier it matches is read, and every file must have at least one. At most one of `tier` and `tierPattern` is given. */
      tierPattern: MemberPatternSchema.optional(),
    })
    .strict()
    .refine((parser) => parser.tier === undefined || parser.tierPattern === undefined, { message: "give at most one of tier and tierPattern, or neither to read every tier", path: ["tier"] }),
  z
    .object({
      format: z.literal("member-text"),
      encoding: EncodingSchema,
      /** A regular expression the file's whole path matches, with one capture group: the recording's id. */
      idPattern: MemberPatternSchema,
      /** The 0-based line of each file that is the text, when a file holds more than the transcript; the whole file otherwise. */
      line: z.int().min(0).optional(),
      /** Set to pass each file's text on exactly as decoded, for a corpus whose documents are the files: surrounding whitespace and line endings are kept and an empty file is an empty text, where otherwise the text is trimmed and an empty one is null. A byte order mark is still not part of the text, being the encoding's mark. A verbatim file is read whole, so it names no `line`. */
      verbatim: z.literal(true).optional(),
    })
    .strict()
    .refine((parser) => parser.verbatim === undefined || parser.line === undefined, { message: "a verbatim file is read whole, so it names no line", path: ["line"] }),
  z.object({ format: z.literal("customer-points"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("solomon"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("top"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("dtop"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("toptw"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("tsplib"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("verolog-2019"), encoding: z.literal("utf-8") }).strict(),
  z.object({ format: z.literal("vrp-rep"), encoding: z.literal("utf-8") }).strict(),
  z.object({ format: z.literal("hhcrsp"), encoding: z.literal("utf-8") }).strict(),
  z.object({ format: z.literal("mankowska"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("verolog-2017"), encoding: EncodingSchema }).strict(),
  z.object({ format: z.literal("tdc"), encoding: EncodingSchema }).strict(),
  /** A resource page of OpenSLR (openslr.org): the resource's title, identifier, summary, category, licence, description and external address as the instance's meta, and its download links as nodes. */
  z.object({ format: z.literal("openslr-resource"), encoding: z.literal("utf-8") }).strict(),
  z.object({ format: z.literal("utterance-lines"), encoding: EncodingSchema, layout: z.enum(["id-first", "id-last", "festival", "sphinx"]).optional() }).strict(),
  z
    .object({
      format: z.literal("csv-table"),
      encoding: EncodingSchema,
      delimiter: z.enum(["comma", "tab", "semicolon", "pipe", "space"]),
      skipLines: z.int().min(0),
      idColumn: ColumnNameSchema.nullable(),
      numericColumns: z.array(z.object({ column: ColumnNameSchema, factor: z.number().positive() }).strict()),
      columns: z.array(ColumnNameSchema).optional(),
      /** Set on a file with no header row: the names of its columns in order, as the parser would have spelled them from a header, so the first record after the skipped lines is a row. */
      headerNames: z.array(ColumnNameSchema).min(1).optional(),
      /** Set on a file that never quotes a field, as a tab-separated list of sentences that holds double quotes in its text: a double quote is then an ordinary character and no field is read as quoted. */
      unquoted: z.literal(true).optional(),
      /** Set on a file whose cells hold line breaks without quoting them (a duration column whose cells end in one, so the next cell starts on the next line): a line break ends a record only once the record holds as many cells as `headerNames` names, and before that it is part of the cell it falls in. Needs `headerNames`, the record's width being known before the file is read. */
      lineBreaksInCells: z.literal(true).optional(),
      /** Cell texts, besides the empty cell, that stand for a missing value (`NA`): such a cell is null in every column, numeric or not. */
      nullValues: z.array(z.string().min(1)).optional(),
      /** Columns each row gains, built from other columns of the same row: a name, and a template of text with `{column}` placeholders, each replaced by that header column's cell as the file writes it, trimmed and not scaled (the id column included). A derived column is null in a row where a column its template names is empty or its `when` condition fails, is kept whatever `columns` lists, and is an ordinary column to the crosswalk. */
      derivedColumns: z.array(DerivedColumnSchema).min(1).optional(),
    })
    .strict()
    .refine((parser) => new Set(parser.numericColumns.map((numeric) => numeric.column)).size === parser.numericColumns.length, { message: "a column may be declared numeric once", path: ["numericColumns"] })
    .refine((parser) => parser.columns === undefined || new Set(parser.columns).size === parser.columns.length, { message: "a column may be listed once", path: ["columns"] })
    .refine((parser) => parser.headerNames === undefined || new Set(parser.headerNames).size === parser.headerNames.length, { message: "a header name may be given once", path: ["headerNames"] })
    .refine((parser) => parser.lineBreaksInCells === undefined || parser.headerNames !== undefined, { message: "line breaks in cells need the column names, which give the width of a record", path: ["lineBreaksInCells"] })
    .superRefine((parser, ctx) => {
      addDerivedColumnIssues(parser.derivedColumns ?? [], parser.headerNames, ctx);
    }),
  z
    .object({
      format: z.literal("lexicon-lines"),
      encoding: EncodingSchema,
      /** Lines that start with one of these are comments and are skipped, with blank lines. */
      commentPrefixes: z.array(z.string().min(1)),
    })
    .strict(),
  /** A word list written as one JSON object whose keys are the words and whose values are their counts: each word is a row with its count, in the order the file writes them. */
  z.object({ format: z.literal("json-word-counts"), encoding: z.literal("utf-8") }).strict(),
  z
    .object({
      format: z.literal("json-table"),
      encoding: z.literal("utf-8"),
      /** `lines` is a file of one JSON record per line (as speech manifests are written), `array` a file that is one JSON array of records, `nested` a file that is one JSON object whose records sit beneath keys, one key for each of the recipe's `levels` (an annotation file keyed by sound class and then by file name). */
      layout: z.enum(["lines", "array", "nested"]),
      /** The field whose value is each record's id, as a string or a number, or the fields whose values are joined with `/` into it when no one field is unique (a transcript line has no id of its own but its session, speaker and start time together name it); a record must hold each, and any of them may also be kept as a field. A nested layout gives none: a record's id is its keys joined with `/`. */
      idField: z.union([ColumnNameSchema, z.array(ColumnNameSchema).min(2)]).optional(),
      /** For the nested layout, the name of each level of keys above the records, outermost first: a record's key at each level is the row's field of that name. */
      levels: z.array(ColumnNameSchema).min(1).optional(),
      /** The fields kept besides the id, each a string, a number or null (also where a record lacks it); any other field of a record is left out. */
      fields: z.array(ColumnNameSchema).min(1),
      /** Fields, among those kept, that a source writes as decimal text (`"8.64"`) and that are read as numbers; a number the record already holds is kept as it is. */
      numericFields: z.array(ColumnNameSchema).optional(),
    })
    .strict()
    .refine((parser) => !(typeof parser.idField === "string" && parser.fields.includes(parser.idField)) && new Set(parser.fields).size === parser.fields.length, { message: "a single id field is the row's id, so it is not listed among the fields, and a field may be listed once", path: ["fields"] })
    .refine((parser) => (parser.numericFields ?? []).every((field) => parser.fields.includes(field)), { message: "a numeric field must be among the fields kept", path: ["numericFields"] })
    .refine((parser) => (parser.layout === "nested") === (parser.levels !== undefined), { message: "the levels name the keys above the records of a nested layout, and only of one", path: ["levels"] })
    .refine((parser) => (parser.layout === "nested") === (parser.idField === undefined), { message: "a nested layout names a record by its keys, and any other layout by an id field", path: ["idField"] })
    .refine((parser) => parser.levels === undefined || new Set([...parser.levels, ...parser.fields, "id"]).size === parser.levels.length + parser.fields.length + 1, { message: "a level is a field of the row, so it must not repeat another level, a kept field or the id", path: ["levels"] }),
  z
    .object({
      format: z.literal("geojson"),
      encoding: z.literal("utf-8"),
      idColumn: ColumnNameSchema.nullable(),
      numericColumns: z.array(z.object({ column: ColumnNameSchema, factor: z.number().positive() }).strict()),
      dateColumns: z.array(ColumnNameSchema),
      columns: z.array(ColumnNameSchema).min(1),
    })
    .strict()
    .refine((parser) => new Set(parser.columns).size === parser.columns.length, { message: "a column may be listed once", path: ["columns"] })
    .refine((parser) => parser.idColumn === null || !parser.columns.includes(parser.idColumn), { message: "the id column is the row's id, so it is not listed among the columns", path: ["columns"] })
    .refine((parser) => parser.numericColumns.every((numeric) => parser.columns.includes(numeric.column)) && parser.dateColumns.every((date) => parser.columns.includes(date)), { message: "a numeric or date column must be among the columns kept", path: ["columns"] })
    .refine((parser) => new Set([...parser.numericColumns.map((numeric) => numeric.column), ...parser.dateColumns]).size === parser.numericColumns.length + parser.dateColumns.length, { message: "a column may be numeric or a date, not both, and once", path: ["dateColumns"] }),
]);
export type Parser = z.infer<typeof ParserSchema>;

/** Where a source is a paged query and not one file. An ArcGIS feature layer returns a limited number of features per request: the source URL is the layer's, the download reads every page in `orderBy` order and the parser reads the one GeoJSON collection they make. A Socrata resource endpoint (`/resource/<id>.csv`) is read `pageSize` rows at a time in the order of its row ids, with only the `select` fields when a recipe lists them, a CKAN datastore dump (`/datastore/dump/<id>`) and an OpenFEMA entity (`/api/open/v<n>/<Entity>`, with any `$select` or `$filter` in the source URL) `pageSize` rows at a time, each page a CSV with its own header; the download joins them into the one CSV the parser reads, so no single response has to survive a long transfer. */
export const PagingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("arcgis-query"), orderBy: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, { message: "must be a field name of the layer" }) }).strict(),
  z
    .object({
      kind: z.literal("socrata-resource"),
      pageSize: z.int().min(1),
      /** The resource's fields a page holds, in the order requested; every field when absent. A recipe lists the id column and the columns its parser keeps, so the columns it would drop are never transferred. */
      select: z.array(ColumnNameSchema).min(1).optional(),
    })
    .strict()
    .refine((paging) => paging.select === undefined || new Set(paging.select).size === paging.select.length, { message: "a field may be selected once", path: ["select"] }),
  z.object({ kind: z.literal("ckan-datastore"), pageSize: z.int().min(1) }).strict(),
  z.object({ kind: z.literal("openfema"), pageSize: z.int().min(1) }).strict(),
]);
export type Paging = z.infer<typeof PagingSchema>;

/** The parser formats that read a dataset spread over several files of one archive, and so the only ones a `files` archive is given to. */
export const MULTI_FILE_FORMATS: ReadonlySet<Parser["format"]> = new Set(["ogb", "member-text", "nxt-words", "eaf", "textgrid", "option-list", "chat", "mtedx", "stm", "musan-annotations", "word-text"]);
/** The multi-file formats that read each file of a files archive into one row of its own, so a streamed recipe can hand the files to them one at a time. */
export type StreamedFileFormat = Extract<Parser["format"], "member-text">;
export const STREAMED_FILE_FORMATS: ReadonlySet<Parser["format"]> = new Set<StreamedFileFormat>(["member-text"]);
/** The parser formats that read a document from named parts, and the part names each requires (none for a format whose part names are its own, such as the splits of a triples download). */
const PART_FORMATS: ReadonlyMap<Parser["format"], readonly string[] | undefined> = new Map([
  ["kg-triples", undefined],
  ["hgb", ["nodes", "links"]],
]);

/**
 * Reports a files archive that does not suit the parser: a multi-file parser reads only a files archive, and a files archive is read by a multi-file parser or, when it concatenates its files, by a parser that reads one file.
 * @param archive - The recipe's archive.
 * @param parser - The recipe's parser.
 * @param path - Where the archive sits in the entry, for the issue's path.
 * @param ctx - The refinement context to report to.
 */
function addFilesArchiveIssues(archive: Archive, parser: Parser, path: readonly (string | number)[], ctx: z.core.$RefinementCtx): void {
  const concatenated = "concatenate" in archive;
  if (concatenated && MULTI_FILE_FORMATS.has(parser.format)) {
    ctx.addIssue({ code: "custom", path: [...path, "concatenate"], message: `the ${parser.format} parser reads the files separately, so its archive does not concatenate them` });
  } else if ("files" in archive !== (MULTI_FILE_FORMATS.has(parser.format) || concatenated)) {
    ctx.addIssue({ code: "custom", path: [...path], message: `a files archive is read by a multi-file parser (${[...MULTI_FILE_FORMATS].join(", ")}) or concatenates its files for a parser that reads one file, and such a parser reads only a files archive` });
  }
}

/** A recipe that downloads one source: the source (by index into `sources`), how it is paged when it is a paged query, the archive layout its bytes unpack by, and the parser. */
export const SourceRecipeSchema = z
  .object({
    status: z.literal("fetchable"),
    source: z.int().min(0),
    paging: PagingSchema.optional(),
    archive: ArchiveSchema,
    parser: ParserSchema,
    /** Set on a dataset too large for a fetch to hold as one document: `fetchDataset` refuses it, and `streamDataset` reads it a page at a time, handing on each page's nodes as they are checked. A streamed recipe reads a CSV paged source with no archive through the `csv-table` parser, a page of rows at a time, or a `files` archive with no paging through a parser that reads each file into one row (`member-text`), a file at a time, for a category whose target is meta and nodes. */
    stream: z.literal(true).optional(),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    const required = PART_FORMATS.get(recipe.parser.format);
    if ("parts" in recipe.archive && !PART_FORMATS.has(recipe.parser.format)) {
      ctx.addIssue({ code: "custom", path: ["archive", "parts"], message: `the ${recipe.parser.format} parser reads one file, so its archive selects a member rather than parts` });
    }
    if (required !== undefined) {
      const names = "parts" in recipe.archive ? recipe.archive.parts.map((part) => part.name) : [];
      if (names.length !== required.length || !required.every((name) => names.includes(name))) {
        ctx.addIssue({ code: "custom", path: ["archive"], message: `the ${recipe.parser.format} parser reads the parts ${required.join(" and ")} from a parts archive` });
      }
    }
    addFilesArchiveIssues(recipe.archive, recipe.parser, ["archive"], ctx);
  });

/** One file of a collection read file by file: the path it is filed under in the collection, the entry's source it is downloaded from (by index into `sources`, so a dead file is fetched from its own pinned snapshot), and the archive layout its bytes unpack by into the one file or, with `members`, the several files the parser reads. */
export const CollectionFileSchema = z.object({ path: RelativePathSchema, source: z.int().min(0), archive: ArchiveSchema }).strict();
export type CollectionFile = z.infer<typeof CollectionFileSchema>;

/** A recipe for a collection whose files are separate downloads (a repository tree, a set of files served one at a time) rather than members of one archive: every file is downloaded in turn and each file, or each member it unpacks into, is an instance, read by the one parser. An instance's id is the file's path, joined by `/` to the member's path when the file is an archive. */
export const FilesRecipeSchema = z
  .object({
    status: z.literal("fetchable"),
    files: z
      .array(CollectionFileSchema)
      .min(1)
      .refine((files) => new Set(files.map((file) => file.path)).size === files.length, { message: "each file's path must be unique" }),
    parser: ParserSchema,
  })
  .strict()
  .superRefine((recipe, ctx) => {
    for (const [index, file] of recipe.files.entries()) {
      addFilesArchiveIssues(file.archive, recipe.parser, ["files", index, "archive"], ctx);
    }
  });

/** How to obtain the dataset: a fetchable recipe that downloads one source, one that downloads each file of a collection, or a statement that no declarative recipe exists yet and why. The fetchable shapes share their status and are told apart by `files`, so this is a union of strict objects. */
export const RecipeSchema = z.union([SourceRecipeSchema, FilesRecipeSchema, z.object({ status: z.literal("not-fetchable"), reason: z.string().min(1) }).strict()]);
export type Recipe = z.infer<typeof RecipeSchema>;
/** A fetchable recipe that downloads one source. */
export type SourceRecipe = z.infer<typeof SourceRecipeSchema>;
/** A fetchable recipe that downloads each file of a collection. */
export type FilesRecipe = z.infer<typeof FilesRecipeSchema>;

/**
 * Whether a recipe reads a collection, whose result is `{ meta, instances }`: one that downloads each file of a collection, or one whose archive selects `members`.
 * @param recipe - A recipe.
 * @returns True for a collection recipe.
 */
export function readsCollection(recipe: Recipe): boolean {
  return recipe.status === "fetchable" && ("files" in recipe || "members" in recipe.archive);
}

/**
 * Reports the ways a fetchable recipe's parts disagree with each other: a streamed recipe that is neither a CSV paged source read by the `csv-table` parser with no archive nor a files archive with no paging read file by file, for a category that can be streamed, and a Socrata selection that leaves out the id column or a column the parser keeps.
 * @param recipe - The fetchable recipe.
 * @param category - The entry's category.
 * @param ctx - The refinement context to report to.
 */
function addRecipeIssues(recipe: SourceRecipe, category: CategoryId, ctx: z.core.$RefinementCtx): void {
  const { paging, parser } = recipe;
  if (recipe.stream === true) {
    const pagedTable = paging !== undefined && paging.kind !== "arcgis-query" && recipe.archive.kind === "none" && parser.format === "csv-table";
    const fileByFile = paging === undefined && "files" in recipe.archive && STREAMED_FILE_FORMATS.has(parser.format);
    if (!pagedTable && !fileByFile) {
      ctx.addIssue({ code: "custom", path: ["recipe", "stream"], message: `a streamed recipe reads a CSV paged source (Socrata, CKAN or OpenFEMA) with no archive through the csv-table parser, or a files archive with no paging through a parser that reads each file into one row (${[...STREAMED_FILE_FORMATS].join(", ")})` });
    }
    if (!isStreamable(category)) {
      ctx.addIssue({ code: "custom", path: ["recipe", "stream"], message: `${category} has no streamed form, as its target is not meta and nodes alone` });
    }
  }
  if (paging?.kind === "socrata-resource" && paging.select !== undefined && parser.format === "csv-table") {
    const selected = new Set(paging.select);
    for (const column of [...(parser.idColumn === null ? [] : [parser.idColumn]), ...(parser.columns ?? [])]) {
      if (!selected.has(column)) {
        ctx.addIssue({ code: "custom", path: ["recipe", "paging", "select"], message: `must select ${column}, which the parser reads` });
      }
    }
  }
}

/** The crossmap crosswalk from the native shape to the category target: the document inline, or a `.json` file path relative to the catalogue root, so entries that share a native shape share one crosswalk. */
export const CrosswalkReferenceSchema = z.union([CrosswalkSchema, z.object({ file: RelativePathSchema.refine((path) => path.endsWith(".json"), { message: "must name a .json file" }) }).strict()]);
export type CrosswalkReference = z.infer<typeof CrosswalkReferenceSchema>;

/** The meta keys a fetched result takes from the entry's own descriptor, which its `properties` therefore may not also set. */
export const RESERVED_META_KEYS = ["id", "name"] as const;

/**
 * One catalogue entry: the descriptor (id, optional namespace, aliases and the ids of entries that hold the same data, name, description, domain, subjects, tags), the category whose target the entry resolves to, where the bytes come from, the licence and citations, the recipe, the crosswalk, the counts a fetched result is expected to have and the dataset's recorded properties. The kind of data is the category's (`kindOf(category)`), never a second field that could disagree with it.
 */
export const EntrySchema = define(
  z
    .object({
      $schema: HttpUrlSchema.optional(),
      id: IdSchema,
      namespace: NamespaceSchema.optional(),
      aliases: z.array(AliasSchema).min(1).optional(),
      sameDataAs: z.array(IdSchema).min(1).optional(),
      name: z.string().min(1),
      description: z.string().min(1).optional(),
      domain: z.string().min(1).optional(),
      subjects: z
        .array(SubjectSchema)
        .min(1)
        .refine((subjects) => new Set(subjects).size === subjects.length, { message: "subjects must be unique" })
        .optional(),
      tags: z.array(z.string().min(1)).refine((tags) => new Set(tags).size === tags.length, { message: "tags must be unique" }),
      category: CategoryIdSchema,
      sources: z.array(SourceSchema).min(1),
      licence: LicenceSchema,
      citations: z.array(CitationSchema),
      recipe: RecipeSchema,
      crosswalk: CrosswalkReferenceSchema,
      expectedCounts: recordOf(RecordKeySchema, z.int().min(0)),
      properties: recordOf(RecordKeySchema, JsonScalarSchema),
    })
    .strict()
    .superRefine((entry, ctx) => {
      const { aliases = [] } = entry;
      if (new Set(aliases).size !== aliases.length || aliases.includes(entry.id)) {
        ctx.addIssue({ code: "custom", path: ["aliases"], message: "aliases must be unique and differ from the entry's own id" });
      }
      const { sameDataAs = [] } = entry;
      if (new Set(sameDataAs).size !== sameDataAs.length || sameDataAs.includes(entry.id)) {
        ctx.addIssue({ code: "custom", path: ["sameDataAs"], message: "sameDataAs must be unique and differ from the entry's own id" });
      }
      const { full } = namesOf(entry);
      if (new Set(full).size !== full.length) {
        ctx.addIssue({ code: "custom", path: ["aliases"], message: "the entry's id and aliases must not give the same fully qualified name twice" });
      }
      if (entry.recipe.status === "fetchable" && "source" in entry.recipe && entry.recipe.source >= entry.sources.length) {
        ctx.addIssue({ code: "custom", path: ["recipe", "source"], message: `names source ${String(entry.recipe.source)} but the entry has ${String(entry.sources.length)}` });
      }
      if ("target" in entry.crosswalk && entry.crosswalk.target !== entry.category) {
        ctx.addIssue({ code: "custom", path: ["crosswalk", "target"], message: `must be the entry's category, ${entry.category}` });
      }
      if (entry.recipe.status === "fetchable" && !("files" in entry.recipe)) {
        addRecipeIssues(entry.recipe, entry.category, ctx);
      }
      if (entry.recipe.status === "fetchable" && "files" in entry.recipe) {
        for (const [index, file] of entry.recipe.files.entries()) {
          if (file.source >= entry.sources.length) {
            ctx.addIssue({ code: "custom", path: ["recipe", "files", index, "source"], message: `names source ${String(file.source)} but the entry has ${String(entry.sources.length)}` });
          }
        }
      }
      const collection = readsCollection(entry.recipe);
      const counted = countedKeys(entry.category, collection);
      for (const key of Object.keys(entry.expectedCounts)) {
        if (!counted.includes(key)) {
          ctx.addIssue({ code: "custom", path: ["expectedCounts", key], message: `${entry.category} ${collection ? "collections count" : "counts"} only ${counted.join(", ")}` });
        }
      }
      for (const key of RESERVED_META_KEYS) {
        if (Object.hasOwn(entry.properties, key)) {
          ctx.addIssue({ code: "custom", path: ["properties", key], message: `${key} is set from the entry itself in a fetched result's meta, so it cannot be a property` });
        }
      }
    }),
);
export type Entry = z.infer<typeof EntrySchema>;

/**
 * Collapses Zod issues into the package's own issue shape, so the public error surface stays stable across Zod versions.
 * @param error - A Zod error.
 * @returns One issue per Zod issue, with its path written as dotted text.
 */
export function toIssues(error: z.ZodError): SyntaxIssue[] {
  return error.issues.map((issue) => ({ path: issue.path.map(String).join(".") || "(root)", message: issue.message }));
}

/**
 * Parses an unknown value as a catalogue entry.
 * @param doc - The candidate entry document.
 * @returns The validated entry.
 * @throws CatalogueSyntaxError carrying every issue found.
 */
export function parseEntry(doc: unknown): Entry {
  const result = EntrySchema.safeParse(doc);
  if (!result.success) {
    throw new CatalogueSyntaxError("entry", toIssues(result.error));
  }

  return result.data;
}
