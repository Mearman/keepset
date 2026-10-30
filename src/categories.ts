import { z } from "zod";
import { UnknownCategoryError } from "./errors";
import { GraphV1Schema, type GraphV1 } from "./targets/graph-v1";
import { COLLECTION_COUNTED, collectionOf, type Collection } from "./targets/collection";
import { ResourceFileSchema, ResourcesMetaSchema, ResourcesV1Schema, type ResourceFile, type ResourcesV1 } from "./targets/resources-v1";
import { TaskSchema, TasksMetaSchema, TasksV1Schema, type Task, type TasksV1 } from "./targets/tasks-v1";
import { TextSchema, TextsMetaSchema, TextsV1Schema, type Text, type TextsV1 } from "./targets/texts-v1";
import type { JsonScalar } from "./targets/json-scalar";

/** Every category id the registry knows. A category id is `<kind>/v<version>`: the kind of data, and the version of its normalisation target, so a breaking change to a target is a new category rather than an edit to an old one. */
export const CategoryIdSchema = z.enum(["graph/v1", "resources/v1", "tasks/v1", "texts/v1"]);
export type CategoryId = z.infer<typeof CategoryIdSchema>;

/** The normalisation target each category resolves to, keyed by category id. */
export interface CategoryTargets {
  readonly "graph/v1": GraphV1;
  readonly "tasks/v1": TasksV1;
  readonly "texts/v1": TextsV1;
  readonly "resources/v1": ResourcesV1;
}

/** The normalised shape of any category: what `fetchDataset` can resolve to. */
export type CategoryTarget = CategoryTargets[CategoryId];

/** The keys of a target whose values are arrays: the collections an entry's `expectedCounts` may name. */
export type CountedKey<Target> = { readonly [Key in keyof Target]: Target[Key] extends readonly unknown[] ? Key : never }[keyof Target] & string;

/** What a fetch of a collection entry resolves to: the entry's metadata and one instance per archive member, each a document of the entry's category. */
export type CollectionTarget<Id extends CategoryId = CategoryId> = Id extends CategoryId ? Collection<CategoryTargets[Id]> : never;

/** The node a streamed result of each category hands on, for a category whose target is `{ meta, nodes }` and nothing else. */
export interface StreamedNodes {
  readonly "tasks/v1": Task;
  readonly "texts/v1": Text;
  readonly "resources/v1": ResourceFile;
}

/** The categories that can be streamed. */
export type StreamableId = keyof StreamedNodes & CategoryId;

/** How a streamed result of a category is checked: its target is meta and nodes with unique ids, so the meta is checked once and each node on its own, and the ids across every node. */
export interface StreamedShape<Node> {
  readonly meta: z.ZodType<Record<string, JsonScalar>>;
  readonly node: z.ZodType<Node>;
}

/** One category: its id, what it holds, the schema of its normalisation target (one document), the schema of a collection of such documents derived from it, which of the target's arrays an entry may record expected counts for, and for a category whose target is meta and nodes alone the shape a streamed result is checked against. */
interface CategoryOf<Id extends CategoryId> {
  readonly id: Id;
  readonly description: string;
  readonly target: z.ZodType<CategoryTargets[Id]>;
  readonly collection: z.ZodType<Collection<CategoryTargets[Id]>>;
  readonly counted: readonly CountedKey<CategoryTargets[Id]>[];
  readonly streamed: Id extends StreamableId ? StreamedShape<StreamedNodes[Id]> : undefined;
}

/** A category, or with no argument any of them: a union over the ids, so each category keeps its own target and counted keys. */
export type Category<Id extends CategoryId = CategoryId> = Id extends CategoryId ? CategoryOf<Id> : never;

/** The registry. Adding a category is adding its id to `CategoryIdSchema` and its entry here, with its target schema beside graph/v1's in src/targets/: the mapped type makes the compiler reject a registry that misses an id or has one too many. */
const registry: { readonly [Id in CategoryId]: CategoryOf<Id> } = {
  "graph/v1": {
    id: "graph/v1",
    description: "A graph as { meta, nodes, edges }: a flat record of scalar metadata, nodes carrying at least an id, and edges carrying at least source and target node ids, with optional node and edge types.",
    target: GraphV1Schema,
    collection: collectionOf(GraphV1Schema),
    counted: ["nodes", "edges"],
    streamed: undefined,
  },
  "tasks/v1": {
    id: "tasks/v1",
    description: "A set of tasks (places or cases to visit or serve) as { meta, nodes }: a flat record of scalar metadata and nodes carrying at least an id, with optional coordinates, prize, prize probability, duration, travel time, skill, territory, lifecycle status and times, and deadline.",
    target: TasksV1Schema,
    collection: collectionOf(TasksV1Schema),
    counted: ["nodes"],
    streamed: { meta: TasksMetaSchema, node: TaskSchema },
  },
  "texts/v1": {
    id: "texts/v1",
    description: "A set of texts (works in a collection, such as the books of a library's catalogue) as { meta, nodes }: a flat record of scalar metadata and nodes carrying at least an id, with optional title, language, authors, subjects, issue date, type, classification and collections.",
    target: TextsV1Schema,
    collection: collectionOf(TextsV1Schema),
    counted: ["nodes"],
    streamed: { meta: TextsMetaSchema, node: TextSchema },
  },
  "resources/v1": {
    id: "resources/v1",
    description: "A downloadable resource as { meta, nodes }: a flat record of scalar metadata saying what the resource is, and nodes carrying at least an id, one per file it is distributed as, with optional url, size and description.",
    target: ResourcesV1Schema,
    collection: collectionOf(ResourcesV1Schema),
    counted: ["nodes"],
    streamed: { meta: ResourcesMetaSchema, node: ResourceFileSchema },
  },
};

/**
 * Looks up a category by id.
 * @param id - Any string; category ids usually come from entry documents, so the argument is untrusted.
 * @returns The category.
 * @throws UnknownCategoryError when no category has that id.
 */
export function getCategory<Id extends CategoryId>(id: Id): Category<Id>;
export function getCategory(id: string): Category;
export function getCategory(id: string): Category {
  const parsed = CategoryIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new UnknownCategoryError(id, CategoryIdSchema.options);
  }

  return registry[parsed.data];
}

/**
 * Returns the schema of a category's normalisation target.
 * @param id - Any string, as for `getCategory`.
 * @returns The target schema.
 * @throws UnknownCategoryError when no category has that id.
 */
export function getTarget<Id extends CategoryId>(id: Id): z.ZodType<CategoryTargets[Id]>;
export function getTarget(id: string): z.ZodType<CategoryTarget>;
export function getTarget(id: string): z.ZodType<CategoryTarget> {
  return getCategory(id).target;
}

/**
 * Returns the schema of a collection of documents of a category: `{ meta, instances }`, each instance a document of the category under an id, derived from the category's own target schema.
 * @param id - Any string, as for `getCategory`.
 * @returns The collection schema.
 * @throws UnknownCategoryError when no category has that id.
 */
export function getCollectionTarget(id: string): z.ZodType<CollectionTarget> {
  return getCategory(id).collection;
}

/**
 * Whether a category's results can be streamed: its target is meta and nodes alone.
 * @param id - A category id.
 * @returns True for a streamable category.
 */
export function isStreamable(id: CategoryId): id is StreamableId {
  return getCategory(id).streamed !== undefined;
}

/**
 * The shape a streamed result of a category is checked against.
 * @param id - A streamable category id.
 * @returns Its meta and node schemas.
 */
export function getStreamedShape<Id extends StreamableId>(id: Id): StreamedShape<StreamedNodes[Id]> {
  return registry[id].streamed;
}

/**
 * The kind of data a category holds: the part of its id before the version.
 * @param id - A category id.
 * @returns The kind, such as `graph`.
 */
export function kindOf(id: CategoryId): string {
  return id.slice(0, id.indexOf("/"));
}

/** @returns Every registered category, in id order. */
export function listCategories(): readonly Category[] {
  return CategoryIdSchema.options.map((id) => getCategory(id));
}

/**
 * The length of one of a target's arrays.
 * @param target - A resolved target.
 * @param key - A key that holds an array.
 * @returns The array's length.
 * @throws TypeError when the key holds no array, which a registry entry's `counted` never names.
 */
function countOf(target: CategoryTarget | CollectionTarget, key: string): number {
  const found: unknown = Object.entries(target).find(([name]) => name === key)?.[1];
  if (!Array.isArray(found)) {
    throw new TypeError(`the target has no collection ${key}`);
  }

  return found.length;
}

/**
 * The keys of a resolved target an entry may record expected counts for: a document's own arrays, or for a collection its instances.
 * @param id - The target's category.
 * @param collection - Whether the entry's recipe reads a collection.
 * @returns The countable keys.
 */
export function countedKeys(id: CategoryId, collection: boolean): readonly string[] {
  return collection ? COLLECTION_COUNTED : getCategory(id).counted;
}

/**
 * Counts the arrays an entry may record expected counts for, in a resolved target.
 * @param id - The target's category.
 * @param target - A resolved document of that category, or a collection of them.
 * @returns The length of each counted array, by key.
 */
export function countTarget(id: CategoryId, target: CategoryTarget | CollectionTarget): ReadonlyMap<string, number> {
  const keys = countedKeys(id, "instances" in target);

  return new Map(keys.map((key) => [key, countOf(target, key)]));
}
