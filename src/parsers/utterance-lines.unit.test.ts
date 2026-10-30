import { describe, expect, it } from "vitest";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";
import { parseUtteranceLines } from "./utterance-lines";

describe("the utterance-lines parser", () => {
  it("reads an id and then the transcript of each line, keeping the transcript's inner spacing", () => {
    expect(parseUtteranceLines("84-121123-0000 GO DO YOU HEAR\n84-121123-0001\tBUT  IN LESS THAN FIVE MINUTES\n")).toEqual({
      meta: {},
      nodes: [
        { id: "84-121123-0000", text: "GO DO YOU HEAR" },
        { id: "84-121123-0001", text: "BUT  IN LESS THAN FIVE MINUTES" },
      ],
    });
  });

  it("gives a line of only an id a null transcript, and skips blank lines, a byte order mark and any line ending", () => {
    expect(parseUtteranceLines("﻿a1 hello\r\n\r\nb2\rc3   spaced out  \n").nodes).toEqual([
      { id: "a1", text: "hello" },
      { id: "b2", text: null },
      { id: "c3", text: "spaced out" },
    ]);
    expect(parseUtteranceLines("").nodes).toEqual([]);
  });

  it("refuses an id listed twice, naming its line", () => {
    expect(() => parseUtteranceLines("a1 x\na1 y\n")).toThrow(NativeParseError);
    expect(() => parseUtteranceLines("a1 x\na1 y\n")).toThrow(/a1 is listed twice/);
  });

  it("is what parseNative runs for the format", () => {
    expect(parseNative(new TextEncoder().encode("a1 hello\n"), { format: "utterance-lines", encoding: "utf-8" }).nodes).toEqual([{ id: "a1", text: "hello" }]);
  });
});
