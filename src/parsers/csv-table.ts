import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";

type CsvTableParser = Extract<Parser, { format: "csv-table" }>;

/** The character each delimiter option splits fields on. */
const DELIMITERS: Readonly<Record<CsvTableParser["delimiter"], string>> = { comma: ",", tab: "\t", semicolon: ";" };

/** A number as a decimal literal, with an optional sign and exponent. `Number` alone would also accept hex, binary, `Infinity` and the empty string. */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** The byte order mark some exporters put before the first header. */
const BYTE_ORDER_MARK = "﻿";

/**
 * The name the parser gives a column: the header with every run of characters outside letters, digits and underscore replaced by one underscore, leading and trailing underscores dropped, and a name starting with a digit prefixed with `c_`. A header with nothing left (an empty cell, as in a table exported with an unnamed index column) is `column_` and its 1-based position. The rule depends on the header and its position alone, so a crosswalk written against a file's headers reads the same wherever it runs.
 * @param header - A header cell.
 * @param position - The cell's 1-based position among the header cells.
 * @returns The column name.
 */
export function columnName(header: string, position: number): string {
  const name = header
    .trim()
    .replaceAll(/[^A-Za-z0-9_]+/g, "_")
    .replaceAll(/^_+|_+$/g, "");
  if (name === "") {
    return `column_${String(position)}`;
  }

  return /^\d/.test(name) ? `c_${name}` : name;
}

/**
 * The names the parser gives a header row's cells, one per cell in order: each cell's `columnName`, except that `id` is the row's id, so a cell of that name which is not the id column is named by its position, as an unnamed one is. The id column is among them; it is only left out of a row's other columns.
 * @param cells - The header cells.
 * @param idColumn - The recipe's id column, or null for the row number.
 * @param line - The 1-based line of the header, for the error.
 * @returns The names.
 * @throws NativeParseError when two cells get the same name.
 */
export function columnNames(cells: readonly string[], idColumn: string | null, line: number): string[] {
  const names: string[] = [];
  for (const [position, cell] of cells.entries()) {
    const named = columnName(cell, position + 1);
    const name = named === "id" && idColumn !== "id" ? `column_${String(position + 1)}` : named;
    const clash = names.indexOf(name);
    if (clash !== -1) {
      throw new NativeParseError("csv-table", line, `header cells ${String(clash + 1)} and ${String(position + 1)} both become the column ${name}`);
    }
    names.push(name);
  }

  return names;
}

/** One record of the file: its fields and the 1-based line it starts on. */
interface CsvRecord {
  readonly line: number;
  readonly fields: readonly string[];
}

/** The code unit of each character the scanner stops at. */
const QUOTE = '"'.charCodeAt(0);
const LINE_FEED = "\n".charCodeAt(0);
const CARRIAGE_RETURN = "\r".charCodeAt(0);

/** Scans a table file's text as it arrives in pieces, holding what a record in progress needs between them: the fields and field so far, whether a quoted field is open, and the line the record began on and the line the scan has reached. */
class RecordScanner {
  private fields: string[] = [];

  private field = "";

  private quoted = false;

  private started: number;

  private line: number;

  public constructor(
    private readonly delimiterCode: number,
    firstLine: number,
    private readonly quoting: boolean,
  ) {
    this.started = firstLine;
    this.line = firstLine;
  }

  /**
   * Scans text, returning the records it completes.
   * @param text - The unscanned text.
   * @param final - Whether no more text follows, so a character that needs the next one to be understood can be taken as it stands.
   * @returns The records the text completes, and the unscanned end of it, which starts at a character that needs the next one when more text may follow.
   * @throws NativeParseError when a quote opens inside an unquoted field.
   */
  public scan(text: string, final: boolean): { readonly completed: CsvRecord[]; readonly carry: string } {
    const completed: CsvRecord[] = [];
    let index = 0;
    while (index < text.length) {
      if (this.quoted) {
        const close = text.indexOf('"', index);
        const end = close === -1 ? text.length : close;
        const run = text.slice(index, end);
        for (let at = run.indexOf("\n"); at !== -1; at = run.indexOf("\n", at + 1)) {
          this.line += 1;
        }
        this.field += run;
        index = end;
        if (close === -1) {
          break;
        }
        if (index + 1 >= text.length && !final) {
          return { completed, carry: text.slice(index) };
        }
        if (text.charCodeAt(index + 1) === QUOTE) {
          this.field += '"';
          index += 2;
        } else {
          this.quoted = false;
          index += 1;
        }
        continue;
      }
      const code = text.charCodeAt(index);
      if (code === QUOTE && this.quoting) {
        if (this.field !== "") {
          throw new NativeParseError("csv-table", this.line, "a quote opens inside an unquoted field");
        }
        this.quoted = true;
        index += 1;
      } else if (code === this.delimiterCode) {
        this.fields.push(this.field);
        this.field = "";
        index += 1;
      } else if (code === LINE_FEED || code === CARRIAGE_RETURN) {
        if (code === CARRIAGE_RETURN && index + 1 >= text.length && !final) {
          return { completed, carry: text.slice(index) };
        }
        index += code === CARRIAGE_RETURN && text.charCodeAt(index + 1) === LINE_FEED ? 2 : 1;
        this.line += 1;
        completed.push(this.endRecord());
      } else {
        let next = index + 1;
        while (next < text.length) {
          const following = text.charCodeAt(next);
          if ((following === QUOTE && this.quoting) || following === this.delimiterCode || following === LINE_FEED || following === CARRIAGE_RETURN) {
            break;
          }
          next += 1;
        }
        this.field += text.slice(index, next);
        index = next;
      }
    }

    return { completed, carry: "" };
  }

  /**
   * The record left unfinished when the text ends without a line break, if any.
   * @returns The record, or undefined when the text ended on a line break.
   * @throws NativeParseError when a quoted field is never closed.
   */
  public finish(): CsvRecord | undefined {
    if (this.quoted) {
      throw new NativeParseError("csv-table", this.started, "a quoted field is never closed");
    }

    return this.field !== "" || this.fields.length > 0 ? this.endRecord() : undefined;
  }

  private endRecord(): CsvRecord {
    this.fields.push(this.field);
    const record = { line: this.started, fields: this.fields };
    this.fields = [];
    this.field = "";
    this.started = this.line;

    return record;
  }
}

/** The options a record reader takes from the recipe's table parser: how fields are delimited and how many physical lines come before the header. */
type RecordOptions = Readonly<Pick<CsvTableParser, "delimiter" | "skipLines" | "unquoted">>;

/**
 * Reads a table file's records as its text arrives in pieces, so neither the whole file nor every cell is held at once: a leading byte order mark is removed, the physical lines the recipe skips are dropped, and the rest is split into records and fields by RFC 4180, or without quoting when the recipe says the file has none, a double quote then being an ordinary character (a field may be quoted, a quoted field may hold the delimiter, line breaks and doubled quotes, and a record ends at an unquoted LF, CRLF or CR). Blank lines are not records. A piece may end anywhere, even between the two quotes of a doubled quote or between a CR and its LF.
 */
class RecordReader {
  private readonly scanner: RecordScanner;

  private carry = "";

  private first = true;

  private toSkip: number;

  public constructor(private readonly options: RecordOptions) {
    this.scanner = new RecordScanner(DELIMITERS[options.delimiter].charCodeAt(0), options.skipLines + 1, options.unquoted !== true);
    this.toSkip = options.skipLines;
  }

  /**
   * Reads the next piece of the file's text.
   * @param piece - The text, which follows the pieces read before it.
   * @returns The records the piece completes, in order.
   * @throws NativeParseError when a quote opens inside an unquoted field.
   */
  public push(piece: string): CsvRecord[] {
    let rest = this.first && piece.startsWith(BYTE_ORDER_MARK) ? piece.slice(BYTE_ORDER_MARK.length) : piece;
    this.first = false;
    while (this.toSkip > 0) {
      const next = rest.indexOf("\n");
      if (next === -1) {
        return [];
      }
      rest = rest.slice(next + 1);
      this.toSkip -= 1;
    }
    if (rest === "") {
      return [];
    }
    const scanned = this.scanner.scan(this.carry + rest, false);
    this.carry = scanned.carry;

    return scanned.completed.filter(isNotBlank);
  }

  /**
   * Ends the file.
   * @returns The records left when the text ends, in order.
   * @throws NativeParseError when a quoted field is never closed, a quote opens inside an unquoted field, or the file has fewer lines than the recipe skips.
   */
  public end(): CsvRecord[] {
    if (this.toSkip > 0) {
      throw new NativeParseError("csv-table", this.options.skipLines - this.toSkip + 1, `the file has fewer than ${String(this.options.skipLines)} lines to skip before the header`);
    }
    const completed = this.scanner.scan(this.carry, true).completed;
    this.carry = "";
    const last = this.scanner.finish();

    return [...completed, ...(last === undefined ? [] : [last])].filter(isNotBlank);
  }
}

/**
 * Splits comma-separated text into its records' fields by RFC 4180, as the record reader does, keeping every record (blank lines included) at its position: the grid a workbook sheet's CSV makes, for a parser that reads a layout of blocks and not one table.
 * @param text - The text.
 * @returns Each record's fields, in order.
 * @throws NativeParseError when a quoted field is never closed or a quote opens inside an unquoted field.
 */
export function csvGrid(text: string): (readonly string[])[] {
  const scanner = new RecordScanner(DELIMITERS.comma.charCodeAt(0), 1, true);
  const { completed } = scanner.scan(text, true);
  const last = scanner.finish();

  return [...completed, ...(last === undefined ? [] : [last])].map((record) => record.fields);
}

/**
 * Whether a record holds anything: a blank line is a record of one empty field.
 * @param record - The record.
 * @returns False for a blank line.
 */
function isNotBlank(record: CsvRecord): boolean {
  return record.fields.length > 1 || record.fields[0]?.trim() !== "";
}

/**
 * The records of a table file after the lines the recipe skips and without its blank lines: the header first, then the rows, one at a time.
 * @param text - The file text, or its pieces in order, which may begin with a byte order mark.
 * @param options - The recipe's table parser, of which the delimiter and the lines to skip are read.
 * @returns Each record.
 * @throws NativeParseError when a quote is never closed or opens inside an unquoted field, or the file has fewer lines than the recipe skips.
 */
function* tableRecords(text: string | Iterable<string>, options: RecordOptions): Generator<CsvRecord, void, undefined> {
  const reader = new RecordReader(options);
  for (const piece of typeof text === "string" ? [text] : text) {
    yield* reader.push(piece);
  }
  yield* reader.end();
}

/**
 * Reads a numeric cell.
 * @param cell - The trimmed cell.
 * @param factor - What the recipe multiplies the value by, to put it in the target's unit.
 * @param column - The column, for the error.
 * @param line - The 1-based line, for the error.
 * @returns The number, or null for an empty cell.
 * @throws NativeParseError when the cell is not a decimal number.
 */
function numeric(cell: string, factor: number, column: string, line: number): number | null {
  if (cell === "") {
    return null;
  }
  if (!DECIMAL.test(cell)) {
    throw new NativeParseError("csv-table", line, `column ${column} is declared numeric but holds ${JSON.stringify(cell)}`);
  }

  return Number(cell) * factor;
}

/**
 * The cells of a table's header row exactly as the file writes them, which is what a curation records so the parser's column names can be derived from it.
 * @param text - The file text, or the start of it cut at a line break.
 * @param options - The recipe's table parser, of which the delimiter and the lines to skip are read.
 * @returns The header cells, trimmed of nothing.
 * @throws NativeParseError when the text has no header row or a quote is malformed.
 */
export function headerCells(text: string, options: RecordOptions): readonly string[] {
  const { value: header } = tableRecords(text, options).next();
  if (header === undefined) {
    throw new NativeParseError("csv-table", options.skipLines + 1, "the file has no header row");
  }

  return header.fields;
}

/** How the rows of a table are built once its header is read: the header's width, where the id is, and each kept column's name, position and numeric factor. */
interface RowLayout {
  readonly width: number;
  readonly idPosition: number;
  readonly kept: readonly { readonly name: string; readonly position: number; readonly factor: number | undefined }[];
}

/**
 * Reads a delimited table into rows as its text arrives in pieces, holding only the record in progress between pieces, so a caller that hands each row on as it is returned holds no more of the table than that. The rows are exactly those `parseCsvTable` gives, in order, with the same errors on the same lines however the text is cut.
 */
export class TableReader {
  private readonly records: RecordReader;

  private layout: RowLayout | undefined;

  private rows = 0;

  private readonly missing: ReadonlySet<string>;

  public constructor(private readonly options: CsvTableParser) {
    this.records = new RecordReader(options);
    this.missing = new Set(options.nullValues ?? []);
    if (options.headerNames !== undefined) {
      this.layout = layoutOf({ fields: [...options.headerNames], line: options.skipLines + 1 }, options);
    }
  }

  /**
   * Reads the next piece of the file's text.
   * @param piece - The text, which follows the pieces read before it.
   * @returns The rows the piece completes, in file order.
   * @throws NativeParseError as `parseCsvTable` does, naming the line of the problem.
   */
  public push(piece: string): NativeRow[] {
    return this.rowsOf(this.records.push(piece));
  }

  /**
   * Ends the file.
   * @returns The rows left when the text ends, in file order.
   * @throws NativeParseError as `parseCsvTable` does, including for a file with no header row unless the recipe names the columns itself.
   */
  public end(): NativeRow[] {
    const rows = this.rowsOf(this.records.end());
    if (this.layout === undefined) {
      throw new NativeParseError("csv-table", this.options.skipLines + 1, "the file has no header row");
    }

    return rows;
  }

  /**
   * Builds the rows of records, the first record of the file being its header.
   * @param records - Records in file order.
   * @returns The rows among them.
   */
  private rowsOf(records: readonly CsvRecord[]): NativeRow[] {
    const rows: NativeRow[] = [];
    for (const record of records) {
      if (this.layout === undefined) {
        this.layout = layoutOf(record, this.options);
      } else {
        rows.push(this.rowOf(record, this.layout));
      }
    }

    return rows;
  }

  /**
   * Builds one row.
   * @param record - A record after the header.
   * @param layout - The header's layout.
   * @returns The row.
   * @throws NativeParseError when the record's width differs from the header's, its id is empty or a numeric cell is not a number.
   */
  private rowOf(record: CsvRecord, layout: RowLayout): NativeRow {
    const { idColumn } = this.options;
    if (record.fields.length !== layout.width) {
      throw new NativeParseError("csv-table", record.line, `the row has ${String(record.fields.length)} fields, the header has ${String(layout.width)}`);
    }
    this.rows += 1;
    const id = idColumn === null ? String(this.rows) : (record.fields[layout.idPosition] ?? "").trim();
    if (id === "") {
      throw new NativeParseError("csv-table", record.line, `the id column ${idColumn ?? ""} is empty`);
    }
    const cells = layout.kept.map(({ name, position, factor }): [string, string | number | null] => {
      const trimmed = (record.fields[position] ?? "").trim();
      const cell = this.missing.has(trimmed) ? "" : trimmed;

      return [name, factor === undefined ? (cell === "" ? null : cell) : numeric(cell, factor, name, record.line)];
    });

    return { ...Object.fromEntries(cells), id };
  }
}

/**
 * Reads a table's header into the layout its rows are built by, checking the recipe against it.
 * @param header - The header record.
 * @param options - The recipe's table parser.
 * @returns The layout.
 * @throws NativeParseError when two header cells get the same name, the recipe names a column the header lacks, lists the id column among the columns, or declares numeric a column it does not keep.
 */
function layoutOf(header: CsvRecord, options: CsvTableParser): RowLayout {
  const names = columnNames(header.fields, options.idColumn, header.line);
  const { idColumn, numericColumns, columns } = options;
  const wanted = new Set(columns ?? names.filter((name) => name !== idColumn));
  for (const named of [...(idColumn === null ? [] : [idColumn]), ...numericColumns.map((entry) => entry.column), ...(columns ?? [])]) {
    if (!names.includes(named)) {
      throw new NativeParseError("csv-table", header.line, `the recipe names the column ${named}, which the header does not have`);
    }
  }
  if (idColumn !== null && wanted.has(idColumn)) {
    throw new NativeParseError("csv-table", header.line, `the id column ${idColumn} is the row's id, so it is not listed among the columns`);
  }
  for (const { column } of numericColumns) {
    if (!wanted.has(column)) {
      throw new NativeParseError("csv-table", header.line, `the column ${column} is declared numeric but is not among the columns kept`);
    }
  }
  const factors = new Map(numericColumns.map((entry) => [entry.column, entry.factor]));

  return {
    width: names.length,
    idPosition: idColumn === null ? -1 : names.indexOf(idColumn),
    kept: names.flatMap((name, position) => (name !== idColumn && wanted.has(name) ? [{ name, position, factor: factors.get(name) }] : [])),
  };
}

/**
 * Parses a delimited table into rows (a cell whose text is one of the recipe's `nullValues` is empty, so null): the first record after `skipLines` lines is the header, each later record is a row (or, when the recipe gives `headerNames`, the file has no header and every record after `skipLines` lines is a row, its cells named by those in order), and every row carries every column but the id column (or, when the recipe lists `columns`, exactly those, so a wide table is not held cell for cell), an empty cell being null. Cells are trimmed. A column the recipe declares numeric is read as a decimal number times its factor and any other column stays a string. `id` is the row's id, so a column of that name which is not the id column is named by its position. A row's id is the cell of the recipe's id column, which is then not also a column, or its 1-based row number when the recipe names none. Blank lines are skipped; a row with a different number of fields than the header, two columns with the same name, and an id cell that is empty are errors.
 * @param text - The file text, or its pieces in order.
 * @param options - The recipe's table parser.
 * @returns The rows, in file order.
 * @throws NativeParseError naming the line of the first problem, including a listed or numeric column the header lacks or a numeric column that is not listed.
 */
export function parseCsvTable(text: string | Iterable<string>, options: CsvTableParser): NativeTable {
  const reader = new TableReader(options);
  const nodes: NativeRow[] = [];
  for (const piece of typeof text === "string" ? [text] : text) {
    for (const row of reader.push(piece)) {
      nodes.push(row);
    }
  }
  for (const row of reader.end()) {
    nodes.push(row);
  }

  return { nodes };
}
