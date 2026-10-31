import { Gunzip, gunzipSync } from "fflate";
import type { CollectionArchive, DocumentArchive, ArchiveMember, FilesArchive, InnerArchive, PartsArchive, SheetArchive } from "./entry";
import { ArchiveError } from "./errors";
import { getOwn } from "./own";
import { bunzip2 } from "./node/bzip2";
import { pointShapefileToCsv } from "./node/shapefile";
import { scanTar } from "./node/tar";
import { unzipEntries, type ZipEntryInfo } from "./node/zip";
import { odsGrid } from "./node/ods";
import { gridToCsv } from "./node/sheet";
import { xlsGrid } from "./node/xls";
import { sheetNames, xlsxGrid } from "./node/xlsx";

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
 * Unpacks downloaded bytes into the one file the parser reads. A member with an `inner` archive is unpacked again by that layout, and the path reported is the outer member's, joined by `/` to the inner member's or the inner sheet's name when the inner layout selects one, as though the inner archive were a directory.
 * @param bytes - The downloaded bytes.
 * @param archive - The recipe's archive layout.
 * @returns The file's bytes, and its member path for a multi-file archive.
 * @throws ArchiveError when the bytes, or a member's bytes that an `inner` layout reads, are not a well-formed archive of the stated kind or a selector does not match exactly one member.
 */
export function unpack(bytes: Uint8Array, archive: DocumentArchive): Unpacked {
  if (archive.kind === "none") {
    return { bytes };
  }
  if (archive.kind === "gzip") {
    return { bytes: gunzip(bytes) };
  }
  if (archive.kind === "bzip2") {
    return { bytes: bunzip2(bytes) };
  }
  if ("sheet" in archive) {
    return { bytes: sheetToCsv(bytes, archive), member: archive.sheet };
  }
  if (archive.kind === "shapefile") {
    return unpackShapefile(bytes, archive.member);
  }
  const outer = selectMember(bytes, archive);
  if (archive.inner === undefined) {
    return outer;
  }
  if (archive.inner.kind === "gzip") {
    return { bytes: gunzip(outer.bytes), member: outer.member };
  }
  if ("sheet" in archive.inner) {
    return { bytes: sheetToCsv(outer.bytes, archive.inner), member: `${outer.member}/${archive.inner.sheet}` };
  }
  const inner = selectMember(outer.bytes, archive.inner);

  return { bytes: inner.bytes, member: `${outer.member}/${inner.member}` };
}

/**
 * Unpacks the one member a file archive's selector matches.
 * @param bytes - The archive's bytes.
 * @param archive - A file archive layout and its selector.
 * @returns The member's bytes and path.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector does not match exactly one member.
 */
function selectMember(bytes: Uint8Array, archive: Extract<InnerArchive, { readonly member: ArchiveMember }>): { readonly bytes: Uint8Array; readonly member: string } {
  if (archive.kind === "zip") {
    const names: string[] = [];
    // The filter sees every entry's name before inflating, so listing the names decompresses nothing and only the chosen member is ever inflated.
    unzip(bytes, (file) => {
      names.push(file.name);

      return false;
    });
    const path = pick(names, archive.member);
    const file = getOwn(
      unzip(bytes, (candidate) => candidate.name === path),
      path,
    );
    if (file === undefined) {
      throw new ArchiveError(`zip member ${path} could not be read`);
    }

    return { bytes: file, member: path };
  }
  const path = pick(scanTar(tarChunks(bytes, archive.kind), () => false).paths, archive.member);
  const found = scanTar(tarChunks(bytes, archive.kind), (candidate) => candidate === path).members.find((member) => member.path === path);
  if (found === undefined) {
    throw new ArchiveError(`tar member ${path} could not be read`);
  }

  return { bytes: found.data, member: path };
}

/**
 * Unpacks a zipped point shapefile into the CSV its attribute table and positions make. The `.dbf`, `.prj` and `.cpg` are the members with the `.shp`'s path and their own extension, matched without case as GIS tools write extensions either way.
 * @param bytes - The zip's bytes.
 * @param member - The selector of the `.shp`.
 * @returns The CSV, and the `.shp`'s path as the member read.
 * @throws ArchiveError when the bytes are not a zip, the selector does not match exactly one `.shp`, a part beside it is missing or there is more than one of it, or the shapefile cannot be read.
 */
function unpackShapefile(bytes: Uint8Array, member: ArchiveMember): Unpacked {
  const names: string[] = [];
  unzip(bytes, (file) => {
    names.push(file.name);

    return false;
  });
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
  const files = unzip(bytes, (candidate) => wanted.has(candidate.name));
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
 * Unpacks downloaded bytes into every file a collection's selector matches, or, with an `xlsx` inner layout, into every sheet of every matched workbook that its `sheets` pattern matches as the sheet's CSV, at the member's path and the sheet's name joined by `/`, members in path order and sheets in the workbook's order. The files are given one at a time: a zip member is inflated only when it is reached, so a reader that lets each file go before taking the next holds one member's bytes beside the archive, never every member at once.
 * @param bytes - The downloaded bytes.
 * @param archive - The recipe's archive layout, which selects members with `members`.
 * @returns Each file.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind, the selector matches no member (at the first file taken), or a member an `xlsx` layout reads is not a workbook or has no sheet the pattern matches (at that member).
 */
export function* unpackMembers(bytes: Uint8Array, archive: CollectionArchive): Generator<Member, void, undefined> {
  const { sheets } = archive.inner ?? {};
  const wanted = sheets === undefined ? undefined : new RegExp(`^(?:${sheets})$`, "u");
  for (const member of selectMembers(bytes, archive)) {
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
 * @param bytes - The downloaded bytes.
 * @param archive - The recipe's archive layout.
 * @returns Each matching member, in path order.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or the selector matches no member, at the first member taken.
 */
function* selectMembers(bytes: Uint8Array, archive: CollectionArchive): Generator<Member, void, undefined> {
  yield* readMembers(bytes, archive.kind, (paths) => pickAll(paths, archive.members).map((path) => ({ path })));
}

/** One named part of a document read from several files: the name the recipe gives it, and the file. */
export interface Part extends Member {
  readonly name: string;
}

/**
 * Unpacks downloaded bytes into the files a parts archive names, each the one member its selector matches.
 * @param bytes - The downloaded bytes.
 * @param archive - The recipe's archive layout, which names its parts.
 * @returns Each part, in the order the recipe names them.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or a part's selector does not match exactly one member.
 */
export function unpackParts(bytes: Uint8Array, archive: PartsArchive): Part[] {
  return [...readMembers(bytes, archive.kind, (paths) => archive.parts.map((part) => ({ name: part.name, path: pick(paths, part.member) })))];
}

/**
 * Reads the members of a file archive that a choice makes from its member paths, one at a time: the archive is listed once and a zip member is inflated only when it is reached, so a reader that lets each member go before taking the next holds one member's bytes beside the archive.
 * @param bytes - The archive's bytes.
 * @param kind - The archive kind.
 * @param choose - Given every member path, the members to read, in the order wanted, each naming its path.
 * @returns Each choice with the bytes of the member it names, in the order chosen.
 * @throws ArchiveError when the bytes are not a well-formed archive of the stated kind or a chosen member cannot be read; whatever `choose` throws.
 */
function* readMembers<Choice extends { readonly path: string }>(bytes: Uint8Array, kind: CollectionArchive["kind"], choose: (paths: readonly string[]) => readonly Choice[]): Generator<Choice & { readonly bytes: Uint8Array }, void, undefined> {
  if (kind === "zip") {
    const names: string[] = [];
    // The filter sees every entry's name before inflating, so listing the names decompresses nothing.
    unzip(bytes, (file) => {
      names.push(file.name);

      return false;
    });
    for (const choice of choose(names)) {
      const file = getOwn(
        unzip(bytes, (candidate) => candidate.name === choice.path),
        choice.path,
      );
      if (file === undefined) {
        throw new ArchiveError(`zip member ${choice.path} could not be read`);
      }
      yield { ...choice, bytes: file };
    }

    return;
  }
  const choices = choose(scanTar(tarChunks(bytes, kind), () => false).paths);
  const wanted = new Set(choices.map((choice) => choice.path));
  const { members } = scanTar(tarChunks(bytes, kind), (path) => wanted.has(path));
  for (const choice of choices) {
    const found = members.find((member) => member.path === choice.path);
    if (found === undefined) {
      throw new ArchiveError(`tar member ${choice.path} could not be read`);
    }
    yield { ...choice, bytes: found.data };
  }
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
 * Unpacks downloaded bytes into every file a multi-file format's selector matches, gunzipping each when the layout's `inner` is `gzip` and, when it is an archive kind with its own selector, unpacking each matched member into the files that selector matches. The paths stay the archive's own, so a gunzipped `edge.csv.gz` keeps its name, and a file of an inner archive is filed under its member's path and its own joined by `/`.
 * @param bytes - The downloaded bytes.
 * @param archive - The recipe's archive layout, which selects files with `files`.
 * @returns Each matching file, in path order (the outer members in path order, and the files of each in path order).
 * @throws ArchiveError when the bytes, or a member `inner` reads, are not well-formed, or a selector matches no member.
 */
export function unpackFiles(bytes: Uint8Array, archive: FilesArchive): Member[] {
  const files = [...unpackMembers(bytes, { kind: archive.kind, members: archive.files })];
  const { inner } = archive;
  if (inner === undefined) {
    return files;
  }
  const inside = <Result>(file: Member, read: () => Result): Result => {
    try {
      return read();
    } catch (error) {
      throw new ArchiveError(`member ${file.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  if (inner.kind === "gzip") {
    return files.map((file) => ({ path: file.path, bytes: inside(file, () => gunzip(file.bytes)) }));
  }

  return files.flatMap((file) => inside(file, () => [...unpackMembers(file.bytes, { kind: inner.kind, members: inner.files })]).map((member) => ({ path: `${file.path}/${member.path}`, bytes: member.bytes })));
}

/** How many compressed bytes are fed to the gzip stream at a time: enough to keep the stream's per-call cost small, few enough that the decompressed bytes it yields stay a bounded multiple of it. */
const KIBIBYTE = 1024;
const GZIP_FEED_BYTES = KIBIBYTE * KIBIBYTE;

/**
 * The bytes of a tar archive, which may be compressed, as chunks: `tar.gz` is gunzipped a slice at a time and `tar.bz2` bunzipped whole, so a `tar.gz` is never held decompressed in full, and `tar` is yielded as it is.
 * @param bytes - The archive's bytes.
 * @param kind - The archive kind.
 * @returns The tar's bytes, in order, cut anywhere.
 * @throws ArchiveError when the bytes are not valid gzip or bzip2 data, as `gunzip` and `bunzip2` report.
 */
function* tarChunks(bytes: Uint8Array, kind: "tar" | "tar.gz" | "tar.bz2"): Generator<Uint8Array, void, undefined> {
  if (kind === "tar") {
    yield bytes;

    return;
  }
  if (kind === "tar.bz2") {
    yield bunzip2(bytes);

    return;
  }
  const produced: Uint8Array[] = [];
  let emitted = 0;
  const stream = new Gunzip((chunk) => {
    produced.push(chunk);
    emitted += chunk.length;
  });
  for (let start = 0; start < Math.max(bytes.length, 1); start += GZIP_FEED_BYTES) {
    try {
      stream.push(bytes.subarray(start, start + GZIP_FEED_BYTES), start + GZIP_FEED_BYTES >= bytes.length);
    } catch (error) {
      // A tar.gz written by tar ends its first gzip member and may then carry padding that is not another member; the stream rejects it only after the whole member is out. What it emitted is all the archive holds, and the tar reader checks that it is a whole archive, so a stream that failed before emitting anything is the only one that is not gzip data.
      if (emitted === 0) {
        throw new ArchiveError(`not valid gzip data: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      yield* produced.splice(0);

      return;
    }
    yield* produced.splice(0);
  }
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
 * Unzips the entries a filter accepts, rethrowing the reader's failure in the package's taxonomy.
 * @param bytes - Zip data.
 * @param filter - Which entries to inflate.
 * @returns The inflated entries, by name.
 */
function unzip(bytes: Uint8Array, filter: (entry: ZipEntryInfo) => boolean): Readonly<Record<string, Uint8Array>> {
  try {
    return unzipEntries(bytes, filter);
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw error;
    }
    throw new ArchiveError(`not valid zip data: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
