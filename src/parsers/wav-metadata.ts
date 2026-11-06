import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";
import { memberId } from "./member-id";

type WavParser = Extract<Parser, { format: "wav-metadata" }>;
const FORMAT = "wav-metadata";
const RIFF_HEADER = 12;
const CHUNK_HEADER = 8;
const PCM_FORMAT_BYTES = 16;
const FOURCC_BYTES = 4;
const RIFF_KIND_OFFSET = 8;
const CHANNELS_OFFSET = 2;
const RATE_OFFSET = 4;
const BYTE_RATE_OFFSET = 8;
const ALIGN_OFFSET = 12;
const BITS_OFFSET = 14;
const BITS_PER_BYTE = 8;

/** Reads PCM WAV headers into recording metadata without retaining the audio. Invalid PCM parameters are recorded on the row so an empty defective source file remains visible. */
export function parseWavMetadata(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<WavParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const position = index + 1;
    const fail = (reason: string): never => { throw new NativeParseError(FORMAT, position, `${file.path}: ${reason}`); };
    const id = memberId(FORMAT, file.path, parser.idPattern, position);
    if (seen.has(id)) fail(`the id ${id} is given by two files`);
    seen.add(id);
    const { bytes } = file;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const text = (start: number, length: number): string => String.fromCharCode(...bytes.subarray(start, start + length));
    if (bytes.length < RIFF_HEADER || text(0, FOURCC_BYTES) !== "RIFF" || text(RIFF_KIND_OFFSET, FOURCC_BYTES) !== "WAVE") fail("expected a RIFF WAVE file");
    if (view.getUint32(FOURCC_BYTES, true) + CHUNK_HEADER !== bytes.length) fail("the RIFF size does not match the file");
    let format: { channels: number; sampleRate: number; byteRate: number; blockAlign: number; bitsPerSample: number } | undefined;
    let dataBytes: number | undefined;
    for (let offset = RIFF_HEADER; offset < bytes.length;) {
      if (offset + CHUNK_HEADER > bytes.length) fail("truncated chunk header");
      const kind = text(offset, FOURCC_BYTES);
      const size = view.getUint32(offset + FOURCC_BYTES, true);
      const start = offset + CHUNK_HEADER;
      const end = start + size;
      if (end + size % 2 > bytes.length) fail(`truncated ${kind} chunk`);
      if (kind === "fmt ") {
        if (format !== undefined || size < PCM_FORMAT_BYTES) fail("invalid or repeated format chunk");
        if (view.getUint16(start, true) !== 1) fail("expected PCM audio");
        format = { channels: view.getUint16(start + CHANNELS_OFFSET, true), sampleRate: view.getUint32(start + RATE_OFFSET, true), byteRate: view.getUint32(start + BYTE_RATE_OFFSET, true), blockAlign: view.getUint16(start + ALIGN_OFFSET, true), bitsPerSample: view.getUint16(start + BITS_OFFSET, true) };
      } else if (kind === "data") {
        if (dataBytes !== undefined) fail("repeated data chunk");
        dataBytes = size;
      }
      offset = end + size % 2;
    }
    if (format === undefined || dataBytes === undefined) throw new NativeParseError(FORMAT, position, `${file.path}: missing format or data chunk`);
    const { channels, sampleRate, byteRate, blockAlign, bitsPerSample } = format;
    const expectedAlign = channels * bitsPerSample / BITS_PER_BYTE;
    const valid = channels > 0 && sampleRate > 0 && bitsPerSample > 0 && bitsPerSample % BITS_PER_BYTE === 0 && blockAlign === expectedAlign && byteRate === sampleRate * blockAlign && dataBytes % blockAlign === 0;
    nodes.push({ id, path: file.path, channels, sampleRate, byteRate, blockAlign, bitsPerSample, dataBytes, duration: valid ? dataBytes / byteRate : null, issue: valid ? null : "invalid PCM format parameters or data length" });
  }

  return { nodes };
}
