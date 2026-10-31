import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { memberId } from "./member-id";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";
import { readXml, type XmlElement } from "./xml";

type NxtWordsParser = Extract<Parser, { format: "nxt-words" }>;

const FORMAT = "nxt-words";

/**
 * The words of an NXT words file, in order: the text of each `w` element, the file's other elements (vocal sounds, disfluency markers, gaps) being left out.
 * @param root - The file's root element.
 * @returns The words, each with whether the file marks it as punctuation.
 */
function wordsOf(root: XmlElement): { readonly word: string; readonly punctuation: boolean }[] {
  return root.children.filter((child) => child.name === "w").map((child) => ({ word: child.text.trim(), punctuation: child.attributes["punc"] === "true" }));
}

/**
 * Reads a corpus whose transcripts are NXT words files (the AMI Meeting Corpus writes one per meeting and speaker): each file is a row, its id taken from the file's path by the recipe's `idPattern`, and its text the file's words in order joined by spaces, a word the file marks as punctuation being attached to the word before it. A row also has the file's `words` count and the times of its first and last words, in seconds, as the file gives them.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser.
 * @returns One row per file, in path order.
 * @throws NativeParseError when a file is not well-formed XML, two files give the same id, or a path does not match the pattern.
 */
export function parseNxtWords(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<NxtWordsParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const id = memberId(FORMAT, file.path, parser.idPattern, index + 1);
    if (seen.has(id)) {
      throw new NativeParseError(FORMAT, index + 1, `the id ${id} is given by two files`);
    }
    seen.add(id);
    const root = readXml(decode(file.bytes, parser), FORMAT);
    const words = wordsOf(root);
    const text = words.reduce((joined, { word, punctuation }) => (joined === "" || punctuation ? `${joined}${word}` : `${joined} ${word}`), "");
    const timed = root.children.filter((child) => child.name === "w");
    const first = timed[0]?.attributes["starttime"];
    const last = timed.at(-1)?.attributes["endtime"];
    nodes.push({ id, text: text === "" ? null : text, words: words.length, start: first === undefined ? null : Number(first), end: last === undefined ? null : Number(last) });
  }

  return { nodes };
}
