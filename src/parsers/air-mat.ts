import { unzlibSync } from "fflate";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";

type AirMatParser = Extract<Parser, { format: "air-mat" }>;
type Scalar = string | number | null;

/** MATLAB level 5 element kinds used by the AIR metadata. */
const MATRIX = 14;
const COMPRESSED = 15;
const STRUCT = 2;
const CHAR = 4;
const DOUBLE = 6;
const HEADER_BYTES = 128;
const TAG_BYTES = 8;
const ALIGNMENT = 8;
const FIELD_NAME_LENGTH_BYTES = 4;
const TAG_WORD_BYTES = 4;
const UTF8 = 16;
const UINT8 = 2;
const INT16 = 3;
const UINT16 = 4;
const FLOAT64 = 9;
const ENDIAN_OFFSET = HEADER_BYTES - 2;

interface Element { readonly type: number; readonly data: Uint8Array; readonly next: number }

/** Reads a normal or small MATLAB data element and checks its bounds. */
function element(bytes: Uint8Array, offset: number, compressed = false): Element {
  if (offset + TAG_BYTES > bytes.length) throw new Error("truncated element tag");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const shortSize = view.getUint16(offset + 2, true);
  if (shortSize !== 0) {
    if (shortSize > FIELD_NAME_LENGTH_BYTES) throw new Error("invalid small element length");

    return { type: view.getUint16(offset, true), data: bytes.subarray(offset + TAG_WORD_BYTES, offset + TAG_WORD_BYTES + shortSize), next: offset + TAG_BYTES };
  }
  const type = view.getUint32(offset, true);
  const size = view.getUint32(offset + TAG_WORD_BYTES, true);
  const start = offset + TAG_BYTES;
  const end = start + size;
  if (end > bytes.length) throw new Error("truncated element data");
  const next = compressed && type === COMPRESSED ? end : start + Math.ceil(size / ALIGNMENT) * ALIGNMENT;
  if (next > bytes.length) throw new Error("truncated element padding");

  return { type, data: bytes.subarray(start, end), next };
}

/** Reads a matrix's common header and returns its name, class and remaining subelements. */
function matrix(bytes: Uint8Array): { readonly name: string; readonly kind: number; readonly rest: Uint8Array } {
  const outer = element(bytes, 0);
  if (outer.type !== MATRIX) throw new Error("expected matrix");
  const flags = element(outer.data, 0);
  if (flags.data.length < FIELD_NAME_LENGTH_BYTES) throw new Error("invalid array flags");
  const kind = flags.data[0];
  if (kind === undefined) throw new Error("missing array class");
  const dimensions = element(outer.data, flags.next);
  const name = element(outer.data, dimensions.next);

  return { name: new TextDecoder().decode(name.data), kind, rest: outer.data.subarray(name.next) };
}

/** Reads a character or numeric field. Numeric vectors remain JSON text to fit flat catalogue rows. */
function value(bytes: Uint8Array): Scalar {
  const item = matrix(bytes);
  if (item.kind !== CHAR && item.kind !== DOUBLE) throw new Error(`unsupported field class ${String(item.kind)}`);
  const data = element(item.rest, 0);
  if (item.kind === CHAR) {
    if (data.type !== UTF8) throw new Error("unsupported character encoding");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data.data);

    return text === "" ? null : text;
  }
  const widths: Readonly<Record<number, number>> = { [UINT8]: 1, [INT16]: 2, [UINT16]: 2, [FLOAT64]: 8 };
  const width = widths[data.type];
  if (width === undefined || data.data.length % width !== 0) throw new Error("unsupported numeric field");
  const view = new DataView(data.data.buffer, data.data.byteOffset, data.data.byteLength);
  const values: number[] = [];
  for (let i = 0; i < data.data.length; i += width) {
    const number = data.type === UINT8 ? view.getUint8(i) : data.type === INT16 ? view.getInt16(i, true) : data.type === UINT16 ? view.getUint16(i, true) : view.getFloat64(i, true);
    if (!Number.isFinite(number)) throw new Error("non-finite numeric field");
    values.push(number);
  }
  const first = values[0];
  if (first === undefined) return null;
  if (values.length === 1) return first;

  return JSON.stringify(values);
}

/** Reads the `air_info` scalar structure from one MATLAB level 5 file. */
function info(bytes: Uint8Array): Readonly<Record<string, Scalar>> {
  if (bytes.length < HEADER_BYTES || new TextDecoder().decode(bytes.subarray(ENDIAN_OFFSET, HEADER_BYTES)) !== "IM") throw new Error("expected a little-endian MATLAB level 5 file");
  for (let offset = HEADER_BYTES; offset < bytes.length;) {
    const top = element(bytes, offset, true);
    offset = top.next;
    if (top.type !== COMPRESSED) throw new Error("expected compressed matrix");
    const raw = unzlibSync(top.data);
    const item = matrix(raw);
    if (item.name !== "air_info") continue;
    if (item.kind !== STRUCT) throw new Error("air_info is not a structure");
    const length = element(item.rest, 0);
    if (length.data.length !== FIELD_NAME_LENGTH_BYTES) throw new Error("invalid field name length");
    const width = new DataView(length.data.buffer, length.data.byteOffset, length.data.byteLength).getUint32(0, true);
    const names = element(item.rest, length.next);
    if (width === 0 || names.data.length % width !== 0) throw new Error("invalid field names");
    const result: Record<string, Scalar> = {};
    let at = names.next;
    for (let i = 0; i < names.data.length; i += width) {
      const field = new TextDecoder().decode(names.data.subarray(i, i + width)).split("\0")[0];
      if (field === undefined || field === "" || Object.hasOwn(result, field)) throw new Error("empty or duplicate field name");
      const child = element(item.rest, at);
      result[field] = value(item.rest.subarray(at, child.next));
      at = child.next;
    }

    return result;
  }
  throw new Error("missing air_info structure");
}

/**
 * Reads AIR metadata structures without retaining their impulse-response arrays.
 * @param files - MATLAB members selected from the archive.
 * @param parser - The metadata fields retained by the recipe.
 * @returns One flat row per response; absent fields are null.
 * @throws NativeParseError when a member is malformed or contains an unlisted field.
 */
export function parseAirMat(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<AirMatParser>): NativeTable {
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    try {
      const metadata = info(file.bytes);
      const unknown = Object.keys(metadata).filter((key) => !parser.fields.includes(key));
      if (unknown.length !== 0) throw new Error(`unlisted fields: ${unknown.join(", ")}`);
      nodes.push({ id: file.path, ...Object.fromEntries(parser.fields.map((field) => [field, metadata[field] ?? null])) });
    } catch (error) {
      throw new NativeParseError(parser.format, index + 1, `${file.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { nodes };
}
