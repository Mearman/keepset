/* The indexes of listing pages (every domain, subject, kind, tag or namespace, with how many datasets each holds): how they are ordered and matched against text. Pure, with no DOM and no Node, so the generator's static index and the client island's interactive one order and filter the same way. */

/** How an index of listing pages orders them: by label, or by how many datasets each holds, the most first and ties by label. */
export type GroupOrder = "label" | "count";

/** One listing page as its index links it: its label (every label the page is for, joined), its path relative to the index and how many datasets it holds. */
export interface GroupLink {
  readonly label: string;
  readonly path: string;
  readonly count: number;
}

/**
 * Joins the labels a listing page is for into the one label its index shows.
 * @param labels - The labels, in label order.
 * @returns The label.
 */
export function groupLabel(labels: readonly string[]): string {
  return labels.join(", ");
}

/**
 * Orders text by its UTF-16 code units, so an index reads the same on every machine whatever its locale.
 * @param left - One text.
 * @param right - The other.
 * @returns A negative number when the left sorts first, a positive one when the right does, zero when they are equal.
 */
export function byText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Orders an index's groups.
 * @param groups - The groups, in any order.
 * @param order - By label, or the most datasets first with ties by label.
 * @returns A new array of the groups in that order.
 */
export function orderGroups<T extends Pick<GroupLink, "label" | "count">>(groups: readonly T[], order: GroupOrder): T[] {
  const byLabel = [...groups].sort((left, right) => byText(left.label, right.label));

  return order === "label" ? byLabel : byLabel.sort((left, right) => right.count - left.count);
}

/**
 * The groups whose label contains some text, ignoring letter case; blank text matches every group.
 * @param groups - The groups.
 * @param text - The text.
 * @returns The matching groups, in their given order.
 */
export function matchingGroups<T extends Pick<GroupLink, "label">>(groups: readonly T[], text: string): T[] {
  const needle = text.trim().toLowerCase();

  return groups.filter((group) => group.label.toLowerCase().includes(needle));
}
