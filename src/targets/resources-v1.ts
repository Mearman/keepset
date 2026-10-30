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
 * A distributed file: one of the files a resource is downloaded as, flat so a crossmap crosswalk can map a parser's fields onto it (a wildcard path must keep the same shape on both sides). The target fixes only what resource hosts share and lets a crosswalk map any further field through under its own name, as graph/v1 does. The `id` is the file's name, `url` is where the host serves it, `size` is its size as the host states it (a figure with a unit, such as `337M`, since a host rounds), and `description` is what the host says the file holds.
 */
export const ResourceFileSchema = z.looseObject({
  id: z.string().min(1),
  url: maybe(z.string().min(1)),
  size: maybe(z.string().min(1)),
  description: maybe(z.string().min(1)),
});
export type ResourceFile = z.infer<typeof ResourceFileSchema>;

/** The metadata of a resources/v1 document: a flat record of scalars. */
export const ResourcesMetaSchema = recordOf(z.string().min(1), JsonScalarSchema);

/**
 * The resources/v1 normalisation target: `{ meta, nodes }`, one downloadable resource (a corpus, a lexicon, a toolkit) as its `meta`, which says what the resource is, and the files it is distributed as in `nodes`. It describes the result `fetchDataset` resolves an entry to, not what a source page may contain. Beyond the field shapes it checks that file ids are unique. A host's whole listing is a collection, one instance per resource. It carries the resource's description, never the files' contents.
 */
export const ResourcesV1Schema = define(
  z
    .object({
      meta: ResourcesMetaSchema,
      nodes: z.array(ResourceFileSchema),
    })
    .strict()
    .superRefine((instance, ctx) => {
      addDuplicateIdIssues(instance.nodes, ctx);
    }),
);
export type ResourcesV1 = z.infer<typeof ResourcesV1Schema>;
