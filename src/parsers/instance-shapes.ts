import type { Parser } from "../entry";
import { HHCRSP_COLUMNS, HHCRSP_META, HHCRSP_TEXT_COLUMNS } from "./hhcrsp";
import { MANKOWSKA_COLUMNS, MANKOWSKA_META, MANKOWSKA_TEXT_COLUMNS } from "./mankowska";
import { TDC_COLUMNS, TDC_META, TDC_TEXT_COLUMNS } from "./tdc";
import { VEROLOG_2017_COLUMNS, VEROLOG_2017_META, VEROLOG_2017_TEXT_COLUMNS } from "./verolog-2017";
import { CUSTOMER_POINTS_COLUMNS, CUSTOMER_POINTS_META, CUSTOMER_POINTS_TEXT_COLUMNS } from "./customer-points";
import { SOLOMON_COLUMNS, SOLOMON_META, SOLOMON_TEXT_COLUMNS } from "./solomon";
import { DTOP_COLUMNS, TOP_COLUMNS, TOP_META, TOP_TEXT_COLUMNS } from "./top";
import { TSPLIB_COLUMNS, TSPLIB_META, TSPLIB_TEXT_COLUMNS } from "./tsplib";
import { VEROLOG_2019_COLUMNS, VEROLOG_2019_META, VEROLOG_2019_TEXT_COLUMNS } from "./verolog-2019";
import { VRP_REP_COLUMNS, VRP_REP_META, VRP_REP_TEXT_COLUMNS } from "./vrp-rep";
import { TOPTW_COLUMNS, TOPTW_META, TOPTW_TEXT_COLUMNS } from "./toptw";

/** What each instance file parser emits, by its format name: the columns of a node (besides its `id`), which of them hold text and not numbers, and the keys of the instance's own `meta`. A recipe's crosswalk maps these, and the seed import checks a curation against them. */
export const INSTANCE_SHAPES = {
  "customer-points": { columns: CUSTOMER_POINTS_COLUMNS, text: CUSTOMER_POINTS_TEXT_COLUMNS, meta: CUSTOMER_POINTS_META },
  solomon: { columns: SOLOMON_COLUMNS, text: SOLOMON_TEXT_COLUMNS, meta: SOLOMON_META },
  top: { columns: TOP_COLUMNS, text: TOP_TEXT_COLUMNS, meta: TOP_META },
  dtop: { columns: DTOP_COLUMNS, text: TOP_TEXT_COLUMNS, meta: TOP_META },
  "verolog-2019": { columns: VEROLOG_2019_COLUMNS, text: VEROLOG_2019_TEXT_COLUMNS, meta: VEROLOG_2019_META },
  "vrp-rep": { columns: VRP_REP_COLUMNS, text: VRP_REP_TEXT_COLUMNS, meta: VRP_REP_META },
  tsplib: { columns: TSPLIB_COLUMNS, text: TSPLIB_TEXT_COLUMNS, meta: TSPLIB_META },
  toptw: { columns: TOPTW_COLUMNS, text: TOPTW_TEXT_COLUMNS, meta: TOPTW_META },
  hhcrsp: { columns: HHCRSP_COLUMNS, text: HHCRSP_TEXT_COLUMNS, meta: HHCRSP_META },
  mankowska: { columns: MANKOWSKA_COLUMNS, text: MANKOWSKA_TEXT_COLUMNS, meta: MANKOWSKA_META },
  "verolog-2017": { columns: VEROLOG_2017_COLUMNS, text: VEROLOG_2017_TEXT_COLUMNS, meta: VEROLOG_2017_META },
  tdc: { columns: TDC_COLUMNS, text: TDC_TEXT_COLUMNS, meta: TDC_META },
} as const;

/** The format names of the instance file parsers. */
export type InstanceFormat = keyof typeof INSTANCE_SHAPES;

/** A parser of an instance file format. */
export type InstanceParser = Extract<Parser, { readonly format: InstanceFormat }>;

/**
 * Whether a parser reads an instance file format, whose output is a node list with a header `meta` of its own.
 * @param parser - Any parser.
 * @returns True for an instance file parser.
 */
export function isInstanceParser(parser: Parser): parser is InstanceParser {
  return Object.hasOwn(INSTANCE_SHAPES, parser.format);
}
