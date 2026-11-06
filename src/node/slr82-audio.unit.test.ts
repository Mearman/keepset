import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { gzip, tar } from "../test-support/archives";
import { fetchEntry, roundTripEntry, type FetchPort } from "./fetch-dataset";

const archive = gzip(tar([
  { path: "CN-Celeb2_flac/data/id10198/entertainment-01-020.flac", text: "audio" },
  { path: "CN-Celeb2_flac/data/id10000/live_broadcast-02-001.flac", text: "audio" },
  { path: "CN-Celeb2_flac/spk.lst", text: "id10198\nid10000\n" },
]));
const suffixes = ["aa", "ab", "ac"];
const cut = Math.floor(archive.length / suffixes.length);
const parts = [archive.subarray(0, cut), archive.subarray(cut, cut * 2), archive.subarray(cut * 2)];
const serving: FetchPort = async (url) => {
  if (url.startsWith("https://archive.org/wayback/available")) return Promise.resolve(new Response(JSON.stringify({ archived_snapshots: {} })));
  const index = suffixes.findIndex((suffix) => url.endsWith(`gz${suffix}`));
  if (index < 0) throw new Error(`unexpected URL ${url}`);

  return Promise.resolve(new Response(parts[index]));
};

describe("CN-Celeb2 recording recipe", () => {
  it("extracts speaker, genre, session and clip codes from paths in the joined archive", async () => {
    const dataset = getDataset("openslr-slr82-cn2-audio");
    const { data, warnings } = await fetchEntry(dataset, { fetch: serving });
    if (!("instances" in data)) throw new Error("expected a collection");
    expect(data.instances[0]?.nodes).toEqual([
      { id: "id10000/live_broadcast-02-001", speaker: "id10000", label: "live_broadcast", session: "02", clip: "001", audio: "CN-Celeb2_flac/data/id10000/live_broadcast-02-001.flac" },
      { id: "id10198/entertainment-01-020", speaker: "id10198", label: "entertainment", session: "01", clip: "020", audio: "CN-Celeb2_flac/data/id10198/entertainment-01-020.flac" },
    ]);
    expect(warnings).toEqual([]);
    expect(await roundTripEntry(dataset, { fetch: serving })).toMatchObject({ holds: true, warnings: [] });
  });
});
