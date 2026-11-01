import { z } from "zod";
import { define } from "./define";
import { HttpUrlSchema, IdSchema, toIssues } from "./entry";
import { CatalogueSyntaxError } from "./errors";
import { recordOf } from "./record";

/** A semantic version, `MAJOR.MINOR.PATCH` with optional pre-release and build parts (https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string). */
export const SemVerSchema = z.string().regex(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/, {
  message: "must be a semantic version, MAJOR.MINOR.PATCH",
});

/** Where a forked catalogue came from: the catalogue it was forked from, the version it forked at and the repository that holds it, which together are what lets a fork's entries be compared with, and brought back to, their origin. */
export const LineageSchema = z
  .object({
    catalogue: IdSchema,
    version: SemVerSchema,
    repository: HttpUrlSchema,
  })
  .strict();
export type Lineage = z.infer<typeof LineageSchema>;

/**
 * A catalogue manifest: the catalogue's own id and version, where it lives, the other names its namespace segments go by, and, for a fork, its lineage. A catalogue is a self-contained set of entry documents beside its manifest, and a fork is its own catalogue with its own id, so lineage may never name the catalogue itself. A segment alias is a name for a whole segment wherever it appears in a namespace, so it may not repeat, name itself, or be the segment of another alias.
 */
export const ManifestSchema = define(
  z
    .object({
      $schema: HttpUrlSchema.optional(),
      id: IdSchema,
      name: z.string().min(1),
      description: z.string().min(1),
      version: SemVerSchema,
      repository: HttpUrlSchema,
      lineage: LineageSchema.optional(),
      namespaceAliases: recordOf(IdSchema, z.array(IdSchema).min(1)).optional(),
    })
    .strict()
    .superRefine((manifest, ctx) => {
      if (manifest.lineage?.catalogue === manifest.id) {
        ctx.addIssue({ code: "custom", path: ["lineage", "catalogue"], message: "a fork is its own catalogue: lineage must name the catalogue it was forked from, not itself" });
      }
      const aliasOf = new Map<string, string>();
      const aliases = manifest.namespaceAliases ?? {};
      for (const [segment, names] of Object.entries(aliases)) {
        for (const alias of names) {
          const earlier = aliasOf.get(alias);
          if (alias === segment) {
            ctx.addIssue({ code: "custom", path: ["namespaceAliases", segment], message: `${alias} cannot be an alias of itself` });
          } else if (earlier !== undefined) {
            ctx.addIssue({ code: "custom", path: ["namespaceAliases", segment], message: `${alias} is already an alias of ${earlier}` });
          } else if (Object.hasOwn(aliases, alias)) {
            ctx.addIssue({ code: "custom", path: ["namespaceAliases", segment], message: `${alias} is itself a segment with aliases` });
          }
          aliasOf.set(alias, segment);
        }
      }
    }),
);
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Parses an unknown value as a catalogue manifest.
 * @param doc - The candidate manifest document.
 * @returns The validated manifest.
 * @throws CatalogueSyntaxError carrying every issue found.
 */
export function parseManifest(doc: unknown): Manifest {
  const result = ManifestSchema.safeParse(doc);
  if (!result.success) {
    throw new CatalogueSyntaxError("manifest", toIssues(result.error));
  }

  return result.data;
}
