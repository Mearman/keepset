import { describe, expect, it } from "vitest";
import { parseNativeFiles } from "./parse-native";

const parser = { format: "transcriber", encoding: "utf-8", idPattern: "([^/]+)\\.trs" } as const;
const file = (text: string) => ({ path: "demo.trs", bytes: new TextEncoder().encode(text) });

describe("Transcriber transcripts", () => {
  it("keeps simultaneous speakers, timing, inline comments and text in order", () => {
    const source = `<?xml version="1.0"?><!DOCTYPE Trans SYSTEM "trans-14.dtd"><Trans audio_filename="demo"><Speakers><Speaker id="a" name="Alice"/><Speaker id="b" name="Bob"/></Speakers><Episode><Section><Turn speaker="a b" startTime="0" endTime="3"><Sync time="0"/><Who nb="1"/>hello<Comment desc="note"/> there<Who nb="2"/>hi<Sync time="2"/><Who nb="1"/>bye</Turn></Section></Episode></Trans>`;
    const { nodes } = parseNativeFiles([file(source)], parser);
    expect(nodes).toEqual([
      { id: "demo/1/1", text: "hello there", speaker: "a", speakerName: "Alice", audio: "demo", start: 0, end: 2, annotations: '[{"offset":5,"name":"Comment","attributes":{"desc":"note"}}]' },
      { id: "demo/1/2", text: "hi", speaker: "b", speakerName: "Bob", audio: "demo", start: 0, end: 2, annotations: "[]" },
      { id: "demo/1/3", text: "bye", speaker: "a", speakerName: "Alice", audio: "demo", start: 2, end: 3, annotations: "[]" },
    ]);
  });

  it("refuses unknown document types and invalid speaker references", () => {
    expect(() => parseNativeFiles([file('<!DOCTYPE Trans [<!ENTITY x "y">]><Trans>&x;</Trans>')], parser)).toThrow("document type declaration");
    expect(() => parseNativeFiles([file('<Trans><Turn speaker="a" endTime="1"><Sync time="0"/><Who nb="2"/>x</Turn></Trans>')], parser)).toThrow("names no speaker");
  });
});
