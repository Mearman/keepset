import { CrosswalkSchema, validateCrosswalk, type Crosswalk } from "crossmap";
import { z } from "zod";
import { kindOf } from "./categories";
import { define } from "./define";
import { EntrySchema, RelativePathSchema, toIssues, type Entry } from "./entry";
import { CatalogueSyntaxError, DatasetAmbiguousError, DatasetNotFoundError } from "./errors";
import { ManifestSchema, type Manifest } from "./manifest";
import { groupsOf, NAME_SEPARATOR, namesOf } from "./names";
import { getOwn } from "./own";
import { recordOf } from "./record";

/**
 * A catalogue index: the manifest, every entry, and every crosswalk file of the catalogue, keyed by its catalogue-relative path. The build assembles it from a catalogue directory; a consumer holding its own catalogue (a fork, say) can pass one to `createCatalogue`. Entry ids are unique, no two entries have the same name once case and surrounding or repeated spaces are ignored (a listing would show two rows a reader cannot tell apart), every fully qualified name (the whole path of an id or alias) identifies one entry and is not another entry's id, every entry `sameDataAs` names exists and names the entry back (the same data is the same data from either side), every namespace segment the manifest gives aliases to is some entry's segment and no alias is itself one, every crosswalk passes crossmap's structural validation, every crosswalk file reference resolves, and every crosswalk's target is the category of each entry that uses it.
 */
export const CatalogueIndexSchema = define(
  z
    .object({
      manifest: ManifestSchema,
      crosswalks: recordOf(RelativePathSchema, CrosswalkSchema),
      entries: z.array(EntrySchema),
    })
    .strict()
    .superRefine((index, ctx) => {
      for (const [file, crosswalk] of Object.entries(index.crosswalks)) {
        for (const issue of validateCrosswalk(crosswalk)) {
          ctx.addIssue({ code: "custom", path: ["crosswalks", file], message: `rule ${String(issue.ruleIndex)}: ${issue.message}` });
        }
      }
      const segments = new Set(index.entries.flatMap((entry) => groupsOf(entry).flat()));
      for (const [segment, aliases] of Object.entries(index.manifest.namespaceAliases ?? {})) {
        if (!segments.has(segment)) {
          ctx.addIssue({ code: "custom", path: ["manifest", "namespaceAliases", segment], message: `no entry has a namespace segment ${segment}, so it has nothing to be an alias of` });
        }
        for (const alias of aliases.filter((name) => segments.has(name))) {
          ctx.addIssue({ code: "custom", path: ["manifest", "namespaceAliases", segment], message: `${alias} is already a namespace segment of an entry, so it cannot also be an alias` });
        }
      }
      const seen = new Set<string>();
      const ids = new Set(index.entries.map((entry) => entry.id));
      const owners = new Map<string, string>();
      const sameData = new Map(index.entries.map((entry) => [entry.id, new Set(entry.sameDataAs)]));
      const namers = new Map<string, string>();
      for (const [position, entry] of index.entries.entries()) {
        const listed = entry.name.trim().replace(/\s+/g, " ").toLowerCase();
        const namer = namers.get(listed);
        if (namer === undefined) {
          namers.set(listed, entry.id);
        } else if (namer !== entry.id) {
          ctx.addIssue({ code: "custom", path: ["entries", position, "name"], message: `${entry.name} is also the name of entry ${namer}, so a listing would show the two alike; name the source or variant that tells them apart` });
        }
        if (seen.has(entry.id)) {
          ctx.addIssue({ code: "custom", path: ["entries", position, "id"], message: `duplicate entry id ${entry.id}` });
        }
        seen.add(entry.id);
        for (const other of entry.sameDataAs ?? []) {
          const theirs = sameData.get(other);
          if (theirs === undefined) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "sameDataAs"], message: `${other} is not an entry of the catalogue` });
          } else if (!theirs.has(entry.id)) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "sameDataAs"], message: `${other} does not name ${entry.id} back, so the two disagree on whether they hold the same data` });
          }
        }
        for (const name of namesOf(entry).full) {
          const owner = owners.get(name);
          if (owner !== undefined && owner !== entry.id) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "aliases"], message: `${name} already names entry ${owner}` });
          } else if (name !== entry.id && ids.has(name)) {
            // A lookup tries ids first, so an alias equal to another entry's id could never reach the entry that declares it.
            ctx.addIssue({ code: "custom", path: ["entries", position, "aliases"], message: `${name} is the id of another entry, which a lookup would reach instead` });
          }
          owners.set(name, owner ?? entry.id);
        }
        if (!("file" in entry.crosswalk)) {
          for (const issue of validateCrosswalk(entry.crosswalk)) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "crosswalk"], message: `rule ${String(issue.ruleIndex)}: ${issue.message}` });
          }
        } else {
          const crosswalk = getOwn(index.crosswalks, entry.crosswalk.file);
          if (crosswalk === undefined) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "crosswalk", "file"], message: `no crosswalk file ${entry.crosswalk.file} in the catalogue` });
          } else if (crosswalk.target !== entry.category) {
            ctx.addIssue({ code: "custom", path: ["entries", position, "crosswalk", "file"], message: `${entry.crosswalk.file} targets ${crosswalk.target}, not the entry's category ${entry.category}` });
          }
        }
      }
    }),
);
export type CatalogueIndex = z.infer<typeof CatalogueIndexSchema>;

/** One dataset as the library returns it: the entry (descriptor, sources, licence, citations and recipe), the kind of data its category holds, its crosswalk resolved from a file reference where it has one, and the catalogue it came from. */
export interface Dataset {
  readonly entry: Entry;
  readonly kind: string;
  readonly crosswalk: Crosswalk;
  readonly catalogue: Pick<Manifest, "id" | "version">;
}

/** Filters for `listDatasets`. Every filter given must match; none given lists everything. */
export interface DatasetQuery {
  /** The kind of data, such as `graph`: the part of the category id before the version. */
  readonly kind?: string;
  /** A category id, such as `graph/v1`. */
  readonly category?: string;
  /** The entry's domain, matched exactly. */
  readonly domain?: string;
  /** A subject slug such as `operations-research`, matched exactly against the entry's subjects. */
  readonly subject?: string;
  /** A group path such as `suitesparse` or `suitesparse/gset`, in which any segment may be an alias the manifest gives it: matches the entries in that group, in any group beneath it, and the entries a path alias files there. */
  readonly namespace?: string;
  /** Text that must appear, ignoring case, in the entry's id, an alias, one of its groups, name, description, domain, one of its subjects or one of its tags. */
  readonly text?: string;
}

/** One namespace in the tree of groups: its path, its last segment, and how many distinct entries sit in it or in any namespace beneath it. */
export interface NamespaceNode {
  readonly path: string;
  readonly name: string;
  readonly count: number;
}

/** A queryable catalogue: the surface `listDatasets`, `getDataset` and `listNamespaces` are bound to. */
export interface Catalogue {
  readonly manifest: Manifest;
  /**
   * Lists the datasets matching a query, in entry id order.
   * @param query - The filters; all must match.
   * @returns The matching datasets.
   */
  readonly listDatasets: (query?: DatasetQuery) => Dataset[];
  /**
   * Returns one dataset by name. An entry's own id always resolves to it, ahead of any alias or shorter form; otherwise the name is an alias, or an id or alias with any trailing run of the entry's namespace before it (`b/c` or `a/b/c` for id `c` in namespace `a/b`), and resolves only when exactly one entry answers to it.
   * @param name - An entry id, alias or qualified name; untrusted, so lookup never reaches inherited properties.
   * @returns The dataset.
   * @throws DatasetAmbiguousError when more than one entry answers to the name and none has it as its id.
   * @throws DatasetNotFoundError when no entry answers to the name.
   */
  readonly getDataset: (name: string) => Dataset;
  /**
   * Lists the namespaces directly beneath a path, or the outermost ones, with how many entries each holds. The tree is every group of every entry and each path above it, so an entry filed in `a/b` counts toward `a/b` and `a`.
   * @param path - A group path whose children to list, in which any segment may be an alias the manifest gives it; absent for the outermost namespaces.
   * @returns The child namespaces in path order; empty when the path has none, whether it is unknown or a leaf.
   */
  readonly listNamespaces: (path?: string) => NamespaceNode[];
}

/**
 * Whether a dataset matches a query.
 * @param dataset - The dataset.
 * @param query - The filters.
 * @param groups - The dataset's groups, each as a path joined by the separator.
 * @param namespace - The query's namespace with every segment alias replaced by its segment, when it has one.
 * @returns True when every given filter matches.
 */
function matches(dataset: Dataset, query: DatasetQuery, groups: readonly string[], namespace: string | undefined): boolean {
  const { entry } = dataset;
  if (query.kind !== undefined && dataset.kind !== query.kind) {
    return false;
  }
  if (query.category !== undefined && entry.category !== query.category) {
    return false;
  }
  if (query.domain !== undefined && entry.domain !== query.domain) {
    return false;
  }
  if (query.subject !== undefined && entry.subjects?.includes(query.subject) !== true) {
    return false;
  }
  if (namespace !== undefined && !groups.some((group) => group === namespace || group.startsWith(`${namespace}${NAME_SEPARATOR}`))) {
    return false;
  }
  if (query.text !== undefined) {
    const needle = query.text.toLowerCase();
    const haystack = [entry.id, ...(entry.aliases ?? []), ...groups, entry.name, entry.description, entry.domain, ...(entry.subjects ?? []), ...entry.tags].filter((field): field is string => field !== undefined);

    return haystack.some((field) => field.toLowerCase().includes(needle));
  }

  return true;
}

/**
 * Builds the tree of namespaces: every group of every entry and each path above it, with the ids of the entries at or beneath each.
 * @param groupsById - Each entry's groups, each as a path joined by the separator.
 * @returns The child namespaces of each path, the outermost ones under the empty path, each list in path order.
 */
function namespaceTree(groupsById: ReadonlyMap<string, readonly string[]>): Map<string, NamespaceNode[]> {
  const members = new Map<string, Set<string>>();
  for (const [id, groups] of groupsById) {
    for (const group of groups) {
      const segments = group.split(NAME_SEPARATOR);
      for (let length = 1; length <= segments.length; length += 1) {
        const path = segments.slice(0, length).join(NAME_SEPARATOR);
        members.set(path, (members.get(path) ?? new Set<string>()).add(id));
      }
    }
  }
  const children = new Map<string, NamespaceNode[]>();
  for (const [path, ids] of [...members].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const cut = path.lastIndexOf(NAME_SEPARATOR);
    const parent = cut === -1 ? "" : path.slice(0, cut);
    children.set(parent, [...(children.get(parent) ?? []), { path, name: path.slice(cut + 1), count: ids.size }]);
  }

  return children;
}

/**
 * Builds a queryable catalogue from an index. Pure and synchronous: no filesystem, no network, so it runs the same in a browser as in Node.
 * @param index - A candidate catalogue index.
 * @returns The catalogue.
 * @throws CatalogueSyntaxError carrying every issue when the index is not a valid catalogue.
 */
export function createCatalogue(index: unknown): Catalogue {
  const parsed = CatalogueIndexSchema.safeParse(index);
  if (!parsed.success) {
    throw new CatalogueSyntaxError("catalogue", toIssues(parsed.error));
  }
  const { manifest, crosswalks, entries } = parsed.data;
  const catalogue = { id: manifest.id, version: manifest.version };
  const segmentAliases = manifest.namespaceAliases ?? {};
  const segmentOf = new Map(Object.entries(segmentAliases).flatMap(([segment, aliases]) => aliases.map((alias): [string, string] => [alias, segment])));
  // A group path as the catalogue spells it: every segment alias replaced by the segment it stands for.
  const canonical = (path: string): string =>
    path
      .split(NAME_SEPARATOR)
      .map((segment) => segmentOf.get(segment) ?? segment)
      .join(NAME_SEPARATOR);
  const datasets = new Map<string, Dataset>();
  const groupsById = new Map<string, readonly string[]>();
  // Every name an entry answers to, mapped to the ids of the entries that answer to it, in id order.
  const names = new Map<string, string[]>();
  for (const entry of [...entries].sort((left, right) => (left.id < right.id ? -1 : 1))) {
    // The schema's refinement has already proved every file reference resolves, so the throw below is unreachable for a parsed index; it narrows the lookup without an assertion.
    const crosswalk = "file" in entry.crosswalk ? getOwn(crosswalks, entry.crosswalk.file) : entry.crosswalk;
    if (crosswalk === undefined) {
      throw new CatalogueSyntaxError("catalogue", [{ path: `entries.${entry.id}.crosswalk.file`, message: "the crosswalk file does not resolve" }]);
    }
    datasets.set(entry.id, { entry, kind: kindOf(entry.category), crosswalk, catalogue });
    groupsById.set(entry.id, groupsOf(entry).map((group) => group.join(NAME_SEPARATOR)));
    for (const name of namesOf(entry, segmentAliases).all) {
      names.set(name, [...(names.get(name) ?? []), entry.id]);
    }
  }
  const tree = namespaceTree(groupsById);

  return {
    manifest,
    listDatasets: (query = {}) => {
      const namespace = query.namespace === undefined ? undefined : canonical(query.namespace);

      return [...datasets.values()].filter((dataset) => matches(dataset, query, groupsById.get(dataset.entry.id) ?? [], namespace));
    },
    getDataset: (name) => {
      const exact = datasets.get(name);
      if (exact !== undefined) {
        return exact;
      }
      const candidates = names.get(name) ?? [];
      const [only, ...others] = candidates;
      if (only === undefined) {
        throw new DatasetNotFoundError(name);
      }
      if (others.length > 0) {
        throw new DatasetAmbiguousError(name, candidates);
      }
      const dataset = datasets.get(only);
      if (dataset === undefined) {
        throw new DatasetNotFoundError(name);
      }

      return dataset;
    },
    listNamespaces: (path) => tree.get(path === undefined ? "" : canonical(path)) ?? [],
  };
}
