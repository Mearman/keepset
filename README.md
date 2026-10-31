# keepset

[![GitHub](https://img.shields.io/badge/GitHub-181717?logo=github&logoColor=white)](https://github.com/Mearman/keepset) [![npm](https://img.shields.io/badge/npm-CB3837?logo=npm&logoColor=white)](https://www.npmjs.com/package/keepset) [![Release](https://img.shields.io/github/v/release/Mearman/keepset)](https://github.com/Mearman/keepset/releases/latest) [![CI](https://img.shields.io/github/actions/workflow/status/Mearman/keepset/ci.yml?branch=main)](https://github.com/Mearman/keepset/actions)

A catalogue of datasets, each with a machine-readable recipe that says how to fetch it and how to normalise it into the shape its category names. The `keepset` package is the consumable library over that catalogue; the CLI and the statically generated site are thin surfaces on top of it. Entries are expressed with [crossmap](https://github.com/ExaDev/crossmap) crosswalks, so fetching a dataset yields a normalised shape directly in user code.

## Usage

```ts
import { getDataset, listDatasets } from "keepset";
import { fetchDataset } from "keepset/node";

// Every graph dataset whose id, name, description, domain or tags mention "citatio".
const graphs = listDatasets({ kind: "graph", text: "citatio" });

// One dataset's entry: its metadata, recipe and resolved crosswalk.
const { entry } = getDataset("cora");

// Fetch it and resolve it to the category's target shape.
const { data, provenance, warnings } = await fetchDataset("cora");
// data is { meta, nodes, edges }: the graph/v1 target
provenance.fetchedUrl; // the URL the bytes actually came from
provenance.sha256; // the hash of exactly those bytes
```

`listDatasets` and `getDataset` read the catalogue bundled with the package and are browser-safe. `fetchDataset` downloads, extracts and parses, so it lives behind the `keepset/node` subpath: it needs the filesystem and the network, and takes an optional `{ fetch, signal, now }` so a caller can inject a stand-in, abort mid-download and pin the provenance clock.

A fetch resolves each source through a chain: its pinned Wayback snapshot first (the bytes the recipe was written against), then the closest capture the Wayback availability API names, then the live URL, which is never tried for a dead source. When the live URL is what was read, the provenance says so and the fetch asks the Internet Archive to capture it (a Save Page Now request made after the result is delivered, so it never delays one), which leaves the next fetcher a snapshot; `keepset fetch --no-archive` stops the request, and the library leaves it to the caller (`captureRequestsFor` and `requestCapture`, exported by `keepset/node` and `keepset/browser`). The browser entry point (`keepset/browser`) resolves the same way, and the site's preview asks for the capture too.

## The CLI

```sh
npx keepset search citatio --kind graph
npx keepset namespaces
npx keepset show cora
npx keepset fetch cora --out cora.json
npx keepset validate cora
npx keepset roundtrip cora
```

`namespaces [path]` lists the namespaces directly beneath a path (the outermost ones without one) with how many datasets each holds, and the site has a page for each, linked from every entry's namespace. `fetch` writes the normalised result with its provenance beside it; `validate` checks the entry against the entry schema and its crosswalk against crossmap's validation without the network; `roundtrip` fetches the dataset and checks that decoding the encoded native document gives it back. Exit status is 0 for an answer, 1 for a negative one (an invalid entry, a round trip that does not hold) and 2 for no answer (bad usage, an unknown or ambiguous name or namespace, a recipe that failed).

## Names, aliases and namespaces

An entry has one canonical id, flat and stable, and can also carry a namespace (the collection it comes from, such as `suitesparse/gset`) and aliases (other names for the same dataset). The library's `getDataset` and every CLI command that takes a dataset resolve any of these names:

```sh
npx keepset fetch ss-gset-g53
npx keepset fetch suitesparse/gset/g53
npx keepset fetch gset/g53
npx keepset fetch g53
```

A qualified name joins the namespace to a name with `/`, and any leading part of the namespace may be dropped while the name still means one dataset (a middle part may not be). An entry's own id always wins; otherwise a name that more than one entry answers to is refused with the ids it could mean (`DatasetAmbiguousError` in the library, exit status 2 in the CLI), and the way out is a longer qualified name or the id. Everything a command writes or prints uses the entry's own id, never the name typed.

An alias that is a path, such as `foo/graphs/bar`, files the entry in a second group as well: it is a name in its own right, not prefixed by the entry's namespace, and answers to `bar`, `graphs/bar` and `foo/graphs/bar`. The namespace is where an entry comes from and path aliases are cross-listing, so an entry can sit in several groups. The catalogue manifest can also give a namespace segment aliases (`namespaceAliases`, such as `ss` for `suitesparse`), and a name then answers with the alias in the segment's place.

`search --namespace suitesparse` (or `listDatasets({ namespace })`) lists a group and every group beneath it, an entry once however many of those it is in. `listNamespaces(path)` lists the namespaces directly beneath a path, or the outermost ones, each with the number of entries at or beneath it.

## The entry format

An entry is a JSON document in `catalogue/entries/`: a descriptor (stable id, name, description, domain, subjects, tags), the category whose normalisation target the entry resolves to, its sources (each with a retrieval date, and for a dead source a pinned Wayback snapshot that travels with the URL because the snapshot timestamp is part of the recipe's reproducibility), its licence and citations, the recipe that turns downloaded bytes into the dataset's native JSON shape, and a crossmap crosswalk mapping that native shape onto the category target. A recipe's archive is no archive, a compressed file (gzip or bzip2), a tar archive (plain, gzip or bzip2 compressed), a zip archive or an Excel workbook, a member of an archive is selected by path, extension or pattern, and a format that is several files (the splits of a knowledge graph, the node and link files of an HGB dataset) is read from named parts of one archive. The format is defined by Zod schemas, and the generated JSON Schema is published with the package as `keepset/schemas/entry.schema.json`, with the catalogue manifest's beside it. The domain is the entry's topic, its tags are the node fields it carries, its namespace is the source it comes from, and its subjects are the fields of study it is relevant to (for example `operations-research`), as slugs a search filters by (`keepset search --subject operations-research`), a listing page per subject on the site and keywords in the JSON-LD.

The catalogue itself is a manifest (`catalogue/manifest.json`: id, version, repository) plus the entries and their crosswalks. Contribution is by forking with lineage: a fork is its own catalogue, its manifest names the catalogue and version it was forked from, and entry ids stay stable across forks so two catalogues can be compared entry by entry.

## Categories and normalisation targets

A category names a normalisation target: the shape every entry in that category resolves to, whatever its native shape. `graph/v1` is `{ meta, nodes, edges }` with unique node ids and edges whose endpoints name nodes; its entries are graph datasets taken from upstream collections such as SuiteSparse, Netzschleuder, SNAP, KONECT and OGB, read by one parser per format (delimited edge lists, which can also be a sheet of a spreadsheet, Matrix Market, GML, Pajek, UCINet DL full matrices, Graph Drawing contest files, Witvliet connectome synapse files, Open Graph Benchmark raw directories read together from the several files of a dataset's zip, KONECT edge files, rating and count files, knowledge graph triples and Heterogeneous Graph Benchmark node and link files), each giving the graph's topology and, where the format states them, node and edge types, weights, times and the split each edge belongs to. `tasks/v1` is `{ meta, nodes }`, a set of tasks as the places or cases it offers to visit or serve (a routing benchmark, or an open data register of permits and complaints), each flat with optional coordinates, prize, prize probability, duration, travel time, skill, territory, lifecycle status and times, and deadline, read from tabular sources by the `csv-table` parser (a delimited file, a member of an archive, a sheet of an Excel workbook, a legacy binary xls workbook or an OpenDocument spreadsheet, or an open data portal read a page at a time) and from ArcGIS feature layers by the `geojson` parser. Its entries come from a survey of open operations-research datasets, imported with a curation that records, for each source, what its download gives and how its columns map onto the node; a dataset whose source has no usable table is imported without a recipe and says why. Any category can be fetched as a collection: a recipe that selects every matching archive member with `members` (by path, by the extensions its name ends with, or by a regular expression its whole path matches) resolves to `{ meta, instances }`, where each instance is a document of the entry's category under the path of the member it came from, the schema derived from the category's own, so a category needs nothing of its own to be collected. The parser reads each member, the crosswalk is applied to each, and a member that does not parse or does not validate fails the fetch and is named. Instance files are read by one parser per format (Solomon and TOPTW time window files, Chao team orienteering files and their dynamic form, TSPLIB style orienteering files, VRP-REP XML, VeRoLog 2019 files and customer point lists), which gives each node the columns the file has and each instance a header of its own; a curation says which of them fill the `tasks/v1` node's fields, which pass through under their own names and which are dropped, so what an entry leaves out is written down, and a source whose time quantities are not seconds keeps them under the source's names with the unit recorded as the entry's `timeUnit`. `texts/v1` is `{ meta, nodes }`, a set of texts as the works a collection catalogues (a library's catalogue feed, say), each flat with optional title, language, authors, subjects, issue date, type, classification and collections, read from tabular sources by the `csv-table` parser; it describes the works and carries none of their contents. `resources/v1` is `{ meta, nodes }`, one downloadable resource (a speech corpus, a lexicon, a toolkit) as its `meta`, which says what it is (name, identifier, summary, category, licence, description, external address), and the files it is distributed as in `nodes`, each with optional url, size and description; a host's whole listing is a collection with one instance per resource, read page by page by the `openslr-resource` parser, and it describes the resources and carries none of their files. `speech/v1` is `{ meta, nodes }`, a speech corpus as the utterances it transcribes, each flat with optional transcript, speaker, gender, language, audio file name, duration in seconds and split, read from tabular sources by the `csv-table` parser (a transcript table may have no header row, in which case the recipe names its columns, or hold double quotes in its text, in which case the recipe says it is unquoted), from files of one utterance per line, as Kaldi, LibriSpeech and Festival write them, by the `utterance-lines` parser, from JSON manifests (one record per line, or one array of records) by the `json-table` parser, and from corpora with one small text file per recording by the `member-text` parser, or one XML file per recording by the `nxt-words` and `eaf` parsers (NXT word files and ELAN annotation files), which read the files a `files` archive selects together into one table; it carries the transcripts and none of the audio, which is in the distribution a `resources/v1` entry lists. A new category starts by defining its target schema in `src/targets/` and registering it in the category registry; an entry cannot name a category that does not exist. The statically generated site renders every entry with schema.org Dataset JSON-LD, so the catalogue surfaces in the dataset discovery layers.

## Licensing

The catalogue's metadata and recipes are repository content under the MIT licence. The datasets they fetch belong to their sources: each entry records its licence as the source states it (an SPDX identifier, a named licence with a URL, or unrecorded where the source states none), and fetching a dataset is subject to that licence, not this repository's. A dead source is fetched from its pinned Wayback snapshot, which serves the bytes as captured.

## Development

Node 22 or later, pnpm, ESM only. See [CONTRIBUTING.md](CONTRIBUTING.md) for adding an entry or a category, the release path, and the constraints a change must preserve.

| Script | |
| --- | --- |
| `pnpm lint` / `pnpm lint:check` | ESLint, fixing and check-only |
| `pnpm typecheck` | `tsc` over the library, CLI and site programs |
| `pnpm test` | Vitest, tests colocated as `*.unit.test.ts` and `*.e2e.test.ts` |
| `pnpm build` | tsdown into `dist` and `dist-cli`, after generating the bundled catalogue, then the JSON Schema generation |
| `pnpm site` | The static site, built from the package's own catalogue |
| `pnpm seed:check` | Checks that the committed seed entries and reports are exactly what each import produces from its committed source; `seed:import:graph` and `seed:import:or` regenerate them |

`CLAUDE.md` and `AGENTS.md` are symlinks to this file.

MIT licensed.
