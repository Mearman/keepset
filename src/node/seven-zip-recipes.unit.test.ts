import { describe, expect, it } from "vitest";
import { getDataset } from "../bundled";
import { sevenZip } from "../test-support/seven-zip";
import { fetchEntry, type FetchPort } from "./fetch-dataset";

const KIBIBYTE = 1024;
/** The compression of Sagalee's own archive, as its headers state it: one solid block of LZMA with a dictionary of 2^23 bytes (`LZMA:23`). */
const SAGALEE_DICTIONARY_BITS = 23;
const SAGALEE_DICTIONARY_BYTES = 2 ** SAGALEE_DICTIONARY_BITS;
const text = (value: string): Uint8Array => new TextEncoder().encode(value);
/** A stand-in recording: the bytes are never read, only skipped over in the solid block. */
const recording = (): Uint8Array => new Uint8Array(KIBIBYTE).fill(1);

describe("the openslr-slr157-transcripts recipe", () => {
  it("reads the transcript beside each recording of Sagalee's solid 7z archive, in every split, and nothing else", async () => {
    // The archive's real layout: a folder per split, a folder per speaker in it, and a transcript and a recording per utterance, with the licence and the speaker list at the top.
    const archive = await sevenZip(
      [
        { path: "LICENSE.txt", bytes: text("Attribution-NonCommercial 4.0 International\n") },
        { path: "speaker_metadata.csv", bytes: text("speaker_id,gender\nSPKR009,F\n") },
        { path: "dev/SPKR009/sagalee_SPKR009_001.txt", bytes: text("HOJJATAA JIRA JECHUUN KOMATE\n") },
        { path: "dev/SPKR009/sagalee_SPKR009_001.wav", bytes: recording() },
        { path: "test/SPKR040/sagalee_SPKR040_007.txt", bytes: text("SAMMUU KEE KEESSA HIN KAAYANI") },
        { path: "test/SPKR040/sagalee_SPKR040_007.wav", bytes: recording() },
        { path: "train/SPKR232/sagalee_SPKR232_082.txt", bytes: text("﻿NAMNI HUNDI\r\n") },
        { path: "train/SPKR232/sagalee_SPKR232_082.wav", bytes: recording() },
      ],
      { solid: true, method: "LZMA", dictionaryBytes: SAGALEE_DICTIONARY_BYTES, level: 1 },
    );
    const dataset = getDataset("openslr-slr157-transcripts");
    const url = dataset.entry.sources[0]?.url;
    expect(url).toBe("https://www.openslr.org/resources/157/sagalee.7z");
    const fetch: FetchPort = async (requested) => Promise.resolve(requested === url ? new Response(archive) : new Response(null, { status: 404 }));
    const { data, provenance } = await fetchEntry(dataset, { fetch });
    expect(data).toMatchObject({
      nodes: [
        { id: "sagalee_SPKR009_001", text: "HOJJATAA JIRA JECHUUN KOMATE" },
        { id: "sagalee_SPKR040_007", text: "SAMMUU KEE KEESSA HIN KAAYANI" },
        { id: "sagalee_SPKR232_082", text: "NAMNI HUNDI" },
      ],
    });
    expect(provenance).toMatchObject({ byteLength: archive.length, members: ["dev/SPKR009/sagalee_SPKR009_001.txt", "test/SPKR040/sagalee_SPKR040_007.txt", "train/SPKR232/sagalee_SPKR232_082.txt"] });
  });
});
