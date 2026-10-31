import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar, zip } from "../test-support/archives";
import { validateDataset } from "../validate";
import { fetchEntry, type FetchPort } from "./fetch-dataset";

const OPENSLR = "https://www.openslr.org/resources";

/** A network port serving fixed bytes by exact URL, and answering anything else (the Wayback availability lookup included) with 404, so a recipe can only read the sources it names. */
function servedBy(files: Readonly<Record<string, Uint8Array>>): FetchPort {
  return async (url) => {
    const body = Object.hasOwn(files, url) ? files[url] : undefined;

    return Promise.resolve(body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body));
  };
}

/** A gzipped tar archive of the given members, which is what every tgz and tar.gz in these recipes is. */
function tgz(members: Readonly<Record<string, string>>): Uint8Array {
  return gzip(tar(Object.entries(members).map(([path, text]) => ({ path, text }))));
}

/** Fetches the entry through its shipped recipe, after checking the catalogue holds it valid. */
async function fetchShipped(id: string, files: Readonly<Record<string, Uint8Array>>): Promise<unknown> {
  const dataset = getDataset(id);
  expect(validateDataset(dataset)).toEqual([]);
  const { data } = await fetchEntry(dataset, { fetch: servedBy(files) });

  return data;
}

describe("the Aishell transcripts recipe", () => {
  it("reads the transcript file by its path and skips the nested wav archives beside it", async () => {
    const archive = tgz({
      "data_aishell/wav/S0002.tar.gz": "not a transcript",
      "data_aishell/transcript/aishell_transcript_v0.8.txt": "BAC009S0002W0122 而 对 楼市 成交 抑制 作用 最 大 的 限购\nBAC009S0002W0123 也 成为 地方 政府 的 眼中 钉\n",
    });
    const data = await fetchShipped("openslr-slr33-transcripts", { [`${OPENSLR}/33/data_aishell.tgz`]: archive });
    expect(data).toMatchObject({
      nodes: [
        { id: "BAC009S0002W0122", text: "而 对 楼市 成交 抑制 作用 最 大 的 限购" },
        { id: "BAC009S0002W0123", text: "也 成为 地方 政府 的 眼中 钉" },
      ],
    });
  });
});

describe("the MAGICDATA read speech transcripts recipe", () => {
  const trans = (rows: readonly string[]): string => ["UtteranceID\tSpeakerID\tTranscription", ...rows, ""].join("\n");

  it("reads the TRANS.txt of each set's archive as one instance, with the speaker beside the text", async () => {
    const files = {
      [`${OPENSLR}/68/train_set.tar.gz`]: tgz({ "train/TRANS.txt": trans(["14_3892_20170824224913.wav\t14_3892\t打开导航"]), "train/14_3892/14_3892_20170824224913.wav": "RIFF" }),
      [`${OPENSLR}/68/dev_set.tar.gz`]: tgz({ "dev/TRANS.txt": trans(["37_5622_20170913203118.wav\t37_5622\t高德地图", "37_5622_20170913203322.wav\t37_5622\t我想用百度搜索短信"]) }),
      [`${OPENSLR}/68/test_set.tar.gz`]: tgz({ "test/TRANS.txt": trans(["5_1932_20170628221832.wav\t5_1932\t今天天气怎么样"]) }),
    };
    const data = await fetchShipped("openslr-slr68-transcripts", files);
    expect(data).toMatchObject({
      instances: [
        { id: "train_set.tar.gz/train/TRANS.txt", nodes: [{ id: "14_3892_20170824224913.wav", speaker: "14_3892", text: "打开导航" }] },
        {
          id: "dev_set.tar.gz/dev/TRANS.txt",
          nodes: [
            { id: "37_5622_20170913203118.wav", speaker: "37_5622", text: "高德地图" },
            { id: "37_5622_20170913203322.wav", speaker: "37_5622", text: "我想用百度搜索短信" },
          ],
        },
        { id: "test_set.tar.gz/test/TRANS.txt", nodes: [{ id: "5_1932_20170628221832.wav", speaker: "5_1932", text: "今天天气怎么样" }] },
      ],
    });
  });
});

describe("the AISHELL-3 transcripts recipe", () => {
  it("reads the content file of each part, whose lines end in CRLF and whose ids carry the wav suffix", async () => {
    const archive = tgz({
      ChangeLog: "log",
      "spk-info.txt": "SSB1837\tB\tfemale\tnorth\n",
      "test/content.txt": "SSB06930002.wav\t武 wu3 术 shu4 始 shi3\r\nSSB06930007.wav\t使 shi3 自 zi4 己 ji3\r\n",
      "test/wav/SSB0693/SSB06930002.wav": "RIFF",
      "train/content.txt": "SSB00050001.wav\t广 guang3 州 zhou1\r\n",
    });
    const data = await fetchShipped("openslr-slr93-transcripts", { [`${OPENSLR}/93/data_aishell3.tgz`]: archive });
    expect(data).toMatchObject({
      instances: [
        {
          id: "test/content.txt",
          nodes: [
            { id: "SSB06930002.wav", text: "武 wu3 术 shu4 始 shi3" },
            { id: "SSB06930007.wav", text: "使 shi3 自 zi4 己 ji3" },
          ],
        },
        { id: "train/content.txt", nodes: [{ id: "SSB00050001.wav", text: "广 guang3 州 zhou1" }] },
      ],
    });
  });
});

describe("the MAGICDATA conversational transcripts recipe", () => {
  it("reads each conversation's tab-separated file whose member path starts with ./, numbering its lines and keeping the span, speaker and dialect field", async () => {
    const archive = tgz({
      "./MDT2021S003/SPKINFO.txt": "CHANNEL\tSPEAKER_ID\tGENDER\tAGE\tREGION,CITY\tDEVICE\nC0\tG00000016\tM\tMiddle-aged and young people\tSichuan\tMobile phone\n",
      "./MDT2021S003/TXT/CTS-CN-F2F-2019-11-15-101.txt": '[1.319,6.691]\tG00000140\t女,普通话\t爱数智慧语音采集二零一九年十一月六日\n[8.106,12.713]\tG00000140\t女,普通话\t最近最近那个新海诚的啊，那个 "嗯"\n',
      "./MDT2021S003/WAV/CTS-CN-F2F-2019-11-15-101.wav": "RIFF",
    });
    const data = await fetchShipped("openslr-slr123-transcripts", { [`${OPENSLR}/123/MagicData-RAMC.tar.gz`]: archive });
    expect(data).toMatchObject({
      instances: [
        {
          id: "./MDT2021S003/TXT/CTS-CN-F2F-2019-11-15-101.txt",
          nodes: [
            { id: "1", span: "[1.319,6.691]", speaker: "G00000140", gender_dialect: "女,普通话", text: "爱数智慧语音采集二零一九年十一月六日" },
            { id: "2", span: "[8.106,12.713]", speaker: "G00000140", gender_dialect: "女,普通话", text: '最近最近那个新海诚的啊，那个 "嗯"' },
          ],
        },
      ],
    });
  });
});

describe("the MUCS 2021 sub-task 1 transcripts recipe", () => {
  it("reads the transcription file of each language's training and test archive as its own instance", async () => {
    const files: Record<string, Uint8Array> = {};
    const lines: Record<string, string> = { Hindi: "01_0003_01_1 बास रीसेट कर", Marathi: "01_0010_01_1 ब्राईटनेस वाढव", Odia: "01_0011_01_1 ଆଲୋକ ବଢ଼ାଅ" };
    for (const [language, line] of Object.entries(lines)) {
      for (const part of ["train", "test"]) {
        files[`${OPENSLR}/103/${language}_${part}.tar.gz`] = tgz({ [`${part}/audio/01_0003_01_1.wav`]: "RIFF", [`${part}/transcription.txt`]: `${line}\n` });
      }
    }
    const data = await fetchShipped("openslr-slr103-transcripts", files);
    expect(data).toMatchObject({
      instances: [
        { id: "Hindi_train.tar.gz/train/transcription.txt", nodes: [{ id: "01_0003_01_1", text: "बास रीसेट कर" }] },
        { id: "Hindi_test.tar.gz/test/transcription.txt", nodes: [{ id: "01_0003_01_1", text: "बास रीसेट कर" }] },
        { id: "Marathi_train.tar.gz/train/transcription.txt", nodes: [{ id: "01_0010_01_1", text: "ब्राईटनेस वाढव" }] },
        { id: "Marathi_test.tar.gz/test/transcription.txt" },
        { id: "Odia_train.tar.gz/train/transcription.txt", nodes: [{ id: "01_0011_01_1", text: "ଆଲୋକ ବଢ଼ାଅ" }] },
        { id: "Odia_test.tar.gz/test/transcription.txt" },
      ],
    });
  });
});

describe("the MUCS 2021 sub-task 2 transcripts recipe", () => {
  it("reads the Kaldi text file of each language pair's archives, leaving the segments file beside it", async () => {
    const files: Record<string, Uint8Array> = {};
    for (const pair of ["Hindi-English", "Bengali-English"]) {
      for (const part of ["train", "test"]) {
        files[`${OPENSLR}/104/${pair}_${part}.tar.gz`] = tgz({
          [`${part}/recording.wav`]: "RIFF",
          [`${part}/transcripts/segments`]: `${pair}_${part}_0001 recording 0.0 4.8\n`,
          [`${part}/transcripts/text`]: `${pair}_${part}_0001 the output of the ls command\n`,
          [`${part}/transcripts/wav.scp`]: "recording recording.wav\n",
        });
      }
    }
    const data = await fetchShipped("openslr-slr104-transcripts", files);
    expect(data).toMatchObject({
      instances: [
        { id: "Hindi-English_train.tar.gz/train/transcripts/text", nodes: [{ id: "Hindi-English_train_0001", text: "the output of the ls command" }] },
        { id: "Hindi-English_test.tar.gz/test/transcripts/text" },
        { id: "Bengali-English_train.tar.gz/train/transcripts/text", nodes: [{ id: "Bengali-English_train_0001", text: "the output of the ls command" }] },
        { id: "Bengali-English_test.tar.gz/test/transcripts/text" },
      ],
    });
  });
});

describe("the Kazakh Speech Corpus transcripts recipe", () => {
  it("reads one record per single-line transcript file, its id the file's name", async () => {
    const archive = tgz({
      "ISSAI_KSC_335RS_v1.1_flac/Audios_flac/5f3192fe9da13.flac": "fLaC",
      "ISSAI_KSC_335RS_v1.1_flac/Meta/train.csv": "5f3192fe9da13 923 M 32 West phone no\n",
      "ISSAI_KSC_335RS_v1.1_flac/Transcriptions/5f3192fe9da13.txt": "мен табақты қолыммен сипалап бір шетіндегі дайын кездікті алып қазының шамасын байқадым\n",
      "ISSAI_KSC_335RS_v1.1_flac/Transcriptions/5ef98259ba9ef.txt": "қауын қарбыз жүзімі де мол екен\n",
    });
    const data = await fetchShipped("openslr-slr102-transcripts", { [`${OPENSLR}/102/ISSAI_KSC_335RS_v1.1_flac.tar.gz`]: archive });
    expect(data).toMatchObject({
      nodes: [
        { id: "5ef98259ba9ef", text: "қауын қарбыз жүзімі де мол екен" },
        { id: "5f3192fe9da13", text: "мен табақты қолыммен сипалап бір шетіндегі дайын кездікті алып қазының шамасын байқадым" },
      ],
    });
  });
});

/** The directories of the Kazakh Speech Dataset, one zip each. */
const KAZAKH_DATASET_ZIPS = ["audio2", "audio3", "audio4", "audio5"];

describe("the Kazakh Speech Dataset transcripts recipe", () => {
  it("reads the JSON array of each zip, whose text begins with a byte order mark, under the audio path as id", async () => {
    const files: Record<string, Uint8Array> = {};
    for (const directory of KAZAKH_DATASET_ZIPS) {
      const records = [{ wav: `dataset/${directory}/21/538_1.wav`, text: `сөйлем ${directory}` }];
      files[`${OPENSLR}/140/${directory}.zip`] = zip([
        { path: `${directory}/train.json`, text: `\uFEFF${JSON.stringify(records)}` },
        { path: `${directory}/21/538_1.wav`, text: "RIFF" },
      ]);
    }
    const data = await fetchShipped("openslr-slr140-transcripts", files);
    expect(data).toMatchObject({
      instances: KAZAKH_DATASET_ZIPS.map((directory) => ({ id: `${directory}.zip/${directory}/train.json`, nodes: [{ id: `dataset/${directory}/21/538_1.wav`, text: `сөйлем ${directory}` }] })),
    });
  });
});

describe("the Hi-Fi TTS transcripts recipe", () => {
  it("reads each reader's manifests as instances, JSON Lines under a .json name, leaving the reader lists beside them", async () => {
    const manifest = (reader: string, kind: string, text: string): string =>
      `${JSON.stringify({ audio_filepath: `audio/${reader}_${kind}/10425/book_0085.flac`, text: text.toLowerCase(), duration: 0.6, text_no_preprocessing: `${text},`, text_normalized: text })}\n`;
    const archive = tgz({
      "hi_fi_tts_v0/LICENSE.txt": "CC BY 4.0",
      "hi_fi_tts_v0/readers_books_clean.txt": "92 book",
      "hi_fi_tts_v0/92_manifest_clean_test.json": manifest("92", "clean", "Which"),
      "hi_fi_tts_v0/6097_manifest_other_train.json": manifest("6097", "other", "He knew"),
      "hi_fi_tts_v0/audio/92_clean/10425/book_0085.flac": "fLaC",
    });
    const data = await fetchShipped("openslr-slr109-transcripts", { [`${OPENSLR}/109/hi_fi_tts_v0.tar.gz`]: archive });
    expect(data).toMatchObject({
      instances: [
        {
          id: "hi_fi_tts_v0/6097_manifest_other_train.json",
          nodes: [{ id: "audio/6097_other/10425/book_0085.flac", text: "he knew", duration: 0.6, text_normalized: "He knew", text_no_preprocessing: "He knew," }],
        },
        { id: "hi_fi_tts_v0/92_manifest_clean_test.json", nodes: [{ id: "audio/92_clean/10425/book_0085.flac", text: "which", duration: 0.6 }] },
      ],
    });
  });
});

/** Durations in seconds of the Golos fixtures, as the manifests write them. */
const CROWD_TEST_SECONDS = 4.9;
const FARFIELD_TEST_SECONDS = 1.696625;
const CROWD_TRAIN_SECONDS = 2.1;

describe("the Golos transcripts recipe", () => {
  it("reads every JSON Lines manifest of the archive, mapping the audio file name to audio", async () => {
    const record = (id: string, text: string, duration: number): string => `${JSON.stringify({ id, audio_filepath: `files/${id}.opus`, text, duration })}\n`;
    const archive = tgz({
      "test_opus/crowd/files/e632f7d39c15e7edfc665b91e6f2071f.opus": "OggS",
      "test_opus/crowd/manifest.jsonl": record("e632f7d39c15e7edfc665b91e6f2071f", "афина воспроизведи музыку впервешку", CROWD_TEST_SECONDS),
      "test_opus/farfield/manifest.jsonl": record("58b586f67f5e634506e215df5996b82e", "джой хватит", FARFIELD_TEST_SECONDS),
      "train_opus/crowd/manifest.jsonl": record("0a1b2c3d4e5f60718293a4b5c6d7e8f9", "включи свет", CROWD_TRAIN_SECONDS),
    });
    const data = await fetchShipped("openslr-slr114-transcripts", { [`${OPENSLR}/114/golos_opus.tar.gz`]: archive });
    expect(data).toMatchObject({
      instances: [
        { id: "test_opus/crowd/manifest.jsonl", nodes: [{ id: "e632f7d39c15e7edfc665b91e6f2071f", text: "афина воспроизведи музыку впервешку", duration: CROWD_TEST_SECONDS, audio: "files/e632f7d39c15e7edfc665b91e6f2071f.opus" }] },
        { id: "test_opus/farfield/manifest.jsonl", nodes: [{ id: "58b586f67f5e634506e215df5996b82e", text: "джой хватит", duration: FARFIELD_TEST_SECONDS }] },
        { id: "train_opus/crowd/manifest.jsonl", nodes: [{ id: "0a1b2c3d4e5f60718293a4b5c6d7e8f9", text: "включи свет", duration: CROWD_TRAIN_SECONDS }] },
      ],
    });
  });
});

describe("the SASPEECH transcripts recipes", () => {
  it("reads the automatic subset's pipe-separated metadata with its header, keeping quotes and commas in the text and the times as numbers", async () => {
    const metadata = [
      "utterance_id|file_id|transcript|start_time|end_time|source_file_audio|source_session",
      "automatic_0000_line_000|automatic_0000|יוֹפִי|0.0|1.0|4000_1_0000.wav|4000_1.wav",
      'automatic_0001_line_000|automatic_0001|עַכְשָׁיו נַעֲשָׂה סַיְיפְּטִי, 5, 4, 3, "2", 1|0.0|4.8|4000_1_0001.wav|4000_1.wav',
      "",
    ].join("\n");
    const archive = tgz({ "saspeech_automatic_data/metadata.csv": metadata, "saspeech_automatic_data/wavs/automatic_0000.wav": "RIFF" });
    const data = await fetchShipped("openslr-slr134-transcripts", { [`${OPENSLR}/134/saspeech_automatic_data_v1.0.tar.gz`]: archive });
    expect(data).toMatchObject({
      nodes: [
        { id: "automatic_0000_line_000", text: "יוֹפִי", file_id: "automatic_0000", start_time: 0, end_time: 1, source_file_audio: "4000_1_0000.wav", source_session: "4000_1.wav" },
        { id: "automatic_0001_line_000", text: 'עַכְשָׁיו נַעֲשָׂה סַיְיפְּטִי, 5, 4, 3, "2", 1', start_time: 0, end_time: 4.8 },
      ],
    });
  });

  it("reads the gold subset's header-less metadata, which has the utterance id and the transcription twice", async () => {
    const archive = tgz({
      "saspeech_gold_standard/README.md": "readme",
      "saspeech_gold_standard/metadata.csv": "gold_000_line_001|אַתֶּם הֶאֱזַנְתֶּם|אתם האזנתם\ngold_000_line_002|שָׁלוֹם|שלום\n",
      "saspeech_gold_standard/metadata_full.csv": "utterance_id|text\n",
    });
    const data = await fetchShipped("openslr-slr134-gold-transcripts", { [`${OPENSLR}/134/saspeech_gold_standard_v1.0.tar.gz`]: archive });
    expect(data).toMatchObject({
      nodes: [
        { id: "gold_000_line_001", text: "אַתֶּם הֶאֱזַנְתֶּם", text_normalised: "אתם האזנתם" },
        { id: "gold_000_line_002", text: "שָׁלוֹם", text_normalised: "שלום" },
      ],
    });
  });
});
