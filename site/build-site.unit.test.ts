import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogue, getManifest, listDatasets, listNamespaces } from "keepset";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { deadEntry, fixtureIndex, liveEntry } from "../src/test-support/entries";
import { buildSite, type SiteCatalogue, type SiteFiles } from "./build-site";

const SITE_URL = "https://example.org/keepset/";
const SHA256_DIGITS = 64;
const HASH_SHOWN = 12;

/** The schema.org Dataset shape the pages promise: the properties Google Dataset Search requires (name, description) and those this generator always writes, each in schema.org's expected type. */
const DatasetJsonLdSchema = z.looseObject({
  "@context": z.literal("https://schema.org"),
  "@type": z.literal("Dataset"),
  name: z.string().min(1),
  description: z.string().min(1),
  url: z.url(),
  identifier: z.string().min(1),
  keywords: z.array(z.string().min(1)),
  license: z.url().optional(),
  citation: z.array(z.string().min(1)).optional(),
  isPartOf: z.object({ "@type": z.literal("DataCatalog"), name: z.string(), url: z.url() }),
  distribution: z.array(z.strictObject({ "@type": z.literal("DataDownload"), contentUrl: z.url(), archivedAt: z.url().optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional() })).min(1),
});

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function build(catalogue: SiteCatalogue): SiteFiles {
  const outDir = mkdtempSync(join(tmpdir(), "keepset-site-"));
  directories.push(outDir);

  return buildSite({ catalogue, packageVersion: "9.9.9", siteUrl: SITE_URL, outDir });
}

function jsonLdOf(html: string): unknown {
  const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (match?.[1] === undefined) {
    throw new Error("the page has no JSON-LD");
  }

  return JSON.parse(match[1]);
}

function page(files: SiteFiles, path: string): string {
  const text = files.get(path);
  if (text === undefined) {
    throw new Error(`the site has no ${path}`);
  }

  return text;
}

describe("buildSite on a fixture catalogue", () => {
  const catalogue = createCatalogue(fixtureIndex);
  const files = build(catalogue);

  it("writes one entry page per dataset and the listing pages by domain and kind", () => {
    expect([...files.keys()].filter((path) => path.startsWith("datasets/")).sort()).toEqual(["datasets/auth-walled/index.html", "datasets/celegans-metabolic/index.html", "datasets/karate/index.html"]);
    for (const path of ["index.html", "domains/index.html", "domains/social-network/index.html", "kinds/index.html", "kinds/graph/index.html", "manifest.webmanifest", "precache.json"]) {
      expect(files.has(path)).toBe(true);
    }
  });

  it("writes a listing page per subject, an entry in each of its subjects, and none for an entry without one", () => {
    expect(files.has("subjects/index.html")).toBe(true);
    expect(files.get("subjects/index.html")).toContain("network-science");
    expect(files.get("subjects/network-science/index.html")).toContain("Zachary Karate Club");
    expect(files.get("subjects/social-science/index.html")).toContain("Zachary Karate Club");
    expect(files.get("subjects/network-science/index.html")).not.toContain("C. elegans");
    expect([...files.keys()].filter((path) => path.startsWith("subjects/") && path.endsWith("/index.html")).sort()).toEqual(["subjects/index.html", "subjects/network-science/index.html", "subjects/social-science/index.html"]);
  });

  it("links an entry to its subjects, links the subjects from every header and carries them in the search index and the precache", () => {
    const entry = files.get("datasets/karate/index.html") ?? "";
    expect(entry).toContain('<a href="../../subjects/network-science/">network-science</a>, <a href="../../subjects/social-science/">social-science</a>');
    expect(files.get("index.html")).toContain('<a href="subjects/">Subjects</a>');
    expect(entry).toContain('<a href="../../subjects/">Subjects</a>');
    expect(JSON.parse(files.get("search-index.json") ?? "[]")).toContainEqual(expect.objectContaining({ id: "karate", subjects: ["network-science", "social-science"] }));
    expect(files.get("precache.json")).toContain("subjects/network-science/");
  });

  it("gives every entry page schema.org Dataset JSON-LD, pointing a dead source at its snapshot", () => {
    const karate = DatasetJsonLdSchema.parse(jsonLdOf(page(files, "datasets/karate/index.html")));
    expect(karate).toMatchObject({ name: "Zachary Karate Club", url: `${SITE_URL}datasets/karate/`, keywords: ["graph", "Social network", "network-science", "social-science", "social", "small"], citation: [expect.stringContaining("https://doi.org/10.1086/jar.33.4.3629752") as string] });
    const dead = DatasetJsonLdSchema.parse(jsonLdOf(page(files, "datasets/celegans-metabolic/index.html")));
    expect(dead.license).toBe("https://spdx.org/licenses/CC-BY-4.0.html");
    expect(dead.distribution).toEqual([{ "@type": "DataDownload", contentUrl: "https://web.archive.org/web/20230601id_/http://example.edu/~lab/data/celegans_metabolic.zip", archivedAt: "https://web.archive.org/web/20230601/http://example.edu/~lab/data/celegans_metabolic.zip" }]);
    expect(dead.description).toBe("C. elegans metabolic network, a graph dataset in the fixture catalogue, normalised to graph/v1.");
  });

  it("links the exact fetch command and renders the recipe and crosswalk as tables", () => {
    const karate = page(files, "datasets/karate/index.html");
    expect(karate).toContain("<code>npx keepset fetch karate</code>");
    expect(karate).toContain('<span data-copy-text="npx keepset fetch karate"></span>');
    expect(karate).toContain("<tr><td>move</td><td><code>nodes[].id</code></td><td><code>nodes[].id</code></td><td>both</td></tr>");
    expect(karate).toContain('<th scope="row">Parser delimiter</th><td><code>&quot;whitespace&quot;</code></td>');
    expect(page(files, "datasets/auth-walled/index.html")).toContain("This entry has no fetchable recipe yet: the source requires an account to download");
  });

  it("leads an entry page with its trail and headline figures, and says which source the recipe reads", () => {
    const karate = page(files, "datasets/karate/index.html");
    expect(karate).toContain('<a class="skip-link" href="#main">Skip to content</a>');
    expect(karate).toContain('<main id="main" tabindex="-1">');
    expect(karate).toContain('<nav class="breadcrumb" aria-label="Breadcrumb"><ol><li><a href="../../">All datasets</a></li><li><a href="../../kinds/graph/">graph</a></li>');
    expect(karate).toContain('<dl class="stats"><div><dt>Nodes</dt><dd>34</dd></div><div><dt>Edges</dt><dd>78</dd></div></dl>');
    expect(karate).toMatch(/<th scope="col">Read by recipe<\/th>/);
    expect(karate).toMatch(/<td>0<\/td><td><a href="[^"]*">[^<]*<\/a><\/td><td>live<\/td><td>[^<]*<\/td><td>yes<\/td>/);
  });

  it("writes an entry's properties and expected counts as labels and readable values", () => {
    const karate = page(files, "datasets/karate/index.html");
    expect(karate).toContain('<th scope="row">Nodes</th><td>34</td>');
    expect(karate).not.toMatch(/<code>(true|false)<\/code>/);
  });

  it("writes a search index whose ids are the catalogue's ids", () => {
    const index: unknown = JSON.parse(page(files, "search-index.json"));
    expect(Array.isArray(index) ? index.map((record: unknown) => (typeof record === "object" && record !== null && "id" in record ? record.id : undefined)) : []).toEqual(catalogue.listDatasets().map((dataset) => dataset.entry.id));
  });

  it("carries each entry's recorded dimensions into the search index and the static listing", () => {
    const index: unknown = JSON.parse(page(files, "search-index.json"));
    expect(index).toContainEqual(expect.objectContaining({ id: "karate", nodes: 34, edges: 78 }));
    const listing = page(files, "kinds/graph/index.html");
    expect(listing).toMatch(/<th scope="col" style="[^"]*">Entities<\/th><th scope="col" style="[^"]*">Size<\/th>/);
    expect(listing).toContain('<td title="34 nodes, 78 edges">34 nodes, 78 edges</td>');
  });

  it("shows a pinned snapshot's checksum in the sources table and the JSON-LD distribution", () => {
    const sha256 = "d".repeat(SHA256_DIGITS);
    const [source] = deadEntry.sources;
    const checksummed = createCatalogue({ ...fixtureIndex, entries: [{ ...deadEntry, sources: [{ ...source, snapshot: { ...source?.snapshot, sha256, byteLength: 4096 } }] }] });
    const text = page(build(checksummed), `datasets/${deadEntry.id}/index.html`);
    expect(text).toContain('<th scope="col">SHA-256</th>');
    expect(text).toContain(`<code title="${sha256}, 4096 bytes">${sha256.slice(0, HASH_SHOWN)}</code>`);
    expect(DatasetJsonLdSchema.parse(jsonLdOf(text)).distribution[0]).toMatchObject({ sha256 });
  });

  it("links a pinned snapshot both as the Wayback page with its banner and as the raw capture, each with a copy mount", () => {
    const text = page(files, `datasets/${deadEntry.id}/index.html`);
    const pageUrl = "https://web.archive.org/web/20230601/http://example.edu/~lab/data/celegans_metabolic.zip";
    const rawUrl = "https://web.archive.org/web/20230601id_/http://example.edu/~lab/data/celegans_metabolic.zip";
    expect(text).toContain(`<a href="${pageUrl}" title="The Wayback Machine page, with the archive&#x27;s banner">20230601</a><span data-copy-text="${pageUrl}" data-copy-label="Copy the snapshot page link" data-copy-style="icon"></span>`);
    expect(text).toContain(`<a href="${rawUrl}" title="The archived bytes as captured, without the archive&#x27;s banner">raw</a><span data-copy-text="${rawUrl}" data-copy-label="Copy the raw snapshot link" data-copy-style="icon"></span>`);
  });

  it("escapes catalogue text, so data never becomes markup", () => {
    const hostile = createCatalogue({ ...fixtureIndex, entries: [{ ...liveEntry, name: '<script>alert("x")</script>', description: "a </script> in prose" }] });
    const hostileFiles = build(hostile);
    const text = page(hostileFiles, "datasets/karate/index.html");
    expect(text).not.toContain("<script>alert");
    expect(text).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(DatasetJsonLdSchema.parse(jsonLdOf(text)).description).toBe("a </script> in prose");
  });
});

describe("buildSite with entries that hold the same data", () => {
  const twins = createCatalogue({
    ...fixtureIndex,
    entries: [
      { ...liveEntry, sameDataAs: ["twin"] },
      { ...liveEntry, id: "twin", name: "Entry twin", sameDataAs: [liveEntry.id] },
    ],
  });
  const files = build(twins);

  it("links each entry's page to the other's, naming it", () => {
    expect(page(files, "datasets/karate/index.html")).toContain('<th scope="row">Same data as</th><td><a href="../twin/">Entry twin</a> <code>twin</code></td>');
    expect(page(files, "datasets/twin/index.html")).toContain('<a href="../karate/">');
  });

  it("names the other entries' pages as schema.org sameAs", () => {
    expect(DatasetJsonLdSchema.parse(jsonLdOf(page(files, "datasets/karate/index.html")))).toMatchObject({ sameAs: [`${SITE_URL}datasets/twin/`] });
  });

  it("leaves the row and the property out for an entry with no counterpart", () => {
    const plain = build(createCatalogue(fixtureIndex));
    expect(page(plain, "datasets/karate/index.html")).not.toContain("Same data as");
    expect(page(plain, "datasets/karate/index.html")).not.toContain("sameAs");
  });
});

describe("buildSite with namespaced and aliased entries", () => {
  const named = createCatalogue({ ...fixtureIndex, entries: [{ ...liveEntry, namespace: ["one", "inner"], aliases: ["short", "club"] }] });
  const files = build(named);

  it("shows the namespace and aliases on the entry page, with the fetch command still for the entry's own id", () => {
    const text = page(files, "datasets/karate/index.html");
    expect(text).toContain('<th scope="row">Namespace</th><td><code><a href="../../namespaces/one/">one</a>/<a href="../../namespaces/one/inner/">inner</a></code></td>');
    expect(text).toContain('<th scope="row">Aliases</th><td><code>short</code>, <code>club</code></td>');
    expect(text).toContain("<code>npx keepset fetch karate</code>");
  });

  it("carries them in the search index, so the listing finds an entry by either", () => {
    const index: unknown = JSON.parse(page(files, "search-index.json"));
    expect(index).toEqual([expect.objectContaining({ id: "karate", namespace: "one/inner", aliases: ["short", "club"] })]);
  });

  it("names the aliases as schema.org alternate names", () => {
    expect(DatasetJsonLdSchema.parse(jsonLdOf(page(files, "datasets/karate/index.html")))).toMatchObject({ alternateName: ["short", "club"] });
  });

  it("leaves the rows and fields out for an entry with neither", () => {
    const plain = build(createCatalogue(fixtureIndex));
    expect(page(plain, "datasets/karate/index.html")).not.toContain('<th scope="row">Namespace</th>');
    expect(page(plain, "search-index.json")).not.toContain("namespace");
  });
});

describe("the namespace pages", () => {
  const bar = { ...liveEntry, id: "bar", name: "Entry bar", namespace: ["home", "deep"], aliases: ["foo/graphs/bar", "one/bar"] };
  const baz = { ...liveEntry, id: "baz", name: "Entry baz", namespace: ["foo", "graphs"] };
  const grouped = createCatalogue({ ...fixtureIndex, entries: [bar, baz] });
  const files = build(grouped);

  it("writes an index and a page for every namespace at any depth, and none for a name", () => {
    const namespacePages = [...files.keys()].filter((path) => path.startsWith("namespaces/")).sort();
    expect(namespacePages).toEqual(["namespaces/foo/graphs/index.html", "namespaces/foo/index.html", "namespaces/home/deep/index.html", "namespaces/home/index.html", "namespaces/index.html", "namespaces/one/index.html"]);
  });

  it("lists the outermost namespaces on the index, each with its count and a link to its page", () => {
    const text = page(files, "namespaces/index.html");
    expect(text).toContain('<ul class="groups"><li><a href="foo/">foo</a> (2)</li><li><a href="home/">home</a> (1)</li><li><a href="one/">one</a> (1)</li></ul>');
    expect(text).not.toContain("<table");
  });

  it("lists the child namespaces and every entry at or beneath a namespace, with links relative to its depth", () => {
    const text = page(files, "namespaces/foo/index.html");
    expect(text).toContain('<ul class="groups"><li><a href="graphs/">graphs</a> (2)</li></ul>');
    expect(text).toContain('<tr data-id="bar">');
    expect(text).toContain('<tr data-id="baz">');
    expect(text).toContain('href="../../datasets/bar/"');
    const deep = page(files, "namespaces/foo/graphs/index.html");
    expect(deep).toContain('<link rel="stylesheet" href="../../../app.css"/>');
    expect(deep).toContain('href="../../../datasets/bar/"');
    expect(deep).not.toContain('<ul class="groups">');
  });

  it("files an entry under each group a path alias names, and not under a group it is not in", () => {
    expect(page(files, "namespaces/one/index.html")).toContain('<tr data-id="bar">');
    expect(page(files, "namespaces/one/index.html")).not.toContain('<tr data-id="baz">');
    expect(page(files, "namespaces/home/deep/index.html")).not.toContain('<tr data-id="baz">');
  });

  it("links the namespace through its path on the entry page, and lists the groups its path aliases file it in", () => {
    const text = page(files, "datasets/bar/index.html");
    expect(text).toContain('<th scope="row">Namespace</th><td><code><a href="../../namespaces/home/">home</a>/<a href="../../namespaces/home/deep/">deep</a></code></td>');
    expect(text).toContain('<th scope="row">Also in</th><td><code><a href="../../namespaces/foo/">foo</a>/<a href="../../namespaces/foo/graphs/">graphs</a></code>, <code><a href="../../namespaces/one/">one</a></code></td>');
  });

  it("links the namespaces from the header of every page, relative to the page's depth", () => {
    expect(page(files, "index.html")).toContain('<a href="namespaces/">Namespaces</a>');
    expect(page(files, "datasets/bar/index.html")).toContain('<a href="../../namespaces/">Namespaces</a>');
    expect(page(files, "namespaces/foo/graphs/index.html")).toContain('<a href="../../../namespaces/">Namespaces</a>');
  });

  it("precaches the namespace pages with the other listing pages", () => {
    const { urls } = z.object({ urls: z.array(z.string()) }).parse(JSON.parse(page(files, "precache.json")));
    expect(urls).toEqual(expect.arrayContaining(["namespaces/", "namespaces/foo/", "namespaces/foo/graphs/", "namespaces/home/deep/", "namespaces/one/"]));
  });

  it("writes an index with no list for a catalogue with no namespaces", () => {
    const text = page(build(createCatalogue(fixtureIndex)), "namespaces/index.html");
    expect(text).toContain("<h1>Namespaces</h1>");
    expect(text).not.toContain('<ul class="groups">');
  });

  it("refuses two namespaces that differ only in letter case, since their pages would share a file", () => {
    const clash = createCatalogue({ ...fixtureIndex, entries: [{ ...liveEntry, id: "a", name: "Entry a", namespace: ["Foo"] }, { ...liveEntry, id: "b", name: "Entry b", namespace: ["foo"] }] });
    expect(() => build(clash)).toThrow(/differ only in letter case/);
  });
});

describe("buildSite on the bundled catalogue", () => {
  const datasets = listDatasets();
  const files = build({ manifest: getManifest(), listDatasets, listNamespaces });

  it("writes a page per entry whose JSON-LD validates, and a search index with exactly the catalogue's ids", () => {
    const ids = datasets.map((dataset) => dataset.entry.id);
    expect([...files.keys()].filter((path) => path.startsWith("datasets/")).map((path) => path.slice("datasets/".length, -"/index.html".length))).toEqual(ids);
    for (const id of ids) {
      expect(DatasetJsonLdSchema.safeParse(jsonLdOf(page(files, `datasets/${id}/index.html`))).success).toBe(true);
    }
    const index: unknown = JSON.parse(page(files, "search-index.json"));
    expect(z.array(z.looseObject({ id: z.string() })).parse(index).map((record) => record.id)).toEqual(ids);
  });
});
