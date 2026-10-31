import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar, type ArchiveFile } from "../test-support/archives";
import { validateDataset } from "../validate";
import { fetchEntry, type FetchPort } from "./fetch-dataset";

/** The archives a stand-in network serves, by URL: any other URL answers 404, so a recipe that asks for a download it should not make fails. */
function serving(archives: Readonly<Record<string, Uint8Array>>): FetchPort {
  return async (url) => {
    const body = Object.hasOwn(archives, url) ? archives[url] : undefined;

    return Promise.resolve(body === undefined ? new Response("missing", { status: 404, statusText: "Not Found" }) : new Response(body));
  };
}

/** Serves one archive for every source of the entry, each given the files `files` builds for the source's URL. */
function serveEntry(id: string, archive: (url: string, index: number) => Uint8Array): FetchPort {
  const sources = getDataset(id).entry.sources;

  return serving(Object.fromEntries(sources.map((source, index) => [source.url, archive(source.url, index)])));
}

const stem = (url: string): string => url.slice(url.lastIndexOf("/") + 1).replace(/\.(?:tar\.gz|tgz|tar\.bz)$/, "");

/** The collection a fetch resolved to, as its instances' ids and the ids of each instance's utterances. */
function shape(data: unknown): Record<string, string[]> {
  if (typeof data !== "object" || data === null || !("instances" in data) || !Array.isArray(data.instances)) {
    return expect.unreachable("the result is a collection");
  }

  return Object.fromEntries(
    data.instances.map((instance: unknown) => {
      if (typeof instance !== "object" || instance === null || !("id" in instance) || typeof instance.id !== "string" || !("nodes" in instance) || !Array.isArray(instance.nodes)) {
        return expect.unreachable("an instance has an id and nodes");
      }

      return [instance.id, instance.nodes.map((node: unknown) => (typeof node === "object" && node !== null && "id" in node && typeof node.id === "string" ? node.id : expect.unreachable("a node has an id")))];
    }),
  );
}

/** The utterances of the collection's instance at `index`, in order. */
function nodesOf(data: unknown, index: number): unknown[] {
  if (typeof data !== "object" || data === null || !("instances" in data) || !Array.isArray(data.instances)) {
    return expect.unreachable("the result is a collection");
  }
  const instance: unknown = data.instances[index];
  if (typeof instance !== "object" || instance === null || !("nodes" in instance) || !Array.isArray(instance.nodes)) {
    return expect.unreachable("the instance has nodes");
  }

  return instance.nodes;
}

const validates = (id: string): void => {
  expect(validateDataset(getDataset(id))).toEqual([]);
};

describe("the openslr-slr12-transcripts recipe", () => {
  const subsets = ["dev-clean", "dev-other", "test-clean", "test-other", "train-clean-100", "train-clean-360", "train-other-500"];

  it("reads each subset archive as one instance, joining its chapters' transcript files and leaving out the metadata and audio", async () => {
    const fetch = serveEntry("openslr-slr12-transcripts", (url) => {
      const subset = stem(url);

      return gzip(
        tar([
          { path: "LibriSpeech/LICENSE.TXT", text: "licence" },
          { path: "LibriSpeech/SPEAKERS.TXT", text: "; speakers" },
          { path: `LibriSpeech/${subset}/84/121123/84-121123-0000.flac`, text: "audio" },
          { path: `LibriSpeech/${subset}/84/121123/84-121123.trans.txt`, text: `84-121123-0000 GO DO YOU HEAR\n84-121123-0001 BUT IN LESS THAN FIVE MINUTES` },
          { path: `LibriSpeech/${subset}/2277/149896/2277-149896.trans.txt`, text: `2277-149896-0000 HE WAS IN A FEVERED STATE\n` },
        ]),
      );
    });
    const { data } = await fetchEntry(getDataset("openslr-slr12-transcripts"), { fetch });
    expect(shape(data)).toEqual(Object.fromEntries(subsets.map((subset) => [`${subset}.tar.gz`, ["2277-149896-0000", "84-121123-0000", "84-121123-0001"]])));
    expect(nodesOf(data, 0)).toMatchObject([{ id: "2277-149896-0000", text: "HE WAS IN A FEVERED STATE" }, { text: "GO DO YOU HEAR" }, { text: "BUT IN LESS THAN FIVE MINUTES" }]);
    validates("openslr-slr12-transcripts");
  });
});

describe("the openslr-slr40-transcripts recipe", () => {
  it("joins the transcript files of the training and test data into one document, leaving out the speaker table and the audio", async () => {
    const archive = gzip(
      tar([
        { path: "AUDIO_INFO", text: "SPEAKERID|NAME|SEX|SCRIPTID|DATASET\n104|BaekGeonJong|m|003|test_data_01\n" },
        { path: "test_data_01/003/149/149_003_0057.flac", text: "audio" },
        { path: "test_data_01/003/149/149_003.trans.txt", text: "149_003_0057 이 일 자동차업계에 따르면\n149_003_0164 우리는 위기의 진앙이 아닌" },
        { path: "train_data_01/002/101/101_002.trans.txt", text: "101_002_0001 안녕하세요\n" },
        { path: "lexicon.txt", text: "word w o r d" },
      ]),
    );
    const { data } = await fetchEntry(getDataset("openslr-slr40-transcripts"), { fetch: serving({ "https://www.openslr.org/resources/40/zeroth_korean.tar.gz": archive }) });
    expect(data).toMatchObject({
      nodes: [
        { id: "149_003_0057", text: "이 일 자동차업계에 따르면" },
        { id: "149_003_0164", text: "우리는 위기의 진앙이 아닌" },
        { id: "101_002_0001", text: "안녕하세요" },
      ],
    });
    validates("openslr-slr40-transcripts");
  });
});

describe("the LibriTTS recipes", () => {
  /** A chapter's transcript table as the corpus writes it: no header, tab separated, with double quotes in the text. */
  const chapter = (root: string, subset: string): ArchiveFile[] => [
    { path: `${root}/${subset}/3081/166546/3081_166546.trans.tsv`, text: '3081_166546_000028_000002\tHow quickly he disappeared!"\tHow quickly he disappeared!"\n3081_166546_000070_000000\t"So they tell me."\t"So they tell me."\n' },
    { path: `${root}/${subset}/3081/166546/3081_166546.book.tsv`, text: "3081_166546_000028_000002\tbook\tbook\ttrue\t0\t1\t0\n" },
    { path: `${root}/${subset}/3081/166546/3081_166546_000028_000002.original.txt`, text: "per utterance" },
    { path: `${root}/${subset}/3081/166546/3081_166546_000028_000002.wav`, text: "audio" },
    { path: `${root}/${subset}/7561/258992/7561_258992.trans.tsv`, text: "7561_258992_000014_000005\tAll that night we slept.\tAll that night we slept.\n" },
  ];

  it("reads each LibriTTS subset's chapter tables as one instance, with the quotes in the text kept and the book tables and per-utterance files left out", async () => {
    const fetch = serveEntry("openslr-slr60-transcripts", (url) => gzip(tar([{ path: "./LibriTTS", text: "", type: "5" }, ...chapter(`./LibriTTS`, stem(url))])));
    const { data } = await fetchEntry(getDataset("openslr-slr60-transcripts"), { fetch });
    expect(Object.keys(shape(data))).toEqual(["dev-clean.tar.gz", "dev-other.tar.gz", "test-clean.tar.gz", "test-other.tar.gz", "train-clean-100.tar.gz", "train-clean-360.tar.gz", "train-other-500.tar.gz"]);
    expect(Object.values(shape(data))[0]).toEqual(["3081_166546_000028_000002", "3081_166546_000070_000000", "7561_258992_000014_000005"]);
    expect(nodesOf(data, 0)).toMatchObject([{ text: 'How quickly he disappeared!"', normalized_text: 'How quickly he disappeared!"' }, { text: '"So they tell me."' }, { text: "All that night we slept." }]);
    validates("openslr-slr60-transcripts");
  });
});

describe("the IISc-MILE recipes", () => {
  it("reads the Kannada training and test archives as two instances, each utterance named by its transcript file, with the joiner characters in the text kept", async () => {
    const fetch = serveEntry("openslr-slr126-transcripts", (url) => {
      const split = stem(url).replace("mile_kannada_", "");

      return gzip(
        tar([
          { path: split, text: "", type: "5" },
          { path: `${split}/trans_files/MILE_03_SP_3415_UTT_0038.txt`, text: "ಹೈಕಮಾಂಡ್‌ ಯೋಚನೆ" },
          { path: `${split}/trans_files/MILE_03_SP_3413_UTT_0102.txt`, text: "ವಾಸ್ತವ್ಯ ಪರಿಸ್ಥಿತಿ\n" },
          { path: `${split}/audio_files/MILE_03_SP_3415_UTT_0038.wav`, text: "audio" },
        ]),
      );
    });
    const { data } = await fetchEntry(getDataset("openslr-slr126-transcripts"), { fetch });
    expect(shape(data)).toEqual({ "mile_kannada_train.tar.gz": ["MILE_03_SP_3413_UTT_0102", "MILE_03_SP_3415_UTT_0038"], "mile_kannada_test.tar.gz": ["MILE_03_SP_3413_UTT_0102", "MILE_03_SP_3415_UTT_0038"] });
    expect(nodesOf(data, 0)).toMatchObject([{ text: "ವಾಸ್ತವ್ಯ ಪರಿಸ್ಥಿತಿ" }, { text: "ಹೈಕಮಾಂಡ್‌ ಯೋಚನೆ" }]);
    validates("openslr-slr126-transcripts");
  });

  it("reads the one Tamil archive as one document of the training and test utterances", async () => {
    const archive = gzip(
      tar([
        { path: "mile_tamil_asr_corpus/train/trans_files/ISTL_0000547_0000070.txt", text: "போசள பேரரசர்கள்\n" },
        { path: "mile_tamil_asr_corpus/train/audio_files/ISTL_0000547_0000070.wav", text: "audio" },
        { path: "mile_tamil_asr_corpus/test/trans_files/MILE_0000252_0000170.txt", text: "சங்கடம் தருவதாக" },
      ]),
    );
    const { data } = await fetchEntry(getDataset("openslr-slr127-transcripts"), { fetch: serving({ "https://www.openslr.org/resources/127/mile_tamil_asr_corpus.tar.gz": archive }) });
    expect(data).toMatchObject({
      nodes: [
        { id: "MILE_0000252_0000170", text: "சங்கடம் தருவதாக" },
        { id: "ISTL_0000547_0000070", text: "போசள பேரரசர்கள்" },
      ],
    });
    validates("openslr-slr127-transcripts");
  });
});

describe("the openslr-slr59-transcripts recipe", () => {
  it("reads the Sphinx transcription of each archive as one instance, the session, start and end in each id", async () => {
    const fetch = serveEntry("openslr-slr59-transcripts", (url) => {
      const name = stem(url);

      return gzip(
        tar([
          { path: "LICENSE.txt", text: "licence" },
          { path: "README.md", text: "readme" },
          { path: `${name}.transcription`, text: `<s> perquè que el president de catalunya </s> (31ca4d158eaef166c37a_18.87_27.76)\n<s> gràcies presidenta </s> (86f47e90ba09d6076e25_20.51_23.6)\n` },
          { path: `${name}.fileids`, text: "sessions/3/1/31ca4d158eaef166c37a_18.87_27.76\n" },
          { path: "sessions/3/1/31ca4d158eaef166c37a_18.87_27.76.wav", text: "audio" },
        ]),
      );
    });
    const { data } = await fetchEntry(getDataset("openslr-slr59-transcripts"), { fetch });
    expect(shape(data)).toEqual({
      "parlament_v1.0_clean.tar.gz/parlament_v1.0_clean.transcription": ["31ca4d158eaef166c37a_18.87_27.76", "86f47e90ba09d6076e25_20.51_23.6"],
      "parlament_v1.0_other.tar.gz/parlament_v1.0_other.transcription": ["31ca4d158eaef166c37a_18.87_27.76", "86f47e90ba09d6076e25_20.51_23.6"],
    });
    expect(nodesOf(data, 0)).toMatchObject([{ text: "perquè que el president de catalunya" }, { text: "gràcies presidenta" }]);
    validates("openslr-slr59-transcripts");
  });
});
