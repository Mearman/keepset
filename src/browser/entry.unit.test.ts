import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogue } from "../catalogue";
import type { Dataset } from "../catalogue";
import { RecipeError } from "../errors";
import { fixtureIndex, liveEntry } from "../test-support/entries";
import { fixtureBytes, TWO_LINES_XZ_BASE64 } from "../test-support/xz-fixtures";
import { fetchEntry } from "./entry";

const datasetWith = (entry: unknown): Dataset => createCatalogue({ ...fixtureIndex, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the fixture catalogue lists its one entry");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the browser entry point", () => {
  it("fetches through the platform's downloader and hashes with SubtleCrypto, matching the recorded digest", async () => {
    const body = "% karate excerpt\n1 2\n2 3\n3 1\n";
    vi.stubGlobal("fetch", (() => new Response(body, { status: 200, headers: { "content-length": String(body.length) } })));
    const fetched = await fetchEntry(datasetWith(liveEntry), {});
    expect(fetched.data).toEqual(expect.objectContaining({ nodes: [{ id: "1" }, { id: "2" }, { id: "3" }], edges: [{ source: "1", target: "2" }, { source: "2", target: "3" }, { source: "3", target: "1" }] }));
    expect(fetched.provenance).toMatchObject({ sha256: createHash("sha256").update(body).digest("hex"), byteLength: body.length });
  });

  it("refuses a recipe whose archive is xz compressed at its extract step, saying where the decoder is", async () => {
    vi.stubGlobal("fetch", (() => new Response(fixtureBytes(TWO_LINES_XZ_BASE64))));
    const entry = { ...liveEntry, recipe: { ...liveEntry.recipe, archive: { kind: "tar.xz", member: { path: "karate.txt" } } } };
    const failure = await fetchEntry(datasetWith(entry), {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(RecipeError);
    expect(failure instanceof Error ? failure.message : "").toMatch(/no xz decoder is available here: the Node entry point \(keepset\/node\) carries one/);
  });
});
