import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { parseLexiconLines } from "./lexicon-lines";
import { parseNative } from "./parse-native";

const parser = (commentPrefixes: readonly string[] = []): Extract<Parser, { format: "lexicon-lines" }> => ({ format: "lexicon-lines", encoding: "utf-8", commentPrefixes: [...commentPrefixes] });

describe("the lexicon-lines parser", () => {
  it("reads a word and its pronunciation from each line, numbering the entries so a word listed twice has two", () => {
    expect(parseLexiconLines("a\ta\na  s i g a\nabajo\ta b a x o\n", parser()).nodes).toEqual([
      { id: "1", word: "a", pronunciation: "a" },
      { id: "2", word: "a", pronunciation: "s i g a" },
      { id: "3", word: "abajo", pronunciation: "a b a x o" },
    ]);
  });

  it("gives a line of only a word a null pronunciation, and skips blank lines, comments and a byte order mark without taking a position", () => {
    expect(parseLexiconLines("﻿# header\n\nword\n; note\nother AH0\n", parser(["#", ";"])).nodes).toEqual([
      { id: "1", word: "word", pronunciation: null },
      { id: "2", word: "other", pronunciation: "AH0" },
    ]);
  });

  it("is what parseNative runs for the format", () => {
    expect(parseNative(new TextEncoder().encode("x y\n"), parser()).nodes).toEqual([{ id: "1", word: "x", pronunciation: "y" }]);
  });
});
