import { describe, expect, it } from "vitest";
import { gzip, tar } from "../test-support/archives";
import { getDataset } from "../bundled";
import { parseEntry } from "../entry";
import { fetchDataset, fetchEntry, roundTripDataset, roundTripEntry, type FetchPort } from "./fetch-dataset";

const FIELDS = ["lfcc", "mag_spectrogram", "mel_spectrogram", "mfcc", "shredded_lfcc", "shredded_mag_spectrogram", "shredded_mel_spectrogram", "shredded_mfcc", "shredded_reversed_lfcc", "shredded_reversed_mag_spectrogram", "shredded_reversed_mel_spectrogram", "shredded_reversed_mfcc", "shredded_reversed_waveform", "shredded_waveform", "waveform"];

function archive(split: string, ids: readonly string[]): Uint8Array {
  return gzip(tar(FIELDS.flatMap((field) => ids.map((id) => ({ path: `${split}/${field}/${id}.wav`, text: "the parser reads paths, not this payload" })))));
}
const testArchive = archive("test", ["spks0_id1", "spks2_id9"]);
const trainArchive = archive("train", ["spks3_id7"]);
const serving: FetchPort = async (url) => {
  if (url.startsWith("https://archive.org/wayback/available")) return Promise.resolve(new Response(JSON.stringify({ archived_snapshots: {} })));

  return Promise.resolve(new Response(url.endsWith("/test.tar.gz") ? testArchive : trainArchive));
};

describe("SLR135 grouped representations", () => {
  it("also groups paths when an entry reads a single archive", async () => {
    const base = getDataset("openslr-slr135-transcripts");
    const recipe = base.entry.recipe;
    if (recipe.status !== "fetchable" || !("files" in recipe)) throw new Error("expected the collection recipe");
    const file = recipe.files[0];
    if (file === undefined) throw new Error("expected the test archive");
    const entry = parseEntry({ ...base.entry, expectedCounts: { nodes: 2 }, recipe: { status: "fetchable", source: file.source, archive: file.archive, parser: recipe.parser } });
    const dataset = { ...base, entry };
    const { data, warnings } = await fetchEntry(dataset, { fetch: serving });
    if (!("nodes" in data)) throw new Error("expected one document");
    expect(data.nodes).toHaveLength(2);
    expect(data.nodes[0]).toMatchObject({ id: "spks0_id1", speakerCount: 0, audio: "test/waveform/spks0_id1.wav" });
    expect(warnings).toEqual([]);
    expect(await roundTripEntry(dataset, { fetch: serving })).toMatchObject({ holds: true });
  });
  it("rejects an unexpected file in a representation directory", async () => {
    const bad = gzip(tar([{ path: "test/new-format/unexpected.bin", text: "unexpected" }]));
    const fetch: FetchPort = async (url) => Promise.resolve(new Response(url.startsWith("https://archive.org/wayback/available") ? JSON.stringify({ archived_snapshots: {} }) : bad));
    await expect(fetchDataset("openslr-slr135-transcripts", { fetch })).rejects.toThrow(/named id and field/);
  });
  it("joins each example's waveform and NumPy feature paths within each split", async () => {
    const { data, warnings } = await fetchDataset("openslr-slr135-transcripts", { fetch: serving });
    expect("instances" in data).toBe(true);
    if (!("instances" in data)) throw new Error("the recipe is a collection");
    expect(data.instances).toHaveLength(2);
    const test = data.instances.find((instance) => instance.id === "test");
    const train = data.instances.find((instance) => instance.id === "train");
    expect(test?.nodes).toHaveLength(2);
    expect(train?.nodes).toHaveLength(1);
    expect(test?.nodes[0]).toMatchObject({ id: "spks0_id1", speakerCount: 0, audio: "test/waveform/spks0_id1.wav", mfcc: "test/mfcc/spks0_id1.wav", shredded_waveform: "test/shredded_waveform/spks0_id1.wav" });
    expect(train?.nodes[0]).toMatchObject({ id: "spks3_id7", speakerCount: 3, audio: "train/waveform/spks3_id7.wav" });
    expect(warnings).toEqual([]);
    expect(await roundTripDataset("openslr-slr135-transcripts", { fetch: serving })).toMatchObject({ holds: true });
  });
});
