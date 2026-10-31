import { z } from "zod";
import { define } from "../define";
import { recordOf } from "../record";
import { JsonScalarSchema } from "./json-scalar";
import { addDuplicateIdIssues } from "./node-ids";

/** A value a node may not have: every field below but the text is optional and nullable, null being what a source's empty cell becomes. */
function maybe<Schema extends z.ZodType>(schema: Schema): z.ZodOptional<z.ZodNullable<Schema>> {
  return schema.nullable().optional();
}

/**
 * A document: one text of a corpus with its whole contents, flat so a crossmap crosswalk can map a source's fields onto it (a wildcard path must keep the same shape on both sides). The target fixes only what text corpora share and lets a crosswalk map any further field through under its own name, as graph/v1 does. `text` is the document's contents as decoded from the source, which a recipe passes on as the source writes it; it is required and may be empty, since a corpus may hold an empty file. `title` and `language` (a code or name as the source writes it) describe the document, `format` is the media type the source stores it as (`text/plain`, `text/html`) and `encoding` the character encoding the source stores it in, both as the source names them.
 */
export const CorpusDocumentSchema = z.looseObject({
  id: z.string().min(1),
  text: z.string(),
  title: maybe(z.string().min(1)),
  language: maybe(z.string().min(1)),
  format: maybe(z.string().min(1)),
  encoding: maybe(z.string().min(1)),
});
export type CorpusDocument = z.infer<typeof CorpusDocumentSchema>;

/** The metadata of a corpus/v1 document: a flat record of scalars. */
export const CorpusMetaSchema = recordOf(z.string().min(1), JsonScalarSchema);

/**
 * The corpus/v1 normalisation target: `{ meta, nodes }`, a text corpus as the documents it holds, each with its full text, whether it is a library's books or a collection of articles. It describes the result `fetchDataset` (or, for a corpus too large to hold, `streamDataset`) resolves an entry to, not what a source file may contain. Beyond the field shapes it checks that document ids are unique. It carries the texts themselves; a catalogue that only describes them is texts/v1.
 */
export const CorpusV1Schema = define(
  z
    .object({
      meta: CorpusMetaSchema,
      nodes: z.array(CorpusDocumentSchema),
    })
    .strict()
    .superRefine((instance, ctx) => {
      addDuplicateIdIssues(instance.nodes, ctx);
    }),
);
export type CorpusV1 = z.infer<typeof CorpusV1Schema>;
