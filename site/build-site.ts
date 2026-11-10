import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { groupsOf, NAME_SEPARATOR, type Dataset, type DatasetQuery, type Entry, type Manifest, type NamespaceNode } from "keepset";
import { dimensionsOf, type Dimensions } from "./dimensions";
import { slug } from "./html";
import { byText, groupLabel, type GroupOrder } from "./group-index";
import { facetQuery, type Facet } from "./listing-query";
import { entryPage, groupsPage, homePage, listingPage, namespacePage, type PageContext, type SameDataEntry } from "./pages";

/** One row of the search index the client island loads: enough to filter and label a result without fetching its page. */
export interface SearchRecord extends Dimensions {
  readonly id: string;
  readonly namespace?: string;
  readonly aliases?: readonly string[];
  readonly name: string;
  readonly description?: string;
  readonly domain?: string;
  readonly kind: string;
  readonly subjects?: readonly string[];
  readonly tags: readonly string[];
  /** Every namespace the entry is listed under, at any depth, as the namespace pages list it; absent for an entry in none. */
  readonly namespaces?: readonly string[];
  readonly fetchable: boolean;
}

/** The parts of a catalogue the generator reads: its manifest, its datasets and its tree of namespaces. A `Catalogue` has all three, and so does the package's bundled catalogue once its functions are gathered into one. */
export interface SiteCatalogue {
  readonly manifest: Manifest;
  readonly listDatasets: (query?: DatasetQuery) => Dataset[];
  readonly listNamespaces: (path?: string) => NamespaceNode[];
}

/** What the generator is given: the catalogue (from the package, never a parallel copy), the package version, the published root URL and the output directory. */
export interface SiteOptions {
  readonly catalogue: SiteCatalogue;
  readonly packageVersion: string;
  readonly siteUrl: string;
  readonly outDir: string;
}

/** The files a build wrote, by path relative to the output directory, so a caller (the service worker's precache list, a test) can see exactly what the site holds. */
export type SiteFiles = ReadonlyMap<string, string>;

/** The datasets that share a listing page: the page's slug, every label filed under it, in label order, and the datasets holding any of them. */
interface Group {
  readonly slug: string;
  readonly labels: readonly string[];
  readonly datasets: readonly Dataset[];
}

/**
 * Groups datasets by a label, one group per slug, since a slug names a listing page.
 * @param datasets - The datasets.
 * @param labelsOf - Each dataset's labels, none for a dataset the grouping does not apply to.
 * @param shareSlugs - Whether labels that share a slug share one page, as tags do (a source's field names can differ only in letter case, as `Weight` and `weight` do); otherwise two such labels are refused, since one would hide the other.
 * @returns The groups in the order of their first labels.
 */
function groupBy(datasets: readonly Dataset[], labelsOf: (dataset: Dataset) => readonly string[], shareSlugs: boolean): Group[] {
  const groups = new Map<string, { labels: Set<string>; datasets: Set<Dataset> }>();
  for (const dataset of datasets) {
    for (const label of labelsOf(dataset)) {
      const key = slug(label);
      if (key === "") {
        throw new Error(`the label ${JSON.stringify(label)} has no listing page of its own: its slug is empty`);
      }
      const group = groups.get(key) ?? { labels: new Set<string>(), datasets: new Set<Dataset>() };
      group.labels.add(label);
      group.datasets.add(dataset);
      groups.set(key, group);
    }
  }

  return [...groups]
    .map(([key, group]) => {
      const labels = [...group.labels].sort(byText);
      if (!shareSlugs && labels.length > 1) {
        throw new Error(`the labels ${labels.map((label) => JSON.stringify(label)).join(" and ")} share the slug ${JSON.stringify(key)}, so one would have no listing page of its own`);
      }

      return { slug: key, labels, datasets: datasets.filter((dataset) => group.datasets.has(dataset)) };
    })
    .sort((left, right) => byText(groupLabel(left.labels), groupLabel(right.labels)));
}

/** One attribute the site has listing pages for: the index's title, the attribute's name in a sentence, the directory its pages sit in, the listing filter that selects the same datasets, each dataset's labels, whether labels sharing a slug share a page, and the order the index lists its groups in. */
interface Dimension {
  readonly title: string;
  readonly noun: string;
  readonly directory: string;
  readonly facet: Facet;
  readonly labelsOf: (dataset: Dataset) => readonly string[];
  readonly shareSlugs: boolean;
  readonly order: GroupOrder;
}

/** The attributes with listing pages. Tags are a source's field names, so labels that differ only in letter case share a page, and the index lists the most common first, since most tags name a field of one source only. */
const DIMENSIONS: readonly Dimension[] = [
  { title: "Domains", noun: "domain", directory: "domains", facet: "domain", labelsOf: (dataset) => (dataset.entry.domain === undefined ? [] : [dataset.entry.domain]), shareSlugs: false, order: "label" },
  { title: "Subjects", noun: "subject", directory: "subjects", facet: "subject", labelsOf: (dataset) => dataset.entry.subjects ?? [], shareSlugs: false, order: "label" },
  { title: "Kinds", noun: "kind", directory: "kinds", facet: "kind", labelsOf: (dataset) => [dataset.kind], shareSlugs: false, order: "label" },
  { title: "Tags", noun: "tag", directory: "tags", facet: "tag", labelsOf: (dataset) => dataset.entry.tags, shareSlugs: true, order: "count" },
];

/**
 * Every namespace a dataset is listed under at any depth: each group its namespace or a path alias files it in, and every namespace above one, which is where the namespace pages list it.
 * @param entry - The entry.
 * @returns The namespace paths, each once.
 */
function namespacesOf(entry: Entry): string[] {
  return [...new Set(groupsOf(entry).flatMap((group) => group.map((_, index) => group.slice(0, index + 1).join(NAME_SEPARATOR))))];
}

/**
 * Lists every namespace of the catalogue's tree, outermost first, refusing two paths that differ only in letter case, since their pages would share a file on a case-insensitive file system.
 * @param catalogue - The catalogue.
 * @returns Every namespace.
 */
function allNamespaces(catalogue: SiteCatalogue): NamespaceNode[] {
  const nodes = [...catalogue.listNamespaces()];
  for (const node of nodes) {
    nodes.push(...catalogue.listNamespaces(node.path));
  }
  const folded = new Map<string, string>();
  for (const { path } of nodes) {
    const clash = folded.get(path.toLowerCase());
    if (clash !== undefined && clash !== path) {
      throw new Error(`the namespaces ${JSON.stringify(clash)} and ${JSON.stringify(path)} differ only in letter case, so their pages would share a file`);
    }
    folded.set(path.toLowerCase(), path);
  }

  return nodes;
}

/**
 * Generates the static site's pages and data: the home page, one page per entry, listing pages by domain, by subject, by kind and by tag and one for each namespace, at any depth, with their indexes, the search index, the web app manifest and the service worker's precache manifest. Static assets and the client bundle are added by the caller.
 * @param options - The catalogue, versions, URL and output directory.
 * @returns Every file written, by relative path.
 */
export function buildSite(options: SiteOptions): SiteFiles {
  const { catalogue, packageVersion, siteUrl } = options;
  const { manifest } = catalogue;
  const datasets = catalogue.listDatasets();
  const files = new Map<string, string>();
  const context = (root: string): PageContext => ({ siteUrl, manifest, packageVersion, root });

  const named = new Map(datasets.map(({ entry }): [string, SameDataEntry] => [entry.id, { id: entry.id, name: entry.name }]));
  const sameDataOf = ({ entry }: Dataset): SameDataEntry[] =>
    (entry.sameDataAs ?? []).map((id) => {
      const other = named.get(id);
      if (other === undefined) {
        throw new Error(`${entry.id} holds the same data as ${id}, which is not an entry of the catalogue`);
      }

      return other;
    });

  files.set("index.html", homePage(context(""), datasets));
  for (const dataset of datasets) {
    files.set(`datasets/${dataset.entry.id}/index.html`, entryPage(context("../../"), dataset, sameDataOf(dataset)));
  }
  for (const { title, noun, directory, facet, labelsOf, shareSlugs, order } of DIMENSIONS) {
    const groups = groupBy(datasets, labelsOf, shareSlugs);
    files.set(`${directory}/index.html`, groupsPage(context("../"), title, groups.map((group) => ({ label: groupLabel(group.labels), path: `${group.slug}/`, count: group.datasets.length })), order));
    for (const group of groups) {
      files.set(`${directory}/${group.slug}/index.html`, listingPage(context("../../"), { title: `${title.slice(0, -1)}: ${groupLabel(group.labels)}`, description: `The datasets with the ${noun} ${group.labels.join(" or ")}.` }, group.datasets, facetQuery(facet, group.labels)));
    }
  }

  files.set("namespaces/index.html", namespacePage(context("../"), undefined, catalogue.listNamespaces(), []));
  for (const { path } of allNamespaces(catalogue)) {
    // The page sits one level below the site root for each segment of its path, and one more for the namespaces directory itself.
    const depth = path.split(NAME_SEPARATOR).length + 1;
    files.set(`namespaces/${path}/index.html`, namespacePage(context("../".repeat(depth)), path, catalogue.listNamespaces(path), catalogue.listDatasets({ namespace: path })));
  }

  const search: SearchRecord[] = datasets.map(({ entry, kind }) => ({
    id: entry.id,
    ...(entry.namespace === undefined ? {} : { namespace: entry.namespace.join(NAME_SEPARATOR) }),
    ...(entry.aliases === undefined ? {} : { aliases: entry.aliases }),
    name: entry.name,
    ...(entry.description === undefined ? {} : { description: entry.description }),
    ...(entry.domain === undefined ? {} : { domain: entry.domain }),
    ...(entry.subjects === undefined ? {} : { subjects: entry.subjects }),
    kind,
    tags: entry.tags,
    ...(groupsOf(entry).length === 0 ? {} : { namespaces: namespacesOf(entry) }),
    fetchable: entry.recipe.status === "fetchable",
    ...dimensionsOf(entry),
  }));
  files.set("search-index.json", JSON.stringify(search));
  files.set(
    "manifest.webmanifest",
    JSON.stringify({ name: "keepset", short_name: "keepset", description: manifest.description, start_url: "./", scope: "./", display: "standalone", background_color: "#ffffff", theme_color: "#1f4e79", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }] }, undefined, 2),
  );
  // The service worker precaches the shell and every listing page, and caches entry pages as they are visited: the entry pages together are most of the site, too much to download on a first visit.
  const shell = ["./", "app.css", "app.js", "icon.svg", "manifest.webmanifest", "search-index.json", ...[...files.keys()].filter((path) => [...DIMENSIONS.map(({ directory }) => directory), "namespaces"].some((directory) => path.startsWith(`${directory}/`))).map((path) => path.replace(/index\.html$/, ""))];
  files.set("precache.json", JSON.stringify({ version: `${packageVersion}+${manifest.id}@${manifest.version}`, urls: shell }));

  for (const [path, text] of files) {
    const target = join(options.outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }

  return files;
}
