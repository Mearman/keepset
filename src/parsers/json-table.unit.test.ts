import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseNative } from "./parse-native";
import { parseJsonTable } from "./json-table";

const parser = (options: Partial<Extract<Parser, { format: "json-table" }>> = {}): Extract<Parser, { format: "json-table" }> => ({
  format: "json-table",
  encoding: "utf-8",
  layout: "lines",
  idField: "audio_filepath",
  fields: ["text", "duration"],
  ...options,
});

describe("the json-table parser", () => {
  it("reads one record per line, keeping the id as text and the fields it is told to, and leaving the rest out", () => {
    const text = '{"audio_filepath": "a/1.wav", "duration": 2.5, "text": "hello", "extra": {"nested": true}}\n\n{"audio_filepath": "a/2.wav", "text": "world", "duration": null}\n';
    expect(parseJsonTable(text, parser()).nodes).toEqual([
      { id: "a/1.wav", text: "hello", duration: 2.5 },
      { id: "a/2.wav", text: "world", duration: null },
    ]);
  });

  it("reads an array of records, giving a field a record lacks as null and a numeric id as text", () => {
    const text = '[{"id": 64869, "text": "one"}, {"id": "7", "text": "two", "length": "8.1"}]';
    expect(parseJsonTable(text, parser({ layout: "array", idField: "id", fields: ["text", "length"] })).nodes).toEqual([
      { id: "64869", text: "one", length: null },
      { id: "7", text: "two", length: "8.1" },
    ]);
  });

  it("names the line of a record that is not JSON, not an object, lacks an id, holds a nested kept field or repeats an id", () => {
    const run = (text: string, options = parser()): NativeParseError => {
      try {
        parseJsonTable(text, options);
      } catch (error) {
        if (error instanceof NativeParseError) {
          return error;
        }
        throw error;
      }
      throw new Error("expected a NativeParseError");
    };
    expect(run('{"audio_filepath": "a"}\n{oops').message).toMatch(/line 2/);
    expect(run("[1]").message).toMatch(/not an object/);
    expect(run('{"text": "x"}').message).toMatch(/id field audio_filepath is missing/);
    expect(run('{"audio_filepath": "a", "text": ["x"]}').message).toMatch(/field text holds object/);
    expect(run('{"audio_filepath": "a", "text": "x"}\n{"audio_filepath": "a", "text": "y"}').message).toMatch(/id a is used twice with different content/);
    expect(run('{"id": "a"}', parser({ layout: "array" })).message).toMatch(/not an array/);
  });

  it("joins several id fields with a slash into the row's id, and refuses a record missing one of them", () => {
    const options = parser({ layout: "array", idField: ["session_id", "speaker", "start_time"], fields: ["words", "speaker"] });
    expect(parseJsonTable('[{"session_id": "S01", "speaker": "P05", "start_time": "00:00:01.2", "words": "hello"}]', options).nodes).toEqual([{ id: "S01/P05/00:00:01.2", words: "hello", speaker: "P05" }]);
    expect(() => parseJsonTable('[{"session_id": "S01", "speaker": "P05", "words": "hello"}]', options)).toThrow(/id field session_id, speaker, start_time is missing/);
  });

  it("reads the fields declared numeric as numbers, from decimal text or a number, and refuses other text", () => {
    const options = parser({ layout: "array", idField: "id", fields: ["length", "text"], numericFields: ["length"] });
    expect(parseJsonTable('[{"id": "a", "length": "8.64", "text": "1"}, {"id": "b", "length": 3, "text": "2"}, {"id": "c", "length": ""}]', options).nodes).toEqual([
      { id: "a", length: 8.64, text: "1" },
      { id: "b", length: 3, text: "2" },
      { id: "c", length: null, text: null },
    ]);
    expect(() => parseJsonTable('[{"id": "a", "length": "long"}]', options)).toThrow(/declared numeric but holds "long"/);
  });

  it("reads an empty or blank string as a missing value, as an empty cell is in a delimited table", () => {
    expect(parseJsonTable('{"audio_filepath": "a", "text": "", "duration": 2}\n{"audio_filepath": "b", "text": "  ", "duration": 3}', parser()).nodes).toEqual([
      { id: "a", text: null, duration: 2 },
      { id: "b", text: null, duration: 3 },
    ]);
  });

  it("reads a record repeated exactly once, even when its keys come in another order", () => {
    const text = '{"audio_filepath": "a", "text": "x", "duration": 1}\n{"duration": 1, "text": "x", "audio_filepath": "a"}\n{"audio_filepath": "b", "text": "y", "duration": 2}';
    expect(parseJsonTable(text, parser()).nodes).toEqual([
      { id: "a", text: "x", duration: 1 },
      { id: "b", text: "y", duration: 2 },
    ]);
  });

  it("is what parseNative runs for the format", () => {
    expect(parseNative(new TextEncoder().encode('{"audio_filepath": "a", "text": "x", "duration": 1}'), parser()).nodes).toEqual([{ id: "a", text: "x", duration: 1 }]);
  });
});
