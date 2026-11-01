import { parseCrosswalk } from "crossmap";
import { describe, expect, it } from "vitest";
import { describeRule } from "./rules";

const crosswalk = parseCrosswalk({
  source: "native",
  target: "shared",
  rules: [
    { op: "move", from: "meta", to: "info" },
    { op: "template", from: { family: "people[].family", given: "people[].given" }, to: "names[]", template: "{family}, {given}" },
    { op: "copy", from: "items[].id", to: ["nodes[].id", "labels[].text"] },
  ],
  oneWay: [
    { op: "drop", from: "internal", direction: "encode" },
    { op: "default", to: "locale", value: "en-GB", direction: "decode" },
    { op: "aggregate", fn: "count", from: "orders[].lines[]", to: "orders[].lineCount", direction: "encode" },
  ],
});

describe("describeRule", () => {
  it("gives a two-way rule's paths on each side and says it applies both ways", () => {
    const [move, template, copy] = crosswalk.rules.map(describeRule);
    expect(move).toEqual({ op: "move", from: ["meta"], to: ["info"], direction: "both" });
    expect(template).toEqual({ op: "template", from: ["people[].family", "people[].given"], to: ["names[]"], direction: "both" });
    expect(copy).toEqual({ op: "copy", from: ["items[].id"], to: ["nodes[].id", "labels[].text"], direction: "both" });
  });

  it("gives a one-way rule's paths, the direction it applies in and what the operation adds", () => {
    const [drop, fallback, count] = crosswalk.oneWay.map(describeRule);
    expect(drop).toEqual({ op: "drop", from: ["internal"], to: [], direction: "encode" });
    expect(fallback).toEqual({ op: "default", from: [], to: ["locale"], direction: "decode", detail: '"en-GB"' });
    expect(count).toEqual({ op: "aggregate", from: ["orders[].lines[]"], to: ["orders[].lineCount"], direction: "encode", detail: "count" });
  });
});
