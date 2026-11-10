import { describe, expect, it } from "vitest";
import { ParserSchema } from "../entry";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";
import { parseTextPattern } from "./text-pattern";

/** Two rows of an Apache directory index, each on its own line, with the parent directory row a listing also has. */
const index = [
  '<tr><td valign="top"><img src="/icons/back.gif" alt="[PARENTDIR]"></td><td><a href="/ftp/">Parent Directory</a></td><td>&nbsp;</td><td align="right">  - </td><td>&nbsp;</td></tr>',
  '<tr><td valign="top"><img src="/icons/unknown.gif" alt="[   ]"></td><td><a href="a.mps.bz2">a.mps.bz2</a></td><td align="right">2009-05-23 18:42  </td><td align="right">3.4M</td><td>&nbsp;</td></tr>',
  '<tr><td valign="top"><img src="/icons/unknown.gif" alt="[   ]"></td><td><a href="b.mps.bz2">b.mps.bz2</a></td><td align="right">2009-05-23 18:42  </td><td align="right"> 13M</td><td>&nbsp;</td></tr>',
].join("\n");

const row = String.raw`<td><a href="(?<id>[^"/]+)">[^<]*</a></td><td align="right">[^<]*</td><td align="right">(?<size>[^<]*)</td>`;

const parser = { format: "text-pattern", encoding: "utf-8", pattern: row } as const;

describe("the text-pattern parser", () => {
  it("reads every match of the pattern, in text order, as a row of its named captures, trimmed", () => {
    expect(parseTextPattern(index, parser)).toEqual({
      nodes: [
        { id: "a.mps.bz2", size: "3.4M" },
        { id: "b.mps.bz2", size: "13M" },
      ],
    });
  });

  it("reads a record that spans lines, a capture that takes no part or is blank being null", () => {
    const listing = '<li><em>file: </em><a href="ken-07.gz">ken-07.gz</a>\n<menu>\n<li><em>size: </em>78 kB\n</li></menu>\n<li><em>file: </em><a href="readme">readme</a>\n<menu>\n<li><em>size: </em> \n</li></menu>\n<li><em>file: </em><a href="cre-a.gz">cre-a.gz</a>\n<menu>\n</menu>';
    const pattern = String.raw`<li><em>file: </em><a href="(?<id>[^"]+)">[^<]*</a>\s*<menu>(?:\s*<li><em>size: </em>(?<size>[^<]*)</li>)?`;
    expect(parseTextPattern(listing, { ...parser, pattern }).nodes).toEqual([
      { id: "ken-07.gz", size: "78 kB" },
      { id: "readme", size: null },
      { id: "cre-a.gz", size: null },
    ]);
  });

  it("adds each derived column, built from the captures it names and null where one is null or its condition fails", () => {
    const derived = {
      ...parser,
      derivedColumns: [
        { name: "url", template: "https://host.example/ftp/{id}" },
        { name: "sizeNote", template: "{size} as listed", when: { column: "id", equals: "b.mps.bz2" } },
      ],
    };
    expect(parseTextPattern(index, derived).nodes).toEqual([
      { id: "a.mps.bz2", size: "3.4M", url: "https://host.example/ftp/a.mps.bz2", sizeNote: null },
      { id: "b.mps.bz2", size: "13M", url: "https://host.example/ftp/b.mps.bz2", sizeNote: "13M as listed" },
    ]);
  });

  it("is reached through parseNative", () => {
    expect(parseNative(new TextEncoder().encode(index), parser)).toEqual(parseTextPattern(index, parser));
  });

  it("refuses text the pattern never matches, an id that repeats or is empty, and a pattern that matches nothing at a position", () => {
    expect(() => parseTextPattern("no rows here", parser)).toThrow(NativeParseError);
    expect(() => parseTextPattern("no rows here", parser)).toThrow("the pattern matches nothing in the text");
    expect(() => parseTextPattern(`${index}\n${index}`, parser)).toThrow("the id a.mps.bz2 is matched twice");
    expect(() => parseTextPattern("x=;", { ...parser, pattern: "x=(?<id>[^;]*);" })).toThrow("a match gives an empty id");
    expect(() => parseTextPattern("abc", { ...parser, pattern: "(?<id>a?)" })).toThrow("an empty match");
  });

  it("names the line a failing match starts on", () => {
    try {
      parseTextPattern(`${index}\n${index}`, parser);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(NativeParseError);
      expect(error instanceof NativeParseError && error.message).toContain("line 5");
    }
  });
});

describe("the text-pattern recipe schema", () => {
  it("accepts a pattern with an id capture and derived columns naming its captures", () => {
    expect(ParserSchema.safeParse({ ...parser, derivedColumns: [{ name: "url", template: "https://host.example/{id}" }] }).success).toBe(true);
  });

  it("refuses a pattern that does not compile, has no id capture or names a capture that is not a column name", () => {
    expect(ParserSchema.safeParse({ ...parser, pattern: "(?<id>[a-z" }).success).toBe(false);
    expect(ParserSchema.safeParse({ ...parser, pattern: "(?<name>[a-z]+)" }).success).toBe(false);
    expect(ParserSchema.safeParse({ ...parser, pattern: "(?<id>[a-z]+)(?<bad_>[0-9])" }).success).toBe(false);
  });

  it("refuses a derived column whose template or condition names no capture, or that takes a capture's name", () => {
    expect(ParserSchema.safeParse({ ...parser, derivedColumns: [{ name: "url", template: "https://host.example/{name}" }] }).success).toBe(false);
    expect(ParserSchema.safeParse({ ...parser, derivedColumns: [{ name: "url", template: "https://host.example/{id}", when: { column: "kind", equals: "x" } }] }).success).toBe(false);
    expect(ParserSchema.safeParse({ ...parser, derivedColumns: [{ name: "size", template: "{id}" }] }).success).toBe(false);
  });
});
