import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { bzip2, gzip, tar, type ArchiveFile } from "../test-support/archives";
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

  it("reads LibriTTS-R from its archives, whose members carry no leading ./", async () => {
    const fetch = serveEntry("openslr-slr141-transcripts", (url) => gzip(tar(chapter("LibriTTS_R", stem(url).replaceAll("_", "-")))));
    const { data } = await fetchEntry(getDataset("openslr-slr141-transcripts"), { fetch });
    expect(Object.keys(shape(data))).toEqual(["dev_clean.tar.gz", "dev_other.tar.gz", "test_clean.tar.gz", "test_other.tar.gz", "train_clean_100.tar.gz", "train_clean_360.tar.gz", "train_other_500.tar.gz"]);
    expect(Object.values(shape(data))[0]).toEqual(["3081_166546_000028_000002", "3081_166546_000070_000000", "7561_258992_000014_000005"]);
    validates("openslr-slr141-transcripts");
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

describe("the openslr-slr94-transcripts recipe", () => {
  it("joins each language's training, development and test transcripts into one instance, leaving out the audio and the metainfo", async () => {
    const fetch = serveEntry("openslr-slr94-transcripts", (url) => {
      const root = stem(url);

      return gzip(
        tar([
          { path: `${root}/metainfo.txt`, text: "speaker|gender" },
          { path: `${root}/train/audio/10900/6473/10900_6473_000094.opus`, text: "audio" },
          { path: `${root}/train/transcripts.txt`, text: "10900_6473_000094\tznowu się duch z ciałem\n" },
          { path: `${root}/dev/transcripts.txt`, text: "11295_11059_000000\tjuż u źwierzyńca\n11295_11059_000001\tdalej tam były przestrogi" },
          { path: `${root}/test/transcripts.txt`, text: "2_3_000000\tto jest test\n" },
        ]),
      );
    });
    const { data } = await fetchEntry(getDataset("openslr-slr94-transcripts"), { fetch });
    expect(Object.keys(shape(data))).toEqual(["mls_dutch_opus.tar.gz", "mls_french_opus.tar.gz", "mls_german_opus.tar.gz", "mls_italian_opus.tar.gz", "mls_polish_opus.tar.gz", "mls_portuguese_opus.tar.gz", "mls_spanish_opus.tar.gz"]);
    expect(Object.values(shape(data))[0]).toEqual(["11295_11059_000000", "11295_11059_000001", "2_3_000000", "10900_6473_000094"]);
    expect(nodesOf(data, 0)).toMatchObject([{ id: "11295_11059_000000", text: "już u źwierzyńca" }, {}, {}, {}]);
    validates("openslr-slr94-transcripts");
  });
});

describe("the openslr-slr129-transcripts recipe", () => {
  it("reads each language's archive as one instance, each verse named by its transcript file, leaving out the audio", async () => {
    const fetch = serveEntry("openslr-slr129-transcripts", (url) => {
      const language = stem(url);

      return gzip(
        tar([
          { path: language, text: "", type: "5" },
          { path: `${language}/dev/EZR/EZR_002_Verse_000.flac`, text: "audio" },
          { path: `${language}/dev/EZR/EZR_002_Verse_000.txt`, text: "Anatoti jẹ́ méjìdínlááàdóje (128)\n" },
          { path: `${language}/train/GEN/GEN_001_Verse_001.txt`, text: "Ní àtètèkọ́ṣe" },
          { path: `${language}/README.txt`, text: "readme" },
        ]),
      );
    });
    const { data } = await fetchEntry(getDataset("openslr-slr129-transcripts"), { fetch });
    expect(Object.keys(shape(data))).toEqual(["akuapem-twi.tgz", "asante-twi.tgz", "ewe.tgz", "hausa.tgz", "lingala.tgz", "yoruba.tgz"]);
    expect(Object.values(shape(data))[0]).toEqual(["EZR_002_Verse_000", "GEN_001_Verse_001"]);
    expect(nodesOf(data, 0)).toMatchObject([{ text: "Anatoti jẹ́ méjìdínlááàdóje (128)" }, { text: "Ní àtètèkọ́ṣe" }]);
    validates("openslr-slr129-transcripts");
  });
});

/** The split tables (`dev.csv` and `train.csv`) each CML-TTS language archive holds in the fixture. */
const SPLITS_IN_FIXTURE = 2;

describe("the openslr-slr146-transcripts recipe", () => {
  it("reads each split's pipe-separated table of each language archive as an instance, its text and speaker on the audio file's name", async () => {
    const fetch = serveEntry("openslr-slr146-transcripts", (url) => {
      const root = stem(url);

      return bzip2(
        tar([
          { path: `${root}/dev/audio/11295/11059/11295_11059_000051.wav`, text: "audio" },
          { path: `${root}/dev.csv`, text: "wav_filename|wav_filesize|transcript|transcript_wav2vec|levenshtein|duration|num_words|client_id\ndev/audio/11295/11059/11295_11059_000051.wav|601964|Proszę pana, tu pano|prosze pana tu pano|0.96|13.6|4|11295\n" },
          { path: `${root}/train.csv`, text: "wav_filename|wav_filesize|transcript|transcript_wav2vec|levenshtein|duration|num_words|client_id\ntrain/audio/6892/8912/6892_8912_000729.wav|601964|Dzień dobry|dzien dobry|0.99|2.1|2|6892\n" },
        ]),
      );
    });
    const { data } = await fetchEntry(getDataset("openslr-slr146-transcripts"), { fetch });
    expect(Object.keys(shape(data)).slice(0, 2)).toEqual(["cml_tts_dataset_dutch_v0.1.tar.bz/cml_tts_dataset_dutch_v0.1/dev.csv", "cml_tts_dataset_dutch_v0.1.tar.bz/cml_tts_dataset_dutch_v0.1/train.csv"]);
    expect(Object.keys(shape(data))).toHaveLength(getDataset("openslr-slr146-transcripts").entry.sources.length * SPLITS_IN_FIXTURE);
    expect(nodesOf(data, 0)).toMatchObject([{ id: "dev/audio/11295/11059/11295_11059_000051.wav", text: "Proszę pana, tu pano", speaker: "11295" }]);
    expect(nodesOf(data, 1)).toMatchObject([{ id: "train/audio/6892/8912/6892_8912_000729.wav", text: "Dzień dobry", speaker: "6892" }]);
    validates("openslr-slr146-transcripts");
  });
});

describe("the openslr-slr100-transcripts recipe", () => {
  it("reads each monolingual archive's splits as one instance of segments, leaving out the audio and the subtitles", async () => {
    const fetch = serveEntry("openslr-slr100-transcripts", (url) => {
      const language = stem(url).replace("mtedx_", "");
      const root = `${language}-${language}/data`;
      const segments = (talk: string): string => `${talk}_0000 ${talk} 10.94 19.67\n${talk}_0001 ${talk} 21.41 24.31\n`;
      const yaml = (talk: string): string => `- {duration: 8.730000000000002, offset: 10.94, speaker_id: ${talk}, wav: ${talk}.wav}\n- {duration: 2.8999999999999986, offset: 21.41, speaker_id: ${talk}, wav: ${talk}.wav}\n`;

      return gzip(
        tar([
          { path: `${language}-${language}/docs/README`, text: "readme" },
          { path: `${root}/train/txt/segments`, text: segments("009AJ_5hPZ4") },
          { path: `${root}/train/txt/train.yaml`, text: yaml("009AJ_5hPZ4") },
          { path: `${root}/train/txt/train.${language}`, text: "(Applaus) Ich spreche heute hier &amp; dort.\nWir genießen es jeden Tag.\n" },
          { path: `${root}/train/vtt/009AJ_5hPZ4.${language}.vtt`, text: "WEBVTT" },
          { path: `${root}/train/wav/009AJ_5hPZ4.flac`, text: "audio" },
          { path: `${root}/valid/txt/valid.${language}`, text: "Ja.\n\n" },
          { path: `${root}/valid/txt/valid.yaml`, text: yaml("O7KrwO3pVZ8") },
          { path: `${root}/valid/txt/segments`, text: segments("O7KrwO3pVZ8") },
        ]),
      );
    });
    const { data } = await fetchEntry(getDataset("openslr-slr100-transcripts"), { fetch });
    expect(Object.keys(shape(data))).toEqual(["mtedx_es.tgz", "mtedx_fr.tgz", "mtedx_pt.tgz", "mtedx_it.tgz", "mtedx_ru.tgz", "mtedx_el.tgz", "mtedx_ar.tgz", "mtedx_de.tgz"]);
    expect(Object.values(shape(data))[0]).toEqual(["009AJ_5hPZ4_0000", "009AJ_5hPZ4_0001", "O7KrwO3pVZ8_0000", "O7KrwO3pVZ8_0001"]);
    expect(nodesOf(data, 0)).toMatchObject([
      { id: "009AJ_5hPZ4_0000", text: "(Applaus) Ich spreche heute hier &amp; dort.", speaker: "009AJ_5hPZ4", audio: "009AJ_5hPZ4.wav", start: 10.94, end: 19.67, duration: 8.730000000000002, split: "train", language: "es" },
      {},
      { text: "Ja.", split: "valid" },
      { text: null },
    ]);
    validates("openslr-slr100-transcripts");
  });
});
