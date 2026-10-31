import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { memberId } from "./member-id";
import type { NativeRow, NativeTable } from "./native";
import { decode } from "./parse-native";
import { readXml, type XmlElement } from "./xml";

type EafParser = Extract<Parser, { format: "eaf" }>;

const FORMAT = "eaf";

/**
 * The elements of a name anywhere beneath an element, in document order.
 * @param element - The element to search beneath.
 * @param name - The element name.
 * @returns The matching elements.
 */
function descendants(element: XmlElement, name: string): XmlElement[] {
  return element.children.flatMap((child) => (child.name === name ? [child, ...descendants(child, name)] : descendants(child, name)));
}

/**
 * Reads a corpus whose transcripts are ELAN annotation files: each non-empty annotation of each tier is a row. A row's id is the file's id (the capture group of the recipe's `idPattern` on the file's path), a slash and the annotation's id in the file. A row has the annotation's `text`, the `tier` it is on, and for an annotation aligned to the time line its `start` and `end` in milliseconds, which are null for an annotation that refers to another annotation and so has no times of its own.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser.
 * @returns The rows, in file and document order.
 * @throws NativeParseError when a file is not well-formed XML, two files give the same id, or a path does not match the pattern.
 */
export function parseEaf(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Readonly<EafParser>): NativeTable {
  const seen = new Set<string>();
  const nodes: NativeRow[] = [];
  for (const [index, file] of files.entries()) {
    const stem = memberId(FORMAT, file.path, parser.idPattern, index + 1);
    if (seen.has(stem)) {
      throw new NativeParseError(FORMAT, index + 1, `the id ${stem} is given by two files`);
    }
    seen.add(stem);
    const root = readXml(decode(file.bytes, parser), FORMAT);
    const slots = new Map(descendants(root, "TIME_SLOT").map((slot) => [slot.attributes["TIME_SLOT_ID"] ?? "", Number(slot.attributes["TIME_VALUE"])]));
    for (const tier of descendants(root, "TIER")) {
      for (const annotation of descendants(tier, "ANNOTATION")) {
        const [inner] = annotation.children;
        const value = inner?.children.find((child) => child.name === "ANNOTATION_VALUE")?.text.trim() ?? "";
        const annotationId = inner?.attributes["ANNOTATION_ID"];
        if (inner === undefined || annotationId === undefined || value === "") {
          continue;
        }
        const startRef = inner.attributes["TIME_SLOT_REF1"];
        const endRef = inner.attributes["TIME_SLOT_REF2"];
        nodes.push({
          id: `${stem}/${annotationId}`,
          text: value,
          tier: tier.attributes["TIER_ID"] ?? null,
          start: startRef === undefined ? null : (slots.get(startRef) ?? null),
          end: endRef === undefined ? null : (slots.get(endRef) ?? null),
        });
      }
    }
  }

  return { nodes };
}
