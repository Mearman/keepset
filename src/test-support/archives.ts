import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { zipSync } from "fflate";
import { BLOCK, CHECKSUM_FILL, HEADER } from "../node/tar";
import { SATURATED_16, SATURATED_32, U16, U32, U64, ZIP_SIGNATURES } from "../node/zip";

const OCTAL = 8;
const FILE_MODE = 0o644;

/** A header field's position in the ustar header. */
interface Field {
  readonly offset: number;
  readonly length: number;
}

function writeField(header: Uint8Array, at: Field, text: string): void {
  header.set(new TextEncoder().encode(text).subarray(0, at.length), at.offset);
}

/** Octal text filling a numeric field: zero-padded digits, then a NUL. */
function octal(value: number, at: Field): string {
  return `${value.toString(OCTAL).padStart(at.length - 1, "0")}\0`;
}

/** One file to put in a test archive. Type `5` writes a directory, `L` a GNU long-name record. */
export interface ArchiveFile {
  readonly path: string;
  readonly text: string;
  readonly type?: string;
}

/**
 * Writes a ustar archive, with a correct checksum on every header and a GNU long-name record before any path longer than the name field holds.
 * @param files - The members.
 * @returns The archive bytes.
 */
export function tar(files: readonly ArchiveFile[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const member = (path: string, data: Uint8Array, type: string): void => {
    const header = new Uint8Array(BLOCK);
    writeField(header, HEADER.name, path);
    writeField(header, HEADER.mode, octal(FILE_MODE, HEADER.mode));
    writeField(header, HEADER.size, octal(data.length, HEADER.size));
    writeField(header, HEADER.type, type);
    writeField(header, HEADER.magic, "ustar\0");
    writeField(header, HEADER.version, "00");
    header.fill(CHECKSUM_FILL, HEADER.checksum.offset, HEADER.checksum.offset + HEADER.checksum.length);
    const sum = header.reduce((total, byte) => total + byte, 0);
    // The checksum field is six octal digits, a NUL and a space.
    writeField(header, HEADER.checksum, `${sum.toString(OCTAL).padStart(HEADER.checksum.length - 2, "0")}\0 `);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
    padded.set(data);
    blocks.push(padded);
  };
  for (const file of files) {
    const data = new TextEncoder().encode(file.text);
    if (file.path.length > HEADER.name.length) {
      member("././@LongLink", new TextEncoder().encode(`${file.path}\0`), "L");
    }
    member(file.path.slice(0, HEADER.name.length), data, file.type ?? "0");
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(blocks.reduce((total, block) => total + block.length, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }

  return out;
}

/**
 * Writes a zip archive.
 * @param files - The members.
 * @returns The archive bytes.
 */
export function zip(files: readonly ArchiveFile[]): Uint8Array {
  return zipSync(Object.fromEntries(files.map((file) => [file.path, new TextEncoder().encode(file.text)])));
}

/**
 * Gzips text or bytes.
 * @param data - The data.
 * @returns The gzip bytes.
 */
export function gzip(data: string | Uint8Array): Uint8Array {
  return gzipSync(typeof data === "string" ? new TextEncoder().encode(data) : data);
}

/** The parts of a minimal workbook, as the files a spreadsheet application writes them. */
export interface WorkbookParts {
  /** The sheets by name: the worksheet XML of each, as a string. */
  readonly sheets: Readonly<Record<string, string>>;
  readonly sharedStrings?: readonly string[];
  /** The `cellXfs` number format ids by style index, and any custom formats by id. */
  readonly styles?: { readonly cellFormats: readonly number[]; readonly custom?: Readonly<Record<number, string>> };
  readonly date1904?: boolean;
}

/**
 * Writes an xlsx workbook: a zip of the parts a reader needs, with a relationship for each sheet.
 * @param parts - The sheets, shared strings and styles.
 * @returns The workbook bytes.
 */
export function workbook(parts: WorkbookParts): Uint8Array {
  const names = Object.keys(parts.sheets);
  const files: ArchiveFile[] = [
    { path: "[Content_Types].xml", text: "<Types/>" },
    { path: "xl/workbook.xml", text: `<workbook xmlns:r="r"><workbookPr${parts.date1904 === true ? ' date1904="1"' : ""}/><sheets>${names.map((name, index) => `<sheet name="${name}" sheetId="${String(index + 1)}" r:id="rId${String(index + 1)}"/>`).join("")}</sheets></workbook>` },
    { path: "xl/_rels/workbook.xml.rels", text: `<Relationships>${names.map((_name, index) => `<Relationship Id="rId${String(index + 1)}" Target="worksheets/sheet${String(index + 1)}.xml"/>`).join("")}</Relationships>` },
    ...names.map((name, index) => ({ path: `xl/worksheets/sheet${String(index + 1)}.xml`, text: `<worksheet><sheetData>${parts.sheets[name] ?? ""}</sheetData></worksheet>` })),
  ];
  if (parts.sharedStrings !== undefined) {
    files.push({ path: "xl/sharedStrings.xml", text: `<sst>${parts.sharedStrings.map((text) => (text.startsWith("<") ? `<si>${text}</si>` : `<si><t>${text}</t></si>`)).join("")}</sst>` });
  }
  if (parts.styles !== undefined) {
    const custom = Object.entries(parts.styles.custom ?? {}).map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code.replaceAll('"', "&quot;")}"/>`).join("");
    files.push({ path: "xl/styles.xml", text: `<styleSheet><numFmts>${custom}</numFmts><cellXfs>${parts.styles.cellFormats.map((id) => `<xf numFmtId="${String(id)}"/>`).join("")}</cellXfs></styleSheet>` });
  }

  return zip(files);
}

/**
 * Compresses bytes with the system `bzip2`, the reference implementation, since Node has no bzip2 encoder. Compressing as separate calls and concatenating the results gives a multi-stream file, which `bzip2 -d` reads as one.
 * @param data - The text or bytes to compress.
 * @returns A single bzip2 stream.
 */
export function bzip2(data: string | Uint8Array): Uint8Array {
  return execFileSync("bzip2", ["-c"], { input: typeof data === "string" ? new TextEncoder().encode(data) : data, maxBuffer: Number.MAX_SAFE_INTEGER });
}

/**
 * Writes an OpenDocument spreadsheet: a zip whose `mimetype` and `content.xml` hold the tables given.
 * @param tables - Each table's rows as the XML inside its `table:table` element, by name.
 * @returns The spreadsheet bytes.
 */
export function odsSpreadsheet(tables: Readonly<Record<string, string>>): Uint8Array {
  const body = Object.entries(tables)
    .map(([name, rows]) => `<table:table table:name="${name}"><table:table-column table:number-columns-repeated="1024"/>${rows}</table:table>`)
    .join("");

  return zip([
    { path: "mimetype", text: "application/vnd.oasis.opendocument.spreadsheet" },
    { path: "content.xml", text: `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.3"><office:body><office:spreadsheet>${body}</office:spreadsheet></office:body></office:document-content>` },
  ]);
}

/** The zip64 extended information extra field's id, the version that needs it, and the length of its three 64-bit values. */
const ZIP64_EXTRA_ID = 1;
const ZIP64_VERSION = 45;
const ZIP64_EXTRA_VALUES = 3;
const ZIP64_END_RECORD_LENGTH = 44;
const ZIP64_DISKS = 1;
const BYTE_BITS = 8;
const WORD = 2 ** (BYTE_BITS * U32);

/**
 * A little-endian unsigned integer of a given width, as bytes.
 * @param width - How many bytes.
 * @param value - The number, below 2^53.
 * @returns The bytes, least significant first.
 */
function littleEndian(width: number, value: number): number[] {
  return Array.from({ length: width }, (_, index) => Math.floor(value / 2 ** (BYTE_BITS * index)) % 2 ** BYTE_BITS);
}
const u16 = (value: number): number[] => littleEndian(U16, value);
const u32 = (value: number): number[] => littleEndian(U32, value);
const u64 = (value: number): number[] => [...u32(value % WORD), ...u32(Math.floor(value / WORD))];

/** How a hand-built zip64 member states itself: its compression method and general purpose flags, which a test sets to provoke a refusal. */
export interface Zip64Options {
  readonly method: number;
  readonly flags: number;
}

/**
 * Writes a one-member zip whose central directory entry and end records carry their sizes and offsets in zip64 form (saturated 32-bit fields with zip64 extra fields), the form an archive over 4 GiB takes; the values are small, so the archive can be built in memory.
 * @param name - The member's name.
 * @param data - Its bytes, stored as they are.
 * @param options - The method and flags the central directory states.
 * @returns The archive.
 */
export function zip64(name: string, data: Uint8Array, options: Readonly<Zip64Options> = { method: 0, flags: 0 }): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const { method, flags } = options;
  const local = [...u32(ZIP_SIGNATURES.localHeader), ...u16(ZIP64_VERSION), ...u16(flags), ...u16(method), ...u16(0), ...u16(0), ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...nameBytes, ...data];
  const values = [...u64(data.length), ...u64(data.length), ...u64(0)];
  const extra = [...u16(ZIP64_EXTRA_ID), ...u16(U64 * ZIP64_EXTRA_VALUES), ...values];
  const central = [
    ...u32(ZIP_SIGNATURES.centralEntry), ...u16(ZIP64_VERSION), ...u16(ZIP64_VERSION), ...u16(flags), ...u16(method), ...u16(0), ...u16(0), ...u32(0),
    ...u32(SATURATED_32), ...u32(SATURATED_32), ...u16(nameBytes.length), ...u16(extra.length), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(SATURATED_32),
    ...nameBytes, ...extra,
  ];
  const directoryAt = local.length;
  const zip64End = [...u32(ZIP_SIGNATURES.zip64EndOfCentralDirectory), ...u64(ZIP64_END_RECORD_LENGTH), ...u16(ZIP64_VERSION), ...u16(ZIP64_VERSION), ...u32(0), ...u32(0), ...u64(1), ...u64(1), ...u64(central.length), ...u64(directoryAt)];
  const locator = [...u32(ZIP_SIGNATURES.zip64Locator), ...u32(0), ...u64(directoryAt + central.length), ...u32(ZIP64_DISKS)];
  const end = [...u32(ZIP_SIGNATURES.endOfCentralDirectory), ...u16(0), ...u16(0), ...u16(SATURATED_16), ...u16(SATURATED_16), ...u32(SATURATED_32), ...u32(SATURATED_32), ...u16(0)];

  return Uint8Array.from([...local, ...central, ...zip64End, ...locator, ...end]);
}
