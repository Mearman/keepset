import { describe, expect, it } from "vitest";
import { parseWavMetadata } from "./wav-metadata";

const HEADER_BYTES = 44;
const FMT_SIZE_OFFSET = 16;
const FORMAT_OFFSET = 20;
const CHANNELS_OFFSET = 22;
const RATE_OFFSET = 24;
const BYTE_RATE_OFFSET = 28;
const ALIGN_OFFSET = 32;
const BITS_OFFSET = 34;
const DATA_TAG_OFFSET = 36;
const DATA_SIZE_OFFSET = 40;
const RIFF_SIZE_OFFSET = 4;
const RIFF_CONTENT_OFFSET = 8;
const PCM_FORMAT_BYTES = 16;
const BITS_PER_BYTE = 8;
const SAMPLE_RATE = 48000;
const EMPTY_RATE = 8000;
const SAMPLE_BITS = 16;
const AUDIO_BYTES = 192000;
const ALIGNMENT = 4;
const JUNK_CHUNK_BYTES = 10;
const RIFF_HEADER_BYTES = 12;

const parser = { format: "wav-metadata", encoding: "utf-8", idPattern: "(.*)\\.wav" } as const;

function wave(channels: number, rate: number, bits: number, audioBytes: number): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES + audioBytes);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string): void => { for (const [index, char] of Array.from(text).entries()) bytes[offset + index] = char.charCodeAt(0); };
  write(0, "RIFF"); view.setUint32(RIFF_SIZE_OFFSET, bytes.length - RIFF_CONTENT_OFFSET, true); write(RIFF_CONTENT_OFFSET, "WAVEfmt "); view.setUint32(FMT_SIZE_OFFSET, PCM_FORMAT_BYTES, true); view.setUint16(FORMAT_OFFSET, 1, true);
  view.setUint16(CHANNELS_OFFSET, channels, true); view.setUint32(RATE_OFFSET, rate, true); view.setUint32(BYTE_RATE_OFFSET, rate * channels * bits / BITS_PER_BYTE, true); view.setUint16(ALIGN_OFFSET, channels * bits / BITS_PER_BYTE, true); view.setUint16(BITS_OFFSET, bits, true); write(DATA_TAG_OFFSET, "data"); view.setUint32(DATA_SIZE_OFFSET, audioBytes, true);

  return bytes;
}

describe("WAV metadata", () => {
  it("reads PCM parameters and duration", () => {
    expect(parseWavMetadata([{ path: "one.wav", bytes: wave(2, SAMPLE_RATE, SAMPLE_BITS, AUDIO_BYTES) }], parser).nodes).toEqual([{ id: "one", path: "one.wav", channels: 2, sampleRate: SAMPLE_RATE, byteRate: AUDIO_BYTES, blockAlign: ALIGNMENT, bitsPerSample: SAMPLE_BITS, dataBytes: AUDIO_BYTES, duration: 1, issue: null }]);
  });
  it("records the publisher's empty file with zero sample width as invalid", () => {
    expect(parseWavMetadata([{ path: "empty.wav", bytes: wave(1, EMPTY_RATE, 0, 0) }], parser).nodes).toEqual([{ id: "empty", path: "empty.wav", channels: 1, sampleRate: EMPTY_RATE, byteRate: 0, blockAlign: 0, bitsPerSample: 0, dataBytes: 0, duration: null, issue: "invalid PCM format parameters or data length" }]);
  });
  it("skips an odd-sized padded chunk before the PCM format", () => {
    const base = wave(1, EMPTY_RATE, SAMPLE_BITS, 2);
    const bytes = new Uint8Array(base.length + JUNK_CHUNK_BYTES);
    bytes.set(base.subarray(0, RIFF_HEADER_BYTES));
    bytes.set(new TextEncoder().encode("JUNK"), RIFF_HEADER_BYTES);
    const view = new DataView(bytes.buffer);
    view.setUint32(RIFF_HEADER_BYTES + RIFF_SIZE_OFFSET, 1, true);
    bytes.set(base.subarray(RIFF_HEADER_BYTES), RIFF_HEADER_BYTES + JUNK_CHUNK_BYTES);
    view.setUint32(RIFF_SIZE_OFFSET, bytes.length - RIFF_CONTENT_OFFSET, true);
    expect(parseWavMetadata([{ path: "one.wav", bytes }], parser).nodes[0]).toMatchObject({ sampleRate: EMPTY_RATE, issue: null });
  });
  it("rejects non-PCM audio", () => {
    const bytes = wave(1, EMPTY_RATE, SAMPLE_BITS, 2);
    new DataView(bytes.buffer).setUint16(FORMAT_OFFSET, 2, true);
    expect(() => parseWavMetadata([{ path: "one.wav", bytes }], parser)).toThrow(/expected PCM/);
  });
  it("rejects a truncated RIFF and repeated identifiers", () => {
    expect(() => parseWavMetadata([{ path: "one.wav", bytes: wave(1, EMPTY_RATE, SAMPLE_BITS, 2).subarray(0, HEADER_BYTES) }], parser)).toThrow(/RIFF size/);
    expect(() => parseWavMetadata([{ path: "one.wav", bytes: wave(1, EMPTY_RATE, SAMPLE_BITS, 2) }, { path: "one.wav", bytes: wave(1, EMPTY_RATE, SAMPLE_BITS, 2) }], parser)).toThrow(/two files/);
  });
});
