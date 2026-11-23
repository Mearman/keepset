import type { Archive, Parser } from "../../src/entry";

/** Recipes for the datasets whose pipeline parser the pipeline's own dispatch chooses by the dataset's id and not its format, written out as declarative keepset recipes, and the downloads a verifying TLS client cannot fetch: the graph import reads both by dataset id and download URL (the dispatch is in experiments/pipeline/scripts/download_benchmark_graph.py of the pipeline's repository; the WormAtlas and WormWiring connectomes are its id-chosen parsers). */

/** A recipe the import writes for one dataset by its id, with the counts that recipe reads where they differ from the catalogue's and the flag that says where it differs from the pipeline's reading; or the reason no recipe reads the dataset. */
export type DatasetRecipe = { readonly archive: Archive; readonly parser: Parser; readonly counts?: { readonly nodes: number; readonly edges: number }; readonly flag: string } | { readonly unsupported: string };

/** The WormAtlas NeuronConnect sheet: Neuron 1, Neuron 2, the synapse type and the synapse count, under one header row. */
const NEURON_CONNECT = { archive: { kind: "xls", sheet: "NeuronConnect.csv" }, columns: { type: 2, count: 3 } } as const;

/** WormAtlas's synapse types (https://www.wormatlas.org/neuronalwiring.html, section 2.1): S and Sp are chemical synapses sent from Neuron 1 to Neuron 2, R and Rp the same synapses recorded from the receiving side, so they are left out of every graph to count each synapse once; EJ is a gap junction, listed from each side; NMJ is a neuromuscular junction, whose Neuron 2 is the literal NMJ. */
const SENDS = ["S", "Sp"];

/**
 * An edge-list parser over a sheet the xls reader writes as CSV.
 * @param options - The options beyond a comma-delimited table with one header line and the endpoints in its first two columns.
 * @returns The parser.
 */
function sheetEdges(options: Partial<Extract<Parser, { format: "edge-list" }>>): Parser {
  return { format: "edge-list", encoding: "utf-8", delimiter: "comma", skipLines: 1, commentPrefixes: [], sourceColumn: 0, targetColumn: 1, ...options };
}

/** The send-only chemical flag shared by the WormAtlas chemical graphs. */
const SENDS_FLAG = "WormAtlas NeuronConnect: the recipe reads the send rows (S, Sp) from Neuron 1 to Neuron 2 and leaves out the receive rows (R, Rp), which record the same synapses from the other side; the pipeline read all four, counting each synapse twice and half of them reversed, so the counts are the recipe's";

/**
 * Recipes for datasets whose pipeline parser is chosen by the dataset's id and not its format (`_download_and_convert_xls`, `_download_and_convert_bumbarger_consensus` and `_download_and_convert_witvliet_json` in experiments/pipeline/scripts/download_benchmark_graph.py of the pipeline's repository), written out as declarative recipes. graph/v1 carries topology only, so a weight or synapse type the pipeline kept on an edge is not carried; where the recipe reads different counts from the catalogue's, the counts it reads, measured on the downloads, are stated. A dataset no single download gives is recorded with the reason.
 */
export const DATASET_RECIPES: ReadonlyMap<string, DatasetRecipe> = new Map<string, DatasetRecipe>([
  ["wormwiring-celegans-hermaphrodite-chemical", { archive: NEURON_CONNECT.archive, parser: sheetEdges({ keep: { column: NEURON_CONNECT.columns.type, values: SENDS }, multiplicityColumn: NEURON_CONNECT.columns.count }), counts: { nodes: 279, edges: 6394 }, flag: `${SENDS_FLAG}; each synapse is an edge, a row giving as many as its count` }],
  ["wormwiring-celegans-hermaphrodite-chemical-weighted", { archive: NEURON_CONNECT.archive, parser: sheetEdges({ keep: { column: NEURON_CONNECT.columns.type, values: SENDS } }), counts: { nodes: 279, edges: 2575 }, flag: `${SENDS_FLAG}; each row is one edge and its synapse count, the weight, is not carried` }],
  ["wormwiring-celegans-hermaphrodite-chemical-typed", { archive: NEURON_CONNECT.archive, parser: sheetEdges({ keep: { column: NEURON_CONNECT.columns.type, values: SENDS } }), counts: { nodes: 279, edges: 2575 }, flag: `${SENDS_FLAG}; each row is one edge and its type and count are not carried` }],
  ["wormwiring-celegans-hermaphrodite-chemical-undirected-typed", { archive: NEURON_CONNECT.archive, parser: sheetEdges({ keep: { column: NEURON_CONNECT.columns.type, values: SENDS } }), counts: { nodes: 279, edges: 2575 }, flag: `${SENDS_FLAG}; each row is one undirected edge, a reciprocal pair staying two, and its type and count are not carried` }],
  ["wormwiring-celegans-hermaphrodite-full", { archive: NEURON_CONNECT.archive, parser: sheetEdges({ keep: { column: NEURON_CONNECT.columns.type, values: [...SENDS, "EJ", "NMJ"] } }), counts: { nodes: 281, edges: 3759 }, flag: `${SENDS_FLAG}; the gap junction rows (EJ) give an edge each way, as the file lists them, and the neuromuscular rows (NMJ) an edge to the node NMJ; each row is one edge and its type and count are not carried` }],
  ["wormwiring-celegans-hermaphrodite-gapjunctions", { archive: NEURON_CONNECT.archive, parser: sheetEdges({ keep: { column: NEURON_CONNECT.columns.type, values: ["EJ"] }, mirrored: true }), counts: { nodes: 253, edges: 517 }, flag: "WormAtlas NeuronConnect: the recipe reads the gap junction rows (EJ), which list each junction from both neurons, as one undirected edge per pair; the pipeline kept both listings, so the counts are the recipe's, and the junction count, the weight, is not carried" }],
  ["wormwiring-ppacificus-pharyngeal", { archive: { kind: "xlsx", sheet: "Sheet1" }, parser: sheetEdges({ skipLines: 2 }), counts: { nodes: 29, edges: 78 }, flag: "Bumbarger and Sommer's consensus network (Table S2) gives each connection the synapse count of each of its two specimens and their average, which is a half for many connections, so no whole number of synapses is recorded: the recipe reads each connection as one edge from the presynaptic to the postsynaptic neuron, below the table's title and header rows; the pipeline rounded the average half to even, so the counts are the recipe's" }],
  ["wormwiring-witvliet-L1-1-chemical", { archive: { kind: "none" }, parser: { format: "witvliet-synapses", encoding: "utf-8" }, flag: "Witvliet synapses: each partner of a polyadic chemical synapse is an edge from the presynaptic neuron" }],
  ["wormwiring-witvliet-L1-4-chemical", { archive: { kind: "none" }, parser: { format: "witvliet-synapses", encoding: "utf-8" }, flag: "Witvliet synapses: each partner of a polyadic chemical synapse is an edge from the presynaptic neuron" }],
  ["wormwiring-witvliet-L2-chemical", { archive: { kind: "none" }, parser: { format: "witvliet-synapses", encoding: "utf-8" }, flag: "Witvliet synapses: each partner of a polyadic chemical synapse is an edge from the presynaptic neuron" }],
  ["wormwiring-witvliet-L3-chemical", { archive: { kind: "none" }, parser: { format: "witvliet-synapses", encoding: "utf-8" }, flag: "Witvliet synapses: each partner of a polyadic chemical synapse is an edge from the presynaptic neuron" }],
  ["wormwiring-witvliet-L1-1-all-unweighted", { unsupported: "the graph joins the specimen's chemical synapse file with its gap junction file (Dataset1_gapjunctions.json beside it), and a recipe reads one download" }],
  ["wormwiring-witvliet-L1-4-all-unweighted", { unsupported: "the graph joins the specimen's chemical synapse file with its gap junction file (Dataset4_gapjunctions.json beside it), and a recipe reads one download" }],
]);

/** Downloads, by URL, that a client verifying TLS cannot fetch from their host although it still serves them, each with the Wayback snapshot holding the same bytes, which the recipe fetches instead, and why. The import records such a download as a dead source pinned to that snapshot and flags the reason. */
export const UNVERIFIABLE_DOWNLOADS: ReadonlyMap<string, { readonly timestamp: string; readonly reason: string }> = new Map([
  [
    "https://www.wormatlas.org/images/NeuronConnect.xls",
    {
      timestamp: "20260829213511",
      reason: "www.wormatlas.org sends only its own certificate and not the InCommon intermediate that issued it, so a client that does not fetch missing intermediates (Node's among them) cannot verify it, and its plain http address redirects to a malformed one; the snapshot holds the bytes the host serves (its Wayback digest is the SHA-1 of the live file)",
    },
  ],
]);
