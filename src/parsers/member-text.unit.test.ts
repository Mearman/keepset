import { describe, expect, it } from "vitest";
import { ParserSchema, type Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseMemberText } from "./member-text";
import { parseNativeFiles } from "./parse-native";

const parser = (options: Readonly<Partial<Extract<Parser, { format: "member-text" }>>> = {}): Extract<Parser, { format: "member-text" }> => ({
  format: "member-text",
  encoding: "utf-8",
  idPattern: "(?:.*/)?([^/]+)\\.wav\\.trn",
  ...options,
});

const file = (path: string, text: string): { readonly path: string; readonly bytes: Uint8Array } => ({ path, bytes: new TextEncoder().encode(text) });

describe("the member-text parser", () => {
  it("makes a row of each file, its id the pattern's capture and its text the trimmed contents without a byte order mark", () => {
    const files = [file("data/A11_0.wav.trn", "﻿绿 是 阳春\n lv4 shi4 \nl v4\n"), file("data/A11_1.wav.trn", "  \n")];
    expect(parseMemberText(files, parser()).nodes).toEqual([
      { id: "A11_0", text: "绿 是 阳春\n lv4 shi4 \nl v4" },
      { id: "A11_1", text: null },
    ]);
  });

  it("takes one line of each file when the recipe names it, whatever the line ending", () => {
    const files = [file("A11_0.wav.trn", "words\r\npinyin\rphones"), file("A11_1.wav.trn", "more words\n  more pinyin \n")];
    expect(parseMemberText(files, parser({ line: 1 })).nodes).toEqual([
      { id: "A11_0", text: "pinyin" },
      { id: "A11_1", text: "more pinyin" },
    ]);
  });

  it("refuses a path the pattern does not match, an id two files give, and a line a file lacks", () => {
    const fails = (run: () => unknown): NativeParseError => {
      try {
        run();
      } catch (error) {
        if (error instanceof NativeParseError) {
          return error;
        }
        throw error;
      }
      throw new Error("expected a NativeParseError");
    };
    expect(fails(() => parseMemberText([file("notes.md", "x")], parser())).message).toMatch(/gives no id/);
    expect(fails(() => parseMemberText([file("a/x.wav.trn", "1"), file("b/x.wav.trn", "2")], parser())).message).toMatch(/id x is given by two files/);
    expect(fails(() => parseMemberText([file("x.wav.trn", "only")], parser({ line: 2 }))).message).toMatch(/no line 3/);
  });

  it("keeps a verbatim file's text exactly as decoded, its whitespace and line endings with it, and an empty file as an empty text", () => {
    const books = [file("10000/pg10000.txt", "﻿  The Magna Carta\r\n\r\nEnd \r\n"), file("10001/pg10001.txt", ""), file("10002/pg10002.txt", " \n")];
    expect(parseMemberText(books, parser({ idPattern: "([0-9]+)/pg\\1\\.txt", verbatim: true })).nodes).toEqual([
      { id: "10000", text: "  The Magna Carta\r\n\r\nEnd \r\n" },
      { id: "10001", text: "" },
      { id: "10002", text: " \n" },
    ]);
  });

  it("refuses a verbatim recipe that also names a line", () => {
    const entryParser = ParserSchema.safeParse(parser({ verbatim: true, line: 0 }));
    expect(entryParser.error?.issues.map((issue) => issue.message)).toEqual(["a verbatim file is read whole, so it names no line"]);
    expect(ParserSchema.safeParse(parser({ verbatim: true })).success).toBe(true);
  });

  it("is what parseNativeFiles runs for the format", () => {
    expect(parseNativeFiles([file("x.wav.trn", "hi")], parser()).nodes).toEqual([{ id: "x", text: "hi" }]);
  });
});
