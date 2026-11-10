import { NativeParseError } from "../errors";
import type { NativeInstance, NativeRow } from "./native";
import { fieldLines, LineCursor, numberReader } from "./number-lines";

/** The columns of a node, one customer of one problem: the problem it belongs to, its planar position and demand, and its problem's number of medians, the capacity of each median and the best solution value the source reports for the problem. */
export const ORLIB_PMEDCAP_COLUMNS = ["problem", "x", "y", "demand", "medians", "medianCapacity", "bestValue"] as const;

/** The columns whose values are text; every column is a number. */
export const ORLIB_PMEDCAP_TEXT_COLUMNS = [] as const;

/** The metadata key the parser reads: the number of problems in the file. */
export const ORLIB_PMEDCAP_META = ["problems"] as const;

const FORMAT = "orlib-pmedcap";

const read = numberReader(FORMAT);

/** The fields of a problem's first line: its number and the best solution value the paper found. */
const TITLE_FIELDS = ["problem", "bestValue"] as const;
/** The fields of a problem's second line: its customer count, median count and the capacity of each median. */
const SIZE_FIELDS = ["customers", "medians", "capacity"] as const;
/** The fields of a customer line. */
const CUSTOMER_FIELDS = ["customer", "x", "y", "demand"] as const;

/**
 * Parses the OR-Library capacitated p-median file (`pmedcap1`, I. H. Osman and N. Christofides's capacitated clustering problems, https://people.brunel.ac.uk/~mastjjb/jeb/orlib/pmedcapinfo.html): the number of problems, then for each problem its number and the best solution value the paper found, its customer count n, median count p and the capacity Q of each median, and n lines of customer number (1 to n in order), x, y and demand. The file is several problems and a document is one, so every customer of every problem is a node, `<problem>-<customer>`, carrying its `problem` and its problem's `medians`, `medianCapacity` and `bestValue` beside its own position and demand; the problem count is `meta`. The costs are Euclidean distances from the coordinates (the paper's results round them down to whole numbers), so no arcs are lost.
 * @param text - The file text.
 * @returns The instance: the problem count as `meta`, and the customers of every problem in file order.
 * @throws NativeParseError naming the line for a count, header or customer line of the wrong shape, a customer out of order, more medians than customers, a problem given twice, a file that ends before a problem's last customer, or lines after the last problem.
 */
export function parseOrlibPmedcap(text: string): NativeInstance {
  const cursor = new LineCursor(FORMAT, fieldLines(text));
  const first = cursor.take("the problem count");
  const problems = read.count(read.fields(first, ["problems"], "the problem count")("problems"), first.line, "the problem count", 1);
  const nodes: NativeRow[] = [];
  const seen = new Set<number>();
  for (let ordinal = 1; ordinal <= problems; ordinal += 1) {
    const title = cursor.take(`problem ${String(ordinal)}`);
    const titleField = read.fields(title, TITLE_FIELDS, "the problem number and best value");
    const problem = read.count(titleField("problem"), title.line, "the problem number", 1);
    if (seen.has(problem)) {
      throw new NativeParseError(FORMAT, title.line, `problem ${String(problem)} is given twice`);
    }
    seen.add(problem);
    const bestValue = read.decimal(titleField("bestValue"), title.line, "the best value");
    const sizes = cursor.take(`the sizes of problem ${String(problem)}`);
    const sizeField = read.fields(sizes, SIZE_FIELDS, "the customer count, median count and median capacity");
    const customers = read.count(sizeField("customers"), sizes.line, "the customer count", 1);
    const medians = read.count(sizeField("medians"), sizes.line, "the median count", 1);
    if (medians > customers) {
      throw new NativeParseError(FORMAT, sizes.line, `${String(medians)} medians for ${String(customers)} customers`);
    }
    const medianCapacity = read.decimal(sizeField("capacity"), sizes.line, "the median capacity");
    for (let customer = 1; customer <= customers; customer += 1) {
      const row = cursor.take(`customer ${String(customer)} of problem ${String(problem)}`);
      const field = read.fields(row, CUSTOMER_FIELDS, "a customer: number, x, y and demand");
      const number = read.count(field("customer"), row.line, "the customer number", 1);
      if (number !== customer) {
        throw new NativeParseError(FORMAT, row.line, `expected customer ${String(customer)}, found ${String(number)}`);
      }
      nodes.push({
        id: `${String(problem)}-${String(customer)}`,
        problem,
        x: read.decimal(field("x"), row.line, "x"),
        y: read.decimal(field("y"), row.line, "y"),
        demand: read.decimal(field("demand"), row.line, "the demand"),
        medians,
        medianCapacity,
        bestValue,
      });
    }
  }
  const extra = cursor.rest();
  if (extra !== undefined) {
    throw new NativeParseError(FORMAT, extra.line, `the file counts ${String(problems)} problems, but goes on after the last`);
  }

  return { meta: { problems }, nodes };
}
