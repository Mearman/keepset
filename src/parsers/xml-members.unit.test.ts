import { describe, expect, it } from "vitest";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseEaf } from "./eaf";
import { parseNxtWords } from "./nxt-words";
import { parseNativeFiles } from "./parse-native";

const file = (path: string, text: string): { readonly path: string; readonly bytes: Uint8Array } => ({ path, bytes: new TextEncoder().encode(text) });

const nxt = (options: Readonly<Partial<Extract<Parser, { format: "nxt-words" }>>> = {}): Extract<Parser, { format: "nxt-words" }> => ({ format: "nxt-words", encoding: "utf-8", idPattern: "(?:.*/)?([^/]+)\\.words\\.xml", ...options });
const eaf = (): Extract<Parser, { format: "eaf" }> => ({ format: "eaf", encoding: "utf-8", idPattern: "(?:.*/)?([^/]+)\\.eaf" });

const words = `<?xml version="1.0" encoding="UTF-8"?>
<nite:root nite:id="EN2001a.A.words" xmlns:nite="http://nite.sourceforge.net/">
  <w nite:id="w0" starttime="5.57" endtime="5.94">Okay</w>
  <w nite:id="w1" starttime="5.94" endtime="5.94" punc="true">.</w>
  <vocalsound nite:id="v0" starttime="6" endtime="7" type="laugh"/>
  <w nite:id="w2" starttime="11.09" endtime="11.25">Steve&#39;s</w>
  <w nite:id="w3" starttime="11.25" endtime="11.5">idea</w>
</nite:root>`;

const annotations = `<?xml version="1.0" encoding="UTF-8"?>
<ANNOTATION_DOCUMENT>
  <TIME_ORDER><TIME_SLOT TIME_SLOT_ID="ts1" TIME_VALUE="0"/><TIME_SLOT TIME_SLOT_ID="ts2" TIME_VALUE="1500"/></TIME_ORDER>
  <TIER TIER_ID="speaker">
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a1" TIME_SLOT_REF1="ts1" TIME_SLOT_REF2="ts2"><ANNOTATION_VALUE> Bueno </ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a2" TIME_SLOT_REF1="ts2" TIME_SLOT_REF2="ts2"><ANNOTATION_VALUE>$</ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
    <ANNOTATION><ALIGNABLE_ANNOTATION ANNOTATION_ID="a3" TIME_SLOT_REF1="ts1" TIME_SLOT_REF2="ts1"><ANNOTATION_VALUE></ANNOTATION_VALUE></ALIGNABLE_ANNOTATION></ANNOTATION>
  </TIER>
  <TIER TIER_ID="translation" PARENT_REF="speaker">
    <ANNOTATION><REF_ANNOTATION ANNOTATION_ID="a4" ANNOTATION_REF="a1"><ANNOTATION_VALUE>Well</ANNOTATION_VALUE></REF_ANNOTATION></ANNOTATION>
  </TIER>
</ANNOTATION_DOCUMENT>`;

describe("the nxt-words parser", () => {
  it("makes a row of each file: its words joined, punctuation attached, with the word count and the first and last times", () => {
    expect(parseNxtWords([file("words/EN2001a.A.words.xml", words)], nxt()).nodes).toEqual([{ id: "EN2001a.A", text: "Okay. Steve's idea", words: 4, start: 5.57, end: 11.5 }]);
  });

  it("gives a file with no words a null text and times, and refuses a repeated id, a path the pattern misses and text that is not XML", () => {
    expect(parseNxtWords([file("x.words.xml", '<nite:root xmlns:nite="http://nite.sourceforge.net/"/>')], nxt()).nodes).toEqual([{ id: "x", text: null, words: 0, start: null, end: null }]);
    expect(() => parseNxtWords([file("a/x.words.xml", words), file("b/x.words.xml", words)], nxt())).toThrow(/id x is given by two files/);
    expect(() => parseNxtWords([file("x.txt", words)], nxt())).toThrow(/gives no id/);
    expect(() => parseNxtWords([file("x.words.xml", "<w>")], nxt())).toThrow(NativeParseError);
  });

  it("is what parseNativeFiles runs for the format", () => {
    expect(parseNativeFiles([file("x.words.xml", words)], nxt()).nodes).toHaveLength(1);
  });
});

describe("the eaf parser", () => {
  it("makes a row of each non-empty annotation, with its tier and the times of an aligned one", () => {
    expect(parseEaf([file("dir/tale.eaf", annotations)], eaf()).nodes).toEqual([
      { id: "tale/a1", text: "Bueno", tier: "speaker", start: 0, end: 1500 },
      { id: "tale/a2", text: "$", tier: "speaker", start: 1500, end: 1500 },
      { id: "tale/a4", text: "Well", tier: "translation", start: null, end: null },
    ]);
  });

  it("refuses a repeated file id and a path the pattern misses, and is what parseNativeFiles runs for the format", () => {
    expect(() => parseEaf([file("a/t.eaf", annotations), file("b/t.eaf", annotations)], eaf())).toThrow(/id t is given by two files/);
    expect(() => parseEaf([file("t.txt", annotations)], eaf())).toThrow(/gives no id/);
    expect(parseNativeFiles([file("t.eaf", annotations)], eaf()).nodes).toHaveLength(parseEaf([file("t.eaf", annotations)], eaf()).nodes.length);
  });
});
