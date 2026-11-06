import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar } from "../test-support/archives";
import { fetchEntry, roundTripEntry, type FetchPort } from "./fetch-dataset";

const archive = gzip(tar([{ path: "CN-Celeb2_flac/spk.lst", text: "id10000\nid10001\n" }]));
const suffixes = ["aa", "ab", "ac"];
const cut = Math.floor(archive.length / suffixes.length);
const parts = [archive.subarray(0, cut), archive.subarray(cut, cut * 2), archive.subarray(cut * 2)];
const serving: FetchPort = async (url) => {
  if (url.startsWith("https://archive.org/wayback/available")) return Promise.resolve(new Response(JSON.stringify({ archived_snapshots: {} })));
  const index = suffixes.findIndex((suffix) => url.endsWith(`gz${suffix}`));
  if (index < 0) throw new Error(`unexpected URL ${url}`);

  return Promise.resolve(new Response(parts[index]));
};

describe("CN-Celeb2 speaker recipe", () => {
  it("reads and round-trips speaker IDs from the joined archive parts", async () => {
    const dataset = getDataset("openslr-slr82-cn2-speakers");
    const { data, warnings, provenance } = await fetchEntry(dataset, { fetch: serving });
    if (!("instances" in data) || !("files" in provenance)) throw new Error("expected a collection");
    expect(data.instances[0]?.nodes).toEqual([{ id: "id10000" }, { id: "id10001" }]);
    expect(warnings).toEqual([]);
    const file = provenance.files[0];
    if (file === undefined || !("parts" in file)) throw new Error("expected three source parts");
    expect(file.parts).toHaveLength(suffixes.length);
    expect(await roundTripEntry(dataset, { fetch: serving })).toMatchObject({ holds: true, warnings: [] });
  });
});
