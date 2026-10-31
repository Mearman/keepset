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
 * A text: one work in a collection of written works, such as a book in a library's catalogue, flat so a crossmap crosswalk can map a table's columns onto it (a wildcard path must keep the same shape on both sides). The target fixes only what catalogues of texts share and lets a crosswalk map any further column through under its own name, as graph/v1 does. `title` and `language` (a code as the source writes it, several joined as the source joins them) describe the work, `authors` and `subjects` are the people and topics the source names, joined as the source joins them, `issued` is when the source published the text, as it writes it, and `type` is the kind of work. `classification` is the shelf-mark scheme's codes for it and `collections` are the groupings the source files it under. `textUrl`, `htmlUrl` and `epubUrl` are the addresses where the source serves the work as plain text, as a web page and as an EPUB, one field each because a crosswalk cannot gather a list from separate columns. They address the work's files and the target carries none of them.
 */
export const TextSchema = z.looseObject({
  id: z.string().min(1),
  title: maybe(z.string().min(1)),
  language: maybe(z.string().min(1)),
  authors: maybe(z.string().min(1)),
  subjects: maybe(z.string().min(1)),
  issued: maybe(z.string().min(1)),
  type: maybe(z.string().min(1)),
  classification: maybe(z.string().min(1)),
  collections: maybe(z.string().min(1)),
  textUrl: maybe(z.string().min(1)),
  htmlUrl: maybe(z.string().min(1)),
  epubUrl: maybe(z.string().min(1)),
});
export type Text = z.infer<typeof TextSchema>;

/** The metadata of a texts/v1 document: a flat record of scalars. */
export const TextsMetaSchema = recordOf(z.string().min(1), JsonScalarSchema);

/**
 * The texts/v1 normalisation target: `{ meta, nodes }`, a set of texts as the nodes it catalogues, whether it comes from a library's catalogue feed or a corpus's index. It describes the result `fetchDataset` resolves an entry to, not what a source file may contain. Beyond the field shapes it checks that node ids are unique. It carries the texts' descriptions and the addresses of their files, never their contents: a source's full texts are a collection of their own.
 */
export const TextsV1Schema = define(
  z
    .object({
      meta: TextsMetaSchema,
      nodes: z.array(TextSchema),
    })
    .strict()
    .superRefine((instance, ctx) => {
      addDuplicateIdIssues(instance.nodes, ctx);
    }),
);
export type TextsV1 = z.infer<typeof TextsV1Schema>;
