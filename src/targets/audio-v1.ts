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
 * An audio clip: one recording in a collection of sounds that are not transcribed speech (noise, music, room impulse responses, vocalisations), flat so a crossmap crosswalk can map an annotation table's columns onto it. `label` is the class the source gives the clip (a genre, a sound type), `speaker` who made the sound where the source says, `duration` its length in seconds and `split` the part of the collection it belongs to. The target fixes only what sound collections share and lets a crosswalk map any further column through under its own name.
 */
export const ClipSchema = z.looseObject({
  id: z.string().min(1),
  label: maybe(z.string().min(1)),
  speaker: maybe(z.string().min(1)),
  duration: maybe(z.number().nonnegative()),
  split: maybe(z.string().min(1)),
});
export type Clip = z.infer<typeof ClipSchema>;

/** The metadata of a audio/v1 document: a flat record of scalars. */
export const AudioMetaSchema = recordOf(z.string().min(1), JsonScalarSchema);

/**
 * The audio/v1 normalisation target: `{ meta, nodes }`, a collection of sounds as the clips it annotates. It describes the result `fetchDataset` resolves an entry to, not what a source file may contain. Beyond the field shapes it checks that clip ids are unique. It carries the clips' annotations, never their audio.
 */
export const AudioV1Schema = define(
  z
    .object({
      meta: AudioMetaSchema,
      nodes: z.array(ClipSchema),
    })
    .strict()
    .superRefine((instance, ctx) => {
      addDuplicateIdIssues(instance.nodes, ctx);
    }),
);
export type AudioV1 = z.infer<typeof AudioV1Schema>;
