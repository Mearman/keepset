import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { convertCatalogue, convertDataset, NAME_OVERRIDES, namespaceOf, netzschleuderCsv, parseWayback, type Outcome } from "./convert";
import { DATASET_RECIPES, UNVERIFIABLE_DOWNLOADS } from "./dataset-recipes";
import { FORMAT_RECIPES, READ_DOWNLOADS, REPLACED_DOWNLOADS, UNREADABLE_FORMATS } from "./graph-recipes";
import { GraphLicencesSchema, graphLicenceResolver } from "./licence";
import { SuiteSparseMirrorSchema } from "./mirror";
import { NetzschleuderIndexSchema } from "./netzschleuder-index";
import { SuiteSparseIndexSchema } from "./suitesparse-index";
import { GraphboxCatalogueSchema, SourceCatalogueSchema } from "./source";

/* A small committed slice of the pipeline catalogue, one dataset per classification path, and of the graphbox catalogue for the overlap section. */
const pipeline = SourceCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/pipeline-slice.json"), "utf8")));
const graphbox = GraphboxCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/graphbox-slice.json"), "utf8")));

const stated = (id: string, name: string, prefixes: readonly string[]) => ({ id, name, prefixes, terms: { licence: { kind: "spdx", id: "CC-BY-4.0" }, statedAt: `https://${id}.example/terms`, statement: `${name} states CC-BY-4.0` } });
const unstated = (id: string, name: string, prefixes: readonly string[]) => ({ id, name, prefixes, terms: { readAt: [`https://${id}.example/about`], reason: `${name} states no terms` } });
/* A licence curation covering exactly the hosts the slice's recipes read from: Pajek states one licence for everything it hosts, the others state none, and the Hugging Face dataset states its own. GroupLens is curated per dataset. */
const licences = GraphLicencesSchema.parse({
  readOn: "2026-10-20",
  publishers: [
    unstated("netzschleuder", "Netzschleuder", ["https://networks.skewed.de/"]),
    unstated("newman", "Newman", ["https://websites.umich.edu/"]),
    unstated("nrvis", "Network Repository", ["http://nrvis.com/", "http://networkrepository.com/"]),
    unstated("snap", "SNAP", ["https://snap.stanford.edu/"]),
    stated("pajek", "Pajek", ["http://vlado.fmf.uni-lj.si/"]),
    stated("suitesparse", "SuiteSparse", ["https://sparse.tamu.edu/", "https://mirror.example/sparse/"]),
    unstated("linqs", "LINQS", ["https://linqs-data.soe.ucsc.edu/"]),
    unstated("conve", "ConvE", ["https://github.com/TimDettmers/ConvE/"]),
    unstated("konect", "KONECT", ["http://konect.cc/"]),
    unstated("example", "Example", ["https://example.org/"]),
    unstated("amazon-ratings", "Amazon product data", ["http://jmcauley.ucsd.edu/"]),
    { id: "grouplens", name: "GroupLens", prefixes: ["https://files.grouplens.org/datasets/"], perDataset: true },
    unstated("openke", "OpenKE", ["https://raw.githubusercontent.com/thunlp/OpenKE/"]),
    unstated("hgb", "Heterogeneous Graph Benchmark", ["https://drive.google.com/"]),
    unstated("mannheim", "Mannheim KGE datasets", ["https://web.informatik.uni-mannheim.de/pi1/kge-datasets/"]),
    { id: "huggingface", name: "Hugging Face", prefixes: ["https://huggingface.co/"], perDataset: true },
  ],
  datasets: {
    "lastfm-hgb": { readAt: ["https://files.grouplens.org/datasets/hetrec2011/"], reason: "The release page states no terms." },
    ...Object.fromEntries(["movielens-100k", "movielens-1m", "movielens-10m", "movielens-25m", "movielens-unread"].map((id) => [id, { readAt: ["https://files.grouplens.org/datasets/movielens/"], reason: "The release page states no terms." }])),
    "ieee-cis-g": { licence: { kind: "spdx", id: "MIT" }, statedAt: "https://huggingface.co/api/datasets/example/data", statement: "The card's licence field is mit." },
    "oag-eng": { readAt: ["https://huggingface.co/api/datasets/example/data"], reason: "The card has no licence field." },
  },
});
/* A resolver is single use: it remembers which curation records a conversion used. The slice holds none of the datasets NAME_OVERRIDES renames or DATASET_RECIPES reads, so it converts with no overrides; the overrides are tested against the committed full catalogue below. */
const resolver = () => graphLicenceResolver(licences);
/* The mirror holds Pajek/Kohonen and not Pajek/Missing, so one of the slice's two SuiteSparse downloads is offered from it. */
const mirror = SuiteSparseMirrorSchema.parse({ label: "the University of Florida mirror", readOn: "2026-10-21", host: "https://mirror.example/sparse/", holds: ["MM/Pajek/Kohonen.tar.gz"] });
const facts = {
  suiteSparse: SuiteSparseIndexSchema.parse({ readOn: "2026-10-24", kinds: { "Pajek/Kohonen": "Weighted Graph" } }),
  netzschleuder: NetzschleuderIndexSchema.parse({ readOn: "2026-10-24", networks: { bison: ["Social", "Animal", "Weighted"] } }),
};
const noFacts = {
  suiteSparse: SuiteSparseIndexSchema.parse({ readOn: "2026-10-24", kinds: {} }),
  netzschleuder: NetzschleuderIndexSchema.parse({ readOn: "2026-10-24", networks: {} }),
};
const NO_OVERRIDES = { names: new Map<string, string>(), recipes: new Map() } as const;
const { entries, report } = convertCatalogue(pipeline, graphbox, { licences: resolver(), mirrors: [mirror], facts, domains: {} }, NO_OVERRIDES);

/** What the source catalogue records for the collaboration network's nodes, which the import corrects without editing it. */
const CATALOGUE_COLLABORATION_NODES = 22015;

function outcome(id: string): Outcome {
  const found = report.outcomes.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no outcome for ${id}`);
  }

  return found;
}

function entry(id: string) {
  const found = entries.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`no entry for ${id}`);
  }

  return found;
}

describe("the seed import's classification", () => {
  it("reports every dataset of the source exactly once, in id order", () => {
    const ids = Object.keys(pipeline.datasets).sort();
    expect(report.outcomes.map((candidate) => candidate.id)).toEqual(ids);
  });

  it("converts a download whose recipe the catalogue records in full, without flags", () => {
    expect(outcome("amazon0302")).toEqual({ id: "amazon0302", outcome: "converted", recipe: "fetchable", flags: [] });
    expect(entry("amazon0302").recipe).toMatchObject({ archive: { kind: "gzip" }, parser: { format: "edge-list", delimiter: "detect" } });
  });

  it("flags each parser override, derived member and pinned snapshot the import supplied", () => {
    expect(outcome("wiki-vote").flags).toContain("pipeline parser override: delimiter tab");
    expect(outcome("adjnoun")).toMatchObject({ outcome: "converted-with-flags", recipe: "fetchable" });
    expect(outcome("csphd").flags).toEqual(["archive member chosen by extension .net or .paj, which the source catalogue does not record", "the source is dead and the recipe fetches its pinned Wayback snapshot"]);
    expect(outcome("advogato").flags).toEqual(["archive member chosen by extension .edges, which the source catalogue does not record"]);
  });

  it("pins a Wayback download as a dead source with its snapshot, reading the member the catalogue names", () => {
    const cities = entry("cities");
    expect(cities.sources[0]).toEqual({
      url: "http://vlado.fmf.uni-lj.si/pub/networks/data/2mode/cities.zip",
      retrieved: cities.sources[0]?.retrieved,
      status: "dead",
      snapshot: { url: "https://web.archive.org/web/20230601/http://vlado.fmf.uni-lj.si/pub/networks/data/2mode/cities.zip", timestamp: "20230601" },
    });
    expect(cities.recipe).toMatchObject({ archive: { kind: "zip", member: { path: "da6+.net" } }, parser: { format: "pajek" } });
  });

  it("reads LINQS citations from the citing paper to the cited one", () => {
    expect(entry("cora").recipe).toMatchObject({ archive: { kind: "tar.gz", member: { extensions: [".cites"] } }, parser: { delimiter: "tab", sourceColumn: 1, targetColumn: 0 } });
  });

  it("applies the Netzschleuder rule to landing pages and graph-tool files alike", () => {
    expect(outcome("7th_graders").flags[0]).toMatch(/^Netzschleuder:/);
    expect(entry("7th_graders").sources.map((source) => source.url)).toContain("https://networks.skewed.de/net/7th_graders/files/7th_graders.csv.zip");
    expect(entry("bos_genetic").sources.map((source) => source.url)).toContain("https://networks.skewed.de/net/genetic_multiplex/files/Bos_Multiplex_Genetic.csv.zip");
    expect(entry("netzschleuder-bison").recipe).toMatchObject({ archive: { kind: "zip", member: { path: "edges.csv" } }, parser: { delimiter: "comma", commentPrefixes: ["#"] } });
  });

  it("drops auth-walled and local-file downloads, naming them, and keeps the rest", () => {
    expect(outcome("h-pokec").flags).toContain("dropped an auth-walled download at www.kaggle.com");
    expect(entry("h-pokec").sources.every((source) => !source.url.includes("kaggle"))).toBe(true);
    expect(outcome("oag-eng").flags).toContain("dropped a download that is a local file path, not a public source");
    expect(entry("oag-eng").sources.every((source) => source.url.startsWith("https://"))).toBe(true);
  });

  it("reads a UCINet download's first matrix with the DL parser, and gives a download that is not DL its reason", () => {
    expect(entry("ucinet-zachary").recipe).toEqual({ status: "fetchable", source: 0, archive: { kind: "none" }, parser: { format: "ucinet-dl", encoding: "utf-8", matrix: 1 } });
    expect(outcome("ucinet-zachary").flags).toContain("UCINet DL: the recipe reads the file's first matrix, the one the pipeline reads");
    expect(entry("ucinet-knokbur").recipe).toEqual({
      status: "not-fetchable",
      reason: "no download is in a form keepset reads yet (ucinet: the file is not a DL file: its first line says it has to be converted into DL format, and its matrices sit under comma-separated headers and end with DOS end-of-file marks)",
    });
  });

  it("reads a GD contest problem from the zip inside the contest bundle", () => {
    expect(entry("pajek-gd04-prob1").recipe).toMatchObject({ status: "fetchable", archive: { kind: "zip", member: { extensions: [".zip"] }, inner: { kind: "zip", member: { path: "challenge/prob1.gd4" } } }, parser: { format: "gd-contest", encoding: "utf-8" } });
    expect(outcome("pajek-gd04-prob1").flags).toContain("GD contest bundle: the problem is read from the bundle's one inner .zip member, which the source catalogue does not record");
  });

  it("marks an entry not fetchable when no download has a declarative form, saying why", () => {
    expect(entry("ieee-cis-g").recipe).toMatchObject({ status: "not-fetchable" });
  });

  it("reads a bzip2 download as a bare bzip2 file when its name says so", () => {
    expect(entry("bz2-edges").recipe).toMatchObject({ status: "fetchable", archive: { kind: "bzip2" }, parser: { format: "edge-list" } });
    expect(entry("bz2-edges").crosswalk).toEqual({ file: "crosswalks/graph-v1/topology.json" });
  });

  it("reads an Amazon ratings file as comma-separated ratings with no header, rated by the shared ratings crosswalk", () => {
    for (const id of ["amazon-musical-instruments", "amazon-movies-tv"]) {
      expect(entry(id).recipe).toMatchObject({ status: "fetchable", archive: { kind: "none" }, parser: { format: "user-item-ratings", delimiter: "comma", skipLines: 0, itemType: "product", maxRating: 5 } });
      expect(entry(id).crosswalk).toEqual({ file: "crosswalks/graph-v1/rated.json" });
      expect(outcome(id).flags).toContain("ratings layout read from the downloaded file: user, product, rating and time separated by commas, with no header");
    }
  });

  it("reads each MovieLens release in the layout that release has, naming the member", () => {
    expect(entry("movielens-100k").recipe).toMatchObject({ archive: { kind: "zip", member: { path: "u.data" } }, parser: { format: "user-item-ratings", delimiter: "tab", skipLines: 0, itemType: "movie", maxRating: 5 } });
    expect(entry("movielens-1m").recipe).toMatchObject({ archive: { kind: "zip", member: { path: "ratings.dat" } }, parser: { delimiter: "double-colon", skipLines: 0 } });
    expect(entry("movielens-10m").recipe).toMatchObject({ archive: { kind: "zip", member: { path: "ratings.dat" } }, parser: { delimiter: "double-colon", skipLines: 0 } });
    expect(entry("movielens-10m").crosswalk).toEqual({ file: "crosswalks/graph-v1/rated.json" });
    expect(outcome("movielens-10m").flags).toContain("ratings layout of ml-10m read from the release: ratings.dat, delimiter double-colon, 0 header lines");
  });

  it("gives a release whose whole fetch failed no recipe, though its layout is read", () => {
    expect(entry("movielens-25m").recipe).toEqual({
      status: "not-fetchable",
      reason: "no download is in a form keepset reads yet (movielens: the ratings file has more edges than one fetch can hold: the crosswalk step aborts on it with an allocation failure (ExaDev/crossmap#57), where ml-10m completes)",
    });
  });

  it("does not guess the layout of a MovieLens release it has not read", () => {
    expect(entry("movielens-unread").recipe).toEqual({ status: "not-fetchable", reason: "no download is in a form keepset reads yet (movielens: a MovieLens release whose ratings layout the import has not read)" });
  });

  it("reads each KONECT archive with the columns its file has, choosing the crosswalk that carries them", () => {
    const member = { pattern: "(?:[^/]+/)?out\\.[^/]+" };
    expect(entry("lesmis").recipe).toMatchObject({ status: "fetchable", archive: { kind: "tar.bz2", member }, parser: { format: "konect", weighted: true, timestamped: false } });
    expect(entry("lesmis").crosswalk).toEqual({ file: "crosswalks/graph-v1/weighted.json" });
    expect(entry("konect-opsahl-ucsocial").recipe).toMatchObject({ parser: { format: "konect", weighted: false, timestamped: true } });
    expect(entry("konect-opsahl-ucsocial").crosswalk).toEqual({ file: "crosswalks/graph-v1/timestamped.json" });
    // The catalogue calls this download `tsv`, and the bipartite and plain pair files read with the topology crosswalk.
    expect(entry("konect-wikispeedia").recipe).toMatchObject({ archive: { kind: "tar.bz2" }, parser: { format: "konect", weighted: false, timestamped: false } });
    expect(entry("konect-opsahl-collaboration").crosswalk).toEqual({ file: "crosswalks/graph-v1/topology.json" });
    expect(outcome("lesmis").flags).toContain("KONECT edge columns read from the downloaded file: the catalogue records only the download");
  });

  it("corrects what a downloaded file contradicts in the catalogue's record, saying so in the report", () => {
    const collaboration = entry("konect-opsahl-collaboration");
    expect(collaboration.expectedCounts).toEqual({ nodes: 38741, edges: 58595 });
    expect(collaboration.properties).toMatchObject({ weighted: false, multigraph: false, selfLoops: false, connected: false, components: 1188, directed: false });
    expect(collaboration.description).toMatch(/^Bipartite authorship network/);
    expect(outcome("konect-opsahl-collaboration").flags.some((flag) => flag.startsWith("corrected against the downloaded file: the file is a bipartite authorship network"))).toBe(true);
    expect(entry("movielens-25m").description).toContain("59,047 movies");
    expect(entry("amazon-movies-tv").description).toMatch(/^Undirected bipartite/);
    // The source catalogue is read, never written, and an entry with no correction keeps its record.
    expect(pipeline.datasets["konect-opsahl-collaboration"]?.nodeCount).toBe(CATALOGUE_COLLABORATION_NODES);
    expect(entry("konect-opsahl-ucsocial").expectedCounts).toEqual({ nodes: 1899, edges: 59835 });
    expect(outcome("konect-opsahl-ucsocial").flags.some((flag) => flag.startsWith("corrected"))).toBe(false);
  });

  it("does not guess the columns of a KONECT archive it has not read", () => {
    expect(entry("konect-unread").recipe).toEqual({ status: "not-fetchable", reason: "no download is in a form keepset reads yet (tsv: a KONECT archive whose edge columns the import has not read)" });
  });

  it("resolves a snapshot of a snapshot to the innermost capture and skips a directory listing", () => {
    const journals = entry("pajek-journals");
    expect(journals.sources[1]).toMatchObject({ url: "http://vlado.fmf.uni-lj.si/pub/networks/data/2mode/revije.zip", status: "dead", snapshot: { timestamp: "20130507053929" } });
    expect(journals.recipe).toMatchObject({ status: "fetchable", source: 1 });
  });

  it("reads each triples download in the layout read from it: the splits of an archive as named parts, or one file with its header and field order", () => {
    expect(entry("kg-nations").recipe).toEqual({
      status: "fetchable",
      source: 0,
      archive: {
        kind: "tar.gz",
        parts: [
          { name: "train", member: { path: "train.txt" } },
          { name: "valid", member: { path: "valid.txt" } },
          { name: "test", member: { path: "test.txt" } },
        ],
      },
      parser: { format: "kg-triples", encoding: "utf-8", delimiter: "tab", order: "head-relation-tail", header: "none", quoted: false },
    });
    expect(entry("kg-nations").crosswalk).toEqual({ file: "crosswalks/graph-v1/relations-split.json" });
    expect(entry("nell-995").recipe).toMatchObject({ archive: { kind: "none" }, parser: { format: "kg-triples", delimiter: "space", order: "head-tail-relation", header: "count" } });
    expect(entry("nell-995").crosswalk).toEqual({ file: "crosswalks/graph-v1/relations.json" });
    expect(entry("yago3-10").recipe).toMatchObject({ status: "fetchable", source: 0, archive: { kind: "tar.gz", parts: [{ name: "train", member: { path: "yago3-10/train.txt" } }, { name: "valid", member: { path: "yago3-10/valid.txt" } }, { name: "test", member: { path: "yago3-10/test.txt" } }] } });
    expect(entry("yago3-10").expectedCounts).toEqual({ nodes: 123182, edges: 1089040 });
    expect(outcome("nell-995").flags).toContain("triples layout read from the downloaded file: OpenKE id triples: the triple count on the first line, then head, tail and relation ids separated by spaces");
  });

  it("reads an HGB zip's node and link files with the types its info.dat gives, and a user-item counts file as two node sets", () => {
    expect(entry("dblp-het").recipe).toMatchObject({
      status: "fetchable",
      archive: {
        kind: "zip",
        parts: [
          { name: "nodes", member: { path: "DBLP/node.dat" } },
          { name: "links", member: { path: "DBLP/link.dat" } },
        ],
      },
      parser: { format: "hgb", nodeTypes: ["author", "paper", "term", "venue"] },
    });
    expect(entry("dblp-het").crosswalk).toEqual({ file: "crosswalks/graph-v1/typed.json" });
    expect(entry("lastfm-hgb").recipe).toMatchObject({ archive: { kind: "zip", member: { path: "user_artists.dat" } }, parser: { format: "user-item-counts", skipLines: 1, itemType: "artist" } });
    expect(entry("lastfm-hgb").crosswalk).toEqual({ file: "crosswalks/graph-v1/typed-weighted.json" });
    expect(entry("lastfm-hgb").expectedCounts).toEqual({ nodes: 19524, edges: 92834 });
    expect(outcome("lastfm-hgb").flags.some((flag) => flag.startsWith("corrected against the downloaded file:"))).toBe(true);
  });

  it("does not guess the layout of a triples download it has not read or the member of an archive in format various", () => {
    expect(entry("kg-unread").recipe).toEqual({ status: "not-fetchable", reason: "no download is in a form keepset reads yet (tsv: format tsv is a triple file whose layout the import has not read)" });

    // arenas-pgp's first download is an archive in format various, so the recipe reads its second, a GML archive.
    expect(entry("arenas-pgp").recipe).toMatchObject({ status: "fetchable", source: 1, parser: { format: "gml" } });
  });

  it("skips a download that is a web page and reads the next one", () => {
    const arxiv = entry("arxiv-citations");
    expect(arxiv.sources.map((source) => source.url)).toEqual(["https://snap.stanford.edu/data/cit-HepPh.html", "https://snap.stanford.edu/data/cit-HepPh.txt.gz", "https://snap.stanford.edu/data/index.html"]);
    expect(arxiv.recipe).toMatchObject({ status: "fetchable", source: 1, archive: { kind: "gzip" } });
  });

  it("reads a landing page recorded as a homepage like a bare landing-page URL, and the endpoint columns and header lines a download records", () => {
    const arxiv = entry("arxiv-citations");
    expect(arxiv.recipe).toMatchObject({ status: "fetchable", source: 1 });
    expect(arxiv.sources.map((source) => source.url)).toContain("https://snap.stanford.edu/data/index.html");
    expect(outcome("triple-table").flags).toEqual(expect.arrayContaining(["catalogue: skip 1 header line", "catalogue: edge endpoints in columns 0 and 2"]));
    expect(entry("triple-table").recipe).toMatchObject({ status: "fetchable", parser: { format: "edge-list", skipLines: 1, sourceColumn: 0, targetColumn: 2 } });
  });

  it("offers a SuiteSparse download the mirror holds ahead of the collection's own link and reads the recipe from it, leaving one the mirror lacks alone", () => {
    const kohonen = entry("ss-pajek-kohonen");
    expect(kohonen.sources.map((source) => source.url)).toEqual(["https://mirror.example/sparse/MM/Pajek/Kohonen.tar.gz", "https://sparse.tamu.edu/MM/Pajek/Kohonen.tar.gz", "https://sparse.tamu.edu/MM/Pajek/Missing.tar.gz"]);
    expect(kohonen.sources[0]).toMatchObject({ status: "live", retrieved: "2026-10-21" });
    expect(kohonen.recipe).toMatchObject({ status: "fetchable", source: 0, archive: { kind: "tar.gz", member: { path: "Kohonen/Kohonen.mtx" } }, parser: { format: "matrix-market" } });
    expect(kohonen.licence).toEqual({ kind: "spdx", id: "CC-BY-4.0" });
  });

  it("offers each mirror's copy of a SuiteSparse download in the order the mirrors are given, ahead of the collection's own link", () => {
    const fileHost = SuiteSparseMirrorSchema.parse({ label: "the file host", readOn: "2026-10-22", host: "https://files.example/", holds: ["MM/Pajek/Kohonen.tar.gz", "MM/Pajek/Missing.tar.gz"] });
    const both = convertCatalogue(pipeline, graphbox, { licences: resolver(), mirrors: [mirror, fileHost], facts, domains: {} }, NO_OVERRIDES);
    const kohonen = both.entries.find((candidate) => candidate.id === "ss-pajek-kohonen");
    expect(kohonen?.sources.map((source) => source.url)).toEqual([
      "https://mirror.example/sparse/MM/Pajek/Kohonen.tar.gz",
      "https://files.example/MM/Pajek/Kohonen.tar.gz",
      "https://sparse.tamu.edu/MM/Pajek/Kohonen.tar.gz",
      "https://files.example/MM/Pajek/Missing.tar.gz",
      "https://sparse.tamu.edu/MM/Pajek/Missing.tar.gz",
    ]);
    expect(kohonen?.sources.map((source) => source.retrieved).slice(0, 2)).toEqual(["2026-10-21", "2026-10-22"]);
    expect(kohonen?.recipe).toMatchObject({ status: "fetchable", source: 0 });
    expect(both.report.outcomes.find((candidate) => candidate.id === "ss-pajek-kohonen")?.flags).toContain("the collection's own link is also offered from the file host, which the recipe reads");
  });

  it("takes a SuiteSparse matrix's domain from the index's kind where the catalogue gives none", () => {
    const kohonen = entry("ss-pajek-kohonen");
    expect(kohonen.domain).toBe("Weighted Graph");
  });

  it("takes the domain curated for a dataset the catalogue and the indexes give none, and refuses a curation that names no dataset or one the catalogue already gives a domain", () => {
    const curated = (domains: Readonly<Record<string, string>>) => convertCatalogue(pipeline, graphbox, { licences: resolver(), mirrors: [mirror], facts, domains }, NO_OVERRIDES);
    expect(curated({ advogato: "Social network" }).entries.find((candidate) => candidate.id === "advogato")?.domain).toBe("Social network");
    expect(() => curated({ absent: "Anything" })).toThrow("the domain curated for absent names no dataset of the catalogue");
    expect(() => curated({ "7th_graders": "Anything" })).toThrow("the domain curated for 7th_graders repeats the catalogue, which already gives it one");
  });

  it("takes a Netzschleuder network's domain from the topic its first tag names", () => {
    expect(entry("netzschleuder-bison").domain).toBe("Social network");
  });

  it("does not convert datasets with nothing to fetch or no retrieval date, saying why", () => {
    expect(outcome("ba-weighted-200k")).toMatchObject({ outcome: "not-converted", reason: "synthetic: generated by the pipeline, with no source to fetch" });
    expect(outcome("bitcoin-blockchain")).toMatchObject({ outcome: "not-converted", reason: "the source catalogue records no sources" });
    expect(outcome("ss-hb-bcspwr09")).toMatchObject({ outcome: "not-converted", reason: "the source catalogue records no download URL" });
    expect(outcome("celegans-metabolic-undir")).toMatchObject({ outcome: "not-converted" });
    expect(JSON.stringify(outcome("celegans-metabolic-undir"))).toMatch(/no retrieval date/);
    for (const id of ["ba-weighted-200k", "bitcoin-blockchain", "ss-hb-bcspwr09", "celegans-metabolic-undir"]) {
      expect(entries.some((candidate) => candidate.id === id)).toBe(false);
    }
  });

  it("carries descriptive metadata as data and recorded counts as expected counts", () => {
    const seventh = entry("7th_graders");
    expect(seventh).toMatchObject({ name: "Seventh Graders Network", domain: "Social network", tags: ["heterogeneous"], category: "graph/v1", licence: { kind: "unrecorded" }, expectedCounts: { nodes: 29, edges: 740 } });
    expect(seventh.properties).toMatchObject({ directed: true, multigraph: true, selfLoops: false });
    expect(seventh.crosswalk).toEqual({ file: "crosswalks/graph-v1/topology.json" });
  });

  it("takes each entry's licence from the curation of the source its recipe fetches, a dataset record winning over its publisher", () => {
    expect(entry("cities").licence).toEqual({ kind: "spdx", id: "CC-BY-4.0" });
    expect(entry("ieee-cis-g").licence).toEqual({ kind: "spdx", id: "MIT" });
    expect(entry("oag-eng").licence).toEqual({ kind: "unrecorded" });
    // The recipe reads the Network Repository copy, so that publisher's curation decides, not the Wayback-pinned Arenas page the first source points at.
    expect(entry("arenas-pgp").sources.map((source) => source.url)).toContain("http://networkrepository.com/datasets/pgp.tar.gz");
    expect(entry("arenas-pgp").licence).toEqual({ kind: "unrecorded" });
  });

  it("refuses a dataset no licence curation covers, and curation that serves no dataset", () => {
    const only = (publishers: readonly unknown[], datasets: Record<string, unknown> = {}) => graphLicenceResolver(GraphLicencesSchema.parse({ readOn: "2026-10-20", publishers, datasets }));
    expect(() => convertCatalogue(pipeline, graphbox, { licences: only([]), mirrors: [mirror], facts, domains: {} }, NO_OVERRIDES)).toThrow(/no licence curation covers/);
    const everything = licences.publishers.map((publisher) => ({ ...publisher }));
    expect(() => convertCatalogue(pipeline, graphbox, { licences: only([...everything, unstated("unused", "Unused", ["https://unused.example/"])], licences.datasets), mirrors: [mirror], facts, domains: {} }, NO_OVERRIDES)).toThrow(/no dataset's source falls under: unused/);
    expect(() => convertCatalogue(pipeline, graphbox, { licences: only(everything, { ...licences.datasets, "not-a-dataset": { readAt: ["https://example.org/"], reason: "x" } }), mirrors: [mirror], facts, domains: {} }, NO_OVERRIDES)).toThrow(/not-a-dataset/);
  });

  it("names the judgement-call removals, the omitted fields and the graphbox overlap without merging", () => {
    expect(report.judgementCallRemovals.map((removal) => removal.id)).toEqual(["yelp-hin", "foursquare", "douban"]);
    expect(report.omittedFields.map((omitted) => omitted.field)).toContain("citeKey");
    expect(report.graphboxOverlap).toEqual([
      { pipelineId: "adjnoun", graphboxId: "adjnoun", matchedBy: "id" },
      { pipelineId: "arxiv-citations", graphboxId: "cit-hepph", matchedBy: "download URL" },
    ]);
  });
});

describe("name overrides", () => {
  it("replaces the name of a listed dataset and leaves every other name as the catalogue gives it", () => {
    const renamed = convertCatalogue(pipeline, graphbox, { licences: resolver(), mirrors: [mirror], facts, domains: {} }, { ...NO_OVERRIDES, names: new Map([["wiki-vote", "Wikipedia votes (a source)"]]) }).entries;
    expect(renamed.find((candidate) => candidate.id === "wiki-vote")?.name).toBe("Wikipedia votes (a source)");
    expect(renamed.find((candidate) => candidate.id === "amazon0302")?.name).toBe(entry("amazon0302").name);
  });

  it("refuses an override for a dataset the catalogue lacks, or one that repeats the catalogue's name", () => {
    expect(() => convertCatalogue(pipeline, graphbox, { licences: resolver(), mirrors: [mirror], facts, domains: {} }, { ...NO_OVERRIDES, names: new Map([["absent", "Anything"]]) })).toThrow("the name override for absent names no dataset of the catalogue");
    expect(() => convertCatalogue(pipeline, graphbox, { licences: resolver(), mirrors: [mirror], facts, domains: {} }, { ...NO_OVERRIDES, names: new Map([["wiki-vote", entry("wiki-vote").name]]) })).toThrow("the name override for wiki-vote repeats the name the catalogue already gives it");
  });

  it("renames, in the committed full catalogue, every dataset it lists to the name it gives", () => {
    const full = SourceCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/pipeline-catalog.json"), "utf8")));
    const fullMirror = SuiteSparseMirrorSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/suitesparse-mirror.json"), "utf8")));
    const fullLicences = graphLicenceResolver(GraphLicencesSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/graph-licences.json"), "utf8"))));
    for (const [id, name] of NAME_OVERRIDES) {
      const dataset = Object.values(full.datasets).find((candidate) => candidate.id === id);
      expect(dataset, id).toBeDefined();
      expect(dataset === undefined ? undefined : convertDataset(dataset, { licences: fullLicences, mirrors: [fullMirror], facts: noFacts, domains: {} }).entry?.name, id).toBe(name);
    }
  });

  it("writes, in the committed full catalogue, each dataset recipe with its counts, or the reason no recipe reads the dataset", () => {
    const full = SourceCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/pipeline-catalog.json"), "utf8")));
    const fullMirror = SuiteSparseMirrorSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/suitesparse-mirror.json"), "utf8")));
    const fullLicences = graphLicenceResolver(GraphLicencesSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/graph-licences.json"), "utf8"))));
    for (const [id, fixed] of DATASET_RECIPES) {
      const dataset = Object.values(full.datasets).find((candidate) => candidate.id === id);
      expect(dataset, id).toBeDefined();
      const converted = dataset === undefined ? undefined : convertDataset(dataset, { licences: fullLicences, mirrors: [fullMirror], facts: noFacts, domains: {} }).entry;
      if ("archive" in fixed) {
        expect(converted?.recipe, id).toMatchObject({ status: "fetchable", archive: fixed.archive, parser: fixed.parser });
        expect(converted?.expectedCounts, id).toEqual(fixed.counts ?? { nodes: dataset?.nodeCount, edges: dataset?.edgeCount });
      } else {
        expect(converted?.recipe, id).toEqual({ status: "not-fetchable", reason: fixed.unsupported });
      }
    }
  });

  it("pins, in the committed full catalogue, every download a verifying client cannot fetch as a dead source with its snapshot", () => {
    const full = SourceCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/pipeline-catalog.json"), "utf8")));
    const fullMirror = SuiteSparseMirrorSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/suitesparse-mirror.json"), "utf8")));
    const fullLicences = graphLicenceResolver(GraphLicencesSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/graph-licences.json"), "utf8"))));
    for (const [url, { timestamp }] of UNVERIFIABLE_DOWNLOADS) {
      const sources = Object.values(full.datasets)
        .map((dataset) => convertDataset(dataset, { licences: fullLicences, mirrors: [fullMirror], facts: noFacts, domains: {} }).entry)
        .flatMap((converted) => converted?.sources ?? [])
        .filter((source) => source.url === url);
      expect(sources.length, url).toBeGreaterThan(0);
      for (const source of sources) {
        expect(source).toMatchObject({ status: "dead", snapshot: { timestamp, url: `https://web.archive.org/web/${timestamp}/${url}` } });
      }
    }
  });

  it("refuses a dataset recipe for a dataset the catalogue lacks", () => {
    expect(() => convertCatalogue(pipeline, graphbox, { licences: resolver(), mirrors: [mirror], facts, domains: {} }, { ...NO_OVERRIDES, recipes: new Map([["absent", { unsupported: "anything" }]]) })).toThrow("the dataset recipe for absent names no dataset of the catalogue");
  });

  it("gives each override a name that no other override shares, ignoring case", () => {
    const names = [...NAME_OVERRIDES.values()].map((name) => name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("the recipes the import states for formats and downloads it has read", () => {
  const full = SourceCatalogueSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/pipeline-catalog.json"), "utf8")));
  const fullLicences = GraphLicencesSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/graph-licences.json"), "utf8")));
  const fullMirror = SuiteSparseMirrorSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, "sources/suitesparse-mirror.json"), "utf8")));
  const converted = (id: string) => {
    const dataset = Object.values(full.datasets).find((candidate) => candidate.id === id);
    if (dataset === undefined) {
      throw new Error(`the committed catalogue has no dataset ${id}`);
    }

    return convertDataset(dataset, { licences: graphLicenceResolver(fullLicences), mirrors: [fullMirror], facts: noFacts, domains: {} });
  };
  const recipeOf = (id: string) => converted(id).entry?.recipe;

  it("reads the SNAP signed, STRING and BioGRID formats with the publisher's fixed layout", () => {
    expect(recipeOf("snap-epinions-signed")).toMatchObject({ status: "fetchable", archive: { kind: "gzip" }, parser: { format: "edge-list", delimiter: "tab", sourceColumn: 0, targetColumn: 1 } });
    expect(recipeOf("string-human-ppi")).toMatchObject({ status: "fetchable", source: 0, archive: { kind: "gzip" }, parser: { format: "edge-list", delimiter: "space", skipLines: 1 } });
    const biogrid = FORMAT_RECIPES.get("biogrid-zip");
    expect(recipeOf("ppi-human")).toEqual({ status: "fetchable", source: 0, archive: biogrid?.archive, parser: biogrid?.parser });
    expect(recipeOf("ppi-human")).toMatchObject({ parser: { sourceColumn: 3, targetColumn: 4, where: [{ column: 12, equals: "physical" }, { column: 15, equals: "9606" }, { column: 16, equals: "9606" }] } });
  });

  it("reads every OGB zip's raw directory with the ogb parser, and adds the publisher's download where the catalogue's mirror answers 404", () => {
    expect(recipeOf("ogbl-citation2")).toMatchObject({ status: "fetchable", source: 0, archive: { kind: "zip", inner: { kind: "gzip" } }, parser: { format: "ogb" } });
    for (const [id, pygMirror] of [
      ["ogbl-biokg", "https://data.pyg.org/datasets/ogbl_biokg.zip"],
      ["ogbn-mag", "https://data.pyg.org/datasets/ogbn_mag.zip"],
    ] as const) {
      const result = converted(id);
      const replacement = REPLACED_DOWNLOADS.get(pygMirror);
      const converts = result.entry;
      if (replacement === undefined || converts === undefined) {
        throw new Error(`${id}: no replacement for ${pygMirror}, or no entry`);
      }
      const urls = converts.sources.map((source) => source.url);
      expect(urls.indexOf(replacement.url), id).toBe(urls.indexOf(pygMirror) + 1);
      expect(converts.sources[urls.indexOf(replacement.url)]?.retrieved, id).toBe(replacement.retrieved);
      expect(converts.recipe, id).toMatchObject({ status: "fetchable", source: urls.indexOf(replacement.url), parser: { format: "ogb" } });
      expect(result.outcome.flags, id).toContain(`added ${replacement.url} beside ${pygMirror}: ${replacement.reason}`);
    }
  });

  it("reads a download whose layout the catalogue does not record by the layout found in it", () => {
    expect(recipeOf("arenas-email")).toMatchObject({ status: "fetchable", archive: { kind: "zip", member: { path: "email.txt" } }, parser: { format: "edge-list", delimiter: "whitespace" } });
    expect(converted("arenas-email").outcome.flags).toContain(READ_DOWNLOADS.get("http://deim.urv.cat/~aarenas/data/xarxes/email.zip")?.flag);
  });

  it("reads a csv download as an edge list over the endpoint columns the catalogue records", () => {
    expect(recipeOf("transport-airline")).toMatchObject({ status: "fetchable", archive: { kind: "none" }, parser: { format: "edge-list", delimiter: "detect", sourceColumn: 2, targetColumn: 4 } });
  });

  it("gives a format read and found unreadable its reason, ahead of the archive kind's", () => {
    for (const [id, format] of [
      ["oag-eng", "pytorch-hetero"],
      ["ieee-cis-g", "ieee-cis-zip"],
      ["aminer-cs", "aminer-7z"],
      ["openalex-citations", "parquet"],
    ] as const) {
      const reason = UNREADABLE_FORMATS.get(format);
      if (reason === undefined) {
        throw new Error(`no reason for ${format}`);
      }
      expect(recipeOf(id), id).toEqual({ status: "not-fetchable", reason: `no download is in a form keepset reads yet (${format}: ${reason})` });
    }
  });
});

describe("the URL helpers", () => {
  it("parses both Wayback forms and nothing else", () => {
    expect(parseWayback("https://web.archive.org/web/20061110114126id_/http://www.nd.edu/a.gz")).toEqual({ timestamp: "20061110114126", original: "http://www.nd.edu/a.gz" });
    expect(parseWayback("https://web.archive.org/web/20230601/http://example.org/x.zip")).toEqual({ timestamp: "20230601", original: "http://example.org/x.zip" });
    expect(parseWayback("https://example.org/web/20230601/http://example.org/x.zip")).toBeUndefined();
  });

  it("derives Netzschleuder's CSV archive", () => {
    expect(netzschleuderCsv("https://networks.skewed.de/net/copenhagen/files/bt.gt.zst")).toBe("https://networks.skewed.de/net/copenhagen/files/bt.csv.zip");
    expect(netzschleuderCsv("https://networks.skewed.de/net/moreno_sheep/")).toBe("https://networks.skewed.de/net/moreno_sheep/files/moreno_sheep.csv.zip");
  });
});

describe("namespaceOf", () => {
  it("files a SuiteSparse id under the collection and its group, with the rest of the id as its name", () => {
    expect(namespaceOf("ss-gset-g53")).toEqual({ namespace: ["suitesparse", "gset"], alias: "g53" });
    expect(namespaceOf("ss-dimacs10-channel-500x100x100-b050")).toEqual({ namespace: ["suitesparse", "dimacs10"], alias: "channel-500x100x100-b050" });
  });

  it("files an id with a collection prefix under that collection", () => {
    expect(namespaceOf("pajek-hep-th")).toEqual({ namespace: ["pajek"], alias: "hep-th" });
    expect(namespaceOf("nr-eco-everglades")).toEqual({ namespace: ["networkrepository"], alias: "eco-everglades" });
  });

  it("leaves an id whose prefix is part of an upstream dataset's name without a namespace", () => {
    expect(namespaceOf("ca-astroph")).toBeUndefined();
    expect(namespaceOf("p2p-gnutella09")).toBeUndefined();
    expect(namespaceOf("cora")).toBeUndefined();
  });

  it("names nothing for an id that is only a prefix or a prefix and a group", () => {
    expect(namespaceOf("pajek")).toBeUndefined();
    expect(namespaceOf("ss-gset")).toBeUndefined();
    expect(namespaceOf("ss")).toBeUndefined();
  });
});
