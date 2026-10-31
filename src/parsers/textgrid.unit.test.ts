import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseNativeFiles } from "./parse-native";
import { parseTextGrid } from "./textgrid";

type TextGridParser = Extract<Parser, { format: "textgrid" }>;

const parser = (options: Readonly<Partial<TextGridParser>> = {}): TextGridParser => ({ format: "textgrid", encoding: "utf-8", idPattern: "(?:.*/)?([^/]+)\\.TextGrid", tier: "words", ...options });

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const MARK = "﻿";

/** UTF-16 starting with a byte order mark, as Praat writes a file with characters beyond Latin-1. */
function utf16(text: string, littleEndian: boolean): Uint8Array {
  const marked = `${MARK}${text}`;
  const bytes = new Uint8Array(marked.length * Uint16Array.BYTES_PER_ELEMENT);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < marked.length; index += 1) {
    view.setUint16(index * Uint16Array.BYTES_PER_ELEMENT, marked.charCodeAt(index), littleEndian);
  }

  return bytes;
}

const file = (path: string, bytes: Uint8Array): { readonly path: string; readonly bytes: Uint8Array } => ({ path, bytes });

const long = `File type = "ooTextFile"
Object class = "TextGrid"

xmin = 0
xmax = 3.5
tiers? <exists>
size = 3
item []:
    item [1]:
        class = "IntervalTier"
        name = "phones"
        xmin = 0
        xmax = 3.5
        intervals: size = 1
        intervals [1]:
            xmin = 0
            xmax = 3.5
            text = "ah"
    item [2]:
        class = "IntervalTier"
        name = "words"
        xmin = 0
        xmax = 3.5
        intervals: size = 4
        intervals [1]:
            xmin = 0
            xmax = 0.5
            text = ""
        intervals [2]:
            xmin = 0.5
            xmax = 1.25
            text = "안녕 하세요"
        intervals [3]:
            xmin = 1.25
            xmax = 2
            text = "she said ""hi"" = = x
and left"
        intervals [4]:
            xmin = 2
            xmax = 3.5
            text = "   "
    item [3]:
        class = "TextTier"
        name = "words"
        xmin = 0
        xmax = 3.5
        points: size = 1
        points [1]:
            number = 3
            mark = "beep"
`;

const short = `File type = "ooTextFile short"
"TextGrid"

0
2
<exists>
2
"IntervalTier"
"words"
0
2
2
0
1
"one"
1
2
"two"
"TextTier"
"words"
0
2
1
1.5
"mark"
`;

describe("the textgrid parser", () => {
  it("reads the non-empty intervals and points of the named tier from a UTF-16 long form file, by tier and annotation position", () => {
    for (const littleEndian of [true, false]) {
      expect(parseTextGrid([file("label/s01.TextGrid", utf16(long, littleEndian))], parser()).nodes).toEqual([
        { id: "s01/2.2", text: "안녕 하세요", start: 0.5, end: 1.25 },
        { id: "s01/2.3", text: 'she said "hi" = = x\nand left', start: 1.25, end: 2 },
        { id: "s01/3.1", text: "beep", start: 3, end: 3 },
      ]);
    }
  });

  it("reads a UTF-8 file with or without a mark, and a file with no mark in the recipe's encoding", () => {
    const grid = (text: string): string => `File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = 1
tiers? <exists>
size = 1
item []:
    item [1]:
        class = "IntervalTier"
        name = "words"
        xmin = 0
        xmax = 1
        intervals: size = 1
        intervals [1]:
            xmin = 0
            xmax = 1
            text = "${text}"
`;
    const expected = (text: string): unknown[] => [{ id: "s01/1.1", text, start: 0, end: 1 }];
    expect(parseTextGrid([file("s01.TextGrid", utf8(grid("안녕")))], parser()).nodes).toEqual(expected("안녕"));
    expect(parseTextGrid([file("s01.TextGrid", utf8(`${MARK}${grid("안녕")}`))], parser()).nodes).toEqual(expected("안녕"));
    const latin1 = Uint8Array.from(grid("caf\u00e9"), (character) => character.charCodeAt(0));
    expect(parseTextGrid([file("s01.TextGrid", latin1)], parser({ encoding: "latin1" })).nodes).toEqual(expected("café"));
    expect(() => parseTextGrid([file("s01.TextGrid", latin1)], parser())).toThrow();
    expect(() => parseTextGrid([file("s01.TextGrid", utf16("A", true).subarray(0, -1))], parser())).toThrow(/not valid utf-16le/);
  });

  it("reads the short form", () => {
    expect(parseTextGrid([file("a/b.TextGrid", utf8(short))], parser()).nodes).toEqual([
      { id: "b/1.1", text: "one", start: 0, end: 1 },
      { id: "b/1.2", text: "two", start: 1, end: 2 },
      { id: "b/2.1", text: "mark", start: 1.5, end: 1.5 },
    ]);
  });

  it("reads every tier that shares the name, and refuses a file with none", () => {
    expect(parseTextGrid([file("b.TextGrid", utf8(short))], parser({ tier: "words" })).nodes.map((row) => row.id)).toEqual(["b/1.1", "b/1.2", "b/2.1"]);
    expect(() => parseTextGrid([file("b.TextGrid", utf8(short))], parser({ tier: "phones" }))).toThrow(/has no tier named phones/);
  });

  it("refuses text that is not a TextGrid, a tier of another class, a file that ends early or runs on, a repeated id and a path the pattern misses", () => {
    const run = (text: string): NativeParseError => {
      try {
        parseTextGrid([file("x.TextGrid", utf8(text))], parser());
      } catch (error) {
        if (error instanceof NativeParseError) {
          return error;
        }
        throw error;
      }
      throw new Error("expected a NativeParseError");
    };
    expect(run("hello").message).toMatch(/does not start with File type/);
    expect(run(short.replace('"TextGrid"', '"Sound"')).message).toMatch(/holds a Sound, not a TextGrid/);
    expect(run(short.replace('"TextTier"', '"Other"')).message).toMatch(/neither an IntervalTier nor a TextTier/);
    expect(run(short.replace('"mark"\n', "")).message).toMatch(/ends where a point's mark in tier words should be/);
    expect(run(short.replace('"two"', "two")).message).toMatch(/as a quoted string, found two/);
    expect(run(short.slice(0, short.indexOf('"words"'))).message).toMatch(/ends where a tier's name should be/);
    expect(run(short.replace("\n1\n2\n\"two\"", "\nx\n2\n\"two\"")).message).toMatch(/as a number, found x/);
    expect(run(`${short}"extra"\n`).message).toMatch(/more after its last tier/);
    expect(() => parseTextGrid([file("a/x.TextGrid", utf8(short)), file("b/x.TextGrid", utf8(short))], parser())).toThrow(/id x is given by two files/);
    expect(() => parseTextGrid([file("x.txt", utf8(short))], parser())).toThrow(/gives no id/);
  });

  it("is what parseNativeFiles runs for the format", () => {
    expect(parseNativeFiles([file("b.TextGrid", utf8(short))], parser()).nodes.map((row) => row.id)).toEqual(["b/1.1", "b/1.2", "b/2.1"]);
  });
});
