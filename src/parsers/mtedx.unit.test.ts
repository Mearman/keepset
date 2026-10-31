import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseMtedx } from "./mtedx";
import { parseNativeFiles } from "./parse-native";

const parser: Extract<Parser, { format: "mtedx" }> = { format: "mtedx", encoding: "utf-8" };

interface File {
  readonly path: string;
  readonly bytes: Uint8Array;
}

interface Segment {
  readonly id: string;
  readonly talk: string;
  readonly start: string;
  readonly end: string;
  readonly duration: string;
  readonly text: string;
}

const file = (path: string, text: string): File => ({ path, bytes: new TextEncoder().encode(text) });

/** The three files of one split, in the layout of a monolingual archive: the segments file, the YAML file and the transcript. */
function split(directory: string, name: string, language: string, lines: readonly Segment[]): { readonly segments: File; readonly yaml: File; readonly text: File; readonly all: readonly File[] } {
  const segments = file(`${directory}/segments`, lines.map((line) => `${line.id} ${line.talk} ${line.start} ${line.end}\n`).join(""));
  const yaml = file(`${directory}/${name}.yaml`, lines.map((line) => `- {duration: ${line.duration}, offset: ${line.start}, speaker_id: ${line.talk}, wav: ${line.talk}.wav}\n`).join(""));
  const text = file(`${directory}/${name}.${language}`, lines.map((line) => `${line.text}\n`).join(""));

  return { segments, yaml, text, all: [segments, yaml, text] };
}

const first: Segment = { id: "O7KrwO3pVZ8_0000", talk: "O7KrwO3pVZ8", start: "18.25", end: "30.87", duration: "12.620000000000001", text: "Nel 2016 mi è stato conferito un premio da National Forum for Teaching &amp; Learning." };
const second: Segment = { id: "O7KrwO3pVZ8_0001", talk: "O7KrwO3pVZ8", start: "32.1", end: "34.0", duration: "1.9000000000000057", text: "" };
const third: Segment = { id: "009AJ_5hPZ4_0000", talk: "009AJ_5hPZ4", start: "10.94", end: "19.67", duration: "8.730000000000002", text: "  (Applaus) Ich spreche heute hier.  " };

describe("the mtedx parser", () => {
  it("reads each split's three line-aligned files into one row per segment, whatever order the archive lists them in", () => {
    const files = [...[...split("it-it/data/train/txt", "train", "it", [third]).all].reverse(), ...[...split("it-it/data/valid/txt", "valid", "it", [first, second]).all].reverse()];
    expect(parseMtedx(files, parser).nodes).toEqual([
      { id: "009AJ_5hPZ4_0000", text: "(Applaus) Ich spreche heute hier.", speaker: "009AJ_5hPZ4", audio: "009AJ_5hPZ4.wav", start: 10.94, end: 19.67, duration: 8.730000000000002, split: "train", language: "it" },
      { id: "O7KrwO3pVZ8_0000", text: "Nel 2016 mi è stato conferito un premio da National Forum for Teaching &amp; Learning.", speaker: "O7KrwO3pVZ8", audio: "O7KrwO3pVZ8.wav", start: 18.25, end: 30.87, duration: 12.620000000000001, split: "valid", language: "it" },
      { id: "O7KrwO3pVZ8_0001", text: null, speaker: "O7KrwO3pVZ8", audio: "O7KrwO3pVZ8.wav", start: 32.1, end: 34, duration: 1.9000000000000057, split: "valid", language: "it" },
    ]);
  });

  it("keeps a carriage return inside a transcript, since the files are aligned on line feeds alone", () => {
    const { all } = split("de-de/data/test/txt", "test", "de", [{ ...third, text: "eins\rzwei" }]);
    expect(parseMtedx(all, parser).nodes).toMatchObject([{ id: "009AJ_5hPZ4_0000", text: "eins\rzwei" }]);
  });

  it("is what parseNativeFiles runs for the format", () => {
    expect(parseNativeFiles(split("de-de/data/test/txt", "test", "de", [third]).all, parser).nodes).toHaveLength(1);
  });

  it("refuses files that are not the same number of lines, as they are not aligned", () => {
    const { segments, yaml } = split("it-it/data/valid/txt", "valid", "it", [first, second]);
    expect(() => parseMtedx([segments, yaml, file("it-it/data/valid/txt/valid.it", "only one line\n")], parser)).toThrow(/have 2, 2 and 1 lines, so they are not aligned/);
  });

  it("refuses a YAML line whose talk or offset disagrees with the segments line", () => {
    const { segments, text } = split("it-it/data/valid/txt", "valid", "it", [first, second]);
    const shifted = file("it-it/data/valid/txt/valid.yaml", "- {duration: 1, offset: 18.25, speaker_id: other, wav: other.wav}\n- {duration: 1, offset: 32.1, speaker_id: other, wav: other.wav}\n");
    expect(() => parseMtedx([segments, shifted, text], parser)).toThrow(NativeParseError);
    expect(() => parseMtedx([segments, shifted, text], parser)).toThrow(/the segment O7KrwO3pVZ8_0000 is in talk O7KrwO3pVZ8 from 18.25, but the .yaml line says speaker other from 18.25/);
  });

  it("refuses a pair archive's second text file, since the split's transcript would be ambiguous", () => {
    const { all } = split("it-es/data/valid/txt", "valid", "it", [first, second]);
    expect(() => parseMtedx([...all, file("it-es/data/valid/txt/valid.es", "uno\ndos\n")], parser)).toThrow(/more than one text file/);
  });

  it("refuses a segments line that is not four fields, a malformed YAML line and a segment listed twice", () => {
    const { segments, yaml, text } = split("it-it/data/valid/txt", "valid", "it", [first, second]);
    expect(() => parseMtedx([file("it-it/data/valid/txt/segments", "a b c\nd e f g\n"), yaml, text], parser)).toThrow(/a segments line is 4 space-separated fields/);
    expect(() => parseMtedx([segments, file("it-it/data/valid/txt/valid.yaml", "- {duration: 1}\n- {duration: 1}\n"), text], parser)).toThrow(/the .yaml line is not of the form/);
    expect(() => parseMtedx(split("it-it/data/valid/txt", "valid", "it", [first, first]).all, parser)).toThrow(/the segment O7KrwO3pVZ8_0000 is listed twice/);
  });

  it("refuses a directory without its YAML file or its transcript", () => {
    expect(() => parseMtedx([file("a/segments", "x y 0 1\n")], parser)).toThrow(/no .yaml file describes the split's segments/);
    expect(() => parseMtedx([file("a/segments", "x y 0 1\n"), file("a/train.yaml", "")], parser)).toThrow(/no train.<language> file/);
  });
});
