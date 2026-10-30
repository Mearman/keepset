import { describe, expect, it } from "vitest";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";
import { parseOpenslrResource } from "./openslr-resource";

/** The block of a file's links as a resource page writes it: the file, its size and description, and its mirrors. */
const file = (name: string, size: string, description: string): string =>
  `<a href="https://host.example/resources/7/${name}"> ${name} </a> [${size}] &nbsp; ( ${description}\n) &nbsp;  Mirrors: \n<a href="https://host.example/resources/7/${name}"> [EU] </a> &nbsp;\n<a href="https://mirror.example/resources/7/${name}"> [CN] </a> &nbsp;\n`;

/** A resource page of the layout OpenSLR serves, with the parts a test varies passed in. */
const page = (parts: { readonly title?: string; readonly labels?: string; readonly downloads?: string; readonly about?: string; readonly external?: string } = {}): string => {
  const { title = "Example &amp; corpus", labels = '<p class="resource"> <b>Identifier:</b> SLR7 </p>\n<p class="resource"> <b>Summary:</b> A small corpus\n </p>\n<p class="resource"> <b>Category:</b> Speech\n </p>\n<p class="resource"> <b>License:</b> CC BY 4.0\n </p>\n', downloads = "", about = "", external = "" } = parts;

  return `<div id="headerRight"><h2 class="slrStyle">Open Speech and Language Resources</h2></div>\n<div class="container" >\n<h2 class="slrStyle"> ${title}\n </h2>\n${labels}${downloads}${about}${external}\n</div>`;
};

const downloads = `<p class="resource"> <b>Downloads (use a mirror closer to you):</b> <br>\n${file("dev.tar.gz", "337M", "development set, &quot;clean&quot; speech")}<br>${file("train.tar.gz", "6.3G", "training set")}<br><br></p>`;
const about = '<p class="resource"><b>About this resource:</b></p><div id="about"><p>Read speech, 16&nbsp;kHz. See <a href="https://example.com/paper">the paper</a> or <a href="https://example.com/home">https://example.com/home</a>.</p>\n<ul><li>one</li><li>two</li></ul><div>nested</div></div>';
const external = '<p class="resource"> <b>External URL:</b> <a href="http://example.com/corpus.tgz\n"> http://example.com/corpus.tgz\n </a> &nbsp;  </p>';

describe("the openslr-resource parser", () => {
  it("reads the resource into the meta and its files into the nodes in page order, without the mirrors", () => {
    const { meta, nodes } = parseOpenslrResource(page({ downloads, about, external }));
    expect(meta).toEqual({
      name: "Example & corpus",
      identifier: "SLR7",
      summary: "A small corpus",
      category: "Speech",
      licence: "CC BY 4.0",
      about: "Read speech, 16 kHz. See the paper (https://example.com/paper) or https://example.com/home.\n\none\ntwo\n\nnested",
      externalUrl: "http://example.com/corpus.tgz",
    });
    expect(nodes).toEqual([
      { id: "dev.tar.gz", url: "https://host.example/resources/7/dev.tar.gz", size: "337M", description: 'development set, "clean" speech' },
      { id: "train.tar.gz", url: "https://host.example/resources/7/train.tar.gz", size: "6.3G", description: "training set" },
    ]);
  });

  it("gives a resource with no downloads, description or external address no nodes and nulls, and a file with no description a null one", () => {
    expect(parseOpenslrResource(page())).toEqual({ meta: { name: "Example & corpus", identifier: "SLR7", summary: "A small corpus", category: "Speech", licence: "CC BY 4.0", about: null, externalUrl: null }, nodes: [] });
    const bare = '<p class="resource"> <b>Downloads (use a mirror closer to you):</b> <br>\n<a href="https://host.example/resources/7/a.tgz"> a.tgz </a> [2.7M] &nbsp; ( \n<br><br></p>';
    expect(parseOpenslrResource(page({ downloads: bare })).nodes).toEqual([{ id: "a.tgz", url: "https://host.example/resources/7/a.tgz", size: "2.7M", description: null }]);
  });

  it("trims the whitespace a page leaves inside a file link's address", () => {
    const padded = '<p class="resource"> <b>Downloads (use a mirror closer to you):</b> <br>\n<a href="https://host.example/resources/7/a.tgz\t"> a.tgz </a> [2.7M] &nbsp; ( x\n) &nbsp;  Mirrors: \n<br><br></p>';
    expect(parseOpenslrResource(page({ downloads: padded })).nodes).toEqual([{ id: "a.tgz", url: "https://host.example/resources/7/a.tgz", size: "2.7M", description: "x" }]);
  });

  it("gives a labelled line the page does not have as null, and leaves an unknown character reference as written", () => {
    const { meta } = parseOpenslrResource(page({ labels: '<p class="resource"> <b>Identifier:</b> SLR7 </p>\n', title: "Caf&eacute; &#233; &#xE9;" }));
    expect(meta).toMatchObject({ name: "Caf&eacute; é é", summary: null, category: null, licence: null });
  });

  it("is what parseNative runs for the format", () => {
    const bytes = new TextEncoder().encode(page({ downloads }));
    expect(parseNative(bytes, { format: "openslr-resource", encoding: "utf-8" }).nodes).toHaveLength(2);
  });

  it("refuses a page without a title or an identifier, a downloads block with no file link, a file listed twice and a description never closed", () => {
    expect(() => parseOpenslrResource("<html></html>")).toThrow(/no resource title/);
    expect(() => parseOpenslrResource(page({ labels: "" }))).toThrow(/no identifier/);
    expect(() => parseOpenslrResource(page({ downloads: '<p class="resource"> <b>Downloads:</b> <br>nothing here<br><br></p>' }))).toThrow(/holds no file link/);
    expect(() => parseOpenslrResource(page({ downloads: `<p class="resource"> <b>Downloads:</b> <br>\n${file("a.tgz", "1M", "x")}<br>${file("a.tgz", "1M", "y")}<br><br></p>` }))).toThrow(/a\.tgz is listed twice/);
    expect(() => parseOpenslrResource(page({ about: '<div id="about"><div>open' }))).toThrow(NativeParseError);
  });
});
