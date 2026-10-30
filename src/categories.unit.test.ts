import { describe, expect, it } from "vitest";
import { CategoryIdSchema, countTarget, getCategory, getCollectionTarget, getTarget, kindOf, listCategories } from "./categories";
import { KeepsetError, UnknownCategoryError } from "./errors";
import { GraphV1Schema } from "./targets/graph-v1";
import { TasksV1Schema } from "./targets/tasks-v1";
import { TextsV1Schema } from "./targets/texts-v1";

const graph = {
  meta: { name: "Zachary karate club", directed: false, nodeCount: 3, note: null },
  nodes: [{ id: "1", type: "member" }, { id: "2" }, { id: "3", label: "kept as given" }],
  edges: [
    { source: "1", target: "2", type: "friendship" },
    { source: "2", target: "3", weight: 4 },
  ],
};

describe("the category registry", () => {
  it("resolves graph/v1 to its target schema", () => {
    expect(getTarget("graph/v1")).toBe(GraphV1Schema);
    expect(getCategory("graph/v1").id).toBe("graph/v1");
  });

  it("resolves tasks/v1 to its target schema", () => {
    expect(getTarget("tasks/v1")).toBe(TasksV1Schema);
    expect(getCategory("tasks/v1").counted).toEqual(["nodes"]);
  });

  it("resolves texts/v1 to its target schema", () => {
    expect(getTarget("texts/v1")).toBe(TextsV1Schema);
    expect(getCategory("texts/v1").counted).toEqual(["nodes"]);
  });

  it("rejects an unknown category id with an error naming the known ones", () => {
    expect(() => getTarget("graph/v2")).toThrow(UnknownCategoryError);
    expect(() => getTarget("graph/v2")).toThrow(KeepsetError);
    expect(() => getTarget("graph/v2")).toThrow(/known categories are graph\/v1, tasks\/v1, texts\/v1/);
  });

  it("holds the removed ids out of the registry: the registry is graph/v1, tasks/v1 and texts/v1, and or/v1 and or-set/v1 are unknown", () => {
    expect(listCategories().map((category) => category.id)).toEqual(["graph/v1", "tasks/v1", "texts/v1"]);
    for (const removed of ["or/v1", "or-set/v1"]) {
      expect(() => getTarget(removed)).toThrow(UnknownCategoryError);
      expect(() => getCategory(removed)).toThrow(/known categories are graph\/v1, tasks\/v1, texts\/v1$/);
    }
  });

  it("does not resolve names inherited from Object.prototype", () => {
    expect(() => getTarget("constructor")).toThrow(UnknownCategoryError);
    expect(() => getTarget("__proto__")).toThrow(UnknownCategoryError);
  });

  it("keys every category by its own id, in the kind/version form", () => {
    for (const category of listCategories()) {
      expect(CategoryIdSchema.parse(category.id)).toBe(category.id);
      expect(category.id).toMatch(/^[a-z][a-z0-9-]*\/v[1-9]\d*$/);
    }
    expect(listCategories().map((category) => category.id)).toEqual(CategoryIdSchema.options);
  });

  it("derives the kind of data from the id", () => {
    expect(kindOf("graph/v1")).toBe("graph");
    expect(kindOf("tasks/v1")).toBe("tasks");
    expect(kindOf("texts/v1")).toBe("texts");
  });
});

describe("the graph/v1 target", () => {
  it("accepts a representative graph, keeping fields beyond the target", () => {
    expect(GraphV1Schema.parse(graph)).toEqual(graph);
  });

  it("rejects a node without an id", () => {
    expect(GraphV1Schema.is({ ...graph, nodes: [...graph.nodes, { type: "member" }] })).toBe(false);
  });

  it("rejects an edge without a source or a target", () => {
    expect(GraphV1Schema.is({ ...graph, edges: [{ target: "1" }] })).toBe(false);
    expect(GraphV1Schema.is({ ...graph, edges: [{ source: "1" }] })).toBe(false);
  });

  it("rejects an edge whose endpoint names no node", () => {
    const result = GraphV1Schema.safeParse({ ...graph, edges: [{ source: "1", target: "9" }] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([["edges", 0, "target"]]);
  });

  it("rejects duplicate node ids", () => {
    expect(GraphV1Schema.is({ ...graph, nodes: [...graph.nodes, { id: "1" }] })).toBe(false);
  });

  it("rejects metadata that is not a flat record of scalars", () => {
    expect(GraphV1Schema.is({ ...graph, meta: { nested: { a: 1 } } })).toBe(false);
    expect(GraphV1Schema.is({ ...graph, meta: { count: Number.POSITIVE_INFINITY } })).toBe(false);
  });

  it("rejects a __proto__ metadata key rather than dropping it", () => {
    const meta: unknown = JSON.parse('{"__proto__": "x"}');
    expect(GraphV1Schema.is({ ...graph, meta })).toBe(false);
  });

  it("rejects a field beyond meta, nodes and edges at the top level", () => {
    expect(GraphV1Schema.is({ ...graph, extra: true })).toBe(false);
  });
});

const instance = {
  meta: { name: "Service requests", durationUnit: "seconds", note: null },
  nodes: [
    { id: "a", lat: 51.5, lon: -0.1, duration: 120, status: "Open", territory: "Camden", deadline: "2026-11-01" },
    { id: "b", lat: null, prize: 3, prizeProbability: 0.25, deadline: 1800, skill: "plumbing" },
    { id: "c", extraColumn: "kept as given" },
  ],
};

const catalogue = {
  meta: { name: "Library catalogue", note: null },
  nodes: [
    { id: "1", title: "The Declaration of Independence", language: "en", authors: "Jefferson, Thomas, 1743-1826", issued: "1971-12-01", type: "Text" },
    { id: "2", title: null, collections: "Politics; United States Law", extraColumn: "kept as given" },
  ],
};

describe("the texts/v1 target", () => {
  it("accepts a representative catalogue, with every field optional or null and others kept", () => {
    expect(TextsV1Schema.parse(catalogue)).toEqual(catalogue);
  });

  it("rejects a node without an id and a duplicate id", () => {
    expect(TextsV1Schema.is({ ...catalogue, nodes: [{ title: "x" }] })).toBe(false);
    const result = TextsV1Schema.safeParse({ ...catalogue, nodes: [{ id: "a" }, { id: "a" }] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/duplicate node id/);
  });

  it("rejects an empty text field, a non-text field and any key beyond meta and nodes", () => {
    for (const node of [{ title: "" }, { language: 5 }, { authors: [] }]) {
      expect(TextsV1Schema.is({ ...catalogue, nodes: [{ id: "a", ...node }] })).toBe(false);
    }
    expect(TextsV1Schema.is({ ...catalogue, edges: [] })).toBe(false);
  });

  it("counts its nodes", () => {
    expect(countTarget("texts/v1", TextsV1Schema.parse(catalogue))).toEqual(new Map([["nodes", catalogue.nodes.length]]));
  });
});

describe("the tasks/v1 target", () => {
  it("accepts a representative instance, with every field optional or null and others kept", () => {
    expect(TasksV1Schema.parse(instance)).toEqual(instance);
  });

  it("rejects a node without an id and a duplicate id", () => {
    expect(TasksV1Schema.is({ ...instance, nodes: [{ lat: 1 }] })).toBe(false);
    const result = TasksV1Schema.safeParse({ ...instance, nodes: [{ id: "a" }, { id: "a" }] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/duplicate node id/);
  });

  it("rejects values outside a field's range or kind", () => {
    for (const node of [{ lat: 91 }, { lat: -91 }, { lon: 181 }, { prizeProbability: 1.5 }, { prizeProbability: -0.1 }, { duration: -1 }, { travelTime: -1 }, { prize: "3" }, { skill: "" }, { deadline: true }]) {
      expect(TasksV1Schema.is({ ...instance, nodes: [{ id: "a", ...node }] })).toBe(false);
    }
  });

  it("rejects an instance with arcs or any key beyond meta and nodes, and a non-scalar meta value", () => {
    expect(TasksV1Schema.is({ ...instance, arcs: [] })).toBe(false);
    expect(TasksV1Schema.is({ ...instance, meta: { nested: { a: 1 } } })).toBe(false);
  });

  it("counts its nodes", () => {
    expect(countTarget("tasks/v1", TasksV1Schema.parse(instance))).toEqual(new Map([["nodes", instance.nodes.length]]));
  });
});

describe("a collection of any category", () => {
  const orSet = {
    meta: { name: "Route suite" },
    instances: [
      { id: "suite/a.txt", meta: { capacity: 200 }, nodes: [{ id: "1", x: 4, y: 5 }, { id: "2", prize: 3 }] },
      { id: "suite/b.txt", meta: {}, nodes: [{ id: "1", x: 0, y: 0 }] },
    ],
  };
  const graphSet = {
    meta: { name: "Graph suite" },
    instances: [
      { id: "g/a.edges", ...graph },
      { id: "g/b.edges", meta: {}, nodes: [{ id: "1" }], edges: [] },
    ],
  };

  it("is derived from each category's own document schema, so a category needs nothing of its own to be collected", () => {
    expect(getCollectionTarget("tasks/v1").safeParse(orSet).success).toBe(true);
    expect(getCollectionTarget("graph/v1").safeParse(graphSet).success).toBe(true);
    expect(getCollectionTarget("tasks/v1")).toBe(getCategory("tasks/v1").collection);
    expect(() => getCollectionTarget("or-set/v1")).toThrow(UnknownCategoryError);
  });

  it("keeps the instance's fields beside its id and counts instances, not nodes", () => {
    expect(getCollectionTarget("tasks/v1").parse(orSet)).toEqual(orSet);
    expect(countTarget("tasks/v1", getCollectionTarget("tasks/v1").parse(orSet))).toEqual(new Map([["instances", 2]]));
    expect(countTarget("graph/v1", getCollectionTarget("graph/v1").parse(graphSet))).toEqual(new Map([["instances", 2]]));
  });

  it("holds each instance to its category: a tasks/v1 node out of range and a graph edge to a missing node are refused, naming the instance", () => {
    const badNode = getCollectionTarget("tasks/v1").safeParse({ ...orSet, instances: [{ id: "x", meta: {}, nodes: [{ id: "1", lat: 91 }] }] });
    expect(badNode.success).toBe(false);
    expect(badNode.error?.issues.map((issue) => issue.path.join("."))).toEqual(["instances.0.nodes.0.lat"]);
    const badEdge = getCollectionTarget("graph/v1").safeParse({ ...graphSet, instances: [{ id: "x", meta: {}, nodes: [{ id: "1" }], edges: [{ source: "1", target: "9" }] }] });
    expect(badEdge.success).toBe(false);
    expect(badEdge.error?.issues.map((issue) => issue.path.join("."))).toEqual(["instances.0.edges.0.target"]);
  });

  it("allows node ids to repeat across instances but refuses them within one, and refuses a repeated instance id", () => {
    expect(getCollectionTarget("tasks/v1").safeParse(orSet).success).toBe(true);
    const within = getCollectionTarget("tasks/v1").safeParse({ ...orSet, instances: [{ id: "x", meta: {}, nodes: [{ id: "1" }, { id: "1" }] }] });
    expect(within.error?.issues.map((issue) => issue.path.join("."))).toEqual(["instances.0.nodes.1.id"]);
    const repeated = getCollectionTarget("tasks/v1").safeParse({ ...orSet, instances: [...orSet.instances, { id: "suite/a.txt", meta: {}, nodes: [] }] });
    expect(repeated.error?.issues.map((issue) => issue.path.join("."))).toEqual(["instances.2.id"]);
  });

  it("refuses an instance without a non-empty string id, one without its document's fields, and a key beyond meta and instances", () => {
    for (const bad of [{ meta: {}, nodes: [] }, { id: "", meta: {}, nodes: [] }, { id: 3, meta: {}, nodes: [] }, { id: "x" }]) {
      expect(getCollectionTarget("tasks/v1").safeParse({ ...orSet, instances: [bad] }).success).toBe(false);
    }
    expect(getCollectionTarget("tasks/v1").safeParse({ ...orSet, nodes: [] }).success).toBe(false);
    expect(getCollectionTarget("tasks/v1").safeParse({ instances: [] }).success).toBe(false);
  });
});
