import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseNativeFiles } from "./parse-native";
import { parseStm } from "./stm";

type StmParser = Extract<Parser, { format: "stm" }>;

const parser = (options: Readonly<Partial<StmParser>> = {}): StmParser => ({ format: "stm", encoding: "utf-8", idPattern: "(?:.*/)?([^/]+)\\.stm", ...options });

const file = (path: string, text: string): { readonly path: string; readonly bytes: Uint8Array } => ({ path, bytes: new TextEncoder().encode(text) });

/** The lines of `stm` that are a speaker's transcript, which are the rows the parser reads. */
const SPEAKER_LINES = 3;

const stm = [
  ";; Transcriber conversion",
  ';; CATEGORY "0" "" ""',
  "",
  "rec_1 1 locuteur2 0.000 3.214 <o,f1,male> maɗe puɗata :fra a",
  "rec_1 1 excluded_region 3.214 9.000 <o,,unknown> ignore_time_segment_in_scoring",
  "rec_1 2 locuteur1 9.000 11.5 <o,f0,> ",
  "rec_1 1 inter_segment_gap 11.5 12.0 <o,f0,> ",
  "rec_1 1 locuteur1 12.0 14.25 <o,f2,female>\ttwo  words",
].join("\n");

describe("the stm parser", () => {
  it("reads each segment line of a speaker as a row with its channel, times, label and text, and leaves out the header, blank and reserved-speaker lines", () => {
    expect(parseStm([file("fuc/1/stm_format/rec_1.stm", stm)], parser()).nodes).toEqual([
      { id: "rec_1/4", speaker: "locuteur2", channel: "1", start: 0, end: 3.214, label: "o,f1,male", text: "maɗe puɗata :fra a" },
      { id: "rec_1/6", speaker: "locuteur1", channel: "2", start: 9, end: 11.5, label: "o,f0,", text: null },
      { id: "rec_1/8", speaker: "locuteur1", channel: "1", start: 12, end: 14.25, label: "o,f2,female", text: "two  words" },
    ]);
  });

  it("reads CR LF line ends", () => {
    expect(parseStm([file("a.stm", stm.replaceAll("\n", "\r\n"))], parser()).nodes).toHaveLength(SPEAKER_LINES);
  });

  it("refuses a line that is not a segment line, a time that is not a number, a repeated id and a path the pattern misses", () => {
    const run = (...files: readonly { readonly path: string; readonly bytes: Uint8Array }[]): NativeParseError => {
      try {
        parseStm(files, parser());
      } catch (error) {
        if (error instanceof NativeParseError) {
          return error;
        }
        throw error;
      }
      throw new Error("expected a NativeParseError");
    };
    expect(run(file("a.stm", "rec_1 1 spk 0.0 1.0 text without a label")).message).toMatch(/line 1 of a\.stm .* is not a segment line/);
    expect(run(file("a.stm", "rec_1 1 spk zero 1.0 <o> text")).message).toMatch(/the begin time "zero" is not a number/);
    expect(run(file("a.stm", "rec_1 1 spk 0.0 one <o> text")).message).toMatch(/the end time "one" is not a number/);
    expect(run(file("a/x.stm", ""), file("b/x.stm", "")).message).toMatch(/the id x is given by two files/);
    expect(run(file("a.txt", "")).message).toMatch(/gives no id by the pattern/);
  });

  it("is what parseNativeFiles runs for the format", () => {
    expect(parseNativeFiles([file("a.stm", stm)], parser()).nodes).toHaveLength(SPEAKER_LINES);
  });
});
