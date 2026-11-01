import { describe, expect, it } from "vitest";
import { CatalogueSyntaxError } from "./errors";
import { ManifestSchema, parseManifest } from "./manifest";
import { MANIFEST_SCHEMA_URL, serialise } from "./serialise";

const root = {
  id: "keepset-graphs",
  name: "keepset graphs",
  description: "Graph datasets with recipes that resolve to graph/v1.",
  version: "1.0.0",
  repository: "https://github.com/Mearman/keepset",
};

const fork = {
  ...root,
  id: "example-lab-graphs",
  version: "0.1.0",
  repository: "https://example.org/lab/graphs",
  lineage: { catalogue: "keepset-graphs", version: "1.0.0", repository: "https://github.com/Mearman/keepset" },
};

describe("the catalogue manifest", () => {
  it("round-trips a root catalogue and a fork through parse and serialise", () => {
    for (const doc of [root, fork]) {
      const text = serialise(parseManifest(doc));
      expect(parseManifest(JSON.parse(text))).toEqual({ ...doc, $schema: MANIFEST_SCHEMA_URL });
      expect(serialise(parseManifest(JSON.parse(text)))).toBe(text);
    }
  });

  it.each(["id", "name", "description", "version", "repository"])("rejects a manifest missing %s", (field) => {
    const doc = Object.fromEntries(Object.entries(root).filter(([key]) => key !== field));
    expect(() => parseManifest(doc)).toThrow(CatalogueSyntaxError);
  });

  it("rejects lineage missing the version it forked at", () => {
    expect(ManifestSchema.is({ ...fork, lineage: { catalogue: "keepset-graphs", repository: "https://github.com/Mearman/keepset" } })).toBe(false);
  });

  it("rejects a version that is not semantic", () => {
    expect(ManifestSchema.is({ ...root, version: "1.0" })).toBe(false);
    expect(ManifestSchema.is({ ...fork, lineage: { ...fork.lineage, version: "v1.0.0" } })).toBe(false);
  });

  it("rejects lineage naming the catalogue itself", () => {
    expect(ManifestSchema.is({ ...fork, lineage: { ...fork.lineage, catalogue: fork.id } })).toBe(false);
  });

  it("accepts aliases for namespace segments and round-trips them", () => {
    const doc = { ...root, namespaceAliases: { suitesparse: ["ss", "sparse"], networkrepository: ["nr"] } };
    expect(parseManifest(JSON.parse(serialise(parseManifest(doc))))).toEqual({ ...doc, $schema: MANIFEST_SCHEMA_URL });
  });

  it("refuses a segment alias that repeats, names itself, or is the key of another segment's aliases", () => {
    for (const namespaceAliases of [{ a: ["x"], b: ["x"] }, { a: ["a"] }, { a: ["b"], b: ["c"] }, { a: ["x", "x"] }, { a: [] }]) {
      expect(ManifestSchema.is({ ...root, namespaceAliases })).toBe(false);
    }
  });
});
