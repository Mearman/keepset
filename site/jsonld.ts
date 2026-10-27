import { rawSnapshotUrl, type Dataset } from "keepset";

/** A schema.org DataDownload: one place the dataset's bytes can be fetched from. */
export interface DataDownload {
  readonly "@type": "DataDownload";
  readonly contentUrl: string;
  readonly archivedAt?: string;
  /** The SHA-256 of the bytes at `contentUrl`, where the entry records one for the snapshot it points at. */
  readonly sha256?: string;
}

/** The schema.org Dataset (https://schema.org/Dataset) an entry page carries, with the properties Google Dataset Search reads (https://developers.google.com/search/docs/appearance/structured-data/dataset): name and description are required there, the rest recommended. */
export interface DatasetJsonLd {
  readonly "@context": "https://schema.org";
  readonly "@type": "Dataset";
  readonly name: string;
  readonly description: string;
  readonly url: string;
  readonly identifier: string;
  readonly keywords: readonly string[];
  readonly license?: string;
  readonly alternateName?: readonly string[];
  /** The pages of the entries that hold the same data, as another file or in another format. */
  readonly sameAs?: readonly string[];
  readonly citation?: readonly string[];
  readonly isPartOf: { readonly "@type": "DataCatalog"; readonly name: string; readonly url: string };
  readonly distribution: readonly DataDownload[];
}

/**
 * The description schema.org gets: the entry's own, or for an entry without one a sentence stating only what the catalogue records about it, since Dataset Search requires a description.
 * @param dataset - The dataset.
 * @returns The description.
 */
export function describe(dataset: Dataset): string {
  const { entry } = dataset;

  if (entry.description !== undefined) {
    return entry.description;
  }

  return `${entry.name}, a ${dataset.kind} dataset in the ${dataset.catalogue.id} catalogue, normalised to ${entry.category}.`;
}

/**
 * The schema.org Dataset for an entry page. A dead source's distribution points at its pinned snapshot and names it as `archivedAt`, so a crawler is sent to bytes that still exist.
 * @param dataset - The dataset.
 * @param pageUrl - The absolute URL of the entry's page.
 * @param catalogueUrl - The absolute URL of the site's root.
 * @returns The JSON-LD document.
 */
export function datasetJsonLd(dataset: Dataset, pageUrl: string, catalogueUrl: string): DatasetJsonLd {
  const { entry } = dataset;
  const { licence } = entry;
  const license = licence.kind === "spdx" ? `https://spdx.org/licenses/${licence.id}.html` : licence.kind === "custom" ? licence.url : undefined;
  const citation = entry.citations.map((cited) => (cited.doi === undefined ? cited.text : `${cited.text} https://doi.org/${cited.doi}`));

  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: entry.name,
    description: describe(dataset),
    url: pageUrl,
    identifier: entry.id,
    ...(entry.aliases === undefined ? {} : { alternateName: entry.aliases }),
    ...(entry.sameDataAs === undefined ? {} : { sameAs: entry.sameDataAs.map((id) => `${catalogueUrl}datasets/${id}/`) }),
    keywords: [dataset.kind, ...(entry.domain === undefined ? [] : [entry.domain]), ...(entry.subjects ?? []), ...entry.tags],
    ...(license === undefined ? {} : { license }),
    ...(citation.length === 0 ? {} : { citation }),
    isPartOf: { "@type": "DataCatalog", name: dataset.catalogue.id, url: catalogueUrl },
    distribution: entry.sources.map((source) =>
      source.status === "dead" && source.snapshot !== undefined
        ? { "@type": "DataDownload", contentUrl: rawSnapshotUrl(source.snapshot.timestamp, source.url), archivedAt: source.snapshot.url, ...(source.snapshot.sha256 === undefined ? {} : { sha256: source.snapshot.sha256 }) }
        : { "@type": "DataDownload", contentUrl: source.url, ...(source.snapshot === undefined ? {} : { archivedAt: source.snapshot.url }) },
    ),
  };
}
