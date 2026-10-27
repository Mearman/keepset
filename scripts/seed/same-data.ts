import { z } from "zod";
import { IdSchema, type Entry } from "../../src/entry";

/* Entries that hold the same data in another file or format are curated by hand: the ids, node counts and edge counts of two entries can agree by coincidence or differ for one graph (a collection stores an undirected edge once or twice), so no rule over the entries finds them reliably. The groups are recorded in scripts/seed/sources/same-data.json and the import gives each entry of a group the others' ids as `sameDataAs`. */

/** The curated groups: each lists the ids of at least two entries that hold the same data. */
export const SameDataSchema = z
  .object({
    groups: z.array(z.array(IdSchema).min(2).refine((ids) => new Set(ids).size === ids.length, { message: "a group lists each entry once" })),
  })
  .strict();
export type SameData = z.infer<typeof SameDataSchema>;

/**
 * The entries with `sameDataAs` set from the curated groups.
 * @param entries - The entries one import produced.
 * @param same - The curated groups, which every import reads: a group none of whose entries this import produced belongs to another import and is skipped.
 * @returns The entries, each in a group naming the others of it in the group's order.
 * @throws Error when a group names both an entry of this import and one that is not, since a relation is written into both entries by the one import, or when an entry sits in two groups.
 */
export function withSameData(entries: readonly Entry[], same: SameData): Entry[] {
  const known = new Set(entries.map((entry) => entry.id));
  const others = new Map<string, readonly string[]>();
  for (const group of same.groups.filter((candidate) => candidate.some((id) => known.has(id)))) {
    for (const id of group) {
      if (!known.has(id)) {
        throw new Error(`the same-data group ${group.join(", ")} names ${id}, which this import did not produce, beside entries it did`);
      }
      if (others.has(id)) {
        throw new Error(`${id} sits in more than one same-data group`);
      }
      others.set(
        id,
        group.filter((other) => other !== id),
      );
    }
  }

  return entries.map((entry) => {
    const related = others.get(entry.id);

    return related === undefined ? entry : { ...entry, sameDataAs: [...related] };
  });
}
