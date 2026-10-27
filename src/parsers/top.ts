import { NativeParseError } from "../errors";
import { lines, type NativeInstance, type NativeRow } from "./native";

/** The columns of a node of a team orienteering file, as the parser names them: the position, the score, and whether it is where the paths start, where they end or a point to visit. */
export const TOP_COLUMNS = ["x", "y", "score", "role"] as const;

/** The columns whose values are text; the others are numbers. */
export const TOP_TEXT_COLUMNS = ["role"] as const;

/** The metadata keys the parser reads: the number of points, the number of paths and the length budget of each path. */
export const TOP_META = ["points", "paths", "budget"] as const;


/** The columns of a node of a dynamic team orienteering file: those of a team orienteering file, with the time at which the point becomes known between the score and the role. */
export const DTOP_COLUMNS = ["x", "y", "score", "arrival", "role"] as const;

/** The header lines before the first point: `n`, `m` and `tmax`. */
const HEADER_LINES = 3;

/** The numbers on a row: a position and a score, and for a dynamic file the time the point becomes known. */
const FIELDS = 3;
const FIELDS_WITH_ARRIVAL = 4;

const NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Reads the value of a header line `<key> <number>`.
 * @param format - The format's name, for the error.
 * @param text - The line.
 * @param key - The key it must start with.
 * @param line - The 1-based line, for the error.
 * @returns The number.
 * @throws NativeParseError when the line is not the key and one number.
 */
function headerOf(format: string, text: string | undefined, key: string, line: number): number {
  const tokens = (text ?? "").trim().split(/\s+/);
  const [name, value, ...extra] = tokens;
  if (name !== key || value === undefined || extra.length > 0 || !NUMBER.test(value)) {
    throw new NativeParseError(format, line, `expected "${key} <number>", found ${JSON.stringify((text ?? "").trim())}`);
  }

  return Number(value);
}

/** What distinguishes the layouts that share the team orienteering header: the format's name for errors, and whether each row carries the time its point becomes known after the score. */
interface TopLayout {
  readonly format: string;
  readonly arrival: boolean;
}

/**
 * Parses a file of the team orienteering layout: `n <points>`, `m <paths>` and `tmax <budget>` on three lines, then one row for each point. The first point is where the paths start and the last is where they end, and the rest are to visit; the file has no ids, so a point's id is its zero-based row number. Columns are separated by any run of spaces or tabs, and blank or whitespace only lines are skipped. The positions and the budget are in the same planar unit, which the format does not name.
 * @param text - The file text.
 * @param layout - The layout's name and whether rows carry an arrival time.
 * @returns The instance: its point count, path count and per-path budget as `meta`, and its nodes in file order.
 * @throws NativeParseError naming the line for a missing or misordered header line, a row that is not the layout's numbers, or a row count that is not the point count.
 */
function parseLayout(text: string, layout: TopLayout): NativeInstance {
  const { format, arrival } = layout;
  const all = lines(text)
    .map((raw, index) => ({ line: index + 1, text: raw.trim() }))
    .filter((entry) => entry.text !== "");
  const [first, second, third] = all;
  const rows = all.slice(HEADER_LINES);
  const points = headerOf(format, first?.text, "n", first?.line ?? 1);
  const paths = headerOf(format, second?.text, "m", second?.line ?? 2);
  const budget = headerOf(format, third?.text, "tmax", third?.line ?? HEADER_LINES);
  if (!Number.isInteger(points) || points < 2) {
    throw new NativeParseError(format, first?.line ?? 1, `expected at least a start and an end point, found n ${String(points)}`);
  }
  if (rows.length !== points) {
    throw new NativeParseError(format, all[all.length - 1]?.line ?? 1, `the header gives ${String(points)} points, found ${String(rows.length)} rows`);
  }
  const nodes: NativeRow[] = rows.map((row, index) => {
    const tokens = row.text.split(/\s+/);
    const [x, y, score, time] = tokens;
    if (tokens.length !== (arrival ? FIELDS_WITH_ARRIVAL : FIELDS) || tokens.some((token) => !NUMBER.test(token))) {
      throw new NativeParseError(format, row.line, `expected ${arrival ? "four numbers (x, y, score, arrival time)" : "three numbers (x, y, score)"}, found ${JSON.stringify(row.text)}`);
    }
    const role = index === 0 ? "start" : index === points - 1 ? "end" : "visit";

    return { id: String(index), x: Number(x), y: Number(y), score: Number(score), ...(arrival ? { arrival: Number(time) } : {}), role };
  });

  return { meta: { points, paths, budget }, nodes };
}

/**
 * Parses a team orienteering problem instance (Chao, Golden and Wasil, as the KU Leuven pages describe it): the team orienteering layout with a position and a score for each point.
 * @param text - The file text.
 * @returns The instance.
 * @throws NativeParseError naming the line for a missing or misordered header line, a row that is not three numbers, or a row count that is not the point count.
 */
export function parseTop(text: string): NativeInstance {
  return parseLayout(text, { format: "top", arrival: false });
}

/**
 * Parses a dynamic team orienteering problem instance: the team orienteering layout with a fourth number on each row, the time at which the point becomes known, which is 0 for a point known from the start (the start and end points always are).
 * @param text - The file text.
 * @returns The instance, each node with its arrival time.
 * @throws NativeParseError naming the line for a missing or misordered header line, a row that is not four numbers, or a row count that is not the point count.
 */
export function parseDtop(text: string): NativeInstance {
  return parseLayout(text, { format: "dtop", arrival: true });
}
