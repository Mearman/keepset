import { describe, expect, it } from "vitest";
import { captureRequestsFor, fetchDataset, roundTripDataset, type FetchPort } from "./fetch-dataset";
import { gzip, tar } from "../test-support/archives";

const xml = '<!DOCTYPE Trans SYSTEM "trans-14.dtd"><Trans audio_filename="recording"><Speakers><Speaker id="s" name="Speaker"/></Speakers><Episode><Section><Turn speaker="s" startTime="0" endTime="2"><Sync time="0"/>hello<Comment desc="note"/> there</Turn></Section></Episode></Trans>';

for (const [number, directory] of [["147", "Tequila-Zongolica-transcriptions/current"], ["148", "Zacatlan-Tepetzintla-Nahuatl-Transcriptions/current"]] as const) {
  describe(`SLR${number} transcription recipe`, () => {
    const archive = gzip(tar([{ path: `${directory}/recording.trs`, text: xml }]));
    const fetch: FetchPort = async () => Promise.resolve(new Response(archive));
    const id = `openslr-slr${number}-transcripts`;
    it("normalises and round-trips the archive without requesting a capture", async () => {
      const result = await fetchDataset(id, {fetch});
      if (!("nodes" in result.data)) throw new Error("expected a document");
      expect(result.data.nodes).toEqual([expect.objectContaining({ id: "recording/1/1", speaker: "s", speakerName: "Speaker", audio: "recording", start: 0, end: 2, text: "hello there" })]);
      expect(captureRequestsFor(result.provenance)).toEqual([]);
      expect(await roundTripDataset(id, {fetch})).toMatchObject({holds: true});
    });
  });
}
