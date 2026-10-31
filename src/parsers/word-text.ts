import { unzipSync } from "fflate";
import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { isCompoundFile } from "./cfb";
import { memberId } from "./member-id";
import type { NativeRow, NativeTable } from "./native";
import { readWordDoc } from "./word-doc";
import { readXml, type XmlElement } from "./xml";

type WordTextParser = Extract<Parser, { format: "word-text" }>;

const FORMAT = "word-text";

/** The member of a `.docx` package that holds the main document's text. */
const DOCUMENT_PART = "word/document.xml";

/** The first bytes of a zip file, which a `.docx` package is. */
const ZIP_SIGNATURE: readonly number[] = Array.from("PK\u0003\u0004", (character) => character.charCodeAt(0));

/** What reading an element of a WordprocessingML part found: the text it adds to the paragraph that holds it, and the paragraphs it completed, in document order. */
interface Reading {
  readonly text: string;
  readonly paragraphs: readonly string[];
}

/**
 * The text a WordprocessingML element adds to its paragraph by itself: a `w:t`'s text, a `w:tab` as a tab, a `w:br` or `w:cr` as a line feed.
 * @param element - The element.
 * @returns Its own text, empty for any other element.
 */
function ownText(element: XmlElement): string {
  if (element.name === "w:t") {
    return element.text;
  }
  if (element.name === "w:tab") {
    return "\t";
  }

  return element.name === "w:br" || element.name === "w:cr" ? "\n" : "";
}

/**
 * Reads the paragraphs of a WordprocessingML element, in document order. A paragraph's text is its runs' text; a paragraph inside another (a text box) is a paragraph of its own, listed before the one that holds it.
 * @param element - The element to read.
 * @returns The element's text for its enclosing paragraph (empty for a paragraph itself) and the paragraphs it completed.
 */
function readParagraphs(element: XmlElement): Reading {
  const children = element.children.map(readParagraphs);
  const text = ownText(element) + children.map((child) => child.text).join("");
  const nested = children.flatMap((child) => child.paragraphs);
  if (element.name === "w:p") {
    return { text: "", paragraphs: [...nested, text] };
  }

  return { text, paragraphs: nested };
}

/**
 * Reads the text of a `.docx` document.
 * @param bytes - The package's bytes.
 * @returns The main document's paragraphs, separated by line feeds.
 * @throws NativeParseError when the package is not a zip, holds no main document part or the part is not well-formed XML.
 */
function readDocx(bytes: Uint8Array): string {
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, { filter: (entry) => entry.name === DOCUMENT_PART });
  } catch (error) {
    throw new NativeParseError(FORMAT, 1, `not a readable zip package: ${error instanceof Error ? error.message : String(error)}`);
  }
  const part = parts[DOCUMENT_PART];
  if (part === undefined) {
    throw new NativeParseError(FORMAT, 1, `the package holds no ${DOCUMENT_PART}`);
  }

  return readParagraphs(readXml(new TextDecoder("utf-8", { fatal: true }).decode(part), FORMAT)).paragraphs.join("\n");
}

/**
 * Reads a corpus of Word documents, one document per file: each file is a row whose id is the capture group of the recipe's `idPattern` (which must match the file's whole path) and whose text is the document's main text as plain text, paragraphs separated by line feeds. A `.docx` package and a legacy `.doc` file (Word 97 to 2003) are told apart by their first bytes, not their names. Headers, footers, footnotes and comments are not part of the text.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser.
 * @returns One row per file, in path order.
 * @throws NativeParseError when a file's path does not match the pattern, two files give the same id, or a file is neither a `.docx` package nor a `.doc` file or is damaged, encrypted or not valid UTF-8 where it holds XML.
 */
export function parseWordText(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<WordTextParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const id = memberId(FORMAT, file.path, parser.idPattern, index + 1);
    if (seen.has(id)) {
      throw new NativeParseError(FORMAT, index + 1, `the id ${id} is given by two files`);
    }
    seen.add(id);
    if (ZIP_SIGNATURE.every((byte, at) => file.bytes[at] === byte)) {
      nodes.push({ id, text: readDocx(file.bytes) });
    } else if (isCompoundFile(file.bytes)) {
      nodes.push({ id, text: readWordDoc(file.bytes, FORMAT) });
    } else {
      throw new NativeParseError(FORMAT, index + 1, `the file ${file.path} is neither a .docx package nor a .doc file`);
    }
  }

  return { nodes };
}
