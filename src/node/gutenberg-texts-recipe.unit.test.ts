import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { tar } from "../test-support/archives";
import { roundTripDataset, streamDataset, type FetchPort, type StreamedNode } from "./fetch-dataset";

/** Two books as Project Gutenberg's plain-text files are written: a licence header before the text and a footer after it, CRLF line endings, UTF-8 beyond ASCII, and blank lines at the end. */
const books = [
  {
    path: "cache/epub/10000/pg10000.txt",
    text: "The Project Gutenberg eBook of The Magna Carta\r\n    \r\nThis eBook is for the use of anyone anywhere in the United States and\r\nmost other parts of the world at no cost and with almost no restrictions\r\nwhatsoever.\r\n\r\nTitle: The Magna Carta\r\n\r\n*** START OF THE PROJECT GUTENBERG EBOOK THE MAGNA CARTA ***\r\n\r\nJohn, by the grace of God, king of England, to the archbishops of Æthelred's line.\r\n\r\n*** END OF THE PROJECT GUTENBERG EBOOK THE MAGNA CARTA ***\r\n\r\nSubscribe to our email newsletter to hear about new eBooks.\r\n\r\n\r\n",
  },
  {
    path: "cache/epub/10001/pg10001.txt",
    text: "The Project Gutenberg eBook of Apocolocyntosis\r\n\r\nTitle: Apocolocyntosis\r\n\r\n*** START OF THE PROJECT GUTENBERG EBOOK APOCOLOCYNTOSIS ***\r\n\r\nQuid actum sit in caelo ante diem III. idus Octobris, Cæsar.\r\n\r\n*** END OF THE PROJECT GUTENBERG EBOOK APOCOLOCYNTOSIS ***\r\n",
  },
];

/** The feed's layout: a zip whose one member is `txt-files.tar`, holding each book at the path the main collection files it under. */
const feed = zipSync({ "txt-files.tar": tar(books) });

/** A port that finds no Wayback capture and serves the feed for its live URL. */
const serving: FetchPort = async (url) => {
  if (url.startsWith("https://archive.org/wayback/available")) {
    return Promise.resolve(new Response(JSON.stringify({ archived_snapshots: {} })));
  }
  expect(url).toBe("https://www.gutenberg.org/cache/epub/feeds/txt-files.tar.zip");

  return Promise.resolve(new Response(feed));
};

describe("the gutenberg-texts recipe", () => {
  it("streams each book as a document named by its ebook number, its text exactly as the file holds it, header and footer included", async () => {
    const nodes: StreamedNode[] = [];
    const streamed = await streamDataset(
      "gutenberg-texts",
      {
        meta: () => undefined,
        nodes: (page) => {
          nodes.push(...page);
        },
      },
      { fetch: serving },
    );
    expect(nodes).toEqual(books.map((book) => ({ id: /pg([0-9]+)\.txt$/.exec(book.path)?.[1], text: book.text })));
    expect(streamed.meta).toMatchObject({ id: "gutenberg-texts", encoding: "utf-8", format: "text/plain" });
    expect(streamed.provenance.members).toEqual(books.map((book) => `txt-files.tar/${book.path}`));
  });

  it("keeps its crosswalk's round trip on every book", async () => {
    const report = await roundTripDataset("gutenberg-texts", { fetch: serving });
    expect(report).toMatchObject({ holds: true, counts: new Map([["nodes", books.length]]) });
  });

  it("is filed beside the catalogue entry that describes the same works", () => {
    const { entry } = getDataset("gutenberg-texts");
    expect(entry.category).toBe("corpus/v1");
    expect(entry.namespace).toEqual(getDataset("gutenberg-catalogue").entry.namespace);
  });
});
