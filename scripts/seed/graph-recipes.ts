import type { Archive, Parser } from "../../src/entry";

/** A recipe for a download, stated whole: the archive layout and parser that read it, and the flag the import reports for it. */
interface StatedRecipe {
  readonly archive: Archive;
  readonly parser: Parser;
  readonly flag: string;
}

/**
 * Catalogue formats that name one publisher's fixed file layout, each with the recipe that reads it, found by reading the files: the pipeline reads each with a converter of its own (the format branches of experiments/pipeline/scripts/download_benchmark_graph.py and `parse_benchmark_download` in experiments/shared/infrastructure/benchmark_data.py of Mearman/Thesis), and the recipe states the same reading declaratively.
 */
export const FORMAT_RECIPES: ReadonlyMap<string, StatedRecipe> = new Map<string, StatedRecipe>([
  [
    "snap-signed",
    {
      archive: { kind: "gzip" },
      parser: edgeList({ delimiter: "tab", commentPrefixes: ["#"] }),
      flag: "SNAP signed network: a gzipped tab-separated FromNodeId, ToNodeId, Sign list under # comments; the sign is not carried",
    },
  ],
  [
    "string-ppi",
    {
      archive: { kind: "gzip" },
      parser: edgeList({ delimiter: "space", skipLines: 1, commentPrefixes: [] }),
      flag: "STRING protein links: a gzipped space-separated protein1, protein2, combined_score list under one header line, every interaction listed in both directions; the score is not carried",
    },
  ],
  [
    "biogrid-zip",
    {
      // BioGRID's TAB3 columns, 0-based (the header of the Homo sapiens file): 3 and 4 are the interactors' BioGRID ids, which every row carries where the Entrez ids can be "-"; 12 is the experimental system type; 15 and 16 are the interactors' NCBI taxonomy ids.
      archive: { kind: "zip", member: { pattern: "BIOGRID-ORGANISM-Homo_sapiens-[0-9.]+\\.tab3\\.txt" } },
      parser: edgeList({
        delimiter: "tab",
        commentPrefixes: ["#"],
        sourceColumn: 3,
        targetColumn: 4,
        where: [
          { column: 12, equals: "physical" },
          { column: 15, equals: "9606" },
          { column: 16, equals: "9606" },
        ],
      }),
      flag: "BioGRID organism archive: the Homo sapiens TAB3 file, one edge per physical interaction record between two human proteins (BioGRID ids), as the pipeline selects them; the pipeline also merges records of the same pair, which the recipe does not, so a pair with several records has several edges",
    },
  ],
  ...(["ogb", "ogb-zip"] as const).map((format): [string, StatedRecipe] => [
    format,
    {
      archive: { kind: "zip", files: { pattern: "[^/]+/raw/(?:num-node-list|num-node-dict|edge|num-edge-list|triplet-type-list|relations/[^/]+/(?:edge|num-edge-list))\\.csv\\.gz" }, inner: { kind: "gzip" } },
      parser: { format: "ogb", encoding: "utf-8" },
      flag: "Open Graph Benchmark zip: the dataset's raw directory, read as OGB reads it, with typed node ids for a heterogeneous dataset",
    },
  ]),
]);

/**
 * Downloads, by original URL, whose layout the catalogue does not record (a `various` archive with no member, or a table whose endpoint columns it does not name), found by reading them, each with the recipe that reads it.
 */
export const READ_DOWNLOADS: ReadonlyMap<string, StatedRecipe> = new Map<string, StatedRecipe>([
  [
    "http://deim.urv.cat/~aarenas/data/xarxes/email.zip",
    { archive: { kind: "zip", member: { path: "email.txt" } }, parser: edgeList({ delimiter: "whitespace" }), flag: "the archive's one member, email.txt, is a whitespace-separated list of sender, recipient and weight" },
  ],
]);

/** Downloads the catalogue records that answer 404, each with the publisher's own download of the same file, which the import adds as a further source for the recipe to read, retrieved on the date given (the catalogue's retrieval date is for the downloads it records). */
export const REPLACED_DOWNLOADS: ReadonlyMap<string, { readonly url: string; readonly retrieved: string; readonly reason: string }> = new Map([
  ["https://data.pyg.org/datasets/ogbl_biokg.zip", { url: "https://snap.stanford.edu/ogb/data/linkproppred/biokg.zip", retrieved: "2026-10-21", reason: "the PyG mirror answers 404; the URL is the one OGB's own ogb/linkproppred/master.csv names for ogbl-biokg" }],
  ["https://data.pyg.org/datasets/ogbn_mag.zip", { url: "https://snap.stanford.edu/ogb/data/nodeproppred/mag.zip", retrieved: "2026-10-21", reason: "the PyG mirror answers 404; the URL is the one OGB's own ogb/nodeproppred/master.csv names for ogbn-mag" }],
]);

/** The retrieval date of each download REPLACED_DOWNLOADS adds, by its URL. */
export const REPLACEMENT_RETRIEVED: ReadonlyMap<string, string> = new Map([...REPLACED_DOWNLOADS.values()].map((replacement) => [replacement.url, replacement.retrieved]));

/** Catalogue formats whose downloads were read and found to have no declarative keepset form, each with what the download holds. */
export const UNREADABLE_FORMATS: ReadonlyMap<string, string> = new Map([
  ["pytorch-hetero", "the file is a PyTorch torch.save archive whose graph is a pickled Python dictionary (pyHGT's OAG layout of node_forward, node_feature and edge_list by target type, source type and relation), which only a Python runtime with PyTorch can unpickle, and it is several gigabytes"],
  ["pytorch-hetero-zip", "the archive holds a PyTorch torch.save file whose graph is a pickled Python dictionary, which only a Python runtime with PyTorch can unpickle"],
  ["ieee-cis-zip", "the archive holds the IEEE-CIS fraud detection competition's raw transaction and identity tables, not a graph: H2GB builds its graph from shared card, address, email and device fields with its own construction code"],
  ["aminer-7z", "the archive is a 7z (LZMA2) file holding one JSON array of paper records (dblp.v12.json) that unpacks to over twelve gigabytes, one member larger than a fetch can hold in memory"],
  ["parquet", "the download is a Hugging Face dataset repository whose citation table is thousands of Parquet files holding billions of rows, tens of gigabytes in all, more than a fetch can hold in memory, so no Parquet reader is added for it"],
]);

/**
 * An edge-list parser with every option stated. The delimiter is detected from the data unless the pipeline fixes one, which is the pipeline's own rule (`parse_edge_list` with no delimiter): the catalogue does not record which delimiter a file uses.
 * @param options - The options that differ from a two-column list with a detected delimiter and `#` and `%` comments.
 * @returns The parser.
 */
export function edgeList(options: Partial<Extract<Parser, { format: "edge-list" }>> = {}): Parser {
  return { format: "edge-list", encoding: "utf-8", delimiter: "detect", skipLines: 0, commentPrefixes: ["#", "%"], sourceColumn: 0, targetColumn: 1, ...options };
}
