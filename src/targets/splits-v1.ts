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
 * A split member: one item (a handwritten line, a page, an utterance) a corpus assigns to a part of its division into training, validation and test data, flat so a crossmap crosswalk can map a list's columns onto it. `split` names the part as the source does, and `document` and `line` locate the item where the source gives both. The target fixes only what split lists share and lets a crosswalk map any further column through under its own name.
 */
export const SplitSchema = z.looseObject({
  id: z.string().min(1),
  split: maybe(z.string().min(1)),
  document: maybe(z.string().min(1)),
  line: maybe(z.string().min(1)),
});
export type Split = z.infer<typeof SplitSchema>;

/** The metadata of a splits/v1 document: a flat record of scalars. */
export const SplitsMetaSchema = recordOf(z.string().min(1), JsonScalarSchema);

/**
 * The splits/v1 normalisation target: `{ meta, nodes }`, a corpus's division into training, validation and test data as the items each part holds. It describes the result `fetchDataset` resolves an entry to, not what a source file may contain. Beyond the field shapes it checks that item ids are unique. It carries the lists, never the items.
 */
export const SplitsV1Schema = define(
  z
    .object({
      meta: SplitsMetaSchema,
      nodes: z.array(SplitSchema),
    })
    .strict()
    .superRefine((instance, ctx) => {
      addDuplicateIdIssues(instance.nodes, ctx);
    }),
);
export type SplitsV1 = z.infer<typeof SplitsV1Schema>;
