/* The datasets a visitor has starred, as the browser keeps them: the pure part, with no storage or DOM, so the rules for reading, changing and writing the stored list are tested on their own. */

/** The local storage key the list of starred dataset ids is kept under. */
export const STARRED_KEY = "keepset:starred";

/**
 * Reads the stored list. Storage is shared with whatever else wrote under the key, so a value that is not a JSON array of strings is no list, which is the same as nothing starred.
 * @param raw - The stored text, or null where nothing is stored.
 * @returns The starred ids.
 */
export function parseStarred(raw: string | null): ReadonlySet<string> {
  if (raw === null) {
    return new Set();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }

  return Array.isArray(parsed) && parsed.every((id): id is string => typeof id === "string") ? new Set(parsed) : new Set();
}

/**
 * The list with one id starred or, if it was starred, not.
 * @param starred - The starred ids.
 * @param id - The dataset's id.
 * @returns A new set; the argument is left as it was.
 */
export function toggled(starred: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(starred);
  if (!next.delete(id)) {
    next.add(id);
  }

  return next;
}

/**
 * The text to store for a list: sorted, so the same stars always give the same text.
 * @param starred - The starred ids.
 * @returns A JSON array of the ids.
 */
export function serialiseStarred(starred: ReadonlySet<string>): string {
  return JSON.stringify([...starred].sort());
}
