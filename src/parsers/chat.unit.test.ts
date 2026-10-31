import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseChat } from "./chat";
import { parseNativeFiles } from "./parse-native";

const parser = (options: Readonly<Partial<Extract<Parser, { format: "chat" }>>> = {}): Extract<Parser, { format: "chat" }> => ({ format: "chat", encoding: "utf-8", idPattern: "(?:.*/)?([^/]+)\\.cha", ...options });

const file = (path: string, text: string): { readonly path: string; readonly bytes: Uint8Array } => ({ path, bytes: new TextEncoder().encode(text) });

const BOM = "﻿";

/** A time mark as CHAT writes it: the start and end in milliseconds joined by an underscore, between two delimiters. */
const mark = (span: string): string => `\u0015${span}\u0015`;

const chat = `@UTF8
@Begin
@Participants:\tAA Alice Speaker, BB Bob Speaker
@Comment:\tA conversation that is
\tcontinued on a second line.
*AA:\t(..) So you don't need to go ${mark("0_9210")}
\tto +/. ${mark("9210_9520")}
*BB:\t     ⌊ &=in well ⌋ ${mark("10000_11000")}
%mor:\tco|well
\tcontinued
*AA:\t${mark("12000_13000")}
*BB:\tno marks here
@End
`;

describe("the chat parser", () => {
  it("makes a row of each main line: the speaker, the text without its time marks and the first start and last end in milliseconds", () => {
    expect(parseChat([file("CHAT/SBC001.cha", chat)], parser()).nodes).toEqual([
      { id: "SBC001/1", speaker: "AA", text: "(..) So you don't need to go to +/.", start: 0, end: 9520 },
      { id: "SBC001/2", speaker: "BB", text: "⌊ &=in well ⌋", start: 10_000, end: 11_000 },
      { id: "SBC001/3", speaker: "AA", text: null, start: 12_000, end: 13_000 },
      { id: "SBC001/4", speaker: "BB", text: "no marks here", start: null, end: null },
    ]);
  });

  it("does not read a header, a dependent tier or the lines that continue them as part of a turn, and reads a byte order mark and CR LF line ends", () => {
    const rows = parseChat([file("a.cha", `${BOM}${chat.replaceAll("\n", "\r\n")}`)], parser()).nodes;
    expect(rows.map((row) => row.text)).toEqual(["(..) So you don't need to go to +/.", "⌊ &=in well ⌋", null, "no marks here"]);
  });

  it("refuses a malformed main line, a stray line, an unclosed or malformed time mark, a repeated id and a path the pattern misses", () => {
    const run = (text: string): NativeParseError => {
      try {
        parseChat([file("x.cha", text)], parser());
      } catch (error) {
        if (error instanceof NativeParseError) {
          return error;
        }
        throw error;
      }
      throw new Error("expected a NativeParseError");
    };
    expect(run("*AA: no tab\n").message).toMatch(/is not of the form \*SPEAKER:<tab>text/);
    expect(run("stray\n").message).toMatch(/begins with none of/);
    expect(run("*AA:\ttext \u00150_1\n").message).toMatch(/is not closed/);
    expect(run(`*AA:\ttext ${mark("0-1")}\n`).message).toMatch(/is not start_end in milliseconds/);
    expect(() => parseChat([file("a/x.cha", chat), file("b/x.cha", chat)], parser())).toThrow(/id x is given by two files/);
    expect(() => parseChat([file("x.txt", chat)], parser())).toThrow(/gives no id/);
  });

  it("is what parseNativeFiles runs for the format", () => {
    expect(parseNativeFiles([file("x.cha", chat)], parser()).nodes.map((row) => row.id)).toEqual(["x/1", "x/2", "x/3", "x/4"]);
  });
});
