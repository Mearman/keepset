import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { memberId } from "./member-id";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";
import { readXml, type XmlElement } from "./xml";

type TranscriberParser = Extract<Parser, { format: "transcriber" }>;
const FORMAT = "transcriber";
const DTD = '<!DOCTYPE Trans SYSTEM "trans-14.dtd">';

function descendants(element: XmlElement, name: string): XmlElement[] {
  return element.children.flatMap((child) => (child.name === name ? [child, ...descendants(child, name)] : descendants(child, name)));
}

function syncTime(value: string | undefined, line: number): number {
  const time = Number(value);
  if (!Number.isFinite(time)) throw new NativeParseError(FORMAT, line, "a sync needs a time");

  return time;
}

function speakerAt(value: string | undefined, ids: readonly string[], line: number): string {
  const number = Number(value);
  const speaker = Number.isInteger(number) && number > 0 ? ids[number - 1] : undefined;
  if (speaker === undefined) throw new NativeParseError(FORMAT, line, "a Who marker names no speaker in its turn");

  return speaker;
}

/** Reads Transcriber turns as time-aligned speaker segments, retaining inline annotations and their offsets. */
export function parseTranscriber(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<TranscriberParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const stem = memberId(FORMAT, file.path, parser.idPattern, index + 1);
    if (seen.has(stem)) throw new NativeParseError(FORMAT, index + 1, `the id ${stem} is given by two files`);
    seen.add(stem);
    const root = readXml(decode(file.bytes, parser).replace(DTD, ""), FORMAT);
    if (root.name !== "Trans") throw new NativeParseError(FORMAT, index + 1, "the root element must be Trans");
    const speakers = new Map(descendants(root, "Speaker").map((speaker) => [speaker.attributes['id'], speaker.attributes['name']]));
    for (const [turnIndex, turn] of descendants(root, "Turn").entries()) {
      const ids = turn.attributes['speaker']?.split(/\s+/) ?? [];
      const end = Number(turn.attributes['endTime']);
      if (ids.length === 0 || !Number.isFinite(end)) throw new NativeParseError(FORMAT, index + 1, "a turn needs speakers and an end time");
      let start: number | undefined;
      let speaker = ids.length === 1 ? ids[0] : undefined;
      let text = "";
      let annotations: { offset: number; name: string; attributes: Readonly<Record<string, string>> }[] = [];
      let sequence = 0;
      const pending: { speaker: string; text: string; annotations: typeof annotations }[] = [];
      const closeSpeaker = (): void => {
        if (text.trim() !== "" || annotations.length > 0) {
          if (speaker === undefined) throw new NativeParseError(FORMAT, index + 1, "text has no speaker");
          pending.push({ speaker, text, annotations });
        }
        text = "";
        annotations = [];
      };
      const closeInterval = (stop: number): void => {
        closeSpeaker();
        if (pending.length > 0 && (start === undefined || stop < start)) throw new NativeParseError(FORMAT, index + 1, "a segment has invalid times");
        for (const part of pending) {
          sequence += 1;
          nodes.push({ id: `${stem}/${String(turnIndex + 1)}/${String(sequence)}`, text: part.text, speaker: part.speaker, speakerName: speakers.get(part.speaker) ?? null, audio: root.attributes['audio_filename'] ?? null, start: start ?? null, end: stop, annotations: JSON.stringify(part.annotations) });
        }
        pending.length = 0;
      };
      for (const item of turn.content) {
        if (typeof item === "string") {
          text += item;
        } else if (item.name === "Sync") {
          const time = syncTime(item.attributes['time'], index + 1);
          closeInterval(time);
          start = time;
          speaker = ids.length === 1 ? ids[0] : undefined;
        } else if (item.name === "Who") {
          closeSpeaker();
          speaker = speakerAt(item.attributes['nb'], ids, index + 1);
        } else if (item.name === "Comment" || item.name === "Event") {
          annotations.push({ offset: text.length, name: item.name, attributes: item.attributes });
        } else {
          throw new NativeParseError(FORMAT, index + 1, `unexpected turn element ${item.name}`);
        }
      }
      closeInterval(end);
    }
  }

  return { nodes };
}
