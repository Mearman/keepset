import { NativeParseError } from "../errors";
import type { NativeInstance, NativeRow } from "./native";

/** The columns of a file of a resource, as the parser names them: where the host serves it, its size as the page states it (a figure with a unit, such as `337M`) and what the page says it holds. All are text. */
export const OPENSLR_RESOURCE_COLUMNS = ["url", "size", "description"] as const;

/** The columns whose values are text; all of them. */
export const OPENSLR_RESOURCE_TEXT_COLUMNS = OPENSLR_RESOURCE_COLUMNS;

/** The metadata keys the parser reads from a resource page: its title, identifier, summary, category and licence, the plain text of its description, and the external address it points to. */
export const OPENSLR_RESOURCE_META = ["name", "identifier", "summary", "category", "licence", "about", "externalUrl"] as const;

const FORMAT = "openslr-resource";

/** The resource's title: the heading at the top of the page's content block, after the site's own banner heading. */
const TITLE = /<div class="container"\s*>\s*<h2 class="slrStyle">([\s\S]*?)<\/h2>/;

/** A labelled line of the resource block, `<p class="resource"><b>Label:</b> value</p>`. The capture groups are the label and the value. */
const LABELLED = /<p class="resource">\s*<b>([^<:]+):<\/b>([\s\S]*?)<\/p>/g;

/** The labelled lines that become metadata, by the page's label and the key the parser gives them. */
const LABELS: Readonly<Record<string, "identifier" | "summary" | "category" | "licence">> = { Identifier: "identifier", Summary: "summary", Category: "category", License: "licence" };

/** The block of download links, from its label to the end of its paragraph (the paragraph that holds it ends after the last file's mirrors). */
const DOWNLOADS = /<b>Downloads[^<]*<\/b>([\s\S]*?)(?:<br><br><\/p>|<\/p>)/;

/** A file link: the host's own address, the file name as the link text, the size in brackets and the opening of the description. A mirror link's text is a bracketed region, so a file name cannot start with a bracket. */
const FILE = /<a href="([^"]+)">\s*([^<\s[][^<]*?)\s*<\/a>\s*\[([^\]]+)\]\s*&nbsp;\s*\(([\s\S]*?)(?=<br><a href|\)\s*&nbsp;\s*Mirrors:|<br><br>|$)/g;

/** The description block, opening tag first. */
const ABOUT_OPEN = /<div id="about">/;

/** The external address block, `<b>External URL:</b> <a href="...">`. */
const EXTERNAL = /<b>External URL:<\/b>\s*<a href="([^"]*)"/;

/** Named character references the pages use, besides numeric ones. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** A character reference: a name, or a decimal or hexadecimal code point. */
const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*));/g;

/** The tags after which text starts on a new line. */
const BLOCK_END = /<\/(?:p|li|ul|ol|h[1-6]|pre|tr|table)>|<br\s*\/?>|<p\s*\/?>/gi;

/** A link with a quoted address, whose text and address are captured. */
const LINK = /<a\s+href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Turns a fragment of page markup into text: a link whose text does not show its address is followed by the address in parentheses, block tags become line breaks, every other tag is dropped, character references are decoded (a name the parser does not know is left as written), runs of blanks become one space, and blank lines collapse to one.
 * @param markup - A fragment of the page.
 * @returns The text, trimmed.
 */
function textOf(markup: string): string {
  const linked = markup.replaceAll(LINK, (_whole, _quote: string, address: string, label: string) => (label.includes(address.trim()) || address.trim() === "" ? label : `${label} (${address.trim()})`));
  const plain = linked.replaceAll(BLOCK_END, "\n").replaceAll(/<[^>]*>/g, "");
  const decoded = plain.replaceAll(ENTITY, (whole, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (decimal !== undefined) {
      return String.fromCodePoint(Number(decimal));
    }
    if (hex !== undefined) {
      return String.fromCodePoint(Number.parseInt(hex, 16));
    }

    return name === undefined ? whole : (NAMED_ENTITIES[name] ?? whole);
  });

  return decoded
    .split("\n")
    .map((line) => line.replaceAll(/[ \t]+/g, " ").trim())
    .join("\n")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The 1-based line a position of the page is on, for an error.
 * @param page - The page text.
 * @param position - An index into it.
 * @returns The line.
 */
function lineOf(page: string, position: number): number {
  return page.slice(0, position).split("\n").length;
}

/**
 * The markup of the description block: from its opening tag to the `</div>` that balances it.
 * @param page - The page text.
 * @returns The markup between the tags, or undefined when the page has no description.
 * @throws NativeParseError when the block is never closed.
 */
function aboutOf(page: string): string | undefined {
  const open = ABOUT_OPEN.exec(page);
  if (open === null) {
    return undefined;
  }
  const start = open.index + open[0].length;
  let depth = 1;
  for (const tag of page.slice(start).matchAll(/<(\/?)div\b[^>]*>/gi)) {
    depth += tag[1] === "/" ? -1 : 1;
    if (depth === 0) {
      return page.slice(start, start + tag.index);
    }
  }

  throw new NativeParseError(FORMAT, lineOf(page, open.index), "the description block is never closed");
}

/**
 * Parses a resource page of OpenSLR (`https://www.openslr.org/<n>/`): the title heading, the labelled lines (identifier, summary, category, licence), a block of download links each with its size and description, an optional block describing the resource and an optional external address. The resource's own fields are the instance's `meta`, with a field the page does not give as null, and its files are the nodes, in page order and identified by file name. The mirror links beside each file are the same file elsewhere and are not kept. A character reference the parser does not know is left as the page writes it.
 * @param page - The page's text.
 * @returns The instance: the resource as `meta` and its files as nodes.
 * @throws NativeParseError naming the line for a page without a title or an identifier, a downloads block in which no file link is found, two files of one name, and a description block that is never closed.
 */
export function parseOpenslrResource(page: string): NativeInstance {
  const title = TITLE.exec(page);
  if (title === null) {
    throw new NativeParseError(FORMAT, 1, "the page has no resource title");
  }
  const labelled: Partial<Record<(typeof LABELS)[string], string>> = {};
  for (const match of page.matchAll(LABELLED)) {
    const key = LABELS[match[1] ?? ""];
    const value = textOf(match[2] ?? "");
    if (key !== undefined && value !== "") {
      labelled[key] = value;
    }
  }
  if (labelled.identifier === undefined) {
    throw new NativeParseError(FORMAT, lineOf(page, title.index), "the page has no identifier");
  }

  const nodes: NativeRow[] = [];
  const names = new Set<string>();
  const downloads = DOWNLOADS.exec(page);
  if (downloads !== null) {
    const block = downloads[1] ?? "";
    for (const match of block.matchAll(FILE)) {
      const name = match[2] ?? "";
      if (names.has(name)) {
        throw new NativeParseError(FORMAT, lineOf(page, downloads.index), `the file ${name} is listed twice`);
      }
      names.add(name);
      const description = textOf((match[4] ?? "").replace(/\)\s*$/, ""));
      nodes.push({ id: name, url: match[1] ?? null, size: match[3] ?? null, description: description === "" ? null : description });
    }
    if (nodes.length === 0) {
      throw new NativeParseError(FORMAT, lineOf(page, downloads.index), "the downloads block holds no file link");
    }
  }

  const about = aboutOf(page);
  const aboutText = about === undefined ? "" : textOf(about);
  const external = EXTERNAL.exec(page)?.[1]?.trim();

  return {
    meta: {
      name: textOf(title[1] ?? ""),
      identifier: labelled.identifier,
      summary: labelled.summary ?? null,
      category: labelled.category ?? null,
      licence: labelled.licence ?? null,
      about: aboutText === "" ? null : aboutText,
      externalUrl: external === undefined || external === "" ? null : external,
    },
    nodes,
  };
}
