import { describe, expect, it } from "vitest";
import { GraphV1Schema, ResourcesV1Schema, TasksV1Schema, TextsV1Schema, getTarget, listCategories } from "./index";

describe("the package's public surface", () => {
  it("exports the target schema of every category the registry holds, so a consumer can validate what a fetch returns", () => {
    const exported: readonly (readonly [string, unknown])[] = [
      ["graph/v1", GraphV1Schema],
      ["resources/v1", ResourcesV1Schema],
      ["tasks/v1", TasksV1Schema],
      ["texts/v1", TextsV1Schema],
    ];
    expect(listCategories().map((category) => category.id)).toEqual(exported.map(([id]) => id));
    for (const [id, schema] of exported) {
      expect(getTarget(id)).toBe(schema);
    }
  });
});
