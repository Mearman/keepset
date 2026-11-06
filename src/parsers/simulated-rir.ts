import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import type { NativeTable } from "./native";
import { decode } from "./parse-native";
import { parseOptionList } from "./option-list";

type SimulatedRirParser = Extract<Parser, { format: "simulated-rir" }>;

/** Dimensions, receiver coordinates and absorption coefficient as listed by the source README. */
const ROOM_VALUE_COUNT = 7;

/**
 * Reads response lists and joins each response to its room's source metadata. The room values are kept in their source order as well as exposed under the column names in the archive's README.
 * @param files - Response lists and room information files selected from one archive.
 * @param parser - The parser's encoding.
 * @returns One row per response, with its room information as source text.
 * @throws NativeParseError when room data is malformed, repeated or missing for a response.
 */
export function parseSimulatedRir(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<SimulatedRirParser>): NativeTable {
  const rooms = new Map<string, string>();
  for (const file of files.filter((item) => item.path.endsWith("/room_info"))) {
    for (const [index, line] of decode(file.bytes, parser).split(/\r\n|\n|\r/).entries()) {
      if (line.trim() === "") continue;
      const match = /^(\S+)\s+(.+?)\s*$/u.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || rooms.has(match[1])) {
        throw new NativeParseError(parser.format, index + 1, `${file.path}: invalid or duplicate room information`);
      }
      rooms.set(match[1], match[2]);
    }
  }
  const lists = files.filter((file) => file.path.endsWith("/rir_list"));
  if (lists.length === 0 || rooms.size === 0) throw new NativeParseError(parser.format, 1, "expected response lists and room information");
  const { nodes } = parseOptionList(lists, { format: "option-list", encoding: parser.encoding, fields: ["rir_id", "room_id"] });

  return { nodes: nodes.map((node) => {
    const room = typeof node["room_id"] === "string" ? rooms.get(node["room_id"]) : undefined;
    if (room === undefined) throw new NativeParseError(parser.format, 1, `${node.id}: missing room information for ${String(node["room_id"])}`);

    const values = room.split(/\s+/u).map(Number);
    if (values.length !== ROOM_VALUE_COUNT || values.some((value) => !Number.isFinite(value))) {
      throw new NativeParseError(parser.format, 1, `${node.id}: expected seven numeric room values`);
    }
    const [room_length, room_width, room_height, receiver_x, receiver_y, receiver_z, absorption_coefficient] = values;
    if (room_length === undefined || room_width === undefined || room_height === undefined || receiver_x === undefined || receiver_y === undefined || receiver_z === undefined || absorption_coefficient === undefined) {
      throw new NativeParseError(parser.format, 1, `${node.id}: expected seven numeric room values`);
    }

    return { ...node, room_info: room, room_length, room_width, room_height, receiver_x, receiver_y, receiver_z, absorption_coefficient };
  }) };
}
