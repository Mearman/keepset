import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { roundTripDataset, streamDataset, type FetchPort, type StreamedNode } from "./fetch-dataset";

const path = "audio-for-forensic-and-multi-speaker-separation/";
const empty = Uint8Array.from(Buffer.from("524946462400000057415645666d74201000000001000100401f000000000000000000006461746100000000", "hex"));
const valid = Uint8Array.from(Buffer.from("524946462600000057415645666d74201000000001000100401f0000803e00000200100064617461020000000000", "hex"));
const zip = zipSync({ [`${path}audio_1.wav`]: valid, [`${path}audio_189.wav`]: empty });
const serving: FetchPort = async (url) => await Promise.resolve(url.startsWith("https://archive.org/wayback/available") ? new Response(JSON.stringify({ archived_snapshots: {} })) : new Response(zip));

describe("SLR162 recording metadata", () => {
  it("streams the recordings and exposes the malformed source header", async () => {
    const nodes: StreamedNode[] = [];
    const result = await streamDataset("openslr-slr162-transcripts", { meta: () => undefined, nodes: (page) => { nodes.push(...page); } }, { fetch: serving });
    expect(nodes).toHaveLength(2);
    expect(nodes.find((node) => node.id === "audio_1")).toMatchObject({ channels: 1, sampleRate: 8000, bitsPerSample: 16, issue: null });
    expect(nodes.find((node) => node.id === "audio_189")).toMatchObject({ bitsPerSample: 0, duration: null, issue: "invalid PCM format parameters or data length" });
    expect(result.provenance.members).toHaveLength(2);
    expect(await roundTripDataset("openslr-slr162-transcripts", { fetch: serving })).toMatchObject({ holds: true });
  });
});
