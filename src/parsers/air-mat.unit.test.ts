import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { parseAirMat } from "./air-mat";
import type { Parser } from "../entry";

const WORD = 4;
const BLOCK = 8;
const MATRIX = 14;
const UINT32 = 6;
const INT32 = 5;
const CHAR = 4;
const DOUBLE = 6;
const UTF8 = 16;
const COMPRESSED = 15;
const HEADER = 128;
const ENDIAN_OFFSET = HEADER - 2;
const SAMPLE_RATE = 48;
const SIGNAL_SAMPLE = 7;

const parser: Extract<Parser, { format: "air-mat" }> = { format: "air-mat", encoding: "utf-8", fields: ["room", "fs", "HHP_xyz", "misc"] };
const encoder = new TextEncoder();

/** Builds level 5 elements in memory so tests exercise tags, padding and compressed matrices. */
function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }

  return joined;
}
function integers(...values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * WORD);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => { view.setUint32(index * WORD, value, true); });

  return bytes;
}
function element(type: number, data: Uint8Array, padded = true): Uint8Array {
  const pad = padded ? (BLOCK - data.length % BLOCK) % BLOCK : 0;

  return concat(integers(type, data.length), data, new Uint8Array(pad));
}
function matrix(kind: number, name: string, ...body: readonly Uint8Array[]): Uint8Array {
  return element(MATRIX, concat(element(UINT32, integers(kind, 0)), element(INT32, integers(1, 1)), element(1, encoder.encode(name)), ...body));
}
function text(value: string): Uint8Array { return matrix(CHAR, "", element(UTF8, encoder.encode(value))); }
function numeric(values: readonly number[]): Uint8Array { return matrix(DOUBLE, "", element(2, Uint8Array.from(values))); }
function fixture(): Uint8Array {
  const names = new Uint8Array(BLOCK * parser.fields.length);
  ["room", "fs", "HHP_xyz", "misc"].forEach((name, index) => { names.set(encoder.encode(name), index * BLOCK); });
  const info = matrix(2, "air_info", element(INT32, integers(BLOCK)), element(1, names), text("office"), numeric([SAMPLE_RATE]), numeric([0, 1, 2]), text(""));
  const signal = matrix(DOUBLE, "h_air", element(2, Uint8Array.from([SIGNAL_SAMPLE])));
  const header = new Uint8Array(HEADER);
  header.set(encoder.encode("MATLAB 5.0 MAT-file"));
  header.set(encoder.encode("IM"), ENDIAN_OFFSET);

  return concat(header, element(COMPRESSED, zlibSync(signal), false), element(COMPRESSED, zlibSync(info), false));
}

describe("AIR MATLAB metadata", () => {
  it("reads a structure after the signal and retains scalar, empty and vector values", () => {
    expect(parseAirMat([{ path: "air.mat", bytes: fixture() }], { ...parser, fields: [...parser.fields] }).nodes).toEqual([{ id: "air.mat", room: "office", fs: SAMPLE_RATE, HHP_xyz: "[0,1,2]", misc: null }]);
  });
  it("rejects truncated files and unlisted source fields", () => {
    const bytes = fixture();
    expect(() => parseAirMat([{ path: "broken.mat", bytes: bytes.subarray(0, HEADER + 2) }], { ...parser, fields: [...parser.fields] })).toThrow("broken.mat: truncated element tag");
    expect(() => parseAirMat([{ path: "air.mat", bytes }], { ...parser, fields: ["room"] })).toThrow("unlisted fields");
  });
});
