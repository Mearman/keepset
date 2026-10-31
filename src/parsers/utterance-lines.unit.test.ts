import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";
import { parseUtteranceLines } from "./utterance-lines";

const parser = (layout?: "id-first" | "id-last" | "festival"): Extract<Parser, { format: "utterance-lines" }> => ({ format: "utterance-lines", encoding: "utf-8", ...(layout === undefined ? {} : { layout }) });

describe("the utterance-lines parser", () => {
  it("reads an id and then the transcript of each line, keeping the transcript's inner spacing", () => {
    expect(parseUtteranceLines("84-121123-0000 GO DO YOU HEAR\n84-121123-0001\tBUT  IN LESS THAN FIVE MINUTES\n", parser())).toEqual({
      meta: {},
      nodes: [
        { id: "84-121123-0000", text: "GO DO YOU HEAR" },
        { id: "84-121123-0001", text: "BUT  IN LESS THAN FIVE MINUTES" },
      ],
    });
  });

  it("gives a line of only an id a null transcript, and skips blank lines, a byte order mark and any line ending", () => {
    expect(parseUtteranceLines("﻿a1 hello\r\n\r\nb2\rc3   spaced out  \n", parser()).nodes).toEqual([
      { id: "a1", text: "hello" },
      { id: "b2", text: null },
      { id: "c3", text: "spaced out" },
    ]);
    expect(parseUtteranceLines("", parser()).nodes).toEqual([]);
  });

  it("reads a line repeated exactly once, in the position of its first appearance", () => {
    expect(parseUtteranceLines("a1 x\nb2 y\na1 x\n", parser()).nodes).toEqual([
      { id: "a1", text: "x" },
      { id: "b2", text: "y" },
    ]);
  });

  it("refuses an id listed twice with different text, naming its line", () => {
    expect(() => parseUtteranceLines("a1 x\na1 y\n", parser())).toThrow(NativeParseError);
    expect(() => parseUtteranceLines("a1 x\na1 y\n", parser())).toThrow(/a1 is listed twice with different text/);
  });

  it("reads the id from the end of a line when the recipe says so, and keeps the rest as the transcript", () => {
    expect(parseUtteranceLines("y eso se puede reducir TEDX_F_001_0001\nsolo TEDX_F_001_0002\nTEDX_F_001_0003", parser("id-last")).nodes).toEqual([
      { id: "TEDX_F_001_0001", text: "y eso se puede reducir" },
      { id: "TEDX_F_001_0002", text: "solo" },
      { id: "TEDX_F_001_0003", text: null },
    ]);
  });

  it("reads Festival lines, unescaping a backslash and the character after it", () => {
    expect(parseUtteranceLines('( sin_1 " කෝකටත් " )\n( sin_2 " she said \\"hi\\" " )\n', parser("festival")).nodes).toEqual([
      { id: "sin_1", text: "කෝකටත්" },
      { id: "sin_2", text: 'she said "hi"' },
    ]);
    expect(() => parseUtteranceLines("sin_1 hello", parser("festival"))).toThrow(/not of the form/);
  });

  it("is what parseNative runs for the format", () => {
    expect(parseNative(new TextEncoder().encode("a1 hello\n"), { format: "utterance-lines", encoding: "utf-8" }).nodes).toEqual([{ id: "a1", text: "hello" }]);
  });
});
