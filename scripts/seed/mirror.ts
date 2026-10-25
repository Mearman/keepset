import { z } from "zod";
import { HttpUrlSchema } from "../../src/entry";
import type { SourceCatalogue } from "./source";

/* A SuiteSparse download can be fetched from somewhere other than the collection's own link: the University of Florida host that served the collection before it moved to Texas A&M, which holds byte-identical copies of most of its files, and the file host the collection's own links redirect to, which now refuses requests but whose files the Wayback Machine captured. Each holds a fixed set of files (matrices added since are absent), so the import cannot assume a given file is there: the files each holds are recorded in an inventory in scripts/seed/sources/ (suitesparse-mirror.json and suitesparse-file-host.json, written by scripts/seed/probe-suitesparse-mirror.ts), and the import offers each holder's copy, in the order the inventories are given, ahead of the collection's own link for each file an inventory lists. */

/** A mirror inventory: how it is named in a flag, the host the files live under, the day they were probed, and the `MM/<group>/<name>.tar.gz` paths found there. */
export const SuiteSparseMirrorSchema = z
  .object({
    label: z.string().min(1),
    readOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: "must be a date, YYYY-MM-DD" }),
    host: HttpUrlSchema.refine((host) => host.endsWith("/"), { message: "must end with a slash" }),
    holds: z.array(z.string().regex(/^MM\/[^/]+\/[^/]+\.tar\.gz$/)),
  })
  .strict();
export type SuiteSparseMirror = z.infer<typeof SuiteSparseMirrorSchema>;

/** The inventory files in scripts/seed/sources/, in the order their holders' copies are offered: a file a holder lists is not asked of the holders after it, so each lists only the files it alone offers. */
export const MIRROR_INVENTORIES: readonly string[] = ["suitesparse-mirror.json", "suitesparse-file-host.json"];

/** The origin the collection's download links name, which the pipeline catalogue records. */
export const SUITESPARSE_ORIGIN = "https://sparse.tamu.edu/";

/**
 * The path of a SuiteSparse Matrix Market download under a host.
 * @param url - A URL.
 * @param host - The host prefix to read it under, ending in a slash.
 * @returns The `MM/<group>/<name>.tar.gz` path, or undefined when the URL is not such a download under that host.
 */
export function matrixMarketPath(url: string, host: string): string | undefined {
  if (!url.startsWith(host)) {
    return undefined;
  }
  const path = url.slice(host.length);

  return /^MM\/[^/]+\/[^/]+\.tar\.gz$/.test(path) ? path : undefined;
}

/**
 * The path of a SuiteSparse Matrix Market download under the collection's own origin or under any of the mirrors' hosts.
 * @param mirrors - The inventories.
 * @param url - A download URL.
 * @returns The `MM/<group>/<name>.tar.gz` path, or undefined when the URL is not such a download under any of them.
 */
export function matrixMarketPathAt(mirrors: readonly SuiteSparseMirror[], url: string): string | undefined {
  return [SUITESPARSE_ORIGIN, ...mirrors.map(({ host }) => host)].reduce<string | undefined>((found, host) => found ?? matrixMarketPath(url, host), undefined);
}

/**
 * The mirrors that hold a SuiteSparse download.
 * @param mirrors - The inventories, in the order their copies are offered.
 * @param url - A download URL from the catalogue.
 * @returns Each mirror holding it with the URL of its copy, none when the URL is not a SuiteSparse Matrix Market download or no mirror holds it.
 */
export function mirrorCopies(mirrors: readonly SuiteSparseMirror[], url: string): readonly { readonly mirror: SuiteSparseMirror; readonly url: string }[] {
  const path = matrixMarketPath(url, SUITESPARSE_ORIGIN);

  return path === undefined ? [] : mirrors.filter(({ holds }) => holds.includes(path)).map((mirror) => ({ mirror, url: `${mirror.host}${path}` }));
}

/**
 * Every SuiteSparse Matrix Market download the catalogue's datasets name.
 * @param catalogue - The source catalogue.
 * @returns The `MM/<group>/<name>.tar.gz` paths, sorted.
 */
export function suiteSparsePaths(catalogue: SourceCatalogue): string[] {
  const paths = new Set<string>();
  for (const dataset of Object.values(catalogue.datasets)) {
    for (const source of dataset.sources ?? []) {
      if (typeof source === "string" || !("downloads" in source)) {
        continue;
      }
      for (const download of source.downloads) {
        const path = download.url === undefined ? undefined : matrixMarketPath(download.url, SUITESPARSE_ORIGIN);
        if (path !== undefined) {
          paths.add(path);
        }
      }
    }
  }

  return [...paths].sort();
}
