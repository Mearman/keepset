import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar } from "../test-support/archives";
import { fetchEntry, type FetchPort } from "./fetch-dataset";

const serving = (body: Uint8Array | string): FetchPort => async () => Promise.resolve(new Response(body));

/** A port that answers each URL with its own body, and refuses any other. */
function routing(bodies: Readonly<Record<string, Uint8Array>>): FetchPort {
  return async (url) => {
    const body = bodies[url];

    return Promise.resolve(body === undefined ? new Response("not found", { status: 404 }) : new Response(body));
  };
}

/** Interval boundaries in seconds, as the files write them. */
const FIRST_START = 0.5;
const FIRST_END = 2.25;
const SECOND_START = 3;
const SECOND_END = 4.5;
const EVAL_START = 6.9;
const EVAL_END = 18.29;
const TEST_START = 1.5;

/** An interval of a tier: its start and end in seconds and its text. */
type Interval = readonly [start: number, end: number, text: string];

/**
 * A TextGrid in the long text form with one interval tier, laid out as the AliMeeting near-field files are (tab indentation, a blank line after the object class, `tiers? <exists>`).
 * @param tier - The tier's name.
 * @param intervals - The tier's intervals, in order.
 * @returns The file text.
 */
function textGrid(tier: string, intervals: readonly Interval[]): string {
  const end = intervals.at(-1)?.[1] ?? 0;
  const lines = [
    'File type = "ooTextFile"',
    'Object class = "TextGrid"',
    "",
    "xmin = 0",
    `xmax = ${String(end)}`,
    "tiers? <exists>",
    "size = 1",
    "item []:",
    "\titem [1]:",
    '\t\tclass = "IntervalTier"',
    `\t\tname = "${tier}"`,
    "\t\txmin = 0",
    `\t\txmax = ${String(end)}`,
    `\t\tintervals: size = ${String(intervals.length)}`,
    ...intervals.flatMap(([start, stop, text], index) => [`\t\tintervals [${String(index + 1)}]:`, `\t\t\txmin = ${String(start)}`, `\t\t\txmax = ${String(stop)}`, `\t\t\ttext = "${text}"`]),
    "",
  ];

  return lines.join("\n");
}

describe("the openslr-slr115-transcripts recipe", () => {
  const prompts = ['( arctic_a0001 "Author of the danger trail, Philip Steels, etc." )', '( arctic_a0002 "Not at this particular case, Tom, apologized Whittemore." )', '( arctic_b0003 "He said \\"never\\" twice." )', ""].join("\n");

  it("reads each Festival prompt line as an utterance with its identifier and text, undoing an escaped quote", async () => {
    const { data } = await fetchEntry(getDataset("openslr-slr115-transcripts"), { fetch: serving(prompts) });

    expect(data).toMatchObject({
      nodes: [
        { id: "arctic_a0001", text: "Author of the danger trail, Philip Steels, etc." },
        { id: "arctic_a0002", text: "Not at this particular case, Tom, apologized Whittemore." },
        { id: "arctic_b0003", text: 'He said "never" twice.' },
      ],
    });
  });

  it("refuses a line that is not in the Festival form", async () => {
    await expect(fetchEntry(getDataset("openslr-slr115-transcripts"), { fetch: serving("arctic_a0001 Author of the danger trail") })).rejects.toThrow();
  });
});

describe("the openslr-slr119-transcripts recipe", () => {
  const base = "https://speech-lab-share-data.oss-cn-shanghai.aliyuncs.com/AliMeeting/openlr/";
  const nearFile = "R0003_M0046_N_SPK0093";
  const archives = {
    [`${base}Train_Ali_near.tar.gz`]: gzip(
      tar([
        { path: "Train_Ali_near/", text: "", type: "5" },
        { path: "Train_Ali_near/audio_dir/", text: "", type: "5" },
        { path: `Train_Ali_near/audio_dir/${nearFile}.wav`, text: "RIFF" },
        { path: "Train_Ali_near/textgrid_dir/", text: "", type: "5" },
        {
          path: `Train_Ali_near/textgrid_dir/${nearFile}.TextGrid`,
          text: textGrid("c1", [
            [FIRST_START, FIRST_END, "first words"],
            [FIRST_END, SECOND_START, ""],
            [SECOND_START, SECOND_END, "second words"],
          ]),
        },
        { path: "Train_Ali_near/textgrid_dir/R0003_M0046_N_SPK0094.TextGrid", text: textGrid("S1", [[1, 2, "another speaker"]]) },
      ]),
    ),
    [`${base}Eval_Ali.tar.gz`]: gzip(
      tar([
        { path: "Eval_Ali/Eval_Ali_far/audio_dir/R8001_M8004_MS801.wav", text: "RIFF" },
        { path: "Eval_Ali/Eval_Ali_far/textgrid_dir/R8001_M8004.TextGrid", text: textGrid("far-field speaker", [[0, 1, "heard from afar"]]) },
        { path: "Eval_Ali/Eval_Ali_near/audio_dir/R8001_M8004_N_SPK8013.wav", text: "RIFF" },
        { path: "Eval_Ali/Eval_Ali_near/textgrid_dir/R8001_M8004_N_SPK8013.TextGrid", text: textGrid("c1", [[EVAL_START, EVAL_END, "evaluation words"]]) },
      ]),
    ),
    [`${base}Test_Ali.tar.gz`]: gzip(
      tar([
        { path: "Test_Ali/Test_Ali_far/textgrid_dir/R8010_M8030.TextGrid", text: textGrid("far-field speaker", [[0, 1, "heard from afar"]]) },
        { path: "Test_Ali/Test_Ali_near/textgrid_dir/R8010_M8030_N_SPK8100.TextGrid", text: textGrid("c1", [[TEST_START, 2, "test words"]]) },
      ]),
    ),
  };

  it("reads each split's near-field TextGrid files as one instance, whatever each file names its tier", async () => {
    const { data, warnings } = await fetchEntry(getDataset("openslr-slr119-transcripts"), { fetch: routing(archives) });

    expect(data).toMatchObject({
      instances: [
        {
          id: "Train_Ali_near",
          nodes: [
            { id: `${nearFile}/1.1`, text: "first words", start: FIRST_START, end: FIRST_END },
            { id: `${nearFile}/1.3`, text: "second words", start: SECOND_START, end: SECOND_END },
            { id: "R0003_M0046_N_SPK0094/1.1", text: "another speaker", start: 1, end: 2 },
          ],
        },
        { id: "Eval_Ali", nodes: [{ id: "R8001_M8004_N_SPK8013/1.1", text: "evaluation words", start: EVAL_START, end: EVAL_END }] },
        { id: "Test_Ali", nodes: [{ id: "R8010_M8030_N_SPK8100/1.1", text: "test words", start: TEST_START, end: 2 }] },
      ],
    });
    expect(warnings).toEqual([]);
  });

  it("leaves the far-field files out", async () => {
    const { data } = await fetchEntry(getDataset("openslr-slr119-transcripts"), { fetch: routing(archives) });

    expect(JSON.stringify(data)).not.toContain("heard from afar");
  });
});
