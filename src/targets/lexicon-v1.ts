import { z } from "zod";
import { define } from "../define";
import { recordOf } from "../record";
import { JsonScalarSchema } from "./json-scalar";
import { addDuplicateIdIssues } from "./node-ids";

/** A value a node may not have: every field below is optional and nullable, null being what a source's empty cell becomes. */
function maybe<Schema extends z.ZodType>(schema: Schema): z.ZodOptional<z.ZodNullable<Schema>> {
  return schema.nullable().optional();
}

/**
 * A lexicon entry: one line of a word list or pronunciation dictionary, flat so a crossmap crosswalk can map a table's columns onto it. A word can appear on several lines (one per pronunciation), so the `id` identifies the line and `word` is the word itself. `pronunciation` is the phones as the source writes them, joined by the source's separator, and `count` is how often the word occurs where the source gives a frequency. The target fixes only what lexicons share and lets a crosswalk map any further column through under its own name.
 */
export const LexiconEntrySchema = z.looseObject({
  id: z.string().min(1),
  word: maybe(z.string().min(1)),
  pronunciation: maybe(z.string().min(1)),
  count: maybe(z.number().nonnegative()),
});
export type LexiconEntry = z.infer<typeof LexiconEntrySchema>;

/** The metadata of a lexicon/v1 document: a flat record of scalars. */
export const LexiconMetaSchema = recordOf(z.string().min(1), JsonScalarSchema);

/**
 * The lexicon/v1 normalisation target: `{ meta, nodes }`, a word list or pronunciation dictionary as its entries. It describes the result `fetchDataset` resolves an entry to, not what a source file may contain. Beyond the field shapes it checks that entry ids are unique. It carries the words and their pronunciations or counts, never the texts they were counted in.
 */
export const LexiconV1Schema = define(
  z
    .object({
      meta: LexiconMetaSchema,
      nodes: z.array(LexiconEntrySchema),
    })
    .strict()
    .superRefine((instance, ctx) => {
      addDuplicateIdIssues(instance.nodes, ctx);
    }),
);
export type LexiconV1 = z.infer<typeof LexiconV1Schema>;
