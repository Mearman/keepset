/* @jsxRuntime automatic */
/** The site's page templates as React components, rendered to static markup in the generator: JSX makes escaping structural (React escapes every text node and attribute value, so catalogue data can never become markup) and lets the facts table take typed nodes instead of pre-escaped HTML strings. These components run only at build time; nothing here reaches the browser. The runtime pragma is a plain block comment because tsx, which runs the generator, transpiles JSX from pragmas rather than the tsconfig the typechecker reads, and a JSDoc-shaped one fails the tag-name lint. */

import { Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describeRule, groupsOf, NAME_SEPARATOR, rawSnapshotUrl, type Archive, type ArchiveMember, type Dataset, type Manifest, type NamespaceNode, type Parser, type RuleView } from "keepset";
import { dimensionsOf, entitiesText, formatCount, sizeText } from "./dimensions";
import { listingColumnWidths } from "./listing-columns";
import { propertyLabel, propertyText } from "./properties";
import { scriptJson, slug } from "./html";
import { datasetJsonLd, describe } from "./jsonld";

/** What every page needs to know about the site: where it is published, which catalogue and package built it, and how deep the page sits, so its links stay relative and the site works from any base path. */
export interface PageContext {
  readonly siteUrl: string;
  readonly manifest: Manifest;
  readonly packageVersion: string;
  /** The path from the page to the site root: "" at the root, "../../" two levels down. */
  readonly root: string;
}

/** One page's own content: its title and meta description as text, its main content and any extra head content (a JSON-LD script) as nodes. */
export interface PageContent {
  readonly title: string;
  readonly description: string;
  readonly body: ReactNode;
  readonly head?: ReactNode;
}

/** How many hex characters of a checksum a table shows, enough to tell one from another; the cell's title and the entry's JSON carry the whole hash. */
const HASH_SHOWN = 12;

/** One row of a listing table. */
function Row({ dataset, root }: { readonly dataset: Dataset; readonly root: string }): ReactNode {
  const { entry } = dataset;
  const dimensions = dimensionsOf(entry);
  const entities = entitiesText(dimensions);

  return (
    <tr data-id={entry.id}><td title={entry.name}><a href={`${root}datasets/${entry.id}/`}>{entry.name}</a></td><td title={entry.id}><code>{entry.id}</code></td><td>{dataset.kind}</td><td title={entry.domain}>{entry.domain ?? ""}</td><td title={entities}>{entities}</td><td>{sizeText(dimensions)}</td><td>{entry.recipe.status === "fetchable" ? "fetchable" : "not fetchable yet"}</td></tr>
  );
}

/** A table listing datasets, inside the wrapper that scrolls it sideways on narrow screens; the class pairs with the stylesheet's sticky desktop header. */
function Listing({ datasets, root }: { readonly datasets: readonly Dataset[]; readonly root: string }): ReactNode {
  const widths = listingColumnWidths(datasets.map((dataset) => ({ kind: dataset.kind, ...dimensionsOf(dataset.entry) })));
  const headers = ["Name", "Id", "Kind", "Domain", "Entities", "Size", "Recipe"];

  return (
    <div className="table-wrap listing"><table className="listing"><thead><tr>{headers.map((header, index) => <th key={header} scope="col" style={{ width: widths[index] }}>{header}</th>)}</tr></thead><tbody>{datasets.map((dataset) => <Row key={dataset.entry.id} dataset={dataset} root={root} />)}</tbody></table></div>
  );
}

/**
 * The facts row that names the archive file or files a recipe reads: a member path, the extensions a member's name ends with, or the pattern its path matches.
 * @param label - The row's label.
 * @param selector - The recipe's member selector.
 * @returns The row.
 */
function selectorRow(label: string, selector: ArchiveMember): readonly [string, ReactNode] {
  if ("path" in selector) {
    return [label, <code key="path">{selector.path}</code>];
  }
  if ("pattern" in selector) {
    return [label, <Fragment key="pattern">matching <code>{selector.pattern}</code></Fragment>];
  }

  return [label, <Fragment key="extensions">ending {selector.extensions.flatMap((extension, index) => (index === 0 ? [<code key={extension}>{extension}</code>] : [" or ", <code key={extension}>{extension}</code>]))}</Fragment>];
}

/** A two-column table of labelled values. */
function Facts({ rows }: { readonly rows: readonly (readonly [string, ReactNode])[] }): ReactNode {
  return (
    <table className="facts"><tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td>{value}</td></tr>)}</tbody></table>
  );
}

/**
 * The rows that describe how a download unpacks.
 * @param archive - The archive layout.
 * @returns Its kind, the member or members it selects and any inner archive.
 */
function archiveRows(archive: Archive): readonly (readonly [string, ReactNode])[] {
  return [
    ["Archive", archive.kind],
    ...("member" in archive ? [selectorRow("Member", archive.member)] : "members" in archive ? [selectorRow("Members", archive.members)] : "parts" in archive ? archive.parts.map((part) => selectorRow(`Part ${part.name}`, part.member)) : "files" in archive ? [selectorRow("Files", archive.files)] : []),
    ...("inner" in archive && archive.inner !== undefined ? [["Inner archive", archive.inner.kind] as const, ...("member" in archive.inner ? [selectorRow("Inner member", archive.inner.member)] : []), ...("sheets" in archive.inner && archive.inner.sheets !== undefined ? [["Sheets matching", <code key="sheets">{archive.inner.sheets}</code>] as const] : [])] : []),
  ];
}

/**
 * The rows that describe a recipe's parser: one per option.
 * @param parser - The parser.
 * @returns The rows.
 */
function parserRows(parser: Parser): readonly (readonly [string, ReactNode])[] {
  return Object.entries(parser).map(([option, value]) => [`Parser ${option}`, <code key={option}>{JSON.stringify(value)}</code>] as const);
}

/** A link whose text is its URL. */
function Link({ url }: { readonly url: string }): ReactNode {
  return <a href={url}>{url}</a>;
}

/** A pinned snapshot's two links, each with a mount for its copy icon: the Wayback Machine page the timestamp names, which wraps the capture in the archive's banner, and the raw capture without it, which is the form a download or a script wants. */
function SnapshotLinks({ timestamp, pageUrl, rawUrl }: { readonly timestamp: string; readonly pageUrl: string; readonly rawUrl: string }): ReactNode {
  return (
    <span className="snapshot-links">
      <span className="snapshot-link"><a href={pageUrl} title="The Wayback Machine page, with the archive's banner">{timestamp}</a><span data-copy-text={pageUrl} data-copy-label="Copy the snapshot page link" data-copy-style="icon" /></span>
      <span className="snapshot-link"><a href={rawUrl} title="The archived bytes as captured, without the archive's banner">raw</a><span data-copy-text={rawUrl} data-copy-label="Copy the raw snapshot link" data-copy-style="icon" /></span>
    </span>
  );
}

/** A namespace path written out with each segment linking to the page of the path up to it. */
function GroupPath({ segments, root }: { readonly segments: readonly string[]; readonly root: string }): ReactNode {
  return (
    <>
      {segments.map((segment, index) => (
        <Fragment key={segments.slice(0, index + 1).join(NAME_SEPARATOR)}>
          {index === 0 ? "" : NAME_SEPARATOR}
          <a href={`${root}namespaces/${segments.slice(0, index + 1).join(NAME_SEPARATOR)}/`}>{segment}</a>
        </Fragment>
      ))}
    </>
  );
}

/**
 * One recorded property as a row of the properties table: its label and its value written for reading, with the exact value in the cell's title where the shown one is shortened.
 * @param key - The property key.
 * @param value - The recorded value.
 * @returns The row.
 */
function propertyRow(key: string, value: unknown): readonly [string, ReactNode] {
  const { text, exact } = propertyText(key, value);

  return [propertyLabel(key), <span key={key} title={exact}>{text}</span>];
}

/**
 * Wraps page content in the shared layout: head with the web app manifest and styles, the site header, and the client island's script.
 * @param context - The page context.
 * @param page - The page's own content.
 * @returns The whole document.
 */
function Layout(context: PageContext, page: PageContent): string {
  const { root, manifest } = context;
  const { title, description, body, head } = page;

  return `<!doctype html>
${renderToStaticMarkup(
  <html lang="en-GB"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>{title}</title><meta name="description" content={description} /><link rel="manifest" href={`${root}manifest.webmanifest`} /><link rel="icon" href={`${root}icon.svg`} type="image/svg+xml" /><link rel="stylesheet" href={`${root}app.css`} /><meta name="theme-color" content="#1f4e79" />{head}</head><body data-root={root}><a className="skip-link" href="#main">Skip to content</a><header><a className="home" href={root}>keepset</a><nav><a href={root}>All datasets</a><a href={`${root}domains/`}>Domains</a><a href={`${root}subjects/`}>Subjects</a><a href={`${root}kinds/`}>Kinds</a><a href={`${root}namespaces/`}>Namespaces</a><a href="https://github.com/Mearman/keepset">Source</a></nav></header><main id="main" tabIndex={-1}>{body}</main><footer>Catalogue <code>{manifest.id}</code> {manifest.version}, built by keepset {context.packageVersion}.</footer><script type="module" src={`${root}app.js`} /></body></html>,
)}
`;
}

/**
 * The home page: every dataset in a static table, with a search box and filters the client island wires to the search index.
 * @param context - The page context.
 * @param datasets - Every dataset.
 * @returns The document.
 */
export function homePage(context: PageContext, datasets: readonly Dataset[]): string {
  const body = (
    <Fragment><h1>keepset</h1><p>{context.manifest.description} Each entry's page shows its sources, licence, recipe and crosswalk, and the command that fetches it.</p><div id="island-root" /><Listing datasets={datasets} root={context.root} /></Fragment>
  );

  return Layout(context, { title: "keepset: dataset catalogue", description: context.manifest.description, body });
}

/** An entry that holds the same data as the page's own: enough to link to it and say what it is. */
export interface SameDataEntry {
  readonly id: string;
  readonly name: string;
}

/**
 * One row of an entry's crosswalk table: the operation, the paths it reads and writes (a default's value stands where the paths it reads would be) and the direction it applies in.
 * @param rule - The rule, as described.
 * @param index - The rule's position among the crosswalk's rules, which keeps a row's key unique.
 * @returns The table row.
 */
function ruleRow(rule: RuleView, index: number): ReactNode {
  const reads = rule.op === "default" ? rule.detail : rule.from.join(", ");

  return (
    <tr key={`${rule.op}-${String(index)}`}>
      <td>{rule.op}</td>
      <td>{reads === undefined || reads === "" ? null : <code>{reads}</code>}</td>
      <td>{rule.to.length === 0 ? null : <code>{rule.to.join(", ")}</code>}</td>
      <td>{rule.direction}</td>
    </tr>
  );
}

/**
 * An entry's page: the descriptor, the copyable fetch command, and tables of sources and provenance, licence and citations, recipe, crosswalk rules, expected counts and properties, with the schema.org Dataset JSON-LD in the head.
 * @param context - The page context (`root` is two levels up).
 * @param dataset - The dataset.
 * @param sameData - The entries that hold the same data, in the order the entry names them.
 * @returns The document.
 */
export function entryPage(context: PageContext, dataset: Dataset, sameData: readonly SameDataEntry[]): string {
  const { entry, crosswalk } = dataset;
  const pageUrl = `${context.siteUrl}datasets/${entry.id}/`;
  const jsonLd = datasetJsonLd(dataset, pageUrl, context.siteUrl);
  const command = `npx keepset fetch ${entry.id}`;
  const { licence, recipe } = entry;
  // The namespace is where the entry comes from; every other group is one a path alias files it in.
  const home = (entry.namespace ?? []).join(NAME_SEPARATOR);
  const otherGroups = groupsOf(entry).filter((group) => group.join(NAME_SEPARATOR) !== home);
  const licenceNode: ReactNode = licence.kind === "spdx" ? <a href={`https://spdx.org/licenses/${licence.id}.html`}>{licence.id}</a> : licence.kind === "custom" ? <a href={licence.url}>{licence.name}</a> : "not recorded by the source";

  const dimensions = dimensionsOf(entry);
  const { nodes, edges, instances } = dimensions;
  const figures: readonly (readonly [string, string])[] = [["Nodes", formatCount(nodes)], ["Edges", formatCount(edges)], ["Instances", formatCount(instances)], ["Size", sizeText(dimensions)]].filter((figure): figure is [string, string] => figure[1] !== "");
  // The entries of the recipe's sources that it reads, so the sources table can say which of the mirrors the fetch uses.
  const readSources = new Set<number>(recipe.status !== "fetchable" ? [] : "files" in recipe ? recipe.files.map((file) => file.source) : [recipe.source]);

  const sections: ReactNode[] = [
    <nav className="breadcrumb" aria-label="Breadcrumb" key="breadcrumb"><ol><li><a href={context.root}>All datasets</a></li><li><a href={`../../kinds/${slug(dataset.kind)}/`}>{dataset.kind}</a></li>{entry.domain === undefined ? null : <li><a href={`../../domains/${slug(entry.domain)}/`}>{entry.domain}</a></li>}</ol></nav>,
    <h1 key="name">{entry.name}</h1>,
    entry.description === undefined ? null : <p className="description" key="description">{entry.description}</p>,
    <p className="command" key="command"><code>{command}</code> <span data-copy-text={command} /></p>,
    figures.length === 0 ? null : <dl className="stats" key="stats">{figures.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>,
    recipe.status === "fetchable" ? (
      <div className="preview" key="preview" data-preview-id={entry.id}>
        <p className="preview-note">Fetch and preview this dataset on this page, or download the result as JSON. The command line fetches it without a browser.</p>
      </div>
    ) : null,
    recipe.status === "fetchable" ? null : <p className="warning" key="warning">This entry has no fetchable recipe yet: {recipe.reason}</p>,
    <h2 key="overview">Overview</h2>,
    <Facts key="overview" rows={[
      ["Id", <code key="id">{entry.id}</code>],
      ...(entry.namespace === undefined ? [] : [["Namespace", <code key="namespace"><GroupPath segments={entry.namespace} root={context.root} /></code>] as const]),
      ...(otherGroups.length === 0 ? [] : [["Also in", otherGroups.map((group) => <code key={group.join(NAME_SEPARATOR)}><GroupPath segments={group} root={context.root} /></code>).flatMap((group, index) => (index === 0 ? [group] : [", ", group]))] as const]),
      ...(entry.aliases === undefined ? [] : [["Aliases", entry.aliases.map((alias) => <code key={alias}>{alias}</code>).flatMap((alias, index) => (index === 0 ? [alias] : [", ", alias]))] as const]),
      ...(sameData.length === 0 ? [] : [["Same data as", sameData.map((other) => <Fragment key={other.id}><a href={`../${other.id}/`}>{other.name}</a> <code>{other.id}</code></Fragment>).flatMap((link, index) => (index === 0 ? [link] : [", ", link]))] as const]),
      ["Category", <code key="category">{entry.category}</code>],
      ["Kind", <a key="kind" href={`../../kinds/${slug(dataset.kind)}/`}>{dataset.kind}</a>],
      ...(entry.domain === undefined ? [] : [["Domain", <a key="domain" href={`../../domains/${slug(entry.domain)}/`}>{entry.domain}</a>] as const]),
      ...(entry.subjects === undefined ? [] : [["Subjects", entry.subjects.map((subject) => <a key={subject} href={`../../subjects/${slug(subject)}/`}>{subject}</a>).flatMap((link, index) => (index === 0 ? [link] : [", ", link]))] as const]),
      ...(entry.tags.length === 0 ? [] : [["Tags", entry.tags.join(", ")] as const]),
      ["Licence", licenceNode],
      ["Catalogue", <Fragment key="catalogue"><code>{dataset.catalogue.id}</code> {dataset.catalogue.version}</Fragment>],
    ]} />,
    <h2 key="sources">Sources and provenance</h2>,
    <div className="table-wrap" key="sources"><table className="provenance"><thead><tr><th scope="col">#</th><th scope="col">URL</th><th scope="col">Status</th><th scope="col">Retrieved</th><th scope="col">Read by recipe</th><th scope="col">Pinned snapshot</th><th scope="col">SHA-256</th></tr></thead><tbody>{entry.sources.map((source, index) => <tr key={String(index)}><td>{String(index)}</td><td><Link url={source.url} /></td><td>{source.status}</td><td>{source.retrieved}</td><td>{readSources.has(index) ? "yes" : ""}</td><td>{source.snapshot === undefined ? "" : <SnapshotLinks timestamp={source.snapshot.timestamp} pageUrl={source.snapshot.url} rawUrl={rawSnapshotUrl(source.snapshot.timestamp, source.url)} />}</td><td>{source.snapshot?.sha256 === undefined ? "" : <code title={`${source.snapshot.sha256}, ${String(source.snapshot.byteLength)} bytes`}>{source.snapshot.sha256.slice(0, HASH_SHOWN)}</code>}</td></tr>)}</tbody></table></div>,
    entry.citations.length === 0 ? null : <h2 key="citations">Citations</h2>,
    entry.citations.length === 0 ? null : (
      <ul className="citations" key="citations-list">{entry.citations.map((cited, index) => (
        <li key={String(index)}>{cited.text}{cited.doi === undefined ? null : <Fragment>{" "}<a href={`https://doi.org/${cited.doi}`}>doi:{cited.doi}</a></Fragment>}{cited.url === undefined ? null : <Fragment>{" "}<Link url={cited.url} /></Fragment>}</li>
      ))}</ul>
    ),
    <h2 key="recipe">Recipe</h2>,
    recipe.status === "not-fetchable" ? (
      <Facts key="recipe-facts" rows={[["Status", `not fetchable: ${recipe.reason}`]]} />
    ) : "files" in recipe ? (
      <Fragment key="recipe-facts">
        <Facts rows={[["Files", `${recipe.files.length.toLocaleString("en-GB")}, each downloaded from its own source`], ...parserRows(recipe.parser)]} />
        <div className="table-wrap"><table className="sources"><thead><tr><th scope="col">File</th><th scope="col">Source</th><th scope="col">Archive</th></tr></thead><tbody>{recipe.files.map((file) => <tr key={file.path}><td><code>{file.path}</code></td><td>#{String(file.source)}</td><td>{file.archive.kind}</td></tr>)}</tbody></table></div>
      </Fragment>
    ) : (
      <Facts key="recipe-facts" rows={[
        ["Source", `#${String(recipe.source)}`],
        ...(recipe.stream === true ? [["Delivery", "streamed a page at a time, too large to hold as one document"] as const] : []),
        ...archiveRows(recipe.archive),
        ...parserRows(recipe.parser),
      ]} />
    ),
    <h2 key="crosswalk">Crosswalk</h2>,
    <p key="crosswalk-note"><code>{crosswalk.source}</code> to <code>{crosswalk.target}</code>, as a crossmap crosswalk.</p>,
    <div className="table-wrap" key="crosswalk"><table className="crosswalk"><thead><tr><th scope="col">Rule</th><th scope="col">From</th><th scope="col">To</th><th scope="col">Direction</th></tr></thead><tbody>{[
      ...[...crosswalk.rules, ...crosswalk.oneWay].map((rule, index) => ruleRow(describeRule(rule), index)),
    ]}</tbody></table></div>,
    Object.keys(entry.expectedCounts).length === 0 ? null : <h2 key="counts">Expected counts</h2>,
    Object.keys(entry.expectedCounts).length === 0 ? null : <Facts key="counts-facts" rows={Object.entries(entry.expectedCounts).map(([key, count]) => [propertyLabel(key), formatCount(count)] as const)} />,
    Object.keys(entry.properties).length === 0 ? null : <h2 key="properties">Properties</h2>,
    Object.keys(entry.properties).length === 0 ? null : <Facts key="properties-facts" rows={Object.entries(entry.properties).map(([key, value]) => propertyRow(key, value))} />,
  ];

  return Layout(context, {
    title: `${entry.name}: keepset`,
    description: describe(dataset),
    body: sections.filter((section) => section !== null),
    head: <Fragment><link rel="canonical" href={pageUrl} /><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: scriptJson(jsonLd) }} /></Fragment>,
  });
}

/**
 * A listing page: the datasets of one domain, subject or kind.
 * @param context - The page context (`root` is two levels up).
 * @param title - What the datasets share, such as "Domain: Social network" or "Subject: operations-research".
 * @param datasets - The datasets.
 * @returns The document.
 */
export function listingPage(context: PageContext, title: string, datasets: readonly Dataset[]): string {
  return Layout(context, { title: `${title}: keepset`, description: `${title}: datasets in the keepset catalogue.`, body: <Fragment><h1>{title}</h1><Listing datasets={datasets} root={context.root} /></Fragment> });
}

/**
 * An index of listing pages: every domain, subject or kind, with how many datasets each holds.
 * @param context - The page context (`root` is one level up).
 * @param title - "Domains", "Subjects" or "Kinds".
 * @param groups - Each group's label and datasets.
 * @returns The document.
 */
export function groupsPage(context: PageContext, title: string, groups: readonly { readonly label: string; readonly count: number }[]): string {
  return Layout(context, { title: `${title}: keepset`, description: `${title} of the datasets in the keepset catalogue.`, body: <Fragment><h1>{title}</h1><ul className="groups">{groups.map((group) => <li key={group.label}><a href={`${slug(group.label)}/`}>{group.label}</a> ({group.count})</li>)}</ul></Fragment> });
}

/**
 * A namespace page: the namespaces directly beneath it with how many entries each holds, and every entry at or beneath it. The index of all namespaces is the same page without a path and without entries.
 * @param context - The page context (`root` is one level up for the index, and one more for each segment of the path).
 * @param path - The namespace's path, or undefined for the index of the outermost namespaces.
 * @param children - The namespaces directly beneath it.
 * @param datasets - The entries at or beneath it; none for the index.
 * @returns The document.
 */
export function namespacePage(context: PageContext, path: string | undefined, children: readonly NamespaceNode[], datasets: readonly Dataset[]): string {
  const title = path === undefined ? "Namespaces" : `Namespace: ${path}`;
  const body = (
    <Fragment>
      <h1>{title}</h1>
      {path === undefined ? null : <p>Entries in this namespace and in every namespace beneath it.</p>}
      {children.length === 0 ? null : <ul className="groups">{children.map((child) => <li key={child.path}><a href={`${child.name}/`}>{child.name}</a> ({child.count})</li>)}</ul>}
      {path === undefined ? null : <Listing datasets={datasets} root={context.root} />}
    </Fragment>
  );

  return Layout(context, { title: `${title}: keepset`, description: path === undefined ? "The namespaces of the datasets in the keepset catalogue." : `${title}: datasets in the keepset catalogue.`, body });
}
