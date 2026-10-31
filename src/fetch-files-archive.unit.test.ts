import { describe, expect, it } from "vitest";
import { createCatalogue } from "./catalogue";
import { fetchEntry, type FetchPort } from "./fetch";
import { fileStore } from "./node/file-store";
import { gzip, tar } from "./test-support/archives";
import { fixtureIndex } from "./test-support/entries";

const SOURCE = "https://example.org/data/subset.tar.gz";

/** The crosswalk that carries each utterance's id and text, as catalogue/crosswalks/speech-v1/utterance-lines.json holds it. */
const crosswalk = {
  source: "utterance-lines",
  target: "speech/v1",
  rules: [
    { op: "move", from: "meta", to: "meta" },
    { op: "move", from: "nodes[].id", to: "nodes[].id" },
    { op: "move", from: "nodes[].text", to: "nodes[].text" },
  ],
  oneWay: [],
};

const entry = (archive: unknown): unknown => ({
  id: "chapters",
  name: "Chapters",
  tags: [],
  category: "speech/v1",
  sources: [{ url: SOURCE, retrieved: "2026-10-31", status: "live" }],
  licence: { kind: "unrecorded" },
  citations: [],
  recipe: { status: "fetchable", source: 0, archive, parser: { format: "utterance-lines", encoding: "utf-8" } },
  crosswalk,
  expectedCounts: {},
  properties: {},
});

const serving = (body: Uint8Array): FetchPort => async () => Promise.resolve(new Response(body));

const subset = gzip(
  tar([
    { path: "Subset/README.TXT", text: "not a transcript" },
    { path: "Subset/2/1/2-1.trans.txt", text: "2-1-0000 TWO ONE ZERO\n2-1-0001 TWO ONE ONE" },
    { path: "Subset/1/1/1-1.trans.txt", text: "1-1-0000 ONE ONE ZERO\n" },
    { path: "Subset/1/1/1-1.flac", text: "audio" },
  ]),
);

describe("a files archive that concatenates its files", () => {
  const select = { kind: "tar.gz", files: { pattern: "Subset/\\d+/\\d+/\\d+-\\d+\\.trans\\.txt" }, concatenate: true };
  const dataset = (archive: unknown) => createCatalogue({ ...fixtureIndex, entries: [entry(archive)] }).listDatasets()[0] ?? expect.unreachable("the fixture catalogue lists its one entry");

  it("reads the matched files, in path order, as the one file the parser takes, a file without a final line break not running into the next", async () => {
    const fetched = await fetchEntry(dataset(select), { store: fileStore(), fetch: serving(subset) });
    expect(fetched.data).toEqual({
      meta: { id: "chapters", name: "Chapters" },
      nodes: [
        { id: "1-1-0000", text: "ONE ONE ZERO" },
        { id: "2-1-0000", text: "TWO ONE ZERO" },
        { id: "2-1-0001", text: "TWO ONE ONE" },
      ],
    });
    expect("members" in fetched.provenance ? fetched.provenance.members : []).toEqual(["Subset/1/1/1-1.trans.txt", "Subset/2/1/2-1.trans.txt"]);
  });

  it("is one instance for each download of a files recipe, named by the file's path", async () => {
    const collection = createCatalogue({
      ...fixtureIndex,
      entries: [{ ...(entry(select) as object), recipe: { status: "fetchable", files: [{ path: "subset", source: 0, archive: select }], parser: { format: "utterance-lines", encoding: "utf-8" } } }],
    }).listDatasets()[0];
    const fetched = await fetchEntry(collection ?? expect.unreachable("the fixture catalogue lists its one entry"), { store: fileStore(), fetch: serving(subset) });
    expect(fetched.data).toMatchObject({ instances: [{ id: "subset", nodes: [{ id: "1-1-0000" }, { id: "2-1-0000" }, { id: "2-1-0001" }] }] });
  });
});
