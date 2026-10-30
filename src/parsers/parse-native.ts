import type { Parser } from "../entry";
import { NativeParseError } from "../errors";
import { parseEdgeList } from "./edge-list";
import { parseGdContest } from "./gd-contest";
import { parseGml } from "./gml";
import { parseHgb } from "./hgb";
import { parseKgTriples } from "./kg-triples";
import { parseKonect } from "./konect";
import { parseOgb } from "./ogb";
import { parseMatrixMarket } from "./matrix-market";
import { parseCsvTable } from "./csv-table";
import { parseGeojson } from "./geojson";
import { parseHhcrsp } from "./hhcrsp";
import { parseOpenslrResource } from "./openslr-resource";
import { parseMankowska } from "./mankowska";
import { parseTdc } from "./tdc";
import { parseVerolog2017 } from "./verolog-2017";
import type { NativeDocument, NativeGraph, NativeInstance, NativeTable } from "./native";
import { parsePajek } from "./pajek";
import { parseCustomerPoints } from "./customer-points";
import { parseSolomon } from "./solomon";
import { parseDtop, parseTop } from "./top";
import { parseToptw } from "./toptw";
import { parseTsplib } from "./tsplib";
import { parseUcinetDl } from "./ucinet-dl";
import { parseVerolog2019 } from "./verolog-2019";
import { parseUserItemCounts } from "./user-item-counts";
import { parseUserItemRatings } from "./user-item-ratings";
import { parseVrpRep } from "./vrp-rep";
import { parseWitvlietSynapses } from "./witvliet-synapses";
import type { InstanceParser } from "./instance-shapes";

/** Bytes converted per String.fromCharCode call: spreading a whole file would exceed the engine's argument-count limit, and this many stays well inside every engine's. */
const LATIN1_CHUNK = 0x8000;

/**
 * Decodes a file's bytes in the recipe's encoding, strictly: bytes that are not valid utf-8 fail rather than becoming replacement characters. latin1 maps every byte to the code point of the same value, so it cannot fail.
 * @param bytes - The unpacked file.
 * @param parser - The recipe's parser, which names the encoding.
 * @returns The file text.
 */
export function decode(bytes: Uint8Array, parser: Parser): string {
  if (parser.encoding === "latin1") {
    // ISO-8859-1 proper, not TextDecoder's "latin1" label, which the WHATWG Encoding Standard maps to windows-1252 and so reads bytes 0x80 to 0x9F differently.
    let text = "";
    for (let start = 0; start < bytes.length; start += LATIN1_CHUNK) {
      text += String.fromCharCode(...bytes.subarray(start, start + LATIN1_CHUNK));
    }

    return text;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    // TextDecoder reports invalid bytes only as a TypeError with no position; rethrown in the package's own taxonomy so the recipe names the step.
    throw new NativeParseError(parser.format, 1, `the file is not valid utf-8 (${error instanceof Error ? error.message : String(error)}); a recipe for a latin1 file states encoding latin1`);
  }
}

const KIBIBYTE = 1024;
const PIECE_MEBIBYTES = 8;

/** Bytes decoded at a time for a format that is read in pieces. The decoder holds only a piece's text at once, so this bounds what a large table costs beyond its bytes; it is large enough that the per-piece work is small beside the piece. */
export const DECODE_PIECE_BYTES = PIECE_MEBIBYTES * KIBIBYTE * KIBIBYTE;

/**
 * Decodes a file's bytes in the recipe's encoding as they arrive in pieces, as strictly as `decode`: a character whose bytes span two pieces is decoded whole with the later one, and bytes that are not valid in the stated encoding fail.
 */
export class PieceDecoder {
  private readonly utf8: TextDecoder | undefined;

  public constructor(private readonly parser: Parser) {
    this.utf8 = parser.encoding === "latin1" ? undefined : new TextDecoder("utf-8", { fatal: true });
  }

  /**
   * Decodes the next piece.
   * @param piece - Bytes that follow the pieces decoded before them.
   * @returns Their text, without a character the piece ends partway through.
   * @throws NativeParseError when the bytes are not valid in the stated encoding.
   */
  public decode(piece: Uint8Array): string {
    const { utf8 } = this;

    return utf8 === undefined ? decode(piece, this.parser) : this.strictly(() => utf8.decode(piece, { stream: true }));
  }

  /**
   * Ends the file.
   * @returns The text of any bytes still held.
   * @throws NativeParseError when the file ends partway through a character.
   */
  public end(): string {
    const { utf8 } = this;

    return utf8 === undefined ? "" : this.strictly(() => utf8.decode());
  }

  /**
   * Runs a utf-8 decode, rethrowing its failure in the package's taxonomy: TextDecoder reports invalid bytes only as a TypeError with no position.
   * @param run - The decode.
   * @returns Its text.
   */
  private strictly(run: () => string): string {
    try {
      return run();
    } catch (error) {
      throw new NativeParseError(this.parser.format, 1, `the file is not valid utf-8 (${error instanceof Error ? error.message : String(error)}); a recipe for a latin1 file states encoding latin1`);
    }
  }
}

/**
 * Decodes a file's bytes in the recipe's encoding a piece at a time, as strictly as `decode`, so a file whose text would not fit in one string can still be read.
 * @param bytes - The unpacked file.
 * @param parser - The recipe's parser, which names the encoding.
 * @param pieceBytes - How many bytes to decode at a time.
 * @returns The text of each piece, in order; a character that spans two pieces is yielded whole with the later one.
 * @throws NativeParseError when the bytes are not valid in the stated encoding.
 */
export function* decodePieces(bytes: Uint8Array, parser: Parser, pieceBytes: number = DECODE_PIECE_BYTES): Generator<string, void, undefined> {
  const decoder = new PieceDecoder(parser);
  for (let start = 0; start < bytes.length; start += pieceBytes) {
    yield decoder.decode(bytes.subarray(start, start + pieceBytes));
  }
  const rest = decoder.end();
  if (rest !== "") {
    yield rest;
  }
}

type TableParser = Extract<Parser, { format: "csv-table" | "geojson" }>;

/**
 * Reads a file into the native shape of the recipe's parser: a graph for the graph formats, a table of rows for the table formats.
 * @param bytes - The unpacked file.
 * @param parser - The recipe's parser.
 * @returns The native document.
 * @throws NativeParseError when the bytes are not valid in the stated encoding or the text is not in the stated format.
 */
export function parseNative(bytes: Uint8Array, parser: TableParser): NativeTable;
export function parseNative(bytes: Uint8Array, parser: Readonly<InstanceParser>): NativeInstance;
export function parseNative(bytes: Uint8Array, parser: Exclude<Parser, TableParser | InstanceParser>): NativeGraph;
export function parseNative(bytes: Uint8Array, parser: Parser): NativeDocument;
export function parseNative(bytes: Uint8Array, parser: Parser): NativeDocument {
  if (parser.format === "csv-table") {
    return parseCsvTable(decodePieces(bytes, parser), parser);
  }
  // The graph formats read a piece of text at a time, so a file of tens of millions of lines is not one string.
  if (parser.format === "user-item-ratings") {
    return parseUserItemRatings(decodePieces(bytes, parser), parser);
  }
  if (parser.format === "konect") {
    return parseKonect(decodePieces(bytes, parser), parser);
  }
  if (parser.format === "user-item-counts") {
    return parseUserItemCounts(decodePieces(bytes, parser), parser);
  }
  if (parser.format === "kg-triples") {
    return parseKgTriples([{ split: undefined, pieces: decodePieces(bytes, parser) }], parser);
  }
  // A technician dispatch file is almost all travel time lines, hundreds of megabytes of text that are checked and let go a line at a time.
  if (parser.format === "tdc") {
    return parseTdc(decodePieces(bytes, parser));
  }
  if (parser.format === "edge-list") {
    return parseEdgeList(decodePieces(bytes, parser), parser);
  }
  const text = decode(bytes, parser);
  if (parser.format === "geojson") {
    return parseGeojson(text, parser);
  }
  if (parser.format === "matrix-market") {
    return parseMatrixMarket(text);
  }
  if (parser.format === "gml") {
    return parseGml(text);
  }
  if (parser.format === "ucinet-dl") {
    return parseUcinetDl(text, parser);
  }
  if (parser.format === "gd-contest") {
    return parseGdContest(text);
  }
  if (parser.format === "witvliet-synapses") {
    return parseWitvlietSynapses(text);
  }
  if (parser.format === "customer-points") {
    return parseCustomerPoints(text);
  }
  if (parser.format === "solomon") {
    return parseSolomon(text);
  }
  if (parser.format === "top") {
    return parseTop(text);
  }
  if (parser.format === "dtop") {
    return parseDtop(text);
  }
  if (parser.format === "toptw") {
    return parseToptw(text);
  }
  if (parser.format === "tsplib") {
    return parseTsplib(text);
  }
  if (parser.format === "verolog-2019") {
    return parseVerolog2019(text);
  }
  if (parser.format === "vrp-rep") {
    return parseVrpRep(text);
  }
  if (parser.format === "hhcrsp") {
    return parseHhcrsp(text);
  }
  if (parser.format === "openslr-resource") {
    return parseOpenslrResource(text);
  }
  if (parser.format === "ogb") {
    // The recipe schema gives a multi-file parser only a files archive, which is read by parseNativeFiles, so a parsed entry never reaches this.
    throw new NativeParseError(parser.format, 1, "the format reads the several files a files archive selects, not one file");
  }
  if (parser.format === "mankowska") {
    return parseMankowska(text);
  }
  if (parser.format === "verolog-2017") {
    return parseVerolog2017(text);
  }

  return parsePajek(text);
}

/** A file of a document read from several, as the archive step gives it: the part's name and its bytes. */
export interface NamedBytes {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * Reads the named parts of a parts archive into the one native graph of the recipe's parser: the split files of a triples download, each edge carrying its part's name as its split, or an HGB dataset's `nodes` and `links` files.
 * @param parts - The parts, in the order the recipe names them.
 * @param parser - The recipe's parser, one of the formats that read parts.
 * @returns The native graph.
 * @throws NativeParseError when a part is not valid in the stated encoding, its text is not in the stated format, the parser reads one file, or an HGB recipe lacks its `nodes` or `links` part.
 */
export function parseNativeParts(parts: readonly NamedBytes[], parser: Parser): NativeGraph {
  if (parser.format === "kg-triples") {
    return parseKgTriples(
      parts.map((part) => ({ split: part.name, pieces: decodePieces(part.bytes, parser) })),
      parser,
    );
  }
  if (parser.format === "hgb") {
    const nodes = parts.find((part) => part.name === "nodes");
    const links = parts.find((part) => part.name === "links");
    if (nodes === undefined || links === undefined) {
      throw new NativeParseError(parser.format, 1, "an HGB recipe reads the parts nodes and links");
    }

    return parseHgb({ nodes: decodePieces(nodes.bytes, parser), links: decodePieces(links.bytes, parser) }, parser);
  }
  throw new NativeParseError(parser.format, 1, `the ${parser.format} parser reads one file, not named parts`);
}

/**
 * Reads the several files of a multi-file format into the one native document they make together.
 * @param files - The files a `files` archive selects, each with its path in the archive, in path order.
 * @param parser - The recipe's parser, which must be a multi-file format.
 * @returns The native graph.
 * @throws NativeParseError when a file is not valid in the stated encoding or the files are not in the stated format, or when the parser reads one file and not several.
 */
export function parseNativeFiles(files: readonly { readonly path: string; readonly bytes: Uint8Array }[], parser: Parser): NativeGraph {
  if (parser.format !== "ogb") {
    // The recipe schema gives a files archive only to a multi-file parser, so a parsed entry never reaches this.
    throw new NativeParseError(parser.format, 1, "the format reads one file, not the several a files archive selects");
  }

  return parseOgb(files.map((file) => ({ path: file.path, text: () => decodePieces(file.bytes, parser) })));
}
