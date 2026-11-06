import { sheetNames, xlsxGrid } from "../node/xlsx";
import { NativeParseError } from "../errors";
import { NodeOrder, type NativeEdge, type NativeGraph } from "./native";

const FORMAT = "similarity-ratings";
const FIRST_RATING_COLUMN = 4;
const FIRST_DATA_ROW = 3;

interface Rating extends NativeEdge {
  readonly stimulus: string;
  readonly workbook: string;
  readonly question: number;
  readonly judge: string;
  readonly score: number;
}

/**
 * Reads pragmatic-similarity workbooks as one edge per participant's judgement of a source and reenactment pair.
 * @param files - Workbooks selected from the source archive, in path order.
 * @returns Distinct utterance nodes and every rating, in workbook, row and column order.
 * @throws NativeParseError when a workbook or rating does not have the source's stated layout.
 */
export function parseSimilarityRatings(files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): NativeGraph {
  const order = new NodeOrder();
  const edges: Rating[] = [];
  for (const file of files) {
    const sheets = sheetNames(file.bytes);
    const sheet = sheets[0];
    if (sheets.length !== 1 || sheet === undefined) throw new NativeParseError(FORMAT, 1, `${file.path}: expected one sheet`);
    const grid = xlsxGrid(file.bytes, sheet);
    const header = grid.rows.get(1);
    const judges = grid.rows.get(2);
    if (header?.[0] !== "Questions" || header[1] !== "Stimuli" || header[2] !== "Source1" || header[3] !== "Source2" || judges === undefined) {
      throw new NativeParseError(FORMAT, 1, `${file.path}: unexpected headers`);
    }
    if (grid.width <= FIRST_RATING_COLUMN) throw new NativeParseError(FORMAT, 2, `${file.path}: no participant columns`);
    const seen = new Set<string>();
    for (let column = FIRST_RATING_COLUMN; column < grid.width; column++) {
      const judge = judges[column]?.trim();
      if (judge === undefined || judge === "" || seen.has(judge)) throw new NativeParseError(FORMAT, 2, `${file.path}: missing or duplicate judge`);
      seen.add(judge);
    }
    for (const [rowNumber, row] of grid.rows) {
      if (rowNumber < FIRST_DATA_ROW) continue;
      const questionText = row[0]?.trim();
      const stimulus = row[1]?.trim();
      const source = row[2]?.trim();
      const target = row[3]?.trim();
      const question = Number(questionText);
      if (questionText === undefined || questionText === "" || !Number.isInteger(question) || stimulus === undefined || stimulus === "" || source === undefined || source === "" || target === undefined || target === "") {
        throw new NativeParseError(FORMAT, rowNumber, `${file.path}: invalid stimulus pair`);
      }
      order.add(source);
      order.add(target);
      for (let column = FIRST_RATING_COLUMN; column < grid.width; column++) {
        const judge = judges[column];
        const rating = row[column]?.trim();
        if (rating === undefined || rating === "") continue;
        const score = Number(rating);
        if (judge === undefined || !Number.isFinite(score)) throw new NativeParseError(FORMAT, rowNumber, `${file.path}: invalid rating`);
        edges.push({ source, target, stimulus, workbook: file.path, question, judge: judge.trim(), score });
      }
    }
  }

  return { nodes: order.nodes(), edges };
}
