import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { parseEntry } from "../entry";
import { gzip, tar } from "../test-support/archives";
import { fetchEntry, roundTripEntry, type FetchPort } from "./fetch-dataset";

const archive = gzip(tar([
  { path: "release_v1/meta_info/utt2info.zh", text: "utt_id, env, stat, noise\n0001_06011349_3_1_ti_0, 室内(宿舍,卧室), 正常, 安静\n" },
  { path: "release_v1/meta_info/spk2info", text: "spk_id, gender, region, age\nspk0001, female, Shanxi, 21\n" },
]));
const serving: FetchPort = async (url) => Promise.resolve(new Response(url.startsWith("https://archive.org/wayback/available") ? JSON.stringify({ archived_snapshots: {} }) : archive));

describe("SLR156 metadata recipes", () => {
  it.each([
    ["openslr-slr156-audio", { id: "0001_06011349_3_1_ti_0", speakerCode: "0001", environment: "室内(宿舍,卧室)", physicalState: "正常", noise: "安静" }],
    ["openslr-slr156-speakers", { id: "spk0001", gender: "female", region: "Shanxi", age: 21 }],
  ])("fetches and round-trips %s", async (id, expected) => {
    const base = getDataset(id);
    const dataset = { ...base, entry: parseEntry({ ...base.entry, expectedCounts: { nodes: 1 } }) };
    const { data, warnings } = await fetchEntry(dataset, { fetch: serving });
    if (!("nodes" in data)) throw new Error("expected one document");
    expect(data.nodes).toEqual([expected]);
    expect(warnings).toEqual([]);
    expect(await roundTripEntry(dataset, { fetch: serving })).toMatchObject({ holds: true, warnings: [] });
  });
});
