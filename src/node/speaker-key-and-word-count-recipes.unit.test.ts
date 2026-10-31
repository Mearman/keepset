import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar } from "../test-support/archives";
import { fetchEntry, type FetchPort } from "./fetch-dataset";

const serving = (body: Uint8Array | string): FetchPort => async () => Promise.resolve(new Response(body));

/** The comment lines that head the LRE 2007 key before its first segment, each starting with a hash. */
const LRE_COMMENT_LINES = 57;

/** The 30 tab-separated fields of one LRE 2007 key line, with the fields the test sets and `n/a` in the rest. */
function lreLine(fields: Readonly<Record<number, string>>): string {
  return Array.from({ length: 30 }, (_, index) => fields[index] ?? "n/a").join("\t");
}

describe("the openslr-slr23-key recipe", () => {
  const lre = [
    ...Array.from({ length: LRE_COMMENT_LINES }, (_, index) => `# comment ${String(index)}`),
    lreLine({ 0: "a62271", 1: "french", 2: "fr_5110", 3: "a", 8: "f", 29: "both" }),
    lreLine({ 0: "a56433", 1: "hindustani.hindi", 7: "104825", 8: "m", 10: "33", 14: '"ine, hin"', 18: " punjab", 29: "sys_only" }),
    "",
  ].join("\n");

  it("skips the comment header, reads a quoted field holding a comma, and makes n/a a missing value", async () => {
    const { data } = await fetchEntry(getDataset("openslr-slr23-key"), { fetch: serving(new Uint8Array(Buffer.from(lre, "latin1"))) });
    expect(data).toMatchObject({
      nodes: [
        { id: "a62271", language: "french", gender: "f", name: null, file: "fr_5110", chan: "a", age: null, second_lang: null, type: "both" },
        { id: "a56433", language: "hindustani.hindi", gender: "m", name: "104825", age: "33", second_lang: "ine, hin", state_born: "punjab", type: "sys_only" },
      ],
    });
  });

  it("reads a byte above 0x7F in the file's own latin1 encoding", async () => {
    const text = lre.replace("a62271\tfrench", "a62271\tfrançais");
    const { data } = await fetchEntry(getDataset("openslr-slr23-key"), { fetch: serving(new Uint8Array(Buffer.from(text, "latin1"))) });
    expect(data).toMatchObject({ nodes: [{ id: "a62271", language: "français" }, {}] });
  });
});

describe("the openslr-slr10-keys recipe", () => {
  const key = "xaaa E 11595 X1 1c 4598 M 320 dial=R - -\r\nxaaa E 11595 X2 1c 2646 F 320 nontar - -\r\nxaab E 10449 B 1s 6768 F 320 dial=E handset cordless_phone\r\n";

  it("reads the space-separated key from its gzip file, a segment listed once for each true speaker, and a dash as a missing value", async () => {
    const { data } = await fetchEntry(getDataset("openslr-slr10-keys"), { fetch: serving(gzip(key)) });
    expect(data).toMatchObject({
      nodes: [
        { id: "1", segment: "xaaa", channel: "X1", name: "4598", gender: "M", language: "E", dialect: "dial=R", microphone: null, phone: null },
        { id: "2", segment: "xaaa", channel: "X2", name: "2646", gender: "F", dialect: "nontar" },
        { id: "3", segment: "xaab", channel: "B", name: "6768", segment_type: "1s", microphone: "handset", phone: "cordless_phone" },
      ],
    });
  });
});

describe("the openslr-slr21-lexicon recipe", () => {
  it("reads the word list from its one JSON member, keeping each word's count and the order the file writes", async () => {
    const wordlist = tar([{ path: "es_wordlist.json", text: '{"bloqueos": 11265, "287145": 1, "asust\\u00e1s": 2}' }]);
    const { data } = await fetchEntry(getDataset("openslr-slr21-lexicon"), { fetch: serving(gzip(wordlist)) });
    expect(data).toMatchObject({
      nodes: [
        { id: "bloqueos", word: "bloqueos", count: 11265 },
        { id: "287145", word: "287145", count: 1 },
        { id: "asustás", word: "asustás", count: 2 },
      ],
    });
  });
});
