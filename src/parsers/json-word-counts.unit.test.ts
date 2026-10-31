import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseJsonWordCounts } from "./json-word-counts";
import { parseNative } from "./parse-native";

const parser: Extract<Parser, { format: "json-word-counts" }> = { format: "json-word-counts", encoding: "utf-8" };

/**
 * Runs the parser on text it must refuse.
 * @param text - The file text.
 * @returns The error it raised.
 */
function refusal(text: string): NativeParseError {
  try {
    parseJsonWordCounts(text);
  } catch (error) {
    if (error instanceof NativeParseError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a NativeParseError");
}

describe("the json-word-counts parser", () => {
  it("reads each word and its count in the order the file writes them, the word being the row's id", () => {
    expect(parseJsonWordCounts('{"bloqueos": 11265, "Eniutin": 2, "xodo": 119}').nodes).toEqual([
      { id: "bloqueos", word: "bloqueos", count: 11265 },
      { id: "Eniutin", word: "Eniutin", count: 2 },
      { id: "xodo", word: "xodo", count: 119 },
    ]);
  });

  it("keeps integer-like keys where the file writes them, which JSON.parse would list first", () => {
    expect(parseJsonWordCounts('{"b": 1, "287145": 1, "a": 2, "42": 3}').nodes.map((node) => node.id)).toEqual(["b", "287145", "a", "42"]);
  });

  it("decodes escapes in a key and reads a document laid out over several lines, after a byte order mark", () => {
    const text = '﻿{\n  "asust\\u00e1s": 1,\n  "a\\"b": 0\n}\n';
    expect(parseJsonWordCounts(text).nodes).toEqual([
      { id: "asustás", word: "asustás", count: 1 },
      { id: 'a"b', word: 'a"b', count: 0 },
    ]);
  });

  it("reads an empty object as no words, and a key such as __proto__ as a word", () => {
    expect(parseJsonWordCounts(" { } ").nodes).toEqual([]);
    expect(parseJsonWordCounts('{"__proto__": 3}').nodes).toEqual([{ id: "__proto__", word: "__proto__", count: 3 }]);
  });

  it("refuses a word listed twice, naming its line, since an object would keep only the last", () => {
    const lines = ["{", '"a": 1,', '"b": 2,', '"a": 3', "}"];
    const error = refusal(lines.join("\n"));
    expect(error.message).toMatch(/the word "a" is listed twice/);
    expect(lines[error.line - 1]).toBe('"a": 3');
  });

  it("refuses a document that is not an object, a count that is not a non-negative integer, an empty key and text after the object", () => {
    expect(refusal("[1]").message).toMatch(/not a JSON object/);
    expect(refusal('{"a": -1}').message).toMatch(/non-negative integer/);
    expect(refusal('{"a": 1.5}').message).toMatch(/non-negative integer/);
    expect(refusal('{"a": "1"}').message).toMatch(/non-negative integer/);
    expect(refusal('{"a": 1,}').message).toMatch(/expected a string key/);
    expect(refusal('{"": 1}').message).toMatch(/key is empty/);
    expect(refusal('{"a": 1} x').message).toMatch(/text follows the object/);
    expect(refusal('{"a": 1').message).toMatch(/expected a string key/);
    expect(refusal('{"a\\q": 1}').message).toMatch(/not a JSON string/);
    expect(refusal('{"a": 9007199254740993}').message).toMatch(/not a safe integer/);
  });

  it("is what parseNative runs for the format", () => {
    expect(parseNative(new TextEncoder().encode('{"x": 4}'), parser).nodes).toEqual([{ id: "x", word: "x", count: 4 }]);
  });
});
