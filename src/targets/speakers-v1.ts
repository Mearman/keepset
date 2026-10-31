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
 * A speaker: one person (or one speaker identity) in a speaker recognition corpus, flat so a crossmap crosswalk can map a table's columns onto it. `gender` and `nationality` are as the source states them, `language` the language or dialect the speaker was recorded in, `set` the part of the corpus the speaker belongs to (development, test) and `name` the speaker's name or the label the source gives them. The target fixes only what speaker lists share and lets a crosswalk map any further column through under its own name.
 */
export const SpeakerSchema = z.looseObject({
  id: z.string().min(1),
  gender: maybe(z.string().min(1)),
  nationality: maybe(z.string().min(1)),
  language: maybe(z.string().min(1)),
  set: maybe(z.string().min(1)),
  name: maybe(z.string().min(1)),
});
export type Speaker = z.infer<typeof SpeakerSchema>;

/** The metadata of a speakers/v1 document: a flat record of scalars. */
export const SpeakersMetaSchema = recordOf(z.string().min(1), JsonScalarSchema);

/**
 * The speakers/v1 normalisation target: `{ meta, nodes }`, a speaker list as the speakers it names. It describes the result `fetchDataset` resolves an entry to, not what a source file may contain. Beyond the field shapes it checks that speaker ids are unique. It carries the speakers' attributes, never their recordings.
 */
export const SpeakersV1Schema = define(
  z
    .object({
      meta: SpeakersMetaSchema,
      nodes: z.array(SpeakerSchema),
    })
    .strict()
    .superRefine((instance, ctx) => {
      addDuplicateIdIssues(instance.nodes, ctx);
    }),
);
export type SpeakersV1 = z.infer<typeof SpeakersV1Schema>;
