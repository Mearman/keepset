import { NativeParseError } from "../errors";
import { lines } from "./native";

/** A line of a numeric instance file that holds values: its 1-based number in the file and its whitespace-separated fields as written. */
export interface FieldLine {
  readonly line: number;
  readonly fields: readonly string[];
}

/** A decimal as the numeric instance formats write one: optionally signed, with digits on either side of an optional point (`5`, `6.000000`, `.0`). */
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

/** A decimal that may carry an exponent, as the formats written by numeric software do (`25900.20064`, `7.12506e+007`, `5.02e-05`). */
export const SCIENTIFIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A whole number as the numeric instance formats write one, optionally signed. */
const INTEGER = /^[+-]?\d+$/;

/**
 * Splits a file into the lines that hold values, each with its fields, accepting LF and CRLF line ends. A line of only spaces and tabs holds no values and is left out, so a format whose sections are set apart by blank lines (or are not) reads alike.
 * @param text - The file text.
 * @returns The lines with fields, in file order.
 */
export function fieldLines(text: string): FieldLine[] {
  const result: FieldLine[] = [];
  for (const [index, raw] of lines(text).entries()) {
    const fields = raw.trim().split(/\s+/);
    if (fields[0] !== "") {
      result.push({ line: index + 1, fields });
    }
  }

  return result;
}

/** Reads the fields of one format's lines as numbers, naming the format and the line in every error. */
export interface NumberReader {
  /**
   * Reads a field as a finite decimal number.
   * @param field - The field as written.
   * @param line - Its 1-based line.
   * @param what - What the field should be.
   * @returns The number.
   * @throws NativeParseError when the field is not a decimal number.
   */
  readonly decimal: (field: string, line: number, what: string) => number;
  /**
   * Reads a field as a whole number that a double holds exactly.
   * @param field - The field as written.
   * @param line - Its 1-based line.
   * @param what - What the field should be.
   * @returns The number.
   * @throws NativeParseError when the field is not a whole number or is too large to be held exactly.
   */
  readonly integer: (field: string, line: number, what: string) => number;
  /**
   * Reads a field as a count or an index, a whole number of at least `least`.
   * @param field - The field as written.
   * @param line - Its 1-based line.
   * @param what - What the field should be.
   * @param least - The smallest value it may take.
   * @returns The number.
   * @throws NativeParseError when the field is not a whole number of at least `least`.
   */
  readonly count: (field: string, line: number, what: string, least: number) => number;
  /**
   * Reads a line that holds exactly the named fields, in order.
   * @param line - The line.
   * @param names - The names of its fields.
   * @param what - What the line should be.
   * @returns A reader of each field as written, by name.
   * @throws NativeParseError when the line holds another number of fields.
   */
  readonly fields: <const Name extends string>(line: FieldLine, names: readonly Name[], what: string) => (name: Name) => string;
}

/**
 * Makes the number reader of a format.
 * @param format - The parser's format, which every error names.
 * @returns The reader.
 */
export function numberReader(format: string): NumberReader {
  const integer = (field: string, line: number, what: string): number => {
    const value = Number(field);
    if (!INTEGER.test(field) || !Number.isSafeInteger(value)) {
      throw new NativeParseError(format, line, `expected ${what} as a whole number, found ${JSON.stringify(field)}`);
    }

    return value;
  };

  return {
    decimal(field, line, what) {
      if (!DECIMAL.test(field)) {
        throw new NativeParseError(format, line, `expected ${what} as a number, found ${JSON.stringify(field)}`);
      }

      return Number(field);
    },
    integer,
    count(field, line, what, least) {
      const value = integer(field, line, what);
      if (value < least) {
        throw new NativeParseError(format, line, `expected ${what} of at least ${String(least)}, found ${field}`);
      }

      return value;
    },
    fields<const Name extends string>(line: FieldLine, names: readonly Name[], what: string): (name: Name) => string {
      if (line.fields.length !== names.length) {
        throw new NativeParseError(format, line.line, `expected ${what} (${String(names.length)} fields), found ${JSON.stringify(line.fields.join(" "))}`);
      }

      return (name) => {
        const field = line.fields[names.indexOf(name)];
        if (field === undefined) {
          throw new NativeParseError(format, line.line, `${what} has no field ${name}`);
        }

        return field;
      };
    },
  };
}

/**
 * Reads the lines of a file one after another, failing at the end of the file with what was expected.
 */
export class LineCursor {
  #next = 0;

  /**
   * @param format - The parser's format, which every error names.
   * @param all - The file's lines with fields.
   */
  public constructor(
    private readonly format: string,
    private readonly all: readonly FieldLine[],
  ) {}

  /**
   * @param what - What the line should be, for the error.
   * @returns The next line.
   * @throws NativeParseError when the file has no more lines.
   */
  public take(what: string): FieldLine {
    const line = this.all[this.#next];
    if (line === undefined) {
      throw new NativeParseError(this.format, this.all.at(-1)?.line ?? 1, `the file ends before ${what}`);
    }
    this.#next += 1;

    return line;
  }

  /** @returns The first line after the ones taken, if there is one. */
  public rest(): FieldLine | undefined {
    return this.all[this.#next];
  }
}
