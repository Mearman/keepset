import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeTable } from "./native";
import { memberId } from "./member-id";

type MemberPathParser = Extract<Parser, { format: "member-path" }>;

/**
 * Reads the paths of selected archive members as rows, without reading their contents.
 * @param paths - Selected paths in path order.
 * @param parser - The pattern capturing each file's identifier.
 * @returns One row per path, with its identifier and source path.
 * @throws NativeParseError when a path does not match or two paths give the same identifier.
 */
export function parseMemberPaths(paths: readonly string[], parser: Readonly<MemberPathParser>): NativeTable {
  const seen = new Set<string>();

  return { nodes: paths.map((path, index) => {
    const id = memberId(parser.format, path, parser.idPattern, index + 1);
    if (seen.has(id)) throw new NativeParseError(parser.format, index + 1, `the id ${id} is given by two files`);
    seen.add(id);

    return { id, path };
  }) };
}
