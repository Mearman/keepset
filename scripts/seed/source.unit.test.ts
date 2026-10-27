import { describe, expect, it } from "vitest";
import { SourceCatalogueSchema, SupplementCatalogueSchema, withSupplement } from "./source";

const dataset = (id: string): Record<string, unknown> => ({ id, name: `Dataset ${id}`, nodeCount: 2, edgeCount: 1, properties: {} });
const catalogue = SourceCatalogueSchema.parse({ version: "1", generated: "2026-01-01", datasets: { a: dataset("a") } });

describe("withSupplement", () => {
  it("adds the supplement's datasets beside the catalogue's", () => {
    const merged = withSupplement(catalogue, SupplementCatalogueSchema.parse({ datasets: { b: dataset("b") } }));
    expect(Object.keys(merged.datasets)).toEqual(["a", "b"]);
  });

  it("refuses a dataset the catalogue already holds", () => {
    expect(() => withSupplement(catalogue, SupplementCatalogueSchema.parse({ datasets: { a: dataset("a") } }))).toThrow("already in the pipeline catalogue");
  });
});
