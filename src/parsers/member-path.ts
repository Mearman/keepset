import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeTable } from "./native";

type MemberPathParser = Extract<Parser, { format: "member-path" }>;

/**
 * Reads the paths of selected archive members as rows, without reading their contents. Named capture groups become additional columns; a group that does not participate is null.
 * @param paths - Selected paths in path order.
 * @param parser - The pattern capturing each file's identifier.
 * @returns One row per path, with its identifier and source path.
 * @throws NativeParseError when a path does not match, two paths give the same identifier, or a named capture conflicts with id or path.
 */
export function parseMemberPaths(paths: readonly string[], parser: Readonly<MemberPathParser>): NativeTable {
  const seen = new Set<string>();
  const pattern = new RegExp(`^(?:${parser.idPattern})$`, "u");

  return { nodes: paths.map((path, index) => {
    const match = pattern.exec(path);
    const id = match?.[1];
    if (id === undefined || id === "") throw new NativeParseError(parser.format, index + 1, `the path ${path} gives no id by the pattern ${parser.idPattern}`);
    if (seen.has(id)) throw new NativeParseError(parser.format, index + 1, `the id ${id} is given by two files`);
    seen.add(id);

    const groups: Readonly<Record<string, string | undefined>> | undefined = match?.groups;
    if (groups !== undefined && ("id" in groups || "path" in groups)) {
      throw new NativeParseError(parser.format, index + 1, "named captures must not be id or path");
    }
    if (groups === undefined) return { id, path };
    const columns = Object.fromEntries(Object.entries(groups).map(([name, value]) => [name, value ?? null]));

    return { id, path, ...columns };
  }) };
}
