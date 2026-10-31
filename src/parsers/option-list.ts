import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";

type OptionListParser = Extract<Parser, { format: "option-list" }>;

const FORMAT = "option-list";

/** The byte order mark some editors put at the start of a text file. */
const BYTE_ORDER_MARK = "﻿";

/**
 * Splits a line into its options and its positional argument.
 * @param line - A non-blank line.
 * @param where - The file's path, for the error.
 * @param position - The 1-based line, for the error.
 * @returns The options by column name (the option's name without its dashes, hyphens made underscores) and the one positional argument.
 * @throws NativeParseError when an option has no value or is given twice, or the line does not end in exactly one positional argument.
 */
function splitLine(line: string, where: string, position: number): { readonly options: ReadonlyMap<string, string>; readonly positional: string } {
  const tokens = line.trim().split(/\s+/);
  const options = new Map<string, string>();
  let index = 0;
  for (let token = tokens[index]; token?.startsWith("--") === true; token = tokens[index]) {
    const value = tokens[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new NativeParseError(FORMAT, position, `${where}: the option ${token} has no value`);
    }
    const name = token.slice("--".length).replaceAll("-", "_");
    if (options.has(name)) {
      throw new NativeParseError(FORMAT, position, `${where}: the option ${token} is given twice`);
    }
    options.set(name, value);
    index += 2;
  }
  const positional = tokens.slice(index);
  const [only] = positional;
  if (only === undefined || positional.length !== 1) {
    throw new NativeParseError(FORMAT, position, `${where}: expected one argument after the options, found ${String(positional.length)}`);
  }

  return { options, positional: only };
}

/**
 * Reads a collection whose annotations are lists of lines in the form `--name value ... <path>`, as Kaldi's recipes write the lists that describe their audio: each line is a row whose id is its final argument, the file or recording it describes, and whose fields are the recipe's options (a hyphen in an option's name is an underscore in the field's, so `--rir-id` is `rir_id`). An option a line does not give is null in its row, so lists that carry different options can be read together, and an option the recipe does not keep is left out. Blank lines are skipped.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser.
 * @returns One row per line, in file and line order.
 * @throws NativeParseError naming the file and line of the first problem: an option without a value or given twice, a line without exactly one argument after its options, or an id used twice, in one file or two.
 */
export function parseOptionList(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<OptionListParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const file of files) {
    const decoded = decode(file.bytes, parser);
    for (const [index, line] of (decoded.startsWith(BYTE_ORDER_MARK) ? decoded.slice(BYTE_ORDER_MARK.length) : decoded).split(/\r\n|\n|\r/).entries()) {
      if (line.trim() === "") {
        continue;
      }
      const { options, positional } = splitLine(line, file.path, index + 1);
      if (seen.has(positional)) {
        throw new NativeParseError(FORMAT, index + 1, `${file.path}: the id ${positional} is given twice`);
      }
      seen.add(positional);
      nodes.push({ ...Object.fromEntries(parser.fields.map((field): [string, string | null] => [field, options.get(field) ?? null])), id: positional });
    }
  }

  return { nodes };
}
