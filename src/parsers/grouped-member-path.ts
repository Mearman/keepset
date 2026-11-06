import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeRow, NativeTable } from "./native";

type GroupedMemberPathParser = Extract<Parser, { format: "grouped-member-path" }>;

/** The metadata named captures other than the id and representation field; unmatched optional groups become null. */
function metadataOf(groups: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | null>> {
  return Object.fromEntries(Object.entries(groups).filter(([name]) => name !== "id" && name !== "field").map(([name, value]) => [name, value ?? null]));
}

/**
 * Groups archive paths by a named id capture, placing each path in the column named by its field capture. Other named captures are shared row metadata.
 * @param paths - Selected archive paths.
 * @param parser - The full-path pattern and required fields.
 * @returns One row per id, in first-appearance order.
 * @throws NativeParseError if a path lacks captures, gives an unknown or duplicate field, gives inconsistent metadata, or an id lacks a required field.
 */
export function parseGroupedMemberPaths(paths: readonly string[], parser: Readonly<GroupedMemberPathParser>): NativeTable {
  const pattern = new RegExp(`^(?:${parser.idPattern})$`, "u");
  const expected = new Set(parser.fields);
  const rows = new Map<string, NativeRow>();
  for (const [index, path] of paths.entries()) {
    const groups = pattern.exec(path)?.groups;
    if (groups?.["id"] === undefined || groups["id"] === "" || groups["field"] === undefined || groups["field"] === "") {
      throw new NativeParseError(parser.format, index + 1, `the path ${path} must give named id and field captures`);
    }
    const id = groups["id"];
    const field = groups["field"];
    if (!expected.has(field)) throw new NativeParseError(parser.format, index + 1, `the path ${path} gives unknown field ${field}`);
    const metadata = metadataOf(groups);
    if (Object.keys(metadata).some((name) => expected.has(name))) throw new NativeParseError(parser.format, index + 1, `the path ${path} gives metadata named as a field`);
    const row = rows.get(id);
    if (row === undefined) {
      rows.set(id, { id, ...metadata, [field]: path });
      continue;
    }
    if (Object.entries(metadata).some(([name, value]) => row[name] !== value) || Object.keys(row).some((name) => name !== "id" && !expected.has(name) && !Object.hasOwn(metadata, name))) {
      throw new NativeParseError(parser.format, index + 1, `the path ${path} gives inconsistent metadata for ${id}`);
    }
    if (Object.hasOwn(row, field)) throw new NativeParseError(parser.format, index + 1, `the id ${id} has two paths for ${field}`);
    rows.set(id, { ...row, [field]: path });
  }
  for (const [id, row] of rows) {
    const missing = parser.fields.filter((field) => !Object.hasOwn(row, field));
    if (missing.length > 0) throw new NativeParseError(parser.format, 1, `the id ${id} has no paths for ${missing.join(", ")}`);
  }

  return { nodes: [...rows.values()] };
}
