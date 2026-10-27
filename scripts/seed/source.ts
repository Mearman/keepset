import { z } from "zod";

/* The shape of the thesis pipeline's graph dataset catalogue (Mearman/Thesis, experiments/pipeline/graphs/catalog.json, with its own catalog.schema.json beside it), as far as the seed import reads it. The upstream schema leaves `citation` and `sources` open, so each of their recorded variants is spelled out here: a variant the import has never seen fails the parse loudly rather than converting into something unchecked. The graphbox catalogue (Mearman/graphbox, src/data/catalog.json) has the same outer shape and is read only for the overlap report. */

/** One download of a dataset: a URL in a stated format, optionally naming the archive member to read and, for a delimited table, the columns holding an edge's endpoints and the header lines to skip, or a generator description for a synthetic dataset. */
export const SourceDownloadSchema = z.looseObject({
  format: z.string().optional(),
  url: z.string().optional(),
  innerPath: z.string().optional(),
  columns: z.tuple([z.int().min(0), z.int().min(0)]).optional(),
  skipLines: z.int().min(0).optional(),
  generator: z.string().optional(),
});
export type SourceDownload = z.infer<typeof SourceDownloadSchema>;

/** One source of a dataset: a landing page (a bare URL, the catalogue's legacy form, or a record whose `homepage` names it), a named source with downloads, or a cached-JSON record listing URLs. The object forms list only the keys the import reads, so the union narrows on `downloads`, `homepage` and `urls`. */
export const SourceEntrySchema = z.union([z.string(), z.object({ source: z.string().optional(), downloads: z.array(SourceDownloadSchema) }), z.object({ homepage: z.string() }), z.object({ format: z.string(), urls: z.array(z.string()) })]);
export type SourceEntry = z.infer<typeof SourceEntrySchema>;

/** A structured citation as the catalogue records most of them. */
export const StructuredCitationSchema = z.looseObject({
  authors: z.array(z.string()),
  title: z.string(),
  type: z.string(),
  year: z.union([z.number(), z.string()]),
  journal: z.string().optional(),
  volume: z.union([z.number(), z.string()]).optional(),
  number: z.union([z.number(), z.string()]).optional(),
  pages: z.union([z.number(), z.string()]).optional(),
  publisher: z.string().optional(),
  doi: z.string().optional(),
});
export type StructuredCitation = z.infer<typeof StructuredCitationSchema>;

/** A citation: structured, a list of `[reference, url]` pairs (the Netzschleuder-derived entries), or null where none is recorded. */
export const SourceCitationSchema = z.union([StructuredCitationSchema, z.array(z.tuple([z.string(), z.string()])), z.null()]);

/** One dataset of the source catalogue. */
export const SourceDatasetSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  domain: z.string().optional(),
  category: z.string().optional(),
  citation: SourceCitationSchema.optional(),
  retrieved: z.union([z.string(), z.null()]).optional(),
  sources: z.union([z.array(SourceEntrySchema), z.null()]).optional(),
  nodeCount: z.int().min(0),
  edgeCount: z.int().min(0),
  rawBytes: z.int().min(0).optional(),
  preferredFormat: z.string().optional(),
  properties: z.record(z.string(), z.unknown()),
});
export type SourceDataset = z.infer<typeof SourceDatasetSchema>;

/** The source catalogue document. */
export const SourceCatalogueSchema = z.looseObject({
  version: z.string(),
  generated: z.string(),
  datasets: z.record(z.string(), SourceDatasetSchema),
});
export type SourceCatalogue = z.infer<typeof SourceCatalogueSchema>;

/** The datasets this repository curates that the pipeline catalogue lacks, in the pipeline catalogue's own record shape. */
export const SupplementCatalogueSchema = z.looseObject({
  datasets: z.record(z.string(), SourceDatasetSchema),
});
export type SupplementCatalogue = z.infer<typeof SupplementCatalogueSchema>;

/**
 * The pipeline catalogue with the supplement's datasets added.
 * @param catalogue - The pipeline catalogue.
 * @param supplement - The datasets to add.
 * @returns The catalogue holding both sets of datasets.
 * @throws Error when a supplement dataset has the id of one the catalogue already holds, which the supplement would silently override.
 */
export function withSupplement(catalogue: SourceCatalogue, supplement: SupplementCatalogue): SourceCatalogue {
  for (const id of Object.keys(supplement.datasets)) {
    if (Object.hasOwn(catalogue.datasets, id)) {
      throw new Error(`the supplement dataset ${id} is already in the pipeline catalogue`);
    }
  }

  return { ...catalogue, datasets: { ...catalogue.datasets, ...supplement.datasets } };
}

/** A graphbox dataset, read only for its id and download URLs. */
export const GraphboxDatasetSchema = z.looseObject({
  id: z.string(),
  sources: z.union([z.array(SourceEntrySchema), z.null()]).optional(),
});

/** The graphbox catalogue document. */
export const GraphboxCatalogueSchema = z.looseObject({
  datasets: z.record(z.string(), GraphboxDatasetSchema),
});
export type GraphboxCatalogue = z.infer<typeof GraphboxCatalogueSchema>;

/**
 * Lists a dataset's downloads in catalogue order, flattening the source variants: a bare string or a `homepage` record is a landing page, and a cached-JSON record contributes its URLs.
 * @param sources - The catalogue's sources.
 * @returns Every download, synthetic ones included.
 */
export function downloadsOf(sources: readonly SourceEntry[]): SourceDownload[] {
  return sources.flatMap((source): SourceDownload[] => {
    if (typeof source === "string") {
      return [{ url: source, format: "landing-page" }];
    }
    if ("downloads" in source) {
      return source.downloads;
    }
    if ("homepage" in source) {
      return [{ url: source.homepage, format: "landing-page" }];
    }

    return source.urls.map((url) => ({ url, format: source.format }));
  });
}
