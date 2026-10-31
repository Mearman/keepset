import { strToU8, zipSync } from "fflate";
import { CFB_SIGNATURE } from "../parsers/cfb";

/** The layout of the compound files built here: 512-byte sectors, a header sector, one allocation table sector, one directory sector, then the two streams, each padded to the smallest size a stream can have without living in the mini stream. */
const SECTOR = 512;
const UINT16_BYTES = 2;
const UINT32_BYTES = 4;
const STREAM_BYTES = 4096;
const SECTORS_PER_STREAM = STREAM_BYTES / SECTOR;
const FAT_SECTORS = 1;
const FIRST_FAT_SECTOR = 0;
const DIRECTORY_SECTOR = 1;
const WORD_STREAM_FIRST = 2;
const TABLE_STREAM_FIRST = WORD_STREAM_FIRST + SECTORS_PER_STREAM;
const FILE_SECTORS = 1 + FAT_SECTORS + 1 + 2 * SECTORS_PER_STREAM;
const END_OF_CHAIN = 0xffff_fffe;
const FAT_SECTOR = 0xffff_fffd;
const FREE_SECTOR = 0xffff_ffff;

/** Offsets in the compound file header, and the values it is given. */
const MINOR_VERSION_AT = 24;
const MAJOR_VERSION_AT = 26;
const BYTE_ORDER_AT = 28;
const SECTOR_SHIFT_AT = 30;
const MINI_SECTOR_SHIFT_AT = 32;
const FAT_SECTOR_COUNT_AT = 44;
const FIRST_DIRECTORY_SECTOR_AT = 48;
const MINI_STREAM_CUTOFF_AT = 56;
const FIRST_MINI_FAT_SECTOR_AT = 60;
const FIRST_DIFAT_SECTOR_AT = 68;
const DIFAT_AT = 76;
const DIFAT_ENTRIES = 109;
const MINOR_VERSION = 0x003e;
const MAJOR_VERSION = 3;
const LITTLE_ENDIAN_MARK = 0xfffe;
const SECTOR_SHIFT = 9;
const MINI_SECTOR_SHIFT = 6;

/** Offsets in a directory entry, and the object types it holds. */
const DIRECTORY_ENTRY_BYTES = 128;
const NAME_LENGTH_AT = 64;
const OBJECT_TYPE_AT = 66;
const START_SECTOR_AT = 116;
const SIZE_AT = 120;
const ROOT_STORAGE = 5;
const STREAM_OBJECT = 2;

/** Offsets in the Word file information block and the values the text is laid out with. */
const FIB_IDENT_AT = 0x00;
const FIB_FLAGS_AT = 0x0a;
const FIB_CCP_TEXT_AT = 0x4c;
const FIB_FC_CLX_AT = 0x1a2;
const FIB_LCB_CLX_AT = 0x1a6;
const WORD_IDENT = 0xa5ec;
const FLAG_TABLE_STREAM_1 = 0x0200;
const FLAG_ENCRYPTED = 0x0100;
const TEXT_OFFSET = 0x200;
const COMPRESSED_PIECE = 0x4000_0000;
const COMPRESSED_OFFSET_SCALE = 2;

/** The shapes in the table stream: a property modifier group (one byte for its kind, two for its size and two of data) before the piece table, which holds a kind byte, a size, one more character position than pieces and eight bytes for each piece. */
const PROPERTY_GROUP_KIND = 0x01;
const PROPERTY_GROUP_DATA_BYTES = 2;
const PROPERTY_GROUP_BYTES = 1 + UINT16_BYTES + PROPERTY_GROUP_DATA_BYTES;
const PIECE_TABLE_KIND = 0x02;
const PIECE_BYTES = 8;
const PIECE_FC_AT = 2;

/** One run of characters of a document's text, stored as the Word binary format stores a piece: one byte each in code page 1252 (`compressed`), or UTF-16. */
export interface WordPiece {
  readonly text: string;
  readonly compressed: boolean;
}

/** What a built `.doc` can be told: `encrypted` sets the encryption flag, and `tableStream` picks which table stream the file uses (`1Table` unless it says `0Table`). */
export interface WordDocOptions {
  readonly encrypted?: boolean;
  readonly tableStream?: "0Table" | "1Table";
}

/**
 * Writes a compound file holding the two streams of a Word document.
 * @param word - The `WordDocument` stream, as long as a padded stream.
 * @param table - The table stream, as long as a padded stream.
 * @param tableName - The table stream's name (`0Table` or `1Table`).
 * @returns The file's bytes.
 */
function compoundFile(word: Uint8Array, table: Uint8Array, tableName: string): Uint8Array {
  const file = new Uint8Array(SECTOR * FILE_SECTORS);
  const view = new DataView(file.buffer);
  const sectorAt = (sector: number): number => SECTOR * (1 + sector);
  file.set(CFB_SIGNATURE, 0);
  view.setUint16(MINOR_VERSION_AT, MINOR_VERSION, true);
  view.setUint16(MAJOR_VERSION_AT, MAJOR_VERSION, true);
  view.setUint16(BYTE_ORDER_AT, LITTLE_ENDIAN_MARK, true);
  view.setUint16(SECTOR_SHIFT_AT, SECTOR_SHIFT, true);
  view.setUint16(MINI_SECTOR_SHIFT_AT, MINI_SECTOR_SHIFT, true);
  view.setUint32(FAT_SECTOR_COUNT_AT, FAT_SECTORS, true);
  view.setUint32(FIRST_DIRECTORY_SECTOR_AT, DIRECTORY_SECTOR, true);
  view.setUint32(MINI_STREAM_CUTOFF_AT, STREAM_BYTES, true);
  view.setUint32(FIRST_MINI_FAT_SECTOR_AT, END_OF_CHAIN, true);
  view.setUint32(FIRST_DIFAT_SECTOR_AT, END_OF_CHAIN, true);
  for (let entry = 0; entry < DIFAT_ENTRIES; entry += 1) {
    view.setUint32(DIFAT_AT + entry * UINT32_BYTES, entry === 0 ? FIRST_FAT_SECTOR : FREE_SECTOR, true);
  }

  const fat = new DataView(file.buffer, sectorAt(FIRST_FAT_SECTOR), SECTOR);
  for (let entry = 0; entry < SECTOR / UINT32_BYTES; entry += 1) {
    fat.setUint32(entry * UINT32_BYTES, FREE_SECTOR, true);
  }
  fat.setUint32(FIRST_FAT_SECTOR * UINT32_BYTES, FAT_SECTOR, true);
  fat.setUint32(DIRECTORY_SECTOR * UINT32_BYTES, END_OF_CHAIN, true);
  for (const first of [WORD_STREAM_FIRST, TABLE_STREAM_FIRST]) {
    for (let at = 0; at < SECTORS_PER_STREAM; at += 1) {
      fat.setUint32((first + at) * UINT32_BYTES, at === SECTORS_PER_STREAM - 1 ? END_OF_CHAIN : first + at + 1, true);
    }
  }

  const entries = [
    { name: "Root Entry", type: ROOT_STORAGE, start: END_OF_CHAIN, size: 0 },
    { name: "WordDocument", type: STREAM_OBJECT, start: WORD_STREAM_FIRST, size: STREAM_BYTES },
    { name: tableName, type: STREAM_OBJECT, start: TABLE_STREAM_FIRST, size: STREAM_BYTES },
  ];
  entries.forEach((entry, index) => {
    const at = sectorAt(DIRECTORY_SECTOR) + index * DIRECTORY_ENTRY_BYTES;
    for (let character = 0; character < entry.name.length; character += 1) {
      file[at + character * UINT16_BYTES] = entry.name.charCodeAt(character);
    }
    view.setUint16(at + NAME_LENGTH_AT, (entry.name.length + 1) * UINT16_BYTES, true);
    file[at + OBJECT_TYPE_AT] = entry.type;
    view.setUint32(at + START_SECTOR_AT, entry.start, true);
    view.setUint32(at + SIZE_AT, entry.size, true);
  });

  file.set(word, sectorAt(WORD_STREAM_FIRST));
  file.set(table, sectorAt(TABLE_STREAM_FIRST));

  return file;
}

/**
 * The bytes a piece of text is stored as.
 * @param piece - The piece.
 * @returns One byte a character when compressed, UTF-16 little-endian otherwise.
 */
function pieceBytes(piece: WordPiece): Uint8Array {
  const units = Array.from(piece.text, (character) => character.charCodeAt(0));

  return piece.compressed ? Uint8Array.from(units) : new Uint8Array(new Uint16Array(units).buffer);
}

/**
 * Builds a legacy Word document whose main story is the given pieces.
 * @param pieces - The runs of text, each stored compressed or as UTF-16, in order.
 * @param options - What the document is told; see `WordDocOptions`.
 * @returns The `.doc` file's bytes.
 */
export function wordDoc(pieces: readonly WordPiece[], options: Readonly<WordDocOptions> = {}): Uint8Array {
  const tableName = options.tableStream ?? "1Table";
  const word = new Uint8Array(STREAM_BYTES);
  const table = new Uint8Array(STREAM_BYTES);
  const wordView = new DataView(word.buffer);
  const tableView = new DataView(table.buffer);

  let offset = TEXT_OFFSET;
  let characters = 0;
  const positions = [0];
  const starts: number[] = [];
  for (const piece of pieces) {
    const bytes = pieceBytes(piece);
    word.set(bytes, offset);
    starts.push(piece.compressed ? (offset * COMPRESSED_OFFSET_SCALE) | COMPRESSED_PIECE : offset);
    offset += bytes.length;
    characters += piece.text.length;
    positions.push(characters);
  }

  const pieceTableBytes = UINT32_BYTES + (UINT32_BYTES + PIECE_BYTES) * pieces.length;
  const clxBytes = PROPERTY_GROUP_BYTES + 1 + UINT32_BYTES + pieceTableBytes;
  wordView.setUint16(FIB_IDENT_AT, WORD_IDENT, true);
  wordView.setUint16(FIB_FLAGS_AT, (tableName === "1Table" ? FLAG_TABLE_STREAM_1 : 0) | (options.encrypted === true ? FLAG_ENCRYPTED : 0), true);
  wordView.setUint32(FIB_CCP_TEXT_AT, characters, true);
  wordView.setUint32(FIB_FC_CLX_AT, 0, true);
  wordView.setUint32(FIB_LCB_CLX_AT, clxBytes, true);

  table[0] = PROPERTY_GROUP_KIND;
  tableView.setUint16(1, PROPERTY_GROUP_DATA_BYTES, true);
  table[PROPERTY_GROUP_BYTES] = PIECE_TABLE_KIND;
  tableView.setUint32(PROPERTY_GROUP_BYTES + 1, pieceTableBytes, true);
  const positionsAt = PROPERTY_GROUP_BYTES + 1 + UINT32_BYTES;
  positions.forEach((position, index) => {
    tableView.setUint32(positionsAt + index * UINT32_BYTES, position, true);
  });
  const descriptorsAt = positionsAt + positions.length * UINT32_BYTES;
  starts.forEach((start, index) => {
    tableView.setUint32(descriptorsAt + index * PIECE_BYTES + PIECE_FC_AT, start >>> 0, true);
  });

  return compoundFile(word, table, tableName);
}

/** The WordprocessingML namespace declaration a `document.xml` part starts with. */
const WORD_NAMESPACE = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/**
 * Builds a `.docx` package whose main document has the given body.
 * @param body - The WordprocessingML inside `w:body`.
 * @returns The package's bytes.
 */
export function docx(body: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${WORD_NAMESPACE}><w:body>${body}</w:body></w:document>`),
  });
}
