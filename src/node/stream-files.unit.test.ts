import { createHash } from "node:crypto";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createCatalogue, type Dataset } from "../catalogue";
import { parseEntry } from "../entry";
import { CatalogueSyntaxError, RecipeError } from "../errors";
import { tar } from "../test-support/archives";
import { fixtureIndex, streamedCorpusEntry } from "../test-support/entries";
import { fetchEntry, fileStore, roundTripEntry, streamEntry, type FetchPort, type NodeSink, type StreamedNode } from "./fetch-dataset";

const now = (): Date => new Date("2026-10-31T12:00:00.000Z");
const datasetWith = (entry: unknown): Dataset => createCatalogue({ ...fixtureIndex, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the fixture catalogue lists its one entry");
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The library's texts as its tar holds them: not in path order, beside a file the selector leaves out, each kept exactly as written. */
const texts = [
  { path: "texts/20.txt", text: "Second by number,\r\nfirst in the tar.\r\n" },
  { path: "texts/readme.md", text: "not a text" },
  { path: "texts/3.txt", text: "  Leading and trailing space  \n\n" },
  { path: "texts/7.txt", text: "" },
];
/** The texts the selector chooses, in the tar's order. */
const chosen = texts.filter((file) => file.path.endsWith(".txt"));
const idOf = (path: string): string => /([0-9]+)\.txt$/.exec(path)?.[1] ?? expect.unreachable("every chosen text is numbered");

/**
 * The library's download: a zip holding the tar, beside a file the recipe does not read.
 * @param files - The tar's members.
 * @returns The zip.
 */
const download = (files: readonly { readonly path: string; readonly text: string }[]): Uint8Array => zipSync({ "texts.tar": tar(files), "about.txt": encode("about the feed") });

/** A port that answers the availability API with no capture and serves the download for the live URL, and the URLs it has been asked for. */
function serving(body: Uint8Array): { readonly port: FetchPort; readonly asked: readonly string[] } {
  const asked: string[] = [];

  return {
    asked,
    port: async (url) => {
      asked.push(url);
      if (url.startsWith("https://archive.org/wayback/available")) {
        return Promise.resolve(new Response(JSON.stringify({ archived_snapshots: {} })));
      }

      return Promise.resolve(new Response(body));
    },
  };
}

/** A sink that collects what it is handed, each call as one page. */
function collecting(): { readonly pages: (readonly StreamedNode[])[]; readonly metas: Readonly<Record<string, unknown>>[]; readonly sink: NodeSink } {
  const pages: (readonly StreamedNode[])[] = [];
  const metas: Readonly<Record<string, unknown>>[] = [];

  return {
    pages,
    metas,
    sink: {
      meta: (meta) => {
        metas.push(meta);
      },
      nodes: (nodes) => {
        pages.push(nodes);
      },
    },
  };
}

async function failure(run: Readonly<Promise<unknown>>): Promise<RecipeError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RecipeError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a RecipeError");
}

describe("streamEntry on a files archive", () => {
  it("hands on the meta and then each text as its own page, in the tar's order, each exactly as the file holds it", async () => {
    const { pages, metas, sink } = collecting();
    const bytes = download(texts);
    const streamed = await streamEntry(datasetWith(streamedCorpusEntry), sink, { fetch: serving(bytes).port, now });
    expect(metas).toEqual([{ id: "library-texts", name: "Library texts" }]);
    expect(pages).toEqual(chosen.map((file) => [{ id: idOf(file.path), text: file.text }]));
    expect(streamed.counts).toEqual(new Map([["nodes", chosen.length]]));
    expect(streamed.provenance).toMatchObject({
      entryId: "library-texts",
      category: "corpus/v1",
      fetchedUrl: streamedCorpusEntry.sources[0].url,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
      members: chosen.map((file) => `texts.tar/${file.path}`),
    });
  });

  it("downloads the source once, whole, and never by ranges, even a zip the store would read by ranges", async () => {
    const bytes = download(texts);
    const server = serving(bytes);
    const ranging: FetchPort = async (url, init) => {
      const answer = await server.port(url, init);

      return init.range === undefined && url === streamedCorpusEntry.sources[0].url ? new Response(answer.body, { headers: { "accept-ranges": "bytes", "content-length": String(bytes.length) } }) : answer;
    };
    const { pages, sink } = collecting();
    await streamEntry(datasetWith(streamedCorpusEntry), sink, { fetch: ranging, store: fileStore({ rangedMinBytes: 1 }), now });
    expect(server.asked.filter((url) => url === streamedCorpusEntry.sources[0].url)).toHaveLength(1);
    expect(pages.flat()).toHaveLength(chosen.length);
  });

  it("warns when the count differs from the one the entry records", async () => {
    const recorded = { ...streamedCorpusEntry, expectedCounts: { nodes: chosen.length + 1 } };
    const streamed = await streamEntry(datasetWith(recorded), collecting().sink, { fetch: serving(download(texts)).port, now });
    expect(streamed.warnings).toEqual([`nodes: the entry records ${String(chosen.length + 1)}, the fetched result has ${String(chosen.length)}`]);
  });

  it("fails at the parse step on a text that is not valid in the stated encoding, naming the file, after handing on the texts before it", async () => {
    // "café" in ISO-8859-1, whose lone byte for the accented letter is not UTF-8.
    const latin1 = zipSync({ "texts.tar": tar([{ path: "texts/20.txt", text: "fine" }, { path: "texts/21.txt", bytes: new Uint8Array(Buffer.from("café", "latin1")) }]) });
    const { pages, sink } = collecting();
    const error = await failure(streamEntry(datasetWith(streamedCorpusEntry), sink, { fetch: serving(latin1).port, now }));
    expect(error.step).toBe("parse");
    expect(error.message).toMatch(/texts\.tar\/texts\/21\.txt/);
    expect(pages).toEqual([[{ id: "20", text: "fine" }]]);
  });

  it("fails at the validate step on an id two files give, and at the extract step when nothing matches", async () => {
    const repeated = { ...streamedCorpusEntry, recipe: { ...streamedCorpusEntry.recipe, parser: { ...streamedCorpusEntry.recipe.parser, idPattern: "texts\\.tar/texts/[0-9]*([0-9])\\.txt" } } };
    const twice = await failure(streamEntry(datasetWith(repeated), collecting().sink, { fetch: serving(download([...chosen, { path: "texts/30.txt", text: "again" }])).port, now }));
    expect(twice.step).toBe("validate");
    expect(twice.message).toMatch(/duplicate node id "0"/);
    const none = await failure(streamEntry(datasetWith(streamedCorpusEntry), collecting().sink, { fetch: serving(download([{ path: "texts/readme.md", text: "no texts" }])).port, now }));
    expect(none.step).toBe("extract");
    expect(none.message).toMatch(/member texts\.tar: expected at least one member matching/);
  });

  it("is refused by fetchEntry, which names streamDataset, before any request", async () => {
    const server = serving(download(texts));
    const held = await failure(fetchEntry(datasetWith(streamedCorpusEntry), { fetch: server.port, now }));
    expect(held.step).toBe("recipe");
    expect(held.message).toMatch(/streamDataset/);
    expect(server.asked).toEqual([]);
  });

  it("gives what the same recipe gives held whole, when the archive is small enough to hold", async () => {
    const bytes = download(texts);
    const { pages, sink } = collecting();
    await streamEntry(datasetWith(streamedCorpusEntry), sink, { fetch: serving(bytes).port, now });
    const heldRecipe = Object.fromEntries(Object.entries(streamedCorpusEntry.recipe).filter(([key]) => key !== "stream"));
    const held = await fetchEntry(datasetWith({ ...streamedCorpusEntry, recipe: heldRecipe }), { fetch: serving(bytes).port, now });
    const byId = (left: StreamedNode, right: StreamedNode): number => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    expect("nodes" in held.data ? held.data.nodes : undefined).toEqual(pages.flat().sort(byId));
  });
});

describe("roundTripEntry on a streamed files archive", () => {
  it("holds on every text and counts them, from one download", async () => {
    const server = serving(download(texts));
    const report = await roundTripEntry(datasetWith(streamedCorpusEntry), { fetch: server.port, now });
    expect(report).toMatchObject({ holds: true, counts: new Map([["nodes", chosen.length]]) });
    expect(server.asked.filter((url) => url === streamedCorpusEntry.sources[0].url)).toHaveLength(1);
  });
});

describe("a streamed files recipe in the entry schema", () => {
  const issues = (entry: unknown): readonly string[] => {
    try {
      parseEntry(entry);

      return [];
    } catch (error) {
      if (error instanceof CatalogueSyntaxError) {
        return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
      }
      throw error;
    }
  };

  it("is a files archive with no paging, read by a parser that reads each file into one row", () => {
    expect(issues(streamedCorpusEntry)).toEqual([]);
    const textGrids = { ...streamedCorpusEntry, recipe: { ...streamedCorpusEntry.recipe, parser: { format: "textgrid", encoding: "utf-8", idPattern: "texts\\.tar/texts/([0-9]+)\\.txt" } } };
    expect(issues(textGrids)).toEqual([expect.stringMatching(/^recipe\.stream: a streamed recipe reads .* or a files archive with no paging through a parser that reads each file into one row \(member-text\)/)]);
    const paged = { ...streamedCorpusEntry, recipe: { ...streamedCorpusEntry.recipe, paging: { kind: "ckan-datastore", pageSize: 2 } } };
    expect(issues(paged)).toEqual([expect.stringMatching(/^recipe\.stream:/)]);
  });
});
