import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";

type JsonTableParser = Extract<Parser, { format: "json-table" }>;

const FORMAT = "json-table";

/** A decimal number as text: an optional sign, digits with an optional fraction, and an optional exponent. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The byte order mark some exporters put at the start of a text file. */
const BYTE_ORDER_MARK = "\uFEFF";

/**
 * Reads one record's field as a table cell.
 * @param record - The record.
 * @param field - The field's name.
 * @param line - The 1-based line of the record, or the record's 1-based position in an array, for the error.
 * @returns The field's string or number, or null when the record lacks the field or holds null or an empty string there.
 * @throws NativeParseError when the field holds anything but a string, a number or null.
 */
function cell(record: Readonly<Record<string, unknown>>, field: string, line: number): string | number | null {
  const value = record[field];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    // An empty string is a missing value, as an empty cell is in a delimited table.
    return value.trim() === "" ? null : value;
  }
  if (typeof value === "number") {
    return value;
  }

  throw new NativeParseError(FORMAT, line, `the field ${field} holds ${typeof value}, not a string or a number`);
}

/**
 * Reads a record's field as a number: a number as it is, decimal text as the number it writes.
 * @param record - The record.
 * @param field - The field's name.
 * @param position - The record's position, for the error.
 * @returns The number, or null when the record lacks the field or holds null or empty text there.
 * @throws NativeParseError when the field holds text that is not a decimal number, or anything but a string, a number or null.
 */
function numberCell(record: Readonly<Record<string, unknown>>, field: string, position: number): number | null {
  const value = cell(record, field, position);
  if (value === null || typeof value === "number") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  if (!DECIMAL.test(trimmed)) {
    throw new NativeParseError(FORMAT, position, `the field ${field} is declared numeric but holds ${JSON.stringify(value)}`);
  }

  return Number(trimmed);
}

/**
 * Narrows a parsed JSON value to a record.
 * @param value - The value.
 * @returns True for an object that is not an array.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds the row of one record.
 * @param value - The parsed record.
 * @param options - The recipe's parser.
 * @param position - The 1-based line of the record in a lines file, or its 1-based position in an array.
 * @returns The row.
 * @throws NativeParseError when the record is not an object, has no id or holds a non-scalar kept field.
 */
function rowOf(value: unknown, options: JsonTableParser, position: number): NativeRow {
  if (!isRecord(value)) {
    throw new NativeParseError(FORMAT, position, "the record is not an object");
  }
  const idFields = typeof options.idField === "string" ? [options.idField] : options.idField;
  const parts = idFields.map((field) => cell(value, field, position));
  if (parts.some((part) => part === null || String(part) === "")) {
    throw new NativeParseError(FORMAT, position, `the id field ${idFields.join(", ")} is missing or empty`);
  }
  const id = parts.map(String).join("/");
  const numeric = new Set(options.numericFields ?? []);
  const cells = options.fields.map((field): [string, string | number | null] => [field, numeric.has(field) ? numberCell(value, field, position) : cell(value, field, position)]);

  return { ...Object.fromEntries(cells), id };
}

/**
 * Parses a file of JSON records into table rows: either one record per line (JSON Lines, as speech manifests are written) or one array of records. Each row has the record's `idField` as its id, as text, and every field the recipe keeps, a string or number as the record holds it and null where the record lacks it. A field the recipe does not keep is left out, as the csv-table parser's `columns` do. A record repeated exactly is read once. Blank lines are skipped.
 * @param text - The file text.
 * @param options - The recipe's parser.
 * @returns The rows, in file order.
 * @throws NativeParseError naming the line (or the array position) of the first problem: text that is not JSON, a record that is not an object, a missing or empty id, a kept field that is not a string, number or null, an id used twice by records that differ, or for an array layout a document that is not an array.
 */
export function parseJsonTable(text: string, options: JsonTableParser): NativeTable {
  const nodes: NativeRow[] = [];
  const seen = new Map<string, string>();
  const add = (value: unknown, position: number): void => {
    const row = rowOf(value, options, position);
    const content = JSON.stringify(row);
    const earlier = seen.get(row.id);
    if (earlier !== undefined) {
      // A record repeated exactly is the same record listed again, so it is read once; the same id on different content is two records sharing an identity, which the target cannot hold.
      if (earlier === content) {
        return;
      }
      throw new NativeParseError(FORMAT, position, `the id ${row.id} is used twice with different content`);
    }
    seen.set(row.id, content);
    nodes.push(row);
  };
  if (options.layout === "array") {
    const parsed = parseJson(text, 1);
    if (!Array.isArray(parsed)) {
      throw new NativeParseError(FORMAT, 1, "the document is not an array of records");
    }
    for (const [index, value] of parsed.entries()) {
      add(value, index + 1);
    }

    return { nodes };
  }
  for (const [index, line] of (text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text).split(/\r\n|\n|\r/).entries()) {
    if (line.trim() !== "") {
      add(parseJson(line, index + 1), index + 1);
    }
  }

  return { nodes };
}

/**
 * Parses JSON text.
 * @param text - The text.
 * @param line - The 1-based line, for the error.
 * @returns The value.
 * @throws NativeParseError when the text is not JSON.
 */
function parseJson(text: string, line: number): unknown {
  try {
    const parsed: unknown = JSON.parse(text);

    return parsed;
  } catch (error) {
    throw new NativeParseError(FORMAT, line, error instanceof Error ? error.message : "the text is not JSON");
  }
}
