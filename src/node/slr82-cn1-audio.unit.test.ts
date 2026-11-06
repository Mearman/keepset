import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar } from "../test-support/archives";
import { fetchEntry, roundTripEntry, type FetchPort } from "./fetch-dataset";

const archive = gzip(tar([
  { path: "CN-Celeb_flac/eval/test/id00939-speech-01-079.flac", text: "test audio" },
  { path: "CN-Celeb_flac/eval/enroll/id00889-enroll.flac", text: "enrolment audio" },
  { path: "CN-Celeb_flac/data/id00998/interview-03-020.flac", text: "data audio" },
]));
const serving: FetchPort = async (url) => Promise.resolve(new Response(url.startsWith("https://archive.org/wayback/available") ? JSON.stringify({ archived_snapshots: {} }) : archive));

describe("CN-Celeb1 recording recipe", () => {
  it("reads data, test and enrolment paths without inventing enrolment session codes", async () => {
    const dataset = getDataset("openslr-slr82-cn1-audio");
    const { data, warnings } = await fetchEntry(dataset, { fetch: serving });
    if (!("nodes" in data)) throw new Error("expected one document");
    expect(data.nodes).toEqual([
      { id: "data/id00998/interview-03-020", partition: "data", speaker: "id00998", label: "interview", session: "03", clip: "020", audio: "CN-Celeb_flac/data/id00998/interview-03-020.flac" },
      { id: "eval/enroll/id00889-enroll", partition: "eval/enroll", speaker: "id00889", label: "enroll", session: null, clip: null, audio: "CN-Celeb_flac/eval/enroll/id00889-enroll.flac" },
      { id: "eval/test/id00939-speech-01-079", partition: "eval/test", speaker: "id00939", label: "speech", session: "01", clip: "079", audio: "CN-Celeb_flac/eval/test/id00939-speech-01-079.flac" },
    ]);
    const expectedWarnings = ["nodes: the entry records 144505, the fetched result has 3"];
    expect(warnings).toEqual(expectedWarnings);
    expect(await roundTripEntry(dataset, { fetch: serving })).toMatchObject({ holds: true, warnings: expectedWarnings });
  });
});
