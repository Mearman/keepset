import { describe, expect, it } from "vitest";
import { TextsV1Schema } from "./texts-v1";

const meta = { name: "catalogue" };

describe("the texts/v1 target", () => {
  it("accepts a text that carries the addresses of its files, and one that carries none", () => {
    const parsed = TextsV1Schema.safeParse({
      meta,
      nodes: [
        { id: "1", title: "A", textUrl: "https://example.org/1.txt", htmlUrl: "https://example.org/1.html", epubUrl: "https://example.org/1.epub" },
        { id: "2", title: "B", textUrl: null, htmlUrl: null, epubUrl: null },
        { id: "3" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an empty address, which would be an address that names nothing", () => {
    for (const field of ["textUrl", "htmlUrl", "epubUrl"]) {
      expect(TextsV1Schema.safeParse({ meta, nodes: [{ id: "1", [field]: "" }] }).success).toBe(false);
    }
  });

  it("still refuses two texts with one id", () => {
    expect(TextsV1Schema.safeParse({ meta, nodes: [{ id: "1" }, { id: "1", textUrl: "https://example.org/1.txt" }] }).success).toBe(false);
  });
});
