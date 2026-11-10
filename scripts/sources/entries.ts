/* The catalogue's entry files as the source scripts see them: every source URL grouped across the entries that record it, and the one edit the archiver makes, pinning a snapshot on a source that has none. */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Entry, parseEntry, type Snapshot, waybackUrl } from "../../src/entry";
import { serialise } from "../../src/serialise";

/** An entry and the file that holds it. */
export interface EntryFile {
  readonly path: string;
  readonly entry: Entry;
}

/**
 * Reads every entry file of a directory, in file name order. A file must already be in canonical form (the bytes `serialise` writes for its parsed value), which is what lets an edit made through `serialise` change nothing but the edit.
 * @param dir - The directory of `<id>.json` entry files.
 * @returns The entries with their paths.
 * @throws Error naming a file that is not in canonical form, and the schema's error for one that does not parse.
 */
export function loadEntryFiles(dir: string): EntryFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const path = join(dir, name);
      const text = readFileSync(path, "utf8");
      const entry = parseEntry(JSON.parse(text));
      if (serialise(entry) !== text) {
        throw new Error(`${path} is not in canonical form: rewrite it as serialise() writes it before this script edits it`);
      }

      return { path, entry };
    });
}

/** One source URL and everything the catalogue records about it. */
export interface SourceGroup {
  readonly url: string;
  /** The ids of the entries that list the URL as a source, sorted. */
  readonly entryIds: readonly string[];
  /** The latest snapshot any of those entries pins for the URL, when one does. */
  readonly snapshot: Snapshot | undefined;
  /** Whether a recipe reads the URL as a paged query, so the URL alone is not the data. */
  readonly paged: boolean;
  /** Whether some entry lists the URL as a source without a snapshot. */
  readonly unpinned: boolean;
  /** Whether some entry records the URL as `live`; false when every entry records it `dead`. */
  readonly live: boolean;
  /** Every distinct snapshot an entry pins for the URL, by timestamp, with whether a source that pins it is `dead` (and so cannot lose it: the schema requires a dead source's snapshot). */
  readonly pins: readonly Pin[];
}

/** A snapshot timestamp pinned on a source URL. */
export interface Pin {
  readonly timestamp: string;
  readonly dead: boolean;
}

/**
 * Groups the sources of every entry by URL.
 * @param files - The entry files.
 * @returns One group per distinct URL, sorted by URL.
 */
export function groupSources(files: readonly EntryFile[]): SourceGroup[] {
  const groups = new Map<string, { entryIds: Set<string>; snapshot: Snapshot | undefined; paged: boolean; unpinned: boolean; live: boolean; pins: Map<string, boolean> }>();
  for (const { entry } of files) {
    entry.sources.forEach((source, index) => {
      const group = groups.get(source.url) ?? { entryIds: new Set<string>(), snapshot: undefined, paged: false, unpinned: false, live: false, pins: new Map<string, boolean>() };
      group.entryIds.add(entry.id);
      if (source.snapshot !== undefined && (group.snapshot === undefined || source.snapshot.timestamp > group.snapshot.timestamp)) {
        group.snapshot = source.snapshot;
      }
      group.paged ||= entry.recipe.status === "fetchable" && "source" in entry.recipe && entry.recipe.source === index && entry.recipe.paging !== undefined;
      group.unpinned ||= source.snapshot === undefined;
      group.live ||= source.status === "live";
      if (source.snapshot !== undefined) {
        group.pins.set(source.snapshot.timestamp, (group.pins.get(source.snapshot.timestamp) ?? false) || source.status === "dead");
      }
      groups.set(source.url, group);
    });
  }

  return [...groups]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([url, group]) => ({ url, entryIds: [...group.entryIds].sort(), snapshot: group.snapshot, paged: group.paged, unpinned: group.unpinned, live: group.live, pins: [...group.pins].sort(([left], [right]) => (left < right ? -1 : 1)).map(([timestamp, dead]) => ({ timestamp, dead })) }));
}

/**
 * The URL each entry's recipe reads, by entry id, for the checks that compare a mirror against the copy it stands in for. An entry whose recipe is not a one-source fetchable recipe has no entry here.
 * @param files - The entry files.
 * @returns The map of entry id to the canonical source URL.
 */
export function canonicalUrlsOf(files: readonly EntryFile[]): Map<string, string> {
  const canonical = new Map<string, string>();
  for (const { entry } of files) {
    if (entry.recipe.status === "fetchable" && "source" in entry.recipe) {
      const url = entry.sources[entry.recipe.source]?.url;
      if (url !== undefined) {
        canonical.set(entry.id, url);
      }
    }
  }

  return canonical;
}

/**
 * The snapshot of a URL at a timestamp, with its URL spelt as the entry schema requires.
 * @param timestamp - A Wayback timestamp.
 * @param url - The source URL.
 * @returns The snapshot.
 */
export function snapshotOf(timestamp: string, url: string): Snapshot {
  return { timestamp, url: waybackUrl(timestamp, url) };
}

/**
 * The entry with a snapshot pinned on each source that has none and whose URL has one in `snapshots`. A source that already pins a snapshot is never replaced, and no other field is touched.
 * @param entry - The entry.
 * @param snapshots - The timestamp to pin for each URL.
 * @returns The edited entry, or the same entry when nothing was pinned.
 */
export function pinSnapshots(entry: Entry, snapshots: ReadonlyMap<string, string>): Entry {
  const wanted = (source: Entry["sources"][number]): string | undefined => (source.snapshot === undefined ? snapshots.get(source.url) : undefined);
  if (!entry.sources.some((source) => wanted(source) !== undefined)) {
    return entry;
  }

  return {
    ...entry,
    sources: entry.sources.map((source) => {
      const timestamp = wanted(source);

      return timestamp === undefined ? source : { ...source, snapshot: snapshotOf(timestamp, source.url) };
    }),
  };
}

/**
 * The entry without the snapshot of a `live` source URL at a timestamp. A `dead` source keeps its snapshot, which the schema requires, and no other field is touched.
 * @param entry - The entry.
 * @param url - The source URL.
 * @param timestamp - The snapshot's timestamp.
 * @returns The edited entry, or the same entry when no live source pins that snapshot.
 */
export function unpinSnapshot(entry: Entry, url: string, timestamp: string): Entry {
  const pinned = (source: Entry["sources"][number]): boolean => source.url === url && source.status === "live" && source.snapshot?.timestamp === timestamp;
  if (!entry.sources.some(pinned)) {
    return entry;
  }

  return { ...entry, sources: entry.sources.map((source) => (pinned(source) ? withoutSnapshot(source) : source)) };
}

/** A source with its snapshot left out. */
function withoutSnapshot(source: Entry["sources"][number]): Entry["sources"][number] {
  return { url: source.url, retrieved: source.retrieved, status: source.status };
}

/**
 * Removes the snapshot of a live source URL at a timestamp from every entry file that pins it, and writes only those files.
 * @param files - The entry files.
 * @param url - The source URL.
 * @param timestamp - The snapshot's timestamp.
 * @returns The files after the edit.
 */
export function removeSnapshot(files: readonly EntryFile[], url: string, timestamp: string): EntryFile[] {
  return files.map((file) => {
    const entry = unpinSnapshot(file.entry, url, timestamp);
    if (entry === file.entry) {
      return file;
    }
    writeFileSync(file.path, serialise(entry), "utf8");

    return { path: file.path, entry };
  });
}

/** The SHA-256 and length of a snapshot's raw bytes, as an entry records them. */
export interface Checksum {
  readonly sha256: string;
  readonly byteLength: number;
}

/**
 * Every distinct pinned snapshot, by source URL and timestamp, that records no checksum yet.
 * @param files - The entry files.
 * @param entryIds - The entries whose snapshots to list, or undefined for every entry.
 * @returns The snapshots to read, sorted by URL then timestamp.
 */
export function unchecksummed(files: readonly EntryFile[], entryIds: ReadonlySet<string> | undefined): { url: string; timestamp: string }[] {
  const pending = new Map<string, { url: string; timestamp: string }>();
  for (const { entry } of files) {
    if (entryIds !== undefined && !entryIds.has(entry.id)) {
      continue;
    }
    for (const source of entry.sources) {
      if (source.snapshot !== undefined && source.snapshot.sha256 === undefined) {
        pending.set(`${source.url}\n${source.snapshot.timestamp}`, { url: source.url, timestamp: source.snapshot.timestamp });
      }
    }
  }

  return [...pending.values()].sort((left, right) => (left.url === right.url ? (left.timestamp < right.timestamp ? -1 : 1) : left.url < right.url ? -1 : 1));
}

/**
 * The entry with a checksum recorded on every source that pins that snapshot of that URL. A snapshot that already records a checksum is never replaced, and no other field is touched.
 * @param entry - The entry.
 * @param url - The source URL.
 * @param timestamp - The pinned snapshot's timestamp.
 * @param checksum - The checksum of the snapshot's raw bytes.
 * @returns The edited entry, or the same entry when nothing was recorded.
 */
export function withChecksum(entry: Entry, url: string, timestamp: string, checksum: Checksum): Entry {
  const wanted = (source: Entry["sources"][number]): boolean => source.url === url && source.snapshot?.timestamp === timestamp && source.snapshot.sha256 === undefined;
  if (!entry.sources.some(wanted)) {
    return entry;
  }

  return { ...entry, sources: entry.sources.map((source) => (wanted(source) && source.snapshot !== undefined ? { ...source, snapshot: { ...source.snapshot, ...checksum } } : source)) };
}

/**
 * Records a snapshot's checksum on the entry files that pin it and writes only those files.
 * @param files - The entry files.
 * @param url - The source URL.
 * @param timestamp - The pinned snapshot's timestamp.
 * @param checksum - The checksum of the snapshot's raw bytes.
 * @returns The files after the edit.
 */
export function recordChecksum(files: readonly EntryFile[], url: string, timestamp: string, checksum: Checksum): EntryFile[] {
  return files.map((file) => {
    const entry = withChecksum(file.entry, url, timestamp, checksum);
    if (entry === file.entry) {
      return file;
    }
    writeFileSync(file.path, serialise(entry), "utf8");

    return { path: file.path, entry };
  });
}

/**
 * Pins snapshots on the entry files that need them and writes only those files.
 * @param files - The entry files.
 * @param snapshots - The timestamp to pin for each URL.
 * @returns The files after the edit, and how many were written.
 */
export function recordSnapshots(files: readonly EntryFile[], snapshots: ReadonlyMap<string, string>): { files: EntryFile[]; written: number } {
  let written = 0;
  const edited = files.map((file) => {
    const entry = pinSnapshots(file.entry, snapshots);
    if (entry === file.entry) {
      return file;
    }
    writeFileSync(file.path, serialise(entry), "utf8");
    written += 1;

    return { path: file.path, entry };
  });

  return { files: edited, written };
}
