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
 * An utterance: one recording of speech and what is said in it, flat so a crossmap crosswalk can map a transcript table's columns onto it (a wildcard path must keep the same shape on both sides). The target fixes only what speech corpora share and lets a crosswalk map any further column through under its own name, as graph/v1 does. `text` is the transcript as the source writes it, `speaker` the speaker's identifier and `gender` the speaker's gender, both as the source states them, `language` the language or dialect as the source codes it, `audio` the recording's file name or path within the corpus's distribution, `duration` its length in seconds and `split` the part of the corpus it belongs to (training, development, test).
 */
export const UtteranceSchema = z.looseObject({
  id: z.string().min(1),
  text: maybe(z.string().min(1)),
  speaker: maybe(z.string().min(1)),
  gender: maybe(z.string().min(1)),
  language: maybe(z.string().min(1)),
  audio: maybe(z.string().min(1)),
  duration: maybe(z.number().nonnegative()),
  split: maybe(z.string().min(1)),
});
export type Utterance = z.infer<typeof UtteranceSchema>;

/** The metadata of a speech/v1 document: a flat record of scalars. */
export const SpeechMetaSchema = recordOf(z.string().min(1), JsonScalarSchema);

/**
 * The speech/v1 normalisation target: `{ meta, nodes }`, a speech corpus as the utterances it transcribes, whether it records read sentences for synthesis, conversations for recognition or commands for keyword spotting. It describes the result `fetchDataset` resolves an entry to, not what a source file may contain. Beyond the field shapes it checks that utterance ids are unique. It carries the utterances' transcripts and descriptions, never their audio: a corpus's recordings are in its distribution, which a resources/v1 entry lists.
 */
export const SpeechV1Schema = define(
  z
    .object({
      meta: SpeechMetaSchema,
      nodes: z.array(UtteranceSchema),
    })
    .strict()
    .superRefine((instance, ctx) => {
      addDuplicateIdIssues(instance.nodes, ctx);
    }),
);
export type SpeechV1 = z.infer<typeof SpeechV1Schema>;
