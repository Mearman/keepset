/* How the listing's seven columns are sized, shared by the static table the generator writes and the interactive one the client mounts, so both lay out identically. The kind, the entities and the size are content columns: each is as wide as the widest header or value it can show, so a count is never cut with an ellipsis. The four that carry long text (name, id, domain and the last, Recipe on the static table and Tags in the island) share what is left in fixed proportions. */

import { entitiesText, sizeText, type Dimensions } from "./dimensions";

/** What the listing needs of a row to size its content columns. */
export interface ListingRow extends Dimensions {
  readonly kind: string;
}

/** The width below which the listing stops fitting the screen and scrolls sideways instead; the table's minimum width, and the width the text columns' shares are of when the wrapper is narrower. */
export const LISTING_FLOOR_WIDTH = "64rem";

/** A cell's horizontal padding on each side, as the table rule in the stylesheet sets it. */
const CELL_PADDING = "var(--mantine-spacing-xs, 0.625rem)";

/** Characters a header gains once its column is sorted: a space and an arrow. */
const SORT_MARK_LENGTH = 2;

/** One column: a content column states its header and how to write a row's value, so its width follows the data; a text column states its share of the width left over. */
type Column = { readonly header: string; readonly value: (row: ListingRow) => string } | { readonly share: number };

const COLUMNS: readonly Column[] = [
  { share: 22 },
  { share: 20 },
  { header: "Kind", value: (row) => row.kind },
  { share: 13 },
  { header: "Entities", value: (row) => entitiesText(row) },
  { header: "Size", value: (row) => sizeText(row) },
  { share: 10 },
];

/**
 * The width of each of the listing's columns, in column order, as CSS lengths.
 * @param rows - Every row the listing can show, not only the visible ones, so a filter never moves a column.
 * @returns One length per column: for a content column, the widest of its header (with the mark a sorted header carries) and its values in characters plus the cell's padding; for a text column, its share of the wrapper's width less the content columns. A container query unit stands for the wrapper's width, because a percentage inside calc() is ignored in a table cell's width.
 */
export function listingColumnWidths(rows: readonly ListingRow[]): readonly string[] {
  const characters = COLUMNS.map((column) => ("header" in column ? Math.max(column.header.length + SORT_MARK_LENGTH, ...rows.map((row) => column.value(row).length)) : 0));
  const contentColumns = COLUMNS.filter((column) => "header" in column).length;
  const contentWidth = `${String(characters.reduce((total, count) => total + count, 0))}ch + ${String(2 * contentColumns)} * ${CELL_PADDING}`;
  const shareTotal = COLUMNS.reduce((total, column) => total + ("share" in column ? column.share : 0), 0);

  return COLUMNS.map((column, index) => ("share" in column ? `calc((max(100cqw, ${LISTING_FLOOR_WIDTH}) - (${contentWidth})) * ${String(column.share / shareTotal)})` : `calc(${String(characters[index])}ch + 2 * ${CELL_PADDING})`));
}
