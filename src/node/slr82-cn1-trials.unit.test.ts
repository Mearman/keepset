import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { parseSpeakerTrials } from "../parsers/speaker-trials";
import { gzip, tar } from "../test-support/archives";
import { fetchEntry, roundTripEntry, type FetchPort } from "./fetch-dataset";

const trials = "id00800-enroll test/id00800-singing-01-001.wav 1\nid00800-enroll test/id00801-speech-01-001.wav 0\nid00800-enroll test/id00801-speech-01-001.wav 0\n";
const archive = gzip(tar([{ path: "CN-Celeb_flac/eval/lists/trials.lst", text: trials }]));
const serving: FetchPort = async (url) => Promise.resolve(new Response(url.startsWith("https://archive.org/wayback/available") ? JSON.stringify({ archived_snapshots: {} }) : archive));

describe("CN-Celeb1 trial recipe", () => {
  it("fetches and round-trips all labels and repeated rows", async () => {
    const dataset = getDataset("openslr-slr82-cn1-trials");
    const { data, warnings } = await fetchEntry(dataset, { fetch: serving });
    expect(warnings).toEqual([]);
    expect(data).toMatchObject({ edges: [
      { source: "id00800-enroll", target: "test/id00800-singing-01-001.wav", type: "1" },
      { source: "id00800-enroll", target: "test/id00801-speech-01-001.wav", type: "0" },
      { source: "id00800-enroll", target: "test/id00801-speech-01-001.wav", type: "0" },
    ] });
    expect(await roundTripEntry(dataset, { fetch: serving })).toMatchObject({ holds: true });
  });

  it.each(["", "a b", "a b 2", "a b 0 extra", "a b 1\n\na b 0"]) ("rejects malformed trials %j", (text) => {
    expect(() => parseSpeakerTrials([text])).toThrow();
  });
});
