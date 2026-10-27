import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { NAME_SEPARATOR, type Dataset, type DatasetQuery, type Manifest, type NamespaceNode } from "keepset";
import { dimensionsOf, type Dimensions } from "./dimensions";
import { slug } from "./html";
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

/**
 * Groups datasets by a label, refusing two labels that share a slug, since they would share a listing page.
 * @param datasets - The datasets.
 * @param labelsOf - Each dataset's labels, none for a dataset the grouping does not apply to.
 * @returns The groups in label order.
 */
function groupBy(datasets: readonly Dataset[], labelsOf: (dataset: Dataset) => readonly string[]): { label: string; datasets: Dataset[] }[] {
  const groups = new Map<string, Dataset[]>();
  for (const dataset of datasets) {
    for (const label of new Set(labelsOf(dataset))) {
      groups.set(label, [...(groups.get(label) ?? []), dataset]);
    }
  }
  const slugs = new Map<string, string>();
  for (const label of groups.keys()) {
    const key = slug(label);
    const clash = slugs.get(key);
    if (key === "" || clash !== undefined) {
      throw new Error(`the label ${JSON.stringify(label)} has no listing page of its own: its slug ${JSON.stringify(key)} is empty or shared with ${JSON.stringify(clash)}`);
    }
    slugs.set(key, label);
  }

  return [...groups].sort(([left], [right]) => (left < right ? -1 : 1)).map(([label, members]) => ({ label, datasets: members }));
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
 * Generates the static site's pages and data: the home page, one page per entry, listing pages by domain, by subject and by kind and one for each namespace, at any depth, with their indexes, the search index, the web app manifest and the service worker's precache manifest. Static assets and the client bundle are added by the caller.
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
  for (const [title, directory, groups] of [
    ["Domains", "domains", groupBy(datasets, (dataset) => (dataset.entry.domain === undefined ? [] : [dataset.entry.domain]))],
    ["Subjects", "subjects", groupBy(datasets, (dataset) => dataset.entry.subjects ?? [])],
    ["Kinds", "kinds", groupBy(datasets, (dataset) => [dataset.kind])],
  ] as const) {
    files.set(`${directory}/index.html`, groupsPage(context("../"), title, groups.map((group) => ({ label: group.label, count: group.datasets.length }))));
    for (const group of groups) {
      files.set(`${directory}/${slug(group.label)}/index.html`, listingPage(context("../../"), `${title.slice(0, -1)}: ${group.label}`, group.datasets));
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
    fetchable: entry.recipe.status === "fetchable",
    ...dimensionsOf(entry),
  }));
  files.set("search-index.json", JSON.stringify(search));
  files.set(
    "manifest.webmanifest",
    JSON.stringify({ name: "keepset", short_name: "keepset", description: manifest.description, start_url: "./", scope: "./", display: "standalone", background_color: "#ffffff", theme_color: "#1f4e79", icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml" }] }, undefined, 2),
  );
  // The service worker precaches the shell and every listing page, and caches entry pages as they are visited: the entry pages together are most of the site, too much to download on a first visit.
  const shell = ["./", "app.css", "app.js", "icon.svg", "manifest.webmanifest", "search-index.json", ...[...files.keys()].filter((path) => path.startsWith("domains/") || path.startsWith("subjects/") || path.startsWith("kinds/") || path.startsWith("namespaces/")).map((path) => path.replace(/index\.html$/, ""))];
  files.set("precache.json", JSON.stringify({ version: `${packageVersion}+${manifest.id}@${manifest.version}`, urls: shell }));

  for (const [path, text] of files) {
    const target = join(options.outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
  }

  return files;
}
