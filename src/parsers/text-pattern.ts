import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { readTemplate } from "./column-template";
import type { NativeRow, NativeTable } from "./native";

type TextPatternParser = Extract<Parser, { format: "text-pattern" }>;

const FORMAT = "text-pattern";

/**
 * The names of a pattern's named capture groups, in the order the pattern opens them.
 * @param pattern - A regular expression in JavaScript syntax, read with the `u` flag.
 * @returns The group names.
 * @throws SyntaxError when the pattern does not compile.
 */
export function captureNames(pattern: string): string[] {
  // An alternative that matches the empty string makes every group present, with an undefined value, in the groups of the match; the groups object lists the names in the order the pattern opens them.
  const groups = new RegExp(`(?:${pattern})|`, "u").exec("")?.groups;

  return groups === undefined ? [] : Object.keys(groups);
}

/**
 * Reads a text, such as a host's listing page or a reference-value file, as the rows its records make: every match of the recipe's pattern, in text order and without overlapping, is a row of the pattern's named captures, each trimmed and null where the group takes no part or captures only blanks. The `id` capture is the row's id. The text between matches is not read, so the pattern is what selects the records, as a member pattern selects an archive's files. Each of the recipe's derived columns is added to every row, its template filled with the captures it names, or null where one of them is null or its condition fails.
 * @param text - The decoded file.
 * @param parser - The recipe's parser: the pattern, and any derived columns.
 * @returns One row per match.
 * @throws NativeParseError when the pattern matches nothing in the text, matches the empty string, gives an empty id, or gives the same id twice; the line given is the one the failing match starts on.
 */
export function parseTextPattern(text: string, parser: Readonly<TextPatternParser>): NativeTable {
  const pattern = new RegExp(parser.pattern, "gu");
  const derived = (parser.derivedColumns ?? []).map((column) => {
    const reading = readTemplate(column.template);
    // The entry schema refuses a template readTemplate does not read, so a parsed recipe never reaches this.
    if (reading.parts === undefined) throw new NativeParseError(FORMAT, 1, `the template of ${column.name} has ${reading.problem}`);

    return { name: column.name, parts: reading.parts, when: column.when };
  });
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  let line = 1;
  let counted = 0;
  for (const match of text.matchAll(pattern)) {
    for (let at = text.indexOf("\n", counted); at !== -1 && at < match.index; at = text.indexOf("\n", at + 1)) {
      line += 1;
    }
    counted = match.index;
    if (match[0] === "") throw new NativeParseError(FORMAT, line, "the pattern gives an empty match, which reads no record");
    // A group that takes no part in the match is undefined in its groups, although the standard library types every value as a string.
    const groups: Readonly<Record<string, string | undefined>> = match.groups ?? {};
    const captures = Object.entries(groups).map(([name, value]): [string, string | null] => {
      const trimmed = value?.trim();

      return [name, trimmed === undefined || trimmed === "" ? null : trimmed];
    });
    const cells = new Map(captures);
    const id = cells.get("id");
    if (id === undefined || id === null) throw new NativeParseError(FORMAT, line, "a match gives an empty id");
    if (seen.has(id)) throw new NativeParseError(FORMAT, line, `the id ${id} is matched twice`);
    seen.add(id);
    const columns = derived.map(({ name, parts, when }): [string, string | null] => {
      if (when !== undefined && cells.get(when.column) !== when.equals) return [name, null];
      const values = parts.map((part) => (typeof part === "string" ? part : (cells.get(part.column) ?? null)));

      return [name, values.includes(null) ? null : values.join("")];
    });
    nodes.push({ ...Object.fromEntries(captures.filter(([name]) => name !== "id")), ...Object.fromEntries(columns), id });
  }
  if (nodes.length === 0) throw new NativeParseError(FORMAT, 1, "the pattern matches nothing in the text");

  return { nodes };
}
