import { z } from "zod";
import { matrixMarketPathAt, type SuiteSparseMirror } from "./mirror";
import { networkDomain, networkName, type NetzschleuderIndex } from "./netzschleuder-index";
import type { SourceDownload } from "./source";
import { matrixKey, type SuiteSparseIndex } from "./suitesparse-index";

/* What the collections' own indexes and hosts state of their datasets, which the source catalogue leaves unrecorded for most of them: the domain of a SuiteSparse matrix or a Netzschleuder network. */

/** The curated domain of each dataset whose source catalogue and collection index state none, by dataset id, each read from the dataset's own description and the topics its collection files it under. */
export const GraphDomainsSchema = z.object({ domains: z.record(z.string().min(1), z.string().min(1)) }).strict();

/** What the indexes of the collections the catalogue draws on state of their datasets. */
export interface SourceFacts {
  /** The kind of each SuiteSparse matrix. */
  readonly suiteSparse: SuiteSparseIndex;
  /** The tags of each Netzschleuder network. */
  readonly netzschleuder: NetzschleuderIndex;
}

/**
 * The kind the SuiteSparse index states for the matrix a dataset downloads.
 * @param downloads - The dataset's downloads.
 * @param mirrors - The SuiteSparse mirrors, whose downloads are laid out as the collection's own.
 * @param index - What the SuiteSparse index states of each matrix.
 * @returns The kind of the first download that is a SuiteSparse Matrix Market file the index lists, or undefined.
 */
function kindOf(downloads: readonly SourceDownload[], mirrors: readonly SuiteSparseMirror[], index: SuiteSparseIndex): string | undefined {
  for (const { url } of downloads) {
    const path = url === undefined ? undefined : matrixMarketPathAt(mirrors, url);
    const key = path === undefined ? undefined : matrixKey(path);
    if (key !== undefined && Object.hasOwn(index.kinds, key)) {
      return index.kinds[key];
    }
  }

  return undefined;
}

/**
 * The domain a Netzschleuder network's tags give a dataset.
 * @param downloads - The dataset's downloads.
 * @param index - The tags of each Netzschleuder network.
 * @returns The domain of the first download that is a network the index lists, or undefined.
 */
function topicOf(downloads: readonly SourceDownload[], index: NetzschleuderIndex): string | undefined {
  for (const { url } of downloads) {
    const name = url === undefined ? undefined : networkName(url);
    const [first, ...rest] = name !== undefined && Object.hasOwn(index.networks, name) ? (index.networks[name] ?? []) : [];
    if (first !== undefined) {
      return networkDomain([first, ...rest]);
    }
  }

  return undefined;
}

/**
 * The domain the collections' indexes give the dataset a set of downloads belongs to.
 * @param downloads - The dataset's downloads.
 * @param mirrors - The SuiteSparse mirrors, whose downloads are laid out as the collection's own.
 * @param facts - The collections' indexes.
 * @returns A SuiteSparse matrix's kind or a Netzschleuder network's topic, or undefined where neither index lists the dataset.
 */
export function indexedDomainOf(downloads: readonly SourceDownload[], mirrors: readonly SuiteSparseMirror[], facts: SourceFacts): string | undefined {
  return kindOf(downloads, mirrors, facts.suiteSparse) ?? topicOf(downloads, facts.netzschleuder);
}
