/** The CRC-32 that gzip, zip and PNG check their data with (ISO 3309, RFC 1952 section 8), in its reflected form: the polynomial with its bits reversed, each byte folded in least significant bit first. */
const REFLECTED_POLYNOMIAL = 0xedb88320;
const BYTE_BITS = 8;
const BYTE_VALUES = 2 ** BYTE_BITS;
const BYTE_MASK = BYTE_VALUES - 1;
/** How many bytes one step of the sliced update folds in. Each of the tables after the first gives a byte's CRC as though that many zero bytes followed it, so eight bytes cost eight lookups and no dependency between them, which is what lets the update run several bytes per step (slicing-by-8, as zlib's own `crc32` does). */
const SLICES = 8;
/** How many bytes of a step are read as one little-endian word before the four that are looked up byte by byte. */
const WORD_BYTES = 4;
/** The register is complemented before and after the update, as the standard CRC-32 starts from all ones and ends by inverting. */
const ALL_ONES = 0xffffffff;

/**
 * The value a table holds at an index the tables were built to cover.
 * @param table - The tables.
 * @param index - The index, below the tables' length.
 * @returns The entry.
 * @throws RangeError when the index lies outside the tables, which only a fault in this module could cause.
 */
function entry(table: Readonly<Uint32Array>, index: number): number {
  const value = table[index];
  if (value === undefined) {
    throw new RangeError(`CRC-32 table index ${String(index)} is outside the table`);
  }

  return value;
}

/**
 * Builds the lookup tables: the first holds each byte value's CRC, and each later one the previous table's entry carried through one more zero byte.
 * @returns The tables, `SLICES` of `BYTE_VALUES` entries each, one after another.
 */
function buildTables(): Uint32Array {
  const tables = new Uint32Array(SLICES * BYTE_VALUES);
  for (let value = 0; value < BYTE_VALUES; value += 1) {
    let register = value;
    for (let bit = 0; bit < BYTE_BITS; bit += 1) {
      register = (register & 1) === 0 ? register >>> 1 : (register >>> 1) ^ REFLECTED_POLYNOMIAL;
    }
    tables[value] = register;
  }
  for (let slice = 1; slice < SLICES; slice += 1) {
    for (let value = 0; value < BYTE_VALUES; value += 1) {
      const previous = entry(tables, (slice - 1) * BYTE_VALUES + value);
      tables[slice * BYTE_VALUES + value] = (previous >>> BYTE_BITS) ^ entry(tables, previous & BYTE_MASK);
    }
  }

  return tables;
}

const TABLES = buildTables();

/** Where in the tables the one for a byte followed by that many zero bytes starts: the table of one zero byte starts at `BYTE_VALUES`, after the table of none. */
const AFTER_2 = BYTE_VALUES + BYTE_VALUES;
const AFTER_3 = AFTER_2 + BYTE_VALUES;
const AFTER_4 = AFTER_3 + BYTE_VALUES;
const AFTER_5 = AFTER_4 + BYTE_VALUES;
const AFTER_6 = AFTER_5 + BYTE_VALUES;
const AFTER_7 = AFTER_6 + BYTE_VALUES;
/** How far a little-endian word is shifted to bring its third and fourth bytes to the bottom; its second is `BYTE_BITS` away. */
const THIRD_BYTE = BYTE_BITS + BYTE_BITS;
const FOURTH_BYTE = THIRD_BYTE + BYTE_BITS;

/**
 * Carries a CRC-32 over more bytes, so a stream's checksum is the update of each of its pieces in turn, starting from 0, whatever the pieces' sizes.
 * @param crc - The CRC-32 of the bytes before these: 0 for none.
 * @param bytes - The bytes that follow them.
 * @returns The CRC-32 of all the bytes, as an unsigned 32-bit number.
 */
export function updateCrc32(crc: number, bytes: Readonly<Uint8Array>): number {
  let register = (crc ^ ALL_ONES) >>> 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sliced = bytes.length - (bytes.length % SLICES);
  let at = 0;
  for (; at < sliced; at += SLICES) {
    const low = (register ^ view.getUint32(at, true)) >>> 0;
    const high = view.getUint32(at + WORD_BYTES, true);
    // A step's first byte has seven bytes after it in the step, so it is looked up in the table of seven zero bytes, and so on down to the last byte in the table of none.
    register =
      entry(TABLES, AFTER_7 + (low & BYTE_MASK)) ^
      entry(TABLES, AFTER_6 + ((low >>> BYTE_BITS) & BYTE_MASK)) ^
      entry(TABLES, AFTER_5 + ((low >>> THIRD_BYTE) & BYTE_MASK)) ^
      entry(TABLES, AFTER_4 + (low >>> FOURTH_BYTE)) ^
      entry(TABLES, AFTER_3 + (high & BYTE_MASK)) ^
      entry(TABLES, AFTER_2 + ((high >>> BYTE_BITS) & BYTE_MASK)) ^
      entry(TABLES, BYTE_VALUES + ((high >>> THIRD_BYTE) & BYTE_MASK)) ^
      entry(TABLES, high >>> FOURTH_BYTE);
  }
  for (const byte of bytes.subarray(at)) {
    register = (register >>> BYTE_BITS) ^ entry(TABLES, (register ^ byte) & BYTE_MASK);
  }

  return (register ^ ALL_ONES) >>> 0;
}
