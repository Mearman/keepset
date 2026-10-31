import { NativeParseError } from "../errors";
import { readCompoundFile } from "./cfb";

/** Offsets in the `WordDocument` stream's file information block (the Word 97 to 2003 layout) and in the piece table that follows it. */
const FIB_IDENT = 0x0000;
const FIB_FLAGS = 0x000a;
const FIB_CCP_TEXT = 0x004c;
const FIB_FC_CLX = 0x01a2;
const FIB_LCB_CLX = 0x01a6;
const WORD_IDENT = 0xa5ec;
const FLAG_ENCRYPTED = 0x0100;
const FLAG_TABLE_STREAM_1 = 0x0200;
const CLX_PRC = 0x01;
const CLX_PCDT = 0x02;
const PIECE_BYTES = 8;
const PIECE_FC = 2;
const CP_BYTES = 4;
const UINT16_BYTES = 2;
const COMPRESSED_PIECE = 0x4000_0000;
const PIECE_OFFSET_MASK = 0x3fff_ffff;

/** The control characters a Word text stream holds, besides the paragraph mark. */
const CELL_MARK = 0x07;
const LINE_BREAK = 0x0b;
const PAGE_BREAK = 0x0c;
const PARAGRAPH_MARK = 0x0d;
const FIELD_BEGIN = 0x13;
const FIELD_SEPARATOR = 0x14;
const FIELD_END = 0x15;
const NON_BREAKING_HYPHEN = 0x1e;
const HORIZONTAL_TAB = 0x09;
const FIRST_PRINTABLE = 0x20;

/**
 * The text of a Word 97 to 2003 document's main story, as the piece table gives it: each piece is a run of characters stored either as one byte each (code page 1252) or as UTF-16.
 * @param bytes - The `.doc` file's bytes.
 * @param format - The name of the format being parsed, for errors.
 * @returns The characters, control characters included, in order.
 * @throws NativeParseError when the file is not a Word document, is encrypted or its piece table is malformed.
 */
function mainStory(bytes: Uint8Array, format: string): string {
  const file = readCompoundFile(bytes, format);
  const word = file.stream("WordDocument");
  if (word === undefined) {
    throw new NativeParseError(format, 1, "the compound file holds no WordDocument stream");
  }
  const fib = new DataView(word.buffer, word.byteOffset, word.byteLength);
  if (fib.getUint16(FIB_IDENT, true) !== WORD_IDENT) {
    throw new NativeParseError(format, 1, "the WordDocument stream is not a Word 97 to 2003 document");
  }
  const flags = fib.getUint16(FIB_FLAGS, true);
  if ((flags & FLAG_ENCRYPTED) !== 0) {
    throw new NativeParseError(format, 1, "the document is encrypted");
  }
  const table = file.stream((flags & FLAG_TABLE_STREAM_1) === 0 ? "0Table" : "1Table");
  if (table === undefined) {
    throw new NativeParseError(format, 1, "the compound file holds no table stream");
  }
  const tableView = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const characters = fib.getUint32(FIB_CCP_TEXT, true);

  let at = fib.getUint32(FIB_FC_CLX, true);
  const end = at + fib.getUint32(FIB_LCB_CLX, true);
  while (at < end && table[at] === CLX_PRC) {
    at += 1 + UINT16_BYTES + tableView.getUint16(at + 1, true);
  }
  if (table[at] !== CLX_PCDT) {
    throw new NativeParseError(format, 1, "the document has no piece table");
  }
  const pieceTableBytes = tableView.getUint32(at + 1, true);
  const pieces = (pieceTableBytes - CP_BYTES) / (CP_BYTES + PIECE_BYTES);
  if (!Number.isInteger(pieces) || pieces < 1) {
    throw new NativeParseError(format, 1, "the piece table has a malformed length");
  }
  const cpAt = at + 1 + CP_BYTES;
  const pcdAt = cpAt + (pieces + 1) * CP_BYTES;

  const latin = new TextDecoder("windows-1252");
  const utf16 = new TextDecoder("utf-16le");
  let text = "";
  for (let piece = 0; piece < pieces; piece += 1) {
    const first = tableView.getUint32(cpAt + piece * CP_BYTES, true);
    const last = Math.min(tableView.getUint32(cpAt + (piece + 1) * CP_BYTES, true), characters);
    if (last <= first) {
      continue;
    }
    const fc = tableView.getUint32(pcdAt + piece * PIECE_BYTES + PIECE_FC, true);
    const count = last - first;
    if ((fc & COMPRESSED_PIECE) === 0) {
      const start = fc & PIECE_OFFSET_MASK;
      text += utf16.decode(word.subarray(start, start + count * UINT16_BYTES));
    } else {
      const start = (fc & PIECE_OFFSET_MASK) / 2;
      text += latin.decode(word.subarray(start, start + count));
    }
  }

  return text;
}

/**
 * Turns a Word story's characters into plain text: paragraph marks and line breaks become line feeds, a table's cell marks tabs, a field keeps its displayed result and drops its instruction, and the other control characters (pictures, footnote marks, optional hyphens) are left out.
 * @param story - The story's characters.
 * @returns The text, paragraphs separated by line feeds.
 */
function plainText(story: string): string {
  let text = "";
  let fieldDepth = 0;
  const inInstruction: boolean[] = [];
  for (const character of story) {
    const code = character.codePointAt(0) ?? 0;
    if (code === FIELD_BEGIN) {
      inInstruction.push(true);
      fieldDepth += 1;
    } else if (code === FIELD_SEPARATOR) {
      inInstruction[fieldDepth - 1] = false;
    } else if (code === FIELD_END) {
      inInstruction.pop();
      fieldDepth = Math.max(fieldDepth - 1, 0);
    } else if (!inInstruction.includes(true)) {
      if (code === PARAGRAPH_MARK || code === LINE_BREAK || code === PAGE_BREAK) {
        text += "\n";
      } else if (code === CELL_MARK) {
        text += "\t";
      } else if (code === NON_BREAKING_HYPHEN) {
        text += "-";
      } else if (code >= FIRST_PRINTABLE || code === HORIZONTAL_TAB) {
        text += character;
      }
    }
  }

  return text;
}

/**
 * Reads the text of a legacy Word document (`.doc`, the Word 97 to 2003 binary format).
 * @param bytes - The file's bytes.
 * @param format - The name of the format being parsed, for errors.
 * @returns The main story's plain text, paragraphs separated by line feeds.
 * @throws NativeParseError when the file is not a compound file holding a Word document, is encrypted or its piece table is malformed.
 */
export function readWordDoc(bytes: Uint8Array, format: string): string {
  return plainText(mainStory(bytes, format));
}
