import type { Archive, CollectionArchive, DocumentArchive, ArchiveMember, FilesArchive, InnerArchive, PartsArchive, SheetArchive } from "./entry";
import { ArchiveError } from "./errors";
import { getOwn } from "./own";
import { gunzip, GunzipStream } from "./gzip";
import { bunzip2, Bunzip2Stream } from "./node/bzip2";
import { pointShapefileToCsv } from "./node/shapefile";
import { scanTar, TarScanner, type TarMember } from "./node/tar";
import { listZip, readZipEntry, readZipEntryChunks, unzipEntries, type ZipEntry, type ZipEntryInfo } from "./node/zip";
import { odsGrid } from "./node/ods";
import { gridToCsv } from "./node/sheet";
import { xlsGrid } from "./node/xls";
import { sheetNames, xlsxGrid } from "./node/xlsx";
import { inTurn } from "./in-turn";
import { asSource, bytesSource, type SourceBytes } from "./source-bytes";

/** The file a recipe's archive step yields: its bytes, and the member path it came from when the archive holds several. */
export interface Unpacked {
  readonly bytes: Uint8Array;
  readonly member?: string;
}

/**
 * Whether an archive member is a macOS resource fork (`__MACOSX/` or an AppleDouble `._` file), which carries Finder metadata rather than data and never matches a selector.
 * @param path - The member path.
 * @returns True for a resource fork.
 */
function isResourceFork(path: string): boolean {
  return path.startsWith("__MACOSX/") || path.split("/").some((segment) => segment.startsWith("._"));
}

/**
 * Whether a member path matches a selector: a path selector matches the whole member path or its trailing segments, an extensions selector the end of the member's name (ignoring case), a pattern selector the whole path.
 * @param path - The member path.
 * @param member - The recipe's selector.
 * @returns True on a match.
 */
function selects(path: string, member: ArchiveMember): boolean {
  if (isResourceFork(path) || path.endsWith("/")) {
    return false;
  }
  if ("path" in member) {
    return path === member.path || path.endsWith(`/${member.path}`);
  }
  if ("pattern" in member) {
    return new RegExp(`^(?:${member.pattern})$`, "u").test(path);
  }

  return member.extensions.some((extension) => path.toLowerCase().endsWith(extension.toLowerCase()));
}

/**
 * Describes what a selector asks for, for an error message.
 * @param member - The selector.
 * @param noun - How to name the member or members.
 * @returns The member path, extensions or pattern it names.
 */
function describeSelector(member: ArchiveMember, noun: string): string {
  if ("path" in member) {
    return `${noun === "one member" ? "member" : noun} ${member.path}`;
  }

  return "pattern" in member ? `${noun} matching ${member.pattern}` : `${noun} ending ${member.extensions.join(" or ")}`;
}

/**
 * Picks every member a selector matches, in path order, so a collection reads in the same order wherever it is unpacked.
 * @param paths - Every member path.
 * @param member - The recipe's selector.
 * @returns The matching paths, sorted, at least one.
 * @throws ArchiveError when no member matches, listing the members.
 */
function pickAll(paths: readonly string[], member: ArchiveMember): string[] {
  const matched = paths.filter((path) => selects(path, member)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  if (matched.length === 0) {
    throw new ArchiveError(`expected at least one ${describeSelector(member, "member")}, found none among: ${paths.join(", ")}`);
  }

  return matched;
}

/**
 * Picks the one member a selector matches.
 * @param paths - Every member path.
 * @param member - The recipe's selector.
 * @returns The matching path.
 * @throws ArchiveError when no member or more than one matches, listing the members.
 */
function pick(paths: readonly string[], member: ArchiveMember): string {
  const matched = paths.filter((path) => selects(path, member));
  const [only] = matched;
  if (matched.length !== 1 || only === undefined) {
    throw new ArchiveError(`expected ${describeSelector(member, "one member")}, found ${String(matched.length)} among: ${paths.join(", ")}`);
  }

  return only;
}

/**
 * Whether a recipe's archive is read by ranges rather than from its first byte to its last: a zip's central directory and the members it selects lie at offsets the directory names, so a store may leave the archive on the server and fetch only those ranges.
 * @param archive - The recipe's archive layout.
 * @returns True for a zip, and for a zipped shapefile.
 */
export function readsByRanges(archive: Archive): boolean {
  return archive.kind === "zip" || archive.kind === "shapefile";
}

/**
 * Unpacks a source into the one file the parser reads. A member with an `inner` archive is unpacked again by that layout, and the path reported is the outer member's, joined by `/` to the inner member's or the inner sheet's name when the inner layout selects one, as though the inner archive were a directory. A tar archive is read as it arrives, a zip by the ranges its directory names and a 7z archive by the platform's 7z reader, so only the selected member is ever held; a plain or compressed file (gzip, bzip2 or xz) and a workbook are read whole, as their parsers read them.
 * @param input - The downloaded bytes, held in memory or kept anywhere.
 * @param archive - The recipe's archive layout.
 * @param options - The platform's 7z reader and xz decoder and the abort signal, each needed only by an archive of its own kind.
 * @returns The file's bytes, and its member path for a multi-file archive.
 * @throws ArchiveError when the bytes, or a member's bytes that an `inner` layout reads, are not a well-formed archive of the stated kind or a selector does not match exactly one member.
 */
export async function unpack(input: Uint8Array | Readonly<SourceBytes>, archive: DocumentArchive, options?: Readonly<UnpackOptions>): Promise<Unpacked> {
  const source = asSource(input);
  if (archive.kind === "none") {
    return { bytes: await source.bytes() };
  }
  if (archive.kind === "gzip") {
    return { bytes: gunzip(await source.bytes()) };
  }
  if (archive.kind === "bzip2") {
    return { bytes: bunzip2(await source.bytes()) };
  }
  if (archive.kind === "xz") {
    return { bytes: await unxzWhole(source, options) };
  }
  if ("sheet" in archive) {
    return { bytes: sheetToCsv(await source.bytes(), archive), member: archive.sheet };
  }
  if (archive.kind === "shapefile") {
    return unpackShapefile(source, archive.member);
  }
  const outer = await selectMember(source, archive, options);
  if (archive.inner === undefined) {
    return outer;
  }
  if (archive.inner.kind === "gzip") {
    return { bytes: gunzip(outer.bytes), member: outer.member };
  }
  if ("sheet" in archive.inner) {
    return { bytes: sheetToCsv(outer.bytes, archive.inner), member: `${outer.member}/${archive.inner.sheet}` };
  }
  const inner = await selectMember(bytesSource(outer.bytes), archive.inner, options);

  return { bytes: inner.bytes, member: `${outer.member}/${inner.member}` };
}

/**
 * Unpacks the one member a file archive's selector matches.
 * @param source - The archive.
 * @param archive - A file archive layout and its selector.
 * @param options - The platform's 7z reader and xz decoder and the abort signal, each needed only by an archive of its own kind.
 * @returns The member's bytes and path.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector does not match exactly one member.
 */
async function selectMember(source: Readonly<SourceBytes>, archive: Extract<InnerArchive, { readonly member: ArchiveMember }>, options: Readonly<UnpackOptions> | undefined): Promise<{ readonly bytes: Uint8Array; readonly member: string }> {
  const members = readMembers(
    source,
    archive.kind,
    { candidate: (path) => selects(path, archive.member), choose: (paths) => [{ path: pick(paths, archive.member) }] },
    options,
  );
  for await (const member of members) {
    return { bytes: member.bytes, member: member.path };
  }

  // `pick` names exactly one member or throws, and `readMembers` yields every member chosen, so the loop always returns.
  throw new ArchiveError("the selected member could not be read");
}

/**
 * Unpacks a zipped point shapefile into the CSV its attribute table and positions make. The `.dbf`, `.prj` and `.cpg` are the members with the `.shp`'s path and their own extension, matched without case as GIS tools write extensions either way.
 * @param source - The zip.
 * @param member - The selector of the `.shp`.
 * @returns The CSV, and the `.shp`'s path as the member read.
 * @throws ArchiveError when the bytes are not a zip, the selector does not match exactly one `.shp`, a part beside it is missing or there is more than one of it, or the shapefile cannot be read.
 */
async function unpackShapefile(source: Readonly<SourceBytes>, member: ArchiveMember): Promise<Unpacked> {
  const names = (await zipEntries(source)).map((entry) => entry.name);
  const shp = pick(names, member);
  if (!shp.toLowerCase().endsWith(".shp")) {
    throw new ArchiveError(`the shapefile member ${shp} is not a .shp`);
  }
  const stem = shp.slice(0, -".shp".length);
  const beside = (extension: string): string => {
    const matched = names.filter((name) => name.length === stem.length + extension.length && name.startsWith(stem) && name.toLowerCase().endsWith(extension));
    const [only] = matched;
    if (only === undefined || matched.length !== 1) {
      throw new ArchiveError(`expected one ${extension} beside ${shp}, found ${String(matched.length)} among: ${names.join(", ")}`);
    }

    return only;
  };
  const paths = { shp, dbf: beside(".dbf"), prj: beside(".prj"), cpg: beside(".cpg") };
  const wanted = new Set(Object.values(paths));
  const files = await unzip(source, (candidate) => wanted.has(candidate.name));
  const read = (path: string): Uint8Array => {
    const file = getOwn(files, path);
    if (file === undefined) {
      throw new ArchiveError(`zip member ${path} could not be read`);
    }

    return file;
  };

  return { bytes: pointShapefileToCsv({ shp: read(paths.shp), dbf: read(paths.dbf), prj: read(paths.prj), cpg: read(paths.cpg) }), member: shp };
}

/** One file of a collection: its path in the archive and its bytes. */
export interface Member {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/**
 * Unpacks a source into every file a collection's selector matches, or, with an `inner` layout, into the files inside each matched member. An `xlsx` layout gives every sheet of every matched workbook that its `sheets` pattern matches as the sheet's CSV, at the member's path and the sheet's name joined by `/`, sheets in the workbook's order. A file archive layout unpacks each matched member as an archive in its turn and gives every file its `members` selector matches, at the member's path and the file's path joined by `/`, in path order. Members are in path order. The files are given one at a time: a zip member is read and inflated only when it is reached, so a reader that lets each file go before taking the next holds one member's bytes, never every member at once; a tar archive is read once as it arrives, keeping only the members the selector matches (the outer archive's other members, however large, are never held), and a matched member that is itself an archive is held while its own files are given.
 * @param input - The downloaded bytes, held in memory or kept anywhere.
 * @param archive - The recipe's archive layout, which selects members with `members`.
 * @param options - The platform's 7z reader and xz decoder and the abort signal, each needed only by an archive of its own kind.
 * @returns Each file.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind, the selector matches no member (at the first file taken), a member an `xlsx` layout reads is not a workbook or has no sheet the pattern matches, or a member an archive layout reads is not a well-formed archive of the stated kind or holds no file the inner selector matches (at that member).
 */
export async function* unpackMembers(input: Uint8Array | Readonly<SourceBytes>, archive: CollectionArchive, options?: Readonly<UnpackOptions>): AsyncGenerator<Member, void, undefined> {
  const { inner } = archive;
  for await (const member of selectMembers(asSource(input), archive, options)) {
    if (inner === undefined) {
      yield member;
      continue;
    }
    const inside = (error: unknown): ArchiveError => new ArchiveError(`member ${member.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    if (inner.kind === "xlsx") {
      const wanted = inner.sheets === undefined ? undefined : new RegExp(`^(?:${inner.sheets})$`, "u");
      let names: string[];
      try {
        names = sheetNames(member.bytes).filter((sheet) => wanted === undefined || wanted.test(sheet));
      } catch (error) {
        throw inside(error);
      }
      if (names.length === 0) {
        throw new ArchiveError(`member ${member.path} has no sheet matching ${inner.sheets ?? ""}`);
      }
      yield* names.map((sheet) => ({ path: `${member.path}/${sheet}`, bytes: sheetToCsv(member.bytes, { kind: "xlsx", sheet }) }));
      continue;
    }
    try {
      for await (const file of unpackMembers(member.bytes, { kind: inner.kind, members: inner.members })) {
        yield { path: `${member.path}/${file.path}`, bytes: file.bytes };
      }
    } catch (error) {
      throw inside(error);
    }
  }
}

/**
 * Unpacks every member a collection's selector matches, one at a time.
 * @param source - The archive.
 * @param archive - The recipe's archive layout.
 * @param options - The platform's 7z reader and xz decoder and the abort signal, each needed only by an archive of its own kind.
 * @returns Each matching member, in path order.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector matches no member, at the first member taken.
 */
async function* selectMembers(source: Readonly<SourceBytes>, archive: CollectionArchive, options: Readonly<UnpackOptions> | undefined): AsyncGenerator<Member, void, undefined> {
  yield* readMembers(
    source,
    archive.kind,
    { candidate: (path) => selects(path, archive.members), choose: (paths) => pickAll(paths, archive.members).map((path) => ({ path })) },
    options,
  );
}

/** One named part of a document read from several files: the name the recipe gives it, and the file. */
export interface Part extends Member {
  readonly name: string;
}

/**
 * Unpacks a source into the files a parts archive names, each the one member its selector matches.
 * @param input - The downloaded bytes, held in memory or kept anywhere.
 * @param archive - The recipe's archive layout, which names its parts.
 * @param options - The platform's 7z reader and xz decoder and the abort signal, each needed only by an archive of its own kind.
 * @returns Each part, in the order the recipe names them.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or a part's selector does not match exactly one member.
 */
export async function unpackParts(input: Uint8Array | Readonly<SourceBytes>, archive: PartsArchive, options?: Readonly<UnpackOptions>): Promise<Part[]> {
  return collect(
    readMembers(
      asSource(input),
      archive.kind,
      { candidate: (path) => archive.parts.some((part) => selects(path, part.member)), choose: (paths) => archive.parts.map((part) => ({ name: part.name, path: pick(paths, part.member) })) },
      options,
    ),
  );
}

/** How a reader of a file archive chooses its members: which member paths the choice may take, known before the archive's paths are (a tar archive is read once, keeping what may be chosen), and, given every path, the members to read in the order wanted. */
interface Selection<Choice extends { readonly path: string }> {
  readonly candidate: (path: string) => boolean;
  readonly choose: (paths: readonly string[]) => readonly Choice[];
}

/**
 * Reads the members of a file archive that a choice makes from its member paths, one at a time. A zip is listed from its central directory and each chosen member read and inflated only when it is reached. A tar archive is read once, as it arrives: its member paths are known only at its end, so the data of every member `candidate` accepts is kept on the way, which must include every member the choice can make. A 7z archive is listed from its headers and decoded once by the platform's 7z reader, which keeps the chosen members.
 * @param source - The archive.
 * @param kind - The archive kind.
 * @param selection - What the choice is made by: `candidate`, given a member path, whether the choice may take it, and `choose`, given every member path, the members to read, in the order wanted, each naming its path.
 * @param options - The platform's 7z reader and xz decoder and the abort signal, each needed only by an archive of its own kind.
 * @returns Each choice with the bytes of the member it names, in the order chosen.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or a chosen member cannot be read; whatever `choose` throws.
 */
async function* readMembers<Choice extends { readonly path: string }>(
  source: Readonly<SourceBytes>,
  kind: CollectionArchive["kind"],
  selection: Readonly<Selection<Choice>>,
  options: Readonly<UnpackOptions> | undefined,
): AsyncGenerator<Choice & { readonly bytes: Uint8Array }, void, undefined> {
  const { candidate, choose } = selection;
  if (kind === "7z") {
    yield* readSevenZip(source, choose, options);

    return;
  }
  if (kind === "zip") {
    const entries = await zipEntries(source);
    yield* inTurn(choose(entries.map((entry) => entry.name)), async (choice) => {
      // The last entry of a name, as an archive tool that extracts every entry in order leaves it.
      const entry = entries.findLast((candidateEntry) => candidateEntry.name === choice.path);
      if (entry === undefined) {
        throw new ArchiveError(`zip member ${choice.path} could not be read`);
      }

      return { ...choice, bytes: await readZip(source, entry) };
    });

    return;
  }
  const { paths, members } = await scanTar(tarChunks(source.chunks(), kind, options), candidate);
  for (const choice of choose(paths)) {
    const found = members.find((member) => member.path === choice.path);
    if (found === undefined) {
      throw new ArchiveError(`tar member ${choice.path} could not be read`);
    }
    yield { ...choice, bytes: found.data };
  }
}

/** What a 7z reader has extracted of an archive: the bytes of each member it was asked for, read one at a time, and the means to let them go. */
export interface ExtractedMembers {
  /**
   * The bytes of one member extracted.
   * @param path - A member path the extraction was asked for.
   * @returns Its bytes, a fresh array the reader may keep.
   * @throws ArchiveError when the extraction was not asked for the path.
   */
  readonly read: (path: string) => Promise<Uint8Array>;
  /** Lets the extracted members go: whatever holds them is deleted, and nothing more may be read. */
  readonly close: () => Promise<void>;
}

/** The 7z port: reads the members of a 7z archive. A solid 7z archive compresses its members as one stream, so a member is reached only by decoding every member before it in its block; a reader therefore decodes the archive once for every member asked of it, and keeps only those members. It is a port because the decoder is the platform's to give: Node's (`keepset/node`) is 7-Zip itself, and a platform that gives none reads no 7z archive. */
export interface SevenZipPort {
  /**
   * Lists the archive's member paths from its headers, without decoding any member.
   * @param source - The archive.
   * @param signal - Aborts the listing.
   * @returns Every member that is a file (no directory), with `/` between its path segments, in the archive's order.
   * @throws ArchiveError when the bytes are not a readable 7z archive; the signal's reason when it aborts.
   */
  readonly list: (source: Readonly<SourceBytes>, signal?: AbortSignal) => Promise<readonly string[]>;
  /**
   * Decodes the archive once, keeping the members asked for and no other.
   * @param source - The archive.
   * @param paths - Member paths `list` gave, each once.
   * @param signal - Aborts the extraction.
   * @returns The members extracted, to read one at a time and then close.
   * @throws ArchiveError when the archive is truncated or corrupt, or a member cannot be decoded; the signal's reason when it aborts.
   */
  readonly extract: (source: Readonly<SourceBytes>, paths: readonly string[], signal?: AbortSignal) => Promise<ExtractedMembers>;
}

/** A decoder of xz compressed data, given the compressed bytes as chunks, in order, and giving the decompressed bytes as chunks, in order, without holding either whole. It is a port because the decoder is WebAssembly that only the Node entry point carries; where none is supplied, a recipe whose archive is xz compressed fails at its extract step with an error that says so. */
export type XzPort = (compressed: Readonly<AsyncIterable<Uint8Array>>) => AsyncIterable<Uint8Array>;

/** What unpacking may be given beside the archive: the platform's 7z reader, without which a 7z archive is refused, its xz decoder, without which an xz compressed archive is refused, and an abort signal for a reader that runs long. */
export interface UnpackOptions {
  readonly sevenZip?: SevenZipPort;
  readonly xz?: XzPort;
  readonly signal?: AbortSignal;
}

/**
 * Reads the members of a 7z archive that a choice makes from its member paths, through the platform's 7z reader: listed from the headers, decoded once for every member chosen, and each given in the order chosen, read from where the reader keeps it only when it is reached.
 * @param source - The archive.
 * @param choose - Given every member path, the members to read, in the order wanted, each naming its path.
 * @param options - The platform's 7z reader and the abort signal.
 * @returns Each choice with the bytes of the member it names, in the order chosen.
 * @throws ArchiveError when no 7z reader is given, or when the reader reports the archive unreadable; whatever `choose` throws.
 */
async function* readSevenZip<Choice extends { readonly path: string }>(
  source: Readonly<SourceBytes>,
  choose: (paths: readonly string[]) => readonly Choice[],
  options: Readonly<UnpackOptions> | undefined,
): AsyncGenerator<Choice & { readonly bytes: Uint8Array }, void, undefined> {
  const reader = options?.sevenZip;
  if (reader === undefined) {
    throw new ArchiveError("a 7z archive is read only where the platform gives a 7z reader, as keepset/node does; this one gives none");
  }
  const { signal } = options ?? {};
  const choices = choose(await reader.list(source, signal));
  const extracted = await reader.extract(source, [...new Set(choices.map((choice) => choice.path))], signal);
  try {
    yield* inTurn(choices, async (choice) => ({ ...choice, bytes: await extracted.read(choice.path) }));
  } finally {
    await extracted.close();
  }
}

/**
 * Collects what an async generator yields.
 * @param items - The generator.
 * @returns Every item, in order.
 */
async function collect<Item>(items: Readonly<AsyncIterable<Item>>): Promise<Item[]> {
  const collected: Item[] = [];
  for await (const item of items) {
    collected.push(item);
  }

  return collected;
}

/**
 * Reads one sheet of a spreadsheet as CSV text, by the spreadsheet's format.
 * @param bytes - The spreadsheet.
 * @param archive - Its format and the sheet to read.
 * @returns The CSV, in UTF-8.
 * @throws ArchiveError when the bytes are not a spreadsheet of that format, the sheet is missing, or a cell cannot be read.
 */
export function sheetToCsv(bytes: Uint8Array, archive: Readonly<SheetArchive>): Uint8Array {
  const read = { xlsx: xlsxGrid, xls: xlsGrid, ods: odsGrid }[archive.kind];

  return gridToCsv(read(bytes, archive.sheet));
}

/**
 * Unpacks a source into every file a multi-file format's selector matches, gunzipping each when the layout's `inner` is `gzip` and, when it is an archive kind with its own selector, unpacking each matched member into the files that selector matches. The paths stay the archive's own, so a gunzipped `edge.csv.gz` keeps its name, and a file of an inner archive is filed under its member's path and its own joined by `/`.
 * @param input - The downloaded bytes, held in memory or kept anywhere.
 * @param archive - The recipe's archive layout, which selects files with `files`.
 * @param options - The platform's 7z reader and xz decoder and the abort signal, each needed only by an archive of its own kind.
 * @returns Each matching file, in path order (the outer members in path order, and the files of each in path order).
 * @throws ArchiveError when the bytes, or a member `inner` reads, are not well-formed, or a selector matches no member.
 */
export async function unpackFiles(input: Uint8Array | Readonly<SourceBytes>, archive: FilesArchive, options?: Readonly<UnpackOptions>): Promise<Member[]> {
  const files = await collect(unpackMembers(input, { kind: archive.kind, members: archive.files }, options));
  const { inner } = archive;
  if (inner === undefined) {
    return files;
  }
  const inside = async <Result>(file: Member, read: () => Result | Promise<Result>): Promise<Result> => {
    try {
      return await read();
    } catch (error) {
      throw new ArchiveError(`member ${file.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  if (inner.kind === "gzip") {
    return Promise.all(files.map(async (file) => ({ path: file.path, bytes: await inside(file, () => gunzip(file.bytes)) })));
  }
  // Each outer member's bytes are already held, so its inner archive is read from them in memory, one member after another.
  const unpacked = await collect(
    inTurn(files, async (file) => {
      const members = await inside(file, async () => collect(unpackMembers(file.bytes, { kind: inner.kind, members: inner.files }, options)));

      return members.map((member) => ({ path: `${file.path}/${member.path}`, bytes: member.bytes }));
    }),
  );

  return unpacked.flat();
}

/** A member of a files archive that `streamFiles` has reached: its path, and its bytes either as they are read (a zip member inflated a feed at a time) or whole. */
interface Reached {
  readonly path: string;
  readonly chunks: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  readonly bytes: () => Promise<Uint8Array>;
}

/**
 * Hands on every file a tar archive holds that a selector matches, each as soon as its data is complete, and fails once the archive has been read when none matched.
 * @param chunks - The tar's bytes, which may be compressed.
 * @param kind - The tar kind.
 * @param files - The selector.
 * @param options - The platform's xz decoder, which only a `tar.xz` archive needs.
 * @returns Each matching file, in the order the archive holds them.
 * @throws ArchiveError when the bytes are not a well-formed archive of the kind, no xz decoder is given for a `tar.xz`, or the selector matches no member, listing the members.
 */
async function* streamTarFiles(chunks: Readonly<AsyncIterable<Uint8Array> | Iterable<Uint8Array>>, kind: "tar" | "tar.gz" | "tar.bz2" | "tar.xz", files: ArchiveMember, options: Readonly<UnpackOptions> | undefined): AsyncGenerator<Member, void, undefined> {
  const scanner = new TarScanner((path) => selects(path, files));
  const asMember = (member: Readonly<TarMember>): Member => ({ path: member.path, bytes: member.data });
  let matched = 0;
  for await (const chunk of tarChunks(chunks, kind, options)) {
    scanner.push(chunk);
    const completed = scanner.take();
    matched += completed.length;
    yield* completed.map(asMember);
  }
  scanner.end();
  const last = scanner.take();
  matched += last.length;
  yield* last.map(asMember);
  if (matched === 0) {
    pickAll(scanner.paths, files);
  }
}

/**
 * A failure reading within a member, naming the member as `unpackFiles` names it.
 * @param path - The member's path.
 * @param error - The failure.
 * @returns The archive error.
 */
function failedWithin(path: string, error: unknown): ArchiveError {
  return new ArchiveError(`member ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

/**
 * Passes on the files read from within one member, naming the member in any failure, as `unpackFiles` names it.
 * @param path - The member's path.
 * @param files - The files read from it.
 * @returns The same files.
 */
async function* within(path: string, files: Readonly<AsyncIterable<Member>>): AsyncGenerator<Member, void, undefined> {
  try {
    yield* files;
  } catch (error) {
    throw failedWithin(path, error);
  }
}

/**
 * The members of a files archive its outer selector matches, as `streamFiles` reaches them: a zip's in path order, each read only when it is reached, and a tar's in archive order as the scan completes each.
 * @param source - The archive.
 * @param archive - Its layout.
 * @param options - The platform's xz decoder, which only a `tar.xz` archive needs.
 * @returns Each matching member.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector matches no member.
 */
async function* reachMembers(source: Readonly<SourceBytes>, archive: FilesArchive, options: Readonly<UnpackOptions> | undefined): AsyncGenerator<Reached, void, undefined> {
  if (archive.kind === "7z") {
    throw new ArchiveError("a 7z archive is read from the file the store kept and cannot be streamed a file at a time");
  }
  if (archive.kind !== "zip") {
    for await (const member of streamTarFiles(source.chunks(), archive.kind, archive.files, options)) {
      yield { path: member.path, chunks: () => [member.bytes], bytes: async () => Promise.resolve(member.bytes) };
    }

    return;
  }
  const entries = await zipEntries(source);
  for (const path of pickAll(
    entries.map((entry) => entry.name),
    archive.files,
  )) {
    // The last entry of a name, as an archive tool that extracts every entry in order leaves it.
    const entry = entries.findLast((candidate) => candidate.name === path);
    if (entry === undefined) {
      throw new ArchiveError(`zip member ${path} could not be read`);
    }
    yield { path, chunks: () => readZipEntryChunks(source, entry), bytes: async () => readZip(source, entry) };
  }
}

/**
 * Unpacks a source into every file a multi-file format's selector matches, as `unpackFiles` does, but hands each file on as soon as it is read rather than collecting them, so a reader that lets each file go before taking the next reads an archive of any size in the memory of one file. A zip's members are taken in path order and read one at a time, and a member that is a tar archive in its turn (a tar zipped whole) is inflated and scanned as it is read, never held whole; a tar archive is scanned once as it arrives. The files of a tar are therefore handed on in the order the tar holds them, not in path order, since sorting them would mean holding them all. A member that is a gzip file or a zip in its turn is held whole, being one file, or an archive whose directory is at its end.
 * @param input - The downloaded bytes, held in memory or kept anywhere.
 * @param archive - The recipe's archive layout, which selects files with `files`.
 * @param options - The platform's xz decoder, which only a `tar.xz` archive needs.
 * @returns Each matching file, filed as `unpackFiles` files it.
 * @throws ArchiveError when the bytes, or a member `inner` reads, are not well-formed, or a selector matches no member (for a tar, once it has been read to its end), after the files before the fault.
 */
export async function* streamFiles(input: Uint8Array | Readonly<SourceBytes>, archive: FilesArchive, options?: Readonly<UnpackOptions>): AsyncGenerator<Member, void, undefined> {
  const { inner } = archive;
  for await (const member of reachMembers(asSource(input), archive, options)) {
    if (inner === undefined) {
      yield { path: member.path, bytes: await member.bytes() };
      continue;
    }
    if (inner.kind === "gzip") {
      const compressed = await member.bytes();
      let bytes: Uint8Array;
      try {
        bytes = gunzip(compressed);
      } catch (error) {
        throw failedWithin(member.path, error);
      }
      yield { path: member.path, bytes };
      continue;
    }
    if (inner.kind === "7z") {
      throw new ArchiveError(`member ${member.path}: a 7z archive inside an archive cannot be streamed a file at a time`);
    }
    const files = inner.kind === "zip" ? unpackMembers(await member.bytes(), { kind: "zip", members: inner.files }) : streamTarFiles(member.chunks(), inner.kind, inner.files, options);
    for await (const file of within(member.path, files)) {
      yield { path: `${member.path}/${file.path}`, bytes: file.bytes };
    }
  }
}

/** The byte of the line feed that ends a line. */
const LINE_FEED = 0x0a;

/**
 * Joins the files a files archive selected into the one file a parser that reads one file takes: each file's bytes in the order given, with a line feed after a file that does not end with one, so a file's last line never runs into the next file's first. A file with no bytes adds nothing.
 * @param files - The files, in path order.
 * @returns The bytes of the joined file.
 */
export function concatenateFiles(files: readonly Member[]): Uint8Array {
  const needsBreak = (file: Member): boolean => file.bytes.length > 0 && file.bytes[file.bytes.length - 1] !== LINE_FEED;
  const joined = new Uint8Array(files.reduce((total, file) => total + file.bytes.length + (needsBreak(file) ? 1 : 0), 0));
  let offset = 0;
  for (const file of files) {
    joined.set(file.bytes, offset);
    offset += file.bytes.length;
    if (needsBreak(file)) {
      joined[offset] = LINE_FEED;
      offset += 1;
    }
  }

  return joined;
}

/**
 * Gives chunks held in memory or arriving as a stream as the stream a decoder port reads.
 * @param chunks - The chunks, in order.
 * @returns The same chunks, as an async iterable.
 */
async function* asyncChunks(chunks: Readonly<AsyncIterable<Uint8Array> | Iterable<Uint8Array>>): AsyncGenerator<Uint8Array, void, undefined> {
  yield* chunks;
}

/**
 * The xz decoder a recipe needs.
 * @param options - What the reader was given.
 * @returns The decoder.
 * @throws ArchiveError when none was given, as in a browser, which does not bundle the WebAssembly decoder.
 */
function xzOf(options: Readonly<UnpackOptions> | undefined): XzPort {
  if (options?.xz === undefined) {
    throw new ArchiveError("this archive is xz compressed, and no xz decoder is available here: the Node entry point (keepset/node) carries one, and the browser entry point does not read xz");
  }

  return options.xz;
}

/**
 * Decompresses xz data, whole, as the document kinds read a compressed file.
 * @param source - The compressed file.
 * @param options - What the reader was given.
 * @returns The decompressed bytes.
 * @throws ArchiveError when no decoder is available or the data is not valid xz.
 */
async function unxzWhole(source: Readonly<SourceBytes>, options: Readonly<UnpackOptions> | undefined): Promise<Uint8Array> {
  const pieces = await collect(xzOf(options)(source.chunks()));
  const whole = new Uint8Array(pieces.reduce((total, piece) => total + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    whole.set(piece, offset);
    offset += piece.length;
  }

  return whole;
}

/** How many compressed bytes are fed to the gzip stream at a time. Everything a feed decompresses to is collected before any of it is yielded, so what is held of the decompressed archive at once is the feed times the data's compression ratio; a mebibyte keeps the stream's per-call cost small and that output a few mebibytes for the text and media archives recipes read. */
const KIBIBYTE = 1024;
const GZIP_FEED_BYTES = KIBIBYTE * KIBIBYTE;

/**
 * The bytes of a tar archive, which may be compressed, as chunks, decompressed as the archive's chunks arrive, so neither the compressed nor the decompressed archive is ever held whole: `tar.gz` is gunzipped a feed at a time, `tar.bz2` a bzip2 block at a time and `tar.xz` as the xz decoder gives it, and `tar` is yielded as it arrives.
 * @param chunks - The archive's bytes, in order: a source's chunks, or a member's as it is inflated.
 * @param kind - The archive kind.
 * @param options - The platform's xz decoder, which only a `tar.xz` archive needs.
 * @returns The tar's bytes, in order, cut anywhere.
 * @throws ArchiveError when the bytes are not valid gzip, bzip2 or xz data, as `GunzipStream`, `Bunzip2Stream` and the xz decoder report: a corrupted or truncated compressed archive fails once its fault is reached, after the bytes before it; or when `tar.xz` is read with no xz decoder.
 */
async function* tarChunks(chunks: Readonly<AsyncIterable<Uint8Array> | Iterable<Uint8Array>>, kind: "tar" | "tar.gz" | "tar.bz2" | "tar.xz", options: Readonly<UnpackOptions> | undefined): AsyncGenerator<Uint8Array, void, undefined> {
  if (kind === "tar") {
    yield* chunks;

    return;
  }
  if (kind === "tar.xz") {
    yield* xzOf(options)(asyncChunks(chunks));

    return;
  }
  const produced: Uint8Array[] = [];
  if (kind === "tar.bz2") {
    const stream = new Bunzip2Stream((chunk) => {
      produced.push(chunk);
    });
    for await (const chunk of chunks) {
      stream.push(chunk);
      yield* produced.splice(0);
    }
    stream.end();
    yield* produced.splice(0);

    return;
  }
  const stream = new GunzipStream((chunk) => {
    produced.push(chunk);
  });
  for await (const chunk of chunks) {
    for (let start = 0; start < chunk.length; start += GZIP_FEED_BYTES) {
      stream.push(chunk.subarray(start, start + GZIP_FEED_BYTES));
      yield* produced.splice(0);
    }
  }
  stream.end();
}

/**
 * Runs a zip reader's step, rethrowing a failure that is not already the package's as one.
 * @param run - The step.
 * @returns What it returns.
 */
async function zipStep<Result>(run: () => Promise<Result>): Promise<Result> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw error;
    }
    throw new ArchiveError(`not valid zip data: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/**
 * Lists a zip's central directory in the package's taxonomy.
 * @param source - The zip.
 * @returns Its entries.
 */
async function zipEntries(source: Readonly<SourceBytes>): Promise<ZipEntry[]> {
  return zipStep(async () => listZip(source));
}

/**
 * Reads one zip entry in the package's taxonomy.
 * @param source - The zip.
 * @param entry - The entry.
 * @returns Its bytes.
 */
async function readZip(source: Readonly<SourceBytes>, entry: Readonly<ZipEntry>): Promise<Uint8Array> {
  return zipStep(async () => readZipEntry(source, entry));
}

/**
 * Unzips the entries a filter accepts in the package's taxonomy.
 * @param source - The zip.
 * @param filter - Which entries to inflate.
 * @returns The inflated entries, by name.
 */
async function unzip(source: Readonly<SourceBytes>, filter: (entry: Readonly<ZipEntryInfo>) => boolean): Promise<Readonly<Record<string, Uint8Array>>> {
  return zipStep(async () => unzipEntries(source, filter));
}
