import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { memberId } from "./member-id";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";
import { readXml, type XmlElement } from "./xml";

type TranscriberParser = Extract<Parser, { format: "transcriber" }>;
const FORMAT = "transcriber";
/** The reference every Transcriber file makes to its document type definition, the only document type declaration read. */
const DTD = /<!DOCTYPE Trans SYSTEM "trans-\d+\.dtd">/;
/** The encoding a file declares for itself, which sits in the first bytes and is plain ASCII whatever the encoding. */
const DECLARED_ENCODING = /^<\?xml[^>]*\sencoding\s*=\s*["']([^"']+)["']/;
/** How many bytes from the start of a file are searched for its XML declaration. */
const DECLARATION_BYTES = 256;
/** The inline elements kept as annotations at their offsets in the segment's text, with the attributes the file gives them. */
const ANNOTATIONS: ReadonlySet<string> = new Set(["Comment", "Event", "Background", "Vocal"]);
const ENCODING_NAMES: ReadonlyMap<string, string> = new Map([["iso-8859-1", "latin1"], ["latin1", "latin1"], ["l1", "latin1"], ["utf8", "utf-8"], ["utf-8", "utf-8"]]);

/**
 * Names an encoding the way the recipe does, so a file's declaration and the recipe can be compared.
 * @param name - An encoding's name as a file or recipe spells it.
 * @returns The canonical name, or the lower-cased name when it has no other spelling.
 */
function canonicalEncoding(name: string): string {
  const lower = name.toLowerCase();

  return ENCODING_NAMES.get(lower) ?? lower;
}

/**
 * Refuses a file whose own declaration disagrees with the encoding the recipe decodes it with. Latin-1 decodes any bytes, so a mismatch would otherwise read as mojibake with no error.
 * @param bytes - The file.
 * @param encoding - The recipe's encoding.
 * @returns The declared encoding when it differs from the recipe's, otherwise undefined.
 */
function mismatchedDeclaration(bytes: Uint8Array, encoding: string): string | undefined {
  const declared = DECLARED_ENCODING.exec(new TextDecoder("latin1").decode(bytes.subarray(0, DECLARATION_BYTES)))?.[1];

  return declared !== undefined && canonicalEncoding(declared) !== canonicalEncoding(encoding) ? declared : undefined;
}

function descendants(element: XmlElement, name: string): XmlElement[] {
  return element.children.flatMap((child) => (child.name === name ? [child, ...descendants(child, name)] : descendants(child, name)));
}

type Refuse = (message: string) => NativeParseError;

function syncTime(value: string | undefined, refuse: Refuse): number {
  const time = Number(value);
  if (value === undefined || value.trim() === "" || !Number.isFinite(time)) throw refuse("a sync needs a time");

  return time;
}

function speakerAt(value: string | undefined, ids: readonly string[], refuse: Refuse): string {
  const number = Number(value);
  const speaker = Number.isInteger(number) && number > 0 ? ids[number - 1] : undefined;
  if (speaker === undefined) throw refuse("a Who marker names no speaker in its turn");

  return speaker;
}

/** Reads Transcriber turns as time-aligned speaker segments, retaining inline annotations and their offsets. */
export function parseTranscriber(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<TranscriberParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const refuse: Refuse = (message) => new NativeParseError(FORMAT, index + 1, `${file.path}: ${message}`);
    const stem = memberId(FORMAT, file.path, parser.idPattern, index + 1);
    if (seen.has(stem)) throw refuse(`the id ${stem} is given by another file`);
    seen.add(stem);
    const declared = mismatchedDeclaration(file.bytes, parser.encoding);
    if (declared !== undefined) throw refuse(`the file declares the encoding ${declared} but the recipe decodes it as ${parser.encoding}`);
    const root = readXml(decode(file.bytes, parser).replace(DTD, ""), FORMAT);
    if (root.name !== "Trans") throw refuse("the root element must be Trans");
    const speakers = new Map(descendants(root, "Speaker").map((speaker) => [speaker.attributes['id'], speaker.attributes['name']]));
    for (const [turnIndex, turn] of descendants(root, "Turn").entries()) {
      // A turn of pauses or noise has no speaker; text in one is refused when it is closed, since it has none to belong to.
      const ids = (turn.attributes['speaker'] ?? "").split(/\s+/).filter((id) => id !== "");
      const endTime = turn.attributes['endTime'];
      const end = Number(endTime);
      if (endTime === undefined || endTime.trim() === "" || !Number.isFinite(end)) throw refuse("a turn needs an end time");
      let start: number | undefined;
      let speaker = ids.length === 1 ? ids[0] : undefined;
      let text = "";
      let annotations: { offset: number; name: string; attributes: Readonly<Record<string, string>> }[] = [];
      let sequence = 0;
      const pending: { speaker: string; text: string; annotations: typeof annotations }[] = [];
      const closeSpeaker = (): void => {
        if (text.trim() !== "" || annotations.length > 0) {
          if (speaker === undefined) throw refuse("text has no speaker");
          // The line breaks and indentation a file puts around a segment's text are layout; offsets move with the text they sit in.
          const lead = text.length - text.trimStart().length;
          const trimmed = text.trim();
          pending.push({ speaker, text: trimmed, annotations: annotations.map((annotation) => ({ ...annotation, offset: Math.min(Math.max(annotation.offset - lead, 0), trimmed.length) })) });
        }
        text = "";
        annotations = [];
      };
      const closeInterval = (stop: number): void => {
        closeSpeaker();
        if (pending.length > 0 && (start === undefined || stop < start)) throw refuse("a segment has invalid times");
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
          const time = syncTime(item.attributes['time'], refuse);
          closeInterval(time);
          start = time;
          speaker = ids.length === 1 ? ids[0] : undefined;
        } else if (item.name === "Who") {
          closeSpeaker();
          speaker = speakerAt(item.attributes['nb'], ids, refuse);
        } else if (ANNOTATIONS.has(item.name)) {
          annotations.push({ offset: text.length, name: item.name, attributes: item.attributes });
        } else {
          throw refuse(`unexpected turn element ${item.name}`);
        }
      }
      closeInterval(end);
    }
  }

  return { nodes };
}
