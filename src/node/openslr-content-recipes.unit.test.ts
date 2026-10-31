import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar, tarHeader, zip } from "../test-support/archives";
import { fixtureBytes, QURAN_TAR_XZ_BASE64 } from "../test-support/xz-fixtures";
import { fetchEntry, type FetchPort } from "./fetch-dataset";

/** The tar block size, which pads every member. */
const BLOCK = 512;

/** Where the silence before a speaker's first words ends in an AISHELL-4 fixture, in seconds, and where those words end. */
const SILENCE_END = 4.8;
const TURN_END = 6.4;

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

/**
 * Writes a ustar archive of members given as bytes, for a member that is not UTF-8 text.
 * @param files - The members.
 * @returns The archive bytes.
 */
function tarOfBytes(files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): Uint8Array {
  const blocks = files.flatMap(({ path, bytes }) => {
    const padded = new Uint8Array(Math.ceil(bytes.length / BLOCK) * BLOCK);
    padded.set(bytes);

    return [tarHeader(path, bytes.length, "0"), padded];
  });
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 2 * BLOCK));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }

  return out;
}

/** The URL of a file of a resource's download list. */
const download = (number: string, name: string): string => `https://www.openslr.org/resources/${number}/${name}`;

/**
 * A Praat TextGrid in the long text form, with every tier an interval tier.
 * @param tiers - The tiers, each with its name and its intervals as start, end and text.
 * @returns The file text.
 */
function textGrid(tiers: readonly { readonly name: string; readonly intervals: readonly { readonly start: number; readonly end: number; readonly text: string }[] }[]): string {
  const lines = ['File type = "ooTextFile"', 'Object class = "TextGrid"', "", "xmin = 0", "xmax = 100", "tiers? <exists>", `size = ${String(tiers.length)}`, "item []:"];
  for (const [index, tier] of tiers.entries()) {
    lines.push(`    item [${String(index + 1)}]:`, '        class = "IntervalTier"', `        name = "${tier.name}"`, "        xmin = 0", "        xmax = 100", `        intervals: size = ${String(tier.intervals.length)}`);
    for (const [at, { start, end, text }] of tier.intervals.entries()) {
      lines.push(`        intervals [${String(at + 1)}]:`, `            xmin = ${String(start)}`, `            xmax = ${String(end)}`, `            text = "${text}"`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * An ELAN annotation file with one tier of aligned annotations.
 * @param tier - The tier's identifier.
 * @param annotations - The annotations as start, end (milliseconds) and text.
 * @returns The file text.
 */
function eaf(tier: string, annotations: readonly { readonly start: number; readonly end: number; readonly text: string }[]): string {
  const slots = annotations.flatMap(({ start, end }, index) => [`<TIME_SLOT TIME_SLOT_ID="ts${String(2 * index + 1)}" TIME_VALUE="${String(start)}"/>`, `<TIME_SLOT TIME_SLOT_ID="ts${String(2 * index + 2)}" TIME_VALUE="${String(end)}"/>`]);
  const items = annotations.map(({ text }, index) => `<ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a${String(index + 1)}" TIME_SLOT_REF1="ts${String(2 * index + 1)}" TIME_SLOT_REF2="ts${String(2 * index + 2)}"><ANNOTATION_VALUE>${text}</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>`);

  return `<?xml version="1.0" encoding="UTF-8"?>\n<ANNOTATION_DOCUMENT><HEADER TIME_UNITS="milliseconds"/><TIME_ORDER>${slots.join("")}</TIME_ORDER><TIER TIER_ID="${tier}">${items.join("")}</TIER></ANNOTATION_DOCUMENT>\n`;
}

/** The instances of a fetched collection, each with its id and its nodes. */
function instancesOf(data: unknown): { readonly id: unknown; readonly nodes: readonly unknown[] }[] {
  if (typeof data !== "object" || data === null || !("instances" in data) || !Array.isArray(data.instances)) {
    return expect.unreachable("the result is a collection");
  }

  return data.instances.map((instance: unknown) => {
    if (typeof instance !== "object" || instance === null || !("id" in instance) || !("nodes" in instance) || !Array.isArray(instance.nodes)) {
      return expect.unreachable("an instance has an id and nodes");
    }

    return { id: instance.id, nodes: instance.nodes };
  });
}

describe("the openslr-slr155-transcripts recipe", () => {
  it("reads each CHAT file of the archive as the turns of a conversation, leaving the audio and other members", async () => {
    const cha = ["@UTF8", "@Begin", "@Participants:\tLENO LENORE Speaker, LYNN LYNNE Speaker", "*LENO:\t(..) so ⌈ you know ⌉ \u0015100_900\u0015", "\t\u0015900_1500\u0015", "*LYNN:\tyeah", "@End", ""].join("\n");
    const archive = gzip(tar([{ path: "CHAT/", text: "", type: "5" }, { path: "CHAT/SBC001.cha", text: cha }, { path: "CHAT/._SBC001.cha", text: "fork" }, { path: "CHAT/notes.txt", text: "not a transcript" }]));
    const { data } = await fetchEntry(getDataset("openslr-slr155-transcripts"), { fetch: serving({ [download("155", "SBCSAE.tar.gz")]: archive }) });
    expect(data).toMatchObject({
      nodes: [
        { id: "SBC001/1", text: "(..) so ⌈ you know ⌉", speaker: "LENO", start: 100, end: 1500 },
        { id: "SBC001/2", text: "yeah", speaker: "LYNN", start: null, end: null },
      ],
    });
  });
});

describe("the openslr-slr28-clips recipe", () => {
  it("reads the room and noise lists of the zip as the recordings they describe, from the options each line carries", async () => {
    const archive = zip([
      { path: "RIRS_NOISES/README", text: "readme" },
      { path: "RIRS_NOISES/pointsource_noises/noise_list", text: "--noise-id noise-free-sound-0000 --noise-type point-source --bg-fg-type foreground RIRS_NOISES/pointsource_noises/noise-free-sound-0000.wav\n" },
      { path: "RIRS_NOISES/pointsource_noises/noise-free-sound-0000.wav", text: "RIFF" },
      { path: "RIRS_NOISES/real_rirs_isotropic_noises/rir_list", text: "--rir-id 00001 --room-id RVB2014_largeroom1 RIRS_NOISES/real_rirs_isotropic_noises/RVB2014_type1_rir_largeroom1_far_angla.wav\n" },
      { path: "RIRS_NOISES/real_rirs_isotropic_noises/noise_list", text: "--noise-id 00001 --noise-type isotropic --room-linkage RVB2014_largeroom1 RIRS_NOISES/real_rirs_isotropic_noises/RVB2014_type1_noise_largeroom1_1.wav\n" },
      { path: "RIRS_NOISES/simulated_rirs/smallroom/rir_list", text: "--rir-id small-Room001-00001 --room-id small-Room001 RIRS_NOISES/simulated_rirs/smallroom/Room001/Room001-00001.wav\n" },
      { path: "RIRS_NOISES/simulated_rirs/smallroom/room_info", text: "room info" },
    ]);
    const { data } = await fetchEntry(getDataset("openslr-slr28-clips"), { fetch: serving({ [download("28", "rirs_noises.zip")]: archive }) });
    expect(data).toMatchObject({
      nodes: [
        { id: "RIRS_NOISES/pointsource_noises/noise-free-sound-0000.wav", label: "point-source", noise_id: "noise-free-sound-0000", bg_fg_type: "foreground", rir_id: null, room_id: null, room_linkage: null },
        { id: "RIRS_NOISES/real_rirs_isotropic_noises/RVB2014_type1_noise_largeroom1_1.wav", label: "isotropic", noise_id: "00001", room_linkage: "RVB2014_largeroom1", rir_id: null },
        { id: "RIRS_NOISES/real_rirs_isotropic_noises/RVB2014_type1_rir_largeroom1_far_angla.wav", label: null, rir_id: "00001", room_id: "RVB2014_largeroom1", noise_id: null },
        { id: "RIRS_NOISES/simulated_rirs/smallroom/Room001/Room001-00001.wav", rir_id: "small-Room001-00001", room_id: "small-Room001" },
      ],
    });
  });
});

describe("the openslr-slr17-clips recipe", () => {
  it("reads the ANNOTATIONS file of each music, speech and noise directory, and nothing else the archive holds", async () => {
    const archive = gzip(
      tar([
        { path: "musan/music/fma/music-fma-0001.wav", text: "RIFF" },
        { path: "musan/music/fma/ANNOTATIONS", text: "music-fma-0001 pop,electronica Y Quiet_Music\n" },
        { path: "musan/music/hd-classical/ANNOTATIONS", text: "music-hd-0001 westernart,baroque N John_Harrison Vivaldi\n" },
        { path: "musan/speech/librivox/ANNOTATIONS", text: "speech-librivox-0001 f german \n" },
        { path: "musan/noise/free-sound/ANNOTATIONS", text: "Background noises:\nnoise-free-sound-0001\n" },
        { path: "musan/noise/sound-bible/noise-sound-bible-0001.wav", text: "RIFF" },
        { path: "musan/music/README", text: "readme" },
      ]),
    );
    const { data } = await fetchEntry(getDataset("openslr-slr17-clips"), { fetch: serving({ [download("17", "musan.tar.gz")]: archive }) });
    expect(data).toMatchObject({
      nodes: [
        { id: "music-fma-0001", label: "music", source: "fma", genre: "pop,electronica", vocals: "Y", artist: "Quiet_Music", composer: null },
        { id: "music-hd-0001", label: "music", source: "hd-classical", vocals: "N", composer: "Vivaldi" },
        { id: "noise-free-sound-0001", label: "noise", source: "free-sound", genre: null },
        { id: "speech-librivox-0001", label: "speech", gender: "f", language: "german", artist: null },
      ],
    });
  });
});

describe("the openslr-slr84-texts recipe", () => {
  it("reads the corpus table from the zip, with the scribe as the author, the split as the collection and the transcription kept", async () => {
    const header = "colormode,img_filename,item_dir,line_index,page,page_side,scribe,scribe_id,split,text_filename,transcribed,page_id,transcription";
    const csv = [
      header,
      'bw,scribblelens.corpus.v1/nl/brouwer.chili/1/line0.jpg,scribblelens.corpus.v1/nl/brouwer.chili/1/,0,1.0,,brouwer.chili,0,train,scribblelens.corpus.v1/nl/brouwer.chili/1/line0.txt,True,brouwer.chili_1_None,"Journael, gehouden"',
      "color,scribblelens.corpus.v1/nl/unsupervised/zeewijck/14/line0.jpg,scribblelens.corpus.v1/nl/unsupervised/zeewijck/14/,0,14.0,,zeewijck,7,unsupervised,scribblelens.corpus.v1/nl/unsupervised/zeewijck/14/line0.txt,False,zeewijck_14_None,",
      "",
    ].join("\n");
    const archive = zip([
      { path: "scribblelens.corpus.v1/corpora/scribblelens.corpus.v1.2.csv", text: csv },
      { path: "scribblelens.corpus.v1/corpora/nl.pages.test.txt", text: "nl/kieft/18/line.wholepage.txt\n" },
      { path: "scribblelens.corpus.v1/nl/brouwer.chili/1/line0.jpg", text: "JFIF" },
    ]);
    const { data } = await fetchEntry(getDataset("openslr-slr84-texts"), { fetch: serving({ [download("84", "scribblelens.corpus.v1.2.zip")]: archive }) });
    expect(data).toMatchObject({
      nodes: [
        { id: "scribblelens.corpus.v1/nl/brouwer.chili/1/line0.jpg", authors: "brouwer.chili", collections: "train", transcription: "Journael, gehouden", transcribed: "True", page_id: "brouwer.chili_1_None", page: "1.0", line_index: "0", scribe_id: "0", colormode: "bw" },
        { id: "scribblelens.corpus.v1/nl/unsupervised/zeewijck/14/line0.jpg", authors: "zeewijck", collections: "unsupervised", transcription: null, transcribed: "False" },
      ],
    });
  });
});

describe("the ELAN recipes", () => {
  it("reads the ELAN files beneath the Totonac conversations", async () => {
    const archive = gzip(
      tar([
        { path: "Conversaciones/Botany/Audios/Zongo_Botan_1.wav", text: "RIFF" },
        { path: "Conversaciones/Botany/Transcripciones/Zongo_Botan_1_ed-2019-08-19.eaf", text: eaf("spk1", [{ start: 0, end: 1000, text: "wa: skaw" }]) },
        { path: "Metadata.xml", text: "<metadata/>" },
      ]),
    );
    const { data } = await fetchEntry(getDataset("openslr-slr107-transcripts"), { fetch: serving({ [download("107", "Totonac_Corpus.tgz")]: archive }) });
    expect(data).toMatchObject({ nodes: [{ id: "Zongo_Botan_1_ed-2019-08-19/a1", text: "wa: skaw", tier: "spk1", start: 0, end: 1000 }] });
  });
});

describe("the TextGrid recipes", () => {
  it("reads one instance for each AISHELL-4 archive, each tier a speaker, from the TextGrid directory and not the diarisation or audio", async () => {
    const meeting = (speakers: readonly string[]): string => textGrid(speakers.map((name, index) => ({ name, intervals: [{ start: 0, end: 4.8, text: "" }, { start: SILENCE_END + index, end: TURN_END + index, text: `你好${name}` }] }))).replaceAll("\n", "\r\n");
    const archive = (set: string, stem: string, speakers: readonly string[]): Uint8Array =>
      gzip(tar([{ path: `${set}/TextGrid/${stem}.TextGrid`, text: meeting(speakers) }, { path: `${set}/TextGrid/${stem}.rttm`, text: "SPEAKER" }, { path: `${set}/wav/${stem}.flac`, text: "fLaC" }]));
    const { data } = await fetchEntry(getDataset("openslr-slr111-transcripts"), {
      fetch: serving({
        [download("111", "train_L.tar.gz")]: archive("train_L", "20200706_L_R001S08C01", ["006-M", "002-F"]),
        [download("111", "train_M.tar.gz")]: archive("train_M", "20200706_M_R001S01C01", ["001-M"]),
        [download("111", "train_S.tar.gz")]: archive("train_S", "20200706_S_R001S01C01", ["003-F"]),
        [download("111", "test.tar.gz")]: archive("test", "L_R003S01C02", ["004-M"]),
      }),
    });
    const instances = instancesOf(data);
    expect(instances.map((instance) => instance.id)).toEqual(["train_L.tar.gz", "train_M.tar.gz", "train_S.tar.gz", "test.tar.gz"]);
    expect(instances[0]?.nodes).toMatchObject([
      { id: "20200706_L_R001S08C01/1.2", text: "你好006-M", speaker: "006-M", start: 4.8, end: 6.4 },
      { id: "20200706_L_R001S08C01/2.2", text: "你好002-F", speaker: "002-F", start: 5.8, end: 7.4 },
    ]);
    expect(instances[3]?.nodes).toMatchObject([{ id: "L_R003S01C02/1.2", speaker: "004-M" }]);
  });

  it("reads the orthography tiers of the Faroese TextGrid files, in Latin-1, from both directories and not the other tiers, the two files damaged at the source or AppleDouble forks", async () => {
    const grid = (tiers: readonly { readonly name: string; readonly intervals: readonly { readonly start: number; readonly end: number; readonly text: string }[] }[]): Uint8Array => Uint8Array.from(Buffer.from(textGrid(tiers), "latin1"));
    const orthography = [{ name: "SPK0|t|orthography", intervals: [{ start: 0, end: 0.5, text: "<o> " }, { start: 0.5, end: 1.1, text: "eindir ðý " }]  }, { name: "SPK0|a|SAMPA", intervals: [{ start: 0, end: 1.1, text: "aIndIr" }]  }, { name: "SPK1|t|orthography", intervals: [{ start: 1.1, end: 2, text: "ja " }]  }];
    const archive = gzip(
      tarOfBytes([
        { path: "BLARK_1.0/overview_sound.csv", bytes: new TextEncoder().encode("Recording ID\n") },
        { path: "BLARK_1.0/textgrids_1.0/ortho/KSM03_100120_eind5.textGrid", bytes: grid(orthography) },
        { path: "BLARK_1.0/textgrids_1.0/ortho/._KSM03_100120_eind5.textGrid", bytes: new TextEncoder().encode("fork") },
        { path: "BLARK_1.0/textgrids_1.0/ortho/MUM04_040320_blogg20.textGrid", bytes: new TextEncoder().encode('File type = "ooTextFile"\nObject class = "TextGrid"\n\nxmin = 0\nxmax = 1\ntiers? <exists>\nsize = 1\nitem []:\n    item [1]:\n        class = "IntervalTier"\n        name = "NO_SPEAKER|d|global') },
        { path: "BLARK_1.0/textgrids_1.0/ortho_phone/KEY01_030519_ord02.textGrid", bytes: grid([{ name: "SPK0|t|Orthography", intervals: [{ start: 0, end: 1, text: "gott " }] }, { name: "NO_SPEAKER|d|global", intervals: [{ start: 0, end: 1, text: "x" }] }]) },
      ]),
    );
    const { data } = await fetchEntry(getDataset("openslr-slr125-transcripts"), { fetch: serving({ [download("125", "BLARK_1.0_update.tar.gz")]: archive }) });
    expect(data).toMatchObject({
      nodes: [
        { id: "KSM03_100120_eind5/1.1", text: "<o>", tier: "SPK0|t|orthography" },
        { id: "KSM03_100120_eind5/1.2", text: "eindir ðý", start: 0.5, end: 1.1 },
        { id: "KSM03_100120_eind5/3.1", text: "ja", tier: "SPK1|t|orthography" },
        { id: "KEY01_030519_ord02/1.1", text: "gott", tier: "SPK0|t|Orthography", start: 0, end: 1 },
      ],
    });
  });
});

describe("the openslr-slr151-transcripts recipe", () => {
  it("reads one instance for each language archive from its STM files, leaving out the Transcriber files, audio and scoring markers", async () => {
    const stm = (recording: string): string =>
      [";; Transcriber conversion", ';; CATEGORY "0" "" ""', `${recording} 1 locuteur2 0.000 3.214 <o,f1,male> maɗe puɗata :fra a`, `${recording} 1 excluded_region 3.214 9.000 <o,,unknown> ignore_time_segment_in_scoring`, `${recording} 1 inter_segment_gap 9.000 9.5 <o,f0,> `, ""].join("\n");
    const archive = (language: string, code: string, recording: string): Uint8Array =>
      gzip(
        tar([
          { path: `clean_dataset_ready4release/${language}/speech_dataset/1/${recording}.wav`, text: "RIFF" },
          { path: `clean_dataset_ready4release/${language}/speech_dataset/1/${recording}.trs`, text: "<Trans/>" },
          { path: `clean_dataset_ready4release/${language}/speech_dataset/1/stm_format/${recording}.stm`, text: stm(recording) },
          { path: `clean_dataset_ready4release/${language}/lexicon/${code}_lexicon.txt`, text: "word" },
        ]),
      );
    const { data } = await fetchEntry(getDataset("openslr-slr151-transcripts"), {
      fetch: serving({
        [download("151", "speech_dataset_wol.tar.gz")]: archive("wolof", "wol", "wol_3110"),
        [download("151", "speech_dataset_fuc.tar.gz")]: archive("pulaar", "fuc", "fuc_4110"),
        [download("151", "speech_dataset_srr.tar.gz")]: archive("sereer", "srr", "srr_3110"),
      }),
    });
    const instances = instancesOf(data);
    expect(instances.map((instance) => instance.id)).toEqual(["speech_dataset_wol.tar.gz", "speech_dataset_fuc.tar.gz", "speech_dataset_srr.tar.gz"]);
    expect(instances[1]?.nodes).toMatchObject([{ id: "fuc_4110/3", text: "maɗe puɗata :fra a", speaker: "locuteur2", channel: "1", start: 0, end: 3.214, label: "o,f1,male" }]);
    expect(instances[1]?.nodes).toHaveLength(1);
  });
});

describe("the openslr-slr132-transcripts recipe", () => {
  it("reads the transcript table from the tar.xz archive, leaving out the audio and the other members", async () => {
    const { data } = await fetchEntry(getDataset("openslr-slr132-transcripts"), { fetch: serving({ [download("132", "Quran_Speech_Dataset.tar.xz")]: fixtureBytes(QURAN_TAR_XZ_BASE64) }) });
    expect(data).toMatchObject({
      nodes: [
        { id: "audio_data/reader_1/001001.mp3", text: "بِسْمِ اللَّهِ الرَّحْمَٰنِ الرَّحِيمِ", duration: 6.552 },
        { id: "audio_data/reader_2/001002.mp3", text: "الْحَمْدُ لِلَّهِ رَبِّ الْعَالَمِينَ", duration: 4.1 },
      ],
    });
  });
});
