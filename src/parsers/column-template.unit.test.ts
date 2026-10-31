import { describe, expect, it } from "vitest";
import { readTemplate, templateColumns } from "./column-template";

describe("reading a column template", () => {
  it("splits text and placeholders in order", () => {
    expect(readTemplate("https://example.org/{group}/item-{code}.txt")).toEqual({
      parts: ["https://example.org/", { column: "group" }, "/item-", { column: "code" }, ".txt"],
    });
    expect(readTemplate("{code}")).toEqual({ parts: [{ column: "code" }] });
  });

  it("lists each column a template names once, in order of first appearance", () => {
    const reading = readTemplate("{b}/{a}/{b}");
    expect(reading.parts).toBeDefined();
    expect(templateColumns(reading.parts ?? [])).toEqual(["b", "a"]);
  });

  it("refuses a template with no placeholder, since every row would get the same text", () => {
    expect(readTemplate("https://example.org/")).toEqual({ problem: "no placeholder naming a column" });
  });

  it("refuses a brace outside a placeholder, whichever side of it", () => {
    expect(readTemplate("{code}}")).toEqual({ problem: "a brace outside a placeholder" });
    expect(readTemplate("{{code}")).toEqual({ problem: "a brace outside a placeholder" });
    expect(readTemplate("a{code} {")).toEqual({ problem: "a brace outside a placeholder" });
  });

  it("keeps an empty placeholder as written for the caller to refuse as no column", () => {
    expect(readTemplate("x{}")).toEqual({ parts: ["x", { column: "" }] });
  });
});
