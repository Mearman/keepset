import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar } from "../test-support/archives";
import { docx, wordDoc } from "../test-support/word-fixtures";
import { fetchEntry, type FetchPort } from "./fetch-dataset";

/**
 * Serves each URL its body, and refuses a URL the recipe has no business requesting.
 * @param bodies - The body for each URL the entry's sources name.
 * @returns A fetch port.
 */
function serving(bodies: Readonly<Record<string, Uint8Array>>): FetchPort {
  return async (url) => {
    const body = bodies[url];

    return Promise.resolve(body === undefined ? new Response("not found", { status: 404 }) : new Response(body));
  };
}

/** The URL of a file of a resource's download list. */
const download = (number: string, name: string): string => `https://www.openslr.org/resources/${number}/${name}`;

describe("the openslr-slr55-corpus recipe", () => {
  it("reads each class's text file of the training and test downloads as a document, though the downloads are plain tar archives under a .tgz name", async () => {
    const fetch = serving({
      [download("55", "train.tgz")]: tar([
        { path: "tech.train", text: "第一 句\n第二 句\n" },
        { path: "sport.train", text: "体育 新闻\n" },
      ]),
      [download("55", "test.tgz")]: tar([{ path: "tech.test", text: "测试 句子\n" }]),
    });
    const { data } = await fetchEntry(getDataset("openslr-slr55-corpus"), { fetch });
    expect(data).toMatchObject({
      instances: [
        { id: "train.tgz", nodes: [{ id: "sport", text: "体育 新闻\n" }, { id: "tech", text: "第一 句\n第二 句\n" }] },
        { id: "test.tgz", nodes: [{ id: "tech", text: "测试 句子\n" }] },
      ],
    });
  });
});

describe("the openslr-slr153-corpus recipe", () => {
  it("reads each .docx and .doc file of the archive as a document named by its path beneath the top directory, leaving the other files out", async () => {
    const fetch = serving({
      [download("153", "data_evnmag.tgz")]: gzip(
        tar([
          { path: "data_evnmag/", text: "", type: "5" },
          { path: "data_evnmag/.DS_Store", text: "junk" },
          { path: "data_evnmag/evnmag1/Բովանդակություն.docx", bytes: docx('<w:p><w:r><w:t>Առաջին</w:t></w:r></w:p><w:p><w:r><w:t>Երկրորդ</w:t></w:r></w:p>') },
          { path: "data_evnmag/evnmag2/old article.doc", bytes: wordDoc([{ text: "Հին\r", compressed: false }]) },
        ]),
      ),
    });
    const { data } = await fetchEntry(getDataset("openslr-slr153-corpus"), { fetch });
    expect(data).toMatchObject({
      nodes: [
        { id: "evnmag1/Բովանդակություն", text: "Առաջին\nԵրկրորդ" },
        { id: "evnmag2/old article", text: "Հին\n" },
      ],
    });
  });
});
