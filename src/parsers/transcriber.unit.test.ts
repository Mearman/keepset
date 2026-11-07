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
  it("drops the layout whitespace around a segment's text and moves annotation offsets with it", () => {
    const source = `<Trans><Speakers><Speaker id="a" name="Alice"/></Speakers><Turn speaker="a" startTime="0" endTime="2">\r\n<Sync time="0"/>\r\nhello<Comment desc="note"/> there\r\n<Event desc="cough"/>\r\n</Turn></Trans>`;
    const { nodes } = parseNativeFiles([file(source)], parser);
    expect(nodes).toEqual([
      { id: "demo/1/1", text: "hello there", speaker: "a", speakerName: "Alice", audio: null, start: 0, end: 2, annotations: '[{"offset":5,"name":"Comment","attributes":{"desc":"note"}},{"offset":11,"name":"Event","attributes":{"desc":"cough"}}]' },
    ]);
  });

  it("accepts a turn with no speaker while it holds no text, and keeps background and vocal elements", () => {
    const source = '<Trans><Speakers><Speaker id="a" name="Alice"/></Speakers><Turn startTime="0" endTime="1"><Sync time="0"/></Turn><Turn speaker="a" startTime="1" endTime="2"><Sync time="1"/>hi<Background time="1.5" type="music" level="high"/><Vocal desc="laugh"/></Turn></Trans>';
    const { nodes } = parseNativeFiles([file(source)], parser);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ text: "hi", speaker: "a", annotations: '[{"offset":2,"name":"Background","attributes":{"time":"1.5","type":"music","level":"high"}},{"offset":2,"name":"Vocal","attributes":{"desc":"laugh"}}]' });
    expect(() => parseNativeFiles([file('<Trans><Turn startTime="0" endTime="1"><Sync time="0"/>words</Turn></Trans>')], parser)).toThrow("text has no speaker");
  });

  it("names the file in its errors and refuses a declared encoding that differs from the recipe's", () => {
    expect(() => parseNativeFiles([file('<Trans><Turn speaker="a" endTime="1"><Sync time="0"/><Who nb="2"/>x</Turn></Trans>')], parser)).toThrow("demo.trs: ");
    const latin1 = { ...parser, encoding: "latin1" } as const;
    expect(() => parseNativeFiles([file('<?xml version="1.0" encoding="UTF-8"?><Trans/>')], latin1)).toThrow("declares the encoding UTF-8");
    expect(() => parseNativeFiles([file('<?xml version="1.0" encoding="ISO-8859-1"?><Trans><Turn speaker="a" startTime="0" endTime="1"><Sync time="0"/>caf\u00e9</Turn></Trans>')], latin1)).not.toThrow();
  });
});
