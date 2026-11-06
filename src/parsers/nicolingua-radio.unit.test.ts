import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { parseNativeFiles } from "./parse-native";

const encoder = new TextEncoder();
const file = (path: string, text: string): { path: string; bytes: Uint8Array } => ({ path: `data/${path}`, bytes: encoder.encode(text) });
const parser: Extract<Parser, { format: "nicolingua-radio" }> = { format: "nicolingua-radio", encoding: "utf-8" };
const manifest = (path: string, rows: string): ReturnType<typeof file> => file(path, `/original/root\n${rows}`);
const tagged = (rows: string): ReturnType<typeof file> => file("metadata.csv", `file,tags\n${rows}`);

describe("Nicolingua radio metadata", () => {
  it("keeps model splits separate from tagged validation clips", () => {
    const result = parseNativeFiles([
      tagged('c.wav,"ct-speech; lng-french"\n'),
      manifest("valid.tsv", "b.wav\t480000\n"),
      manifest("train.tsv", "a.wav\t480000\n"),
    ], parser);
    expect(result.nodes).toEqual([
      { id: "a.wav", audio: "a.wav", samples: 480000, label: null, collection: "training", split: "train" },
      { id: "b.wav", audio: "b.wav", samples: 480000, label: null, collection: "training", split: "valid" },
      { id: "c.wav", audio: "c.wav", samples: null, label: "ct-speech; lng-french", collection: "tagged-validation", split: null },
    ]);
  });

  it("rejects missing, duplicate and malformed data", () => {
    const train = manifest("train.tsv", "a.wav\t480000\n");
    const valid = manifest("valid.tsv", "b.wav\t480000\n");
    expect(() => parseNativeFiles([train, valid], parser)).toThrow("metadata.csv: missing file");
    expect(() => parseNativeFiles([train, train, valid, tagged("")], parser)).toThrow("train.tsv: duplicate file");
    expect(() => parseNativeFiles([train, valid, tagged("a.wav,ct-speech\n")], parser)).toThrow("duplicate clip a.wav");
    expect(() => parseNativeFiles([manifest("train.tsv", "a.wav\tbad\n"), valid, tagged("")], parser)).toThrow("declared numeric");
    expect(() => parseNativeFiles([manifest("train.tsv", "a.wav\t-1\n"), valid, tagged("")], parser)).toThrow("sample count must be a nonnegative integer");
    expect(() => parseNativeFiles([manifest("train.tsv", "a.wav\t\n"), valid, tagged("")], parser)).toThrow("sample count must be a nonnegative integer");
  });
});
