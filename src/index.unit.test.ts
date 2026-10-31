import { describe, expect, it } from "vitest";
import { AudioV1Schema, CorpusV1Schema, GraphV1Schema, LexiconV1Schema, SpeakersV1Schema, SplitsV1Schema, ResourcesV1Schema, SpeechV1Schema, TasksV1Schema, TextsV1Schema, getTarget, listCategories } from "./index";

describe("the package's public surface", () => {
  it("exports the target schema of every category the registry holds, so a consumer can validate what a fetch returns", () => {
    const exported: readonly (readonly [string, unknown])[] = [
      ["audio/v1", AudioV1Schema],
      ["corpus/v1", CorpusV1Schema],
      ["graph/v1", GraphV1Schema],
      ["lexicon/v1", LexiconV1Schema],
      ["resources/v1", ResourcesV1Schema],
      ["speakers/v1", SpeakersV1Schema],
      ["speech/v1", SpeechV1Schema],
      ["splits/v1", SplitsV1Schema],
      ["tasks/v1", TasksV1Schema],
      ["texts/v1", TextsV1Schema],
    ];
    expect(listCategories().map((category) => category.id)).toEqual(exported.map(([id]) => id));
    for (const [id, schema] of exported) {
      expect(getTarget(id)).toBe(schema);
    }
  });
});
