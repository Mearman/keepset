import { describe, expect, it } from "vitest";
import { parseGroupedMemberPaths } from "./grouped-member-path";
import type { Parser } from "../entry";

const parser: Extract<Parser, { format: "grouped-member-path" }> = { format: "grouped-member-path", encoding: "utf-8", idPattern: "(?<field>audio|features)/(?<id>spks(?<speakerCountCode>[0-9]+)_id[0-9]+)\\.wav", fields: ["audio", "features"] };

describe("grouped archive paths", () => {
  it("joins interleaved paths by id while retaining shared metadata", () => {
    const paths = ["audio/spks0_id1.wav", "audio/spks2_id9.wav", "features/spks2_id9.wav", "features/spks0_id1.wav"];
    expect(parseGroupedMemberPaths(paths, parser).nodes).toEqual([
      { id: "spks0_id1", speakerCountCode: "0", audio: paths[0], features: paths[3] },
      { id: "spks2_id9", speakerCountCode: "2", audio: paths[1], features: paths[2] },
    ]);
  });
  it("rejects missing and duplicate representations", () => {
    expect(() => parseGroupedMemberPaths(["audio/spks0_id1.wav"], parser)).toThrow(/no paths for features/);
    expect(() => parseGroupedMemberPaths(["audio/spks0_id1.wav", "audio/spks0_id1.wav"], parser)).toThrow(/two paths for audio/);
  });
  it("rejects unknown fields and inconsistent metadata", () => {
    const broad = { ...parser, idPattern: "(?<field>[^/]+)/(?<speakerCountCode>[0-9]+)/(?<id>[^/]+)" };
    expect(() => parseGroupedMemberPaths(["other/0/x"], broad)).toThrow(/unknown field/);
    expect(() => parseGroupedMemberPaths(["audio/0/x", "features/1/x"], broad)).toThrow(/inconsistent metadata/);
  });
  it("rejects paths without the required named captures", () => {
    expect(() => parseGroupedMemberPaths(["audio/x"], { ...parser, idPattern: "audio/(.*)" })).toThrow(/named id and field/);
  });
});
