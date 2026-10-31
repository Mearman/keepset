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

const nestedParser = (options: Partial<Extract<Parser, { format: "json-table" }>> = {}): Extract<Parser, { format: "json-table" }> => ({
  format: "json-table",
  encoding: "utf-8",
  layout: "nested",
  levels: ["class", "file"],
  fields: ["speakerID", "age"],
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

  it("reads a nested document, naming a record by its keys and giving the row the key at each level under the level's name", () => {
    const text = '\ufeff{"coughing": {"a.wav": {"speakerID": "S1", "age": 19, "extra": true}, "b.wav": {"speakerID": "S2"}}, "crying": {"c.wav": {"speakerID": "S3", "age": 30}}}';
    expect(parseJsonTable(text, nestedParser()).nodes).toEqual([
      { id: "coughing/a.wav", class: "coughing", file: "a.wav", speakerID: "S1", age: 19 },
      { id: "coughing/b.wav", class: "coughing", file: "b.wav", speakerID: "S2", age: null },
      { id: "crying/c.wav", class: "crying", file: "c.wav", speakerID: "S3", age: 30 },
    ]);
    expect(parseJsonTable('{"k": {"x": 1}, "m": {}}', nestedParser({ levels: ["name"], fields: ["x"] })).nodes).toEqual([
      { id: "k", name: "k", x: 1 },
      { id: "m", name: "m", x: null },
    ]);
  });

  it("refuses a nested document whose value above the records is not an object, or whose record is not", () => {
    expect(() => parseJsonTable("[1]", nestedParser())).toThrow(/document is not an object/);
    expect(() => parseJsonTable('{"coughing": []}', nestedParser())).toThrow(/beneath coughing is not an object/);
    expect(() => parseJsonTable('{"coughing": {"a.wav": 3}}', nestedParser())).toThrow(/record is not an object/);
    expect(() => parseJsonTable('{"coughing": {"a.wav": {"speakerID": {"x": 1}}}}', nestedParser())).toThrow(/field speakerID holds object/);
  });

  it("refuses a nested id read from keys that joins two records to one id", () => {
    expect(() => parseJsonTable('{"a": {"b/c": {"speakerID": "S1"}}, "a/b": {"c": {"speakerID": "S2"}}}', nestedParser())).toThrow(/id a\/b\/c is used twice with different content/);
  });

  it("is what parseNative runs for a nested document", () => {
    expect(parseNative(new TextEncoder().encode('{"c": {"a.wav": {"speakerID": "S1", "age": 2}}}'), nestedParser()).nodes).toEqual([{ id: "c/a.wav", class: "c", file: "a.wav", speakerID: "S1", age: 2 }]);
  });
});
