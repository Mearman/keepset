import { Gunzip, gunzipSync } from "fflate";
import type { Archive, CollectionArchive, DocumentArchive, ArchiveMember, FilesArchive, InnerArchive, PartsArchive, SheetArchive } from "./entry";
import { ArchiveError } from "./errors";
import { getOwn } from "./own";
import { bunzip2, Bunzip2Stream } from "./node/bzip2";
import { pointShapefileToCsv } from "./node/shapefile";
import { scanTar } from "./node/tar";
import { listZip, readZipEntry, unzipEntries, type ZipEntry, type ZipEntryInfo } from "./node/zip";
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
 * Unpacks a source into the one file the parser reads. A member with an `inner` archive is unpacked again by that layout, and the path reported is the outer member's, joined by `/` to the inner member's or the inner sheet's name when the inner layout selects one, as though the inner archive were a directory. A tar archive is read as it arrives and a zip by the ranges its directory names, so only the selected member is ever held; a plain or compressed file and a workbook are read whole, as their parsers read them.
 * @param input - The downloaded bytes, held in memory or kept anywhere.
 * @param archive - The recipe's archive layout.
 * @returns The file's bytes, and its member path for a multi-file archive.
 * @throws ArchiveError when the bytes, or a member's bytes that an `inner` layout reads, are not a well-formed archive of the stated kind or a selector does not match exactly one member.
 */
export async function unpack(input: Uint8Array | Readonly<SourceBytes>, archive: DocumentArchive): Promise<Unpacked> {
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
  if ("sheet" in archive) {
    return { bytes: sheetToCsv(await source.bytes(), archive), member: archive.sheet };
  }
  if (archive.kind === "shapefile") {
    return unpackShapefile(source, archive.member);
  }
  const outer = await selectMember(source, archive);
  if (archive.inner === undefined) {
    return outer;
  }
  if (archive.inner.kind === "gzip") {
    return { bytes: gunzip(outer.bytes), member: outer.member };
  }
  if ("sheet" in archive.inner) {
    return { bytes: sheetToCsv(outer.bytes, archive.inner), member: `${outer.member}/${archive.inner.sheet}` };
  }
  const inner = await selectMember(bytesSource(outer.bytes), archive.inner);

  return { bytes: inner.bytes, member: `${outer.member}/${inner.member}` };
}

/**
 * Unpacks the one member a file archive's selector matches.
 * @param source - The archive.
 * @param archive - A file archive layout and its selector.
 * @returns The member's bytes and path.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector does not match exactly one member.
 */
async function selectMember(source: Readonly<SourceBytes>, archive: Extract<InnerArchive, { readonly member: ArchiveMember }>): Promise<{ readonly bytes: Uint8Array; readonly member: string }> {
  const members = readMembers(
    source,
    archive.kind,
    (path) => selects(path, archive.member),
    (paths) => [{ path: pick(paths, archive.member) }],
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
 * Unpacks a source into every file a collection's selector matches, or, with an `xlsx` inner layout, into every sheet of every matched workbook that its `sheets` pattern matches as the sheet's CSV, at the member's path and the sheet's name joined by `/`, members in path order and sheets in the workbook's order. The files are given one at a time: a zip member is read and inflated only when it is reached, so a reader that lets each file go before taking the next holds one member's bytes, never every member at once; a tar archive is read once as it arrives, keeping the members the selector matches.
 * @param input - The downloaded bytes, held in memory or kept anywhere.
 * @param archive - The recipe's archive layout, which selects members with `members`.
 * @returns Each file.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind, the selector matches no member (at the first file taken), or a member an `xlsx` layout reads is not a workbook or has no sheet the pattern matches (at that member).
 */
export async function* unpackMembers(input: Uint8Array | Readonly<SourceBytes>, archive: CollectionArchive): AsyncGenerator<Member, void, undefined> {
  const { sheets } = archive.inner ?? {};
  const wanted = sheets === undefined ? undefined : new RegExp(`^(?:${sheets})$`, "u");
  for await (const member of selectMembers(asSource(input), archive)) {
    if (archive.inner === undefined) {
      yield member;
      continue;
    }
    let names: string[];
    try {
      names = sheetNames(member.bytes).filter((sheet) => wanted === undefined || wanted.test(sheet));
    } catch (error) {
      throw new ArchiveError(`member ${member.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    if (names.length === 0) {
      throw new ArchiveError(`member ${member.path} has no sheet matching ${sheets ?? ""}`);
    }
    yield* names.map((sheet) => ({ path: `${member.path}/${sheet}`, bytes: sheetToCsv(member.bytes, { kind: "xlsx", sheet }) }));
  }
}

/**
 * Unpacks every member a collection's selector matches, one at a time.
 * @param source - The archive.
 * @param archive - The recipe's archive layout.
 * @returns Each matching member, in path order.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector matches no member, at the first member taken.
 */
async function* selectMembers(source: Readonly<SourceBytes>, archive: CollectionArchive): AsyncGenerator<Member, void, undefined> {
  yield* readMembers(
    source,
    archive.kind,
    (path) => selects(path, archive.members),
    (paths) => pickAll(paths, archive.members).map((path) => ({ path })),
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
 * @returns Each part, in the order the recipe names them.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or a part's selector does not match exactly one member.
 */
export async function unpackParts(input: Uint8Array | Readonly<SourceBytes>, archive: PartsArchive): Promise<Part[]> {
  return collect(
    readMembers(
      asSource(input),
      archive.kind,
      (path) => archive.parts.some((part) => selects(path, part.member)),
      (paths) => archive.parts.map((part) => ({ name: part.name, path: pick(paths, part.member) })),
    ),
  );
}

/**
 * Reads the members of a file archive that a choice makes from its member paths, one at a time. A zip is listed from its central directory and each chosen member read and inflated only when it is reached. A tar archive is read once, as it arrives: its member paths are known only at its end, so the data of every member `candidate` accepts is kept on the way, which must include every member the choice can make.
 * @param source - The archive.
 * @param kind - The archive kind.
 * @param candidate - Given a member path, whether the choice may take it.
 * @param choose - Given every member path, the members to read, in the order wanted, each naming its path.
 * @returns Each choice with the bytes of the member it names, in the order chosen.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or a chosen member cannot be read; whatever `choose` throws.
 */
async function* readMembers<Choice extends { readonly path: string }>(
  source: Readonly<SourceBytes>,
  kind: CollectionArchive["kind"],
  candidate: (path: string) => boolean,
  choose: (paths: readonly string[]) => readonly Choice[],
): AsyncGenerator<Choice & { readonly bytes: Uint8Array }, void, undefined> {
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
  const { paths, members } = await scanTar(tarChunks(source, kind), candidate);
  for (const choice of choose(paths)) {
    const found = members.find((member) => member.path === choice.path);
    if (found === undefined) {
      throw new ArchiveError(`tar member ${choice.path} could not be read`);
    }
    yield { ...choice, bytes: found.data };
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
 * @returns Each matching file, in path order (the outer members in path order, and the files of each in path order).
 * @throws ArchiveError when the bytes, or a member `inner` reads, are not well-formed, or a selector matches no member.
 */
export async function unpackFiles(input: Uint8Array | Readonly<SourceBytes>, archive: FilesArchive): Promise<Member[]> {
  const files = await collect(unpackMembers(input, { kind: archive.kind, members: archive.files }));
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
      const members = await inside(file, async () => collect(unpackMembers(file.bytes, { kind: inner.kind, members: inner.files })));

      return members.map((member) => ({ path: `${file.path}/${member.path}`, bytes: member.bytes }));
    }),
  );

  return unpacked.flat();
}

/** How many compressed bytes are fed to the gzip stream at a time. The stream decompresses each feed into one array before it hands any of it on, so what a feed yields, which is what is held of the decompressed archive at once, is the feed times the data's compression ratio; a mebibyte keeps the stream's per-call cost small and that output a few mebibytes for the text and media archives recipes read. */
const KIBIBYTE = 1024;
const GZIP_FEED_BYTES = KIBIBYTE * KIBIBYTE;

/**
 * The bytes of a tar archive, which may be compressed, as chunks, decompressed as the source's chunks arrive, so neither the compressed nor the decompressed archive is ever held whole: `tar.gz` is gunzipped a feed at a time and `tar.bz2` a bzip2 block at a time, and `tar` is yielded as it arrives.
 * @param source - The archive.
 * @param kind - The archive kind.
 * @returns The tar's bytes, in order, cut anywhere.
 * @throws ArchiveError when the bytes are not valid gzip or bzip2 data, as `gunzip` and `bunzip2` report.
 */
async function* tarChunks(source: Readonly<SourceBytes>, kind: "tar" | "tar.gz" | "tar.bz2"): AsyncGenerator<Uint8Array, void, undefined> {
  if (kind === "tar") {
    yield* source.chunks();

    return;
  }
  const produced: Uint8Array[] = [];
  if (kind === "tar.bz2") {
    const stream = new Bunzip2Stream((chunk) => {
      produced.push(chunk);
    });
    for await (const chunk of source.chunks()) {
      stream.push(chunk);
      yield* produced.splice(0);
    }
    stream.end();
    yield* produced.splice(0);

    return;
  }
  let emitted = 0;
  const stream = new Gunzip((chunk) => {
    produced.push(chunk);
    emitted += chunk.length;
  });
  /**
   * Feeds the stream one piece.
   * @returns Whether the stream goes on: false once it has rejected what follows the archive.
   */
  const feed = (piece: Uint8Array, final: boolean): boolean => {
    try {
      stream.push(piece, final);

      return true;
    } catch (error) {
      // A tar.gz written by tar ends its first gzip member and may then carry padding that is not another member; the stream rejects it only after the whole member is out. What it emitted is all the archive holds, and the tar reader checks that it is a whole archive, so a stream that failed before emitting anything is the only one that is not gzip data.
      if (emitted === 0) {
        throw new ArchiveError(`not valid gzip data: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }

      return false;
    }
  };
  for await (const chunk of source.chunks()) {
    for (let start = 0; start < chunk.length; start += GZIP_FEED_BYTES) {
      const goesOn = feed(chunk.subarray(start, start + GZIP_FEED_BYTES), false);
      yield* produced.splice(0);
      if (!goesOn) {
        return;
      }
    }
  }
  // The source's end is known only once its chunks are done, so the stream is told with an empty last piece.
  feed(new Uint8Array(0), true);
  yield* produced.splice(0);
}

/**
 * Gunzips bytes, rethrowing zlib's failure in the package's taxonomy.
 * @param bytes - Gzip data.
 * @returns The decompressed bytes.
 */
function gunzip(bytes: Uint8Array): Uint8Array {
  try {
    return gunzipSync(bytes);
  } catch (error) {
    throw new ArchiveError(`not valid gzip data: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
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
