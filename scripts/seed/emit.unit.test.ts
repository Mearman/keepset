import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseEntry, waybackUrl } from "../../src/entry";
import { serialise } from "../../src/serialise";
import { liveEntry } from "../../src/test-support/entries";
import { DownloadSizesSchema } from "./download-sizes";
import { apply, entryWrites, reportedIds, staleEntries } from "./emit";

/** A SHA-256 is 64 hex digits. */
const SHA256_DIGITS = 64;

/** The byte length the carry-over test's committed pin records. */
const PINNED_BYTES = 4096;

/** The size a host states for the carry-over test's live download. */
const STATED_BYTES = 777;

const NO_SIZES = DownloadSizesSchema.parse({ readOn: "2026-10-24", sizes: {} });

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "keepset-emit-"));
  directories.push(directory);

  return directory;
}

describe("entryWrites", () => {
  it("maps each entry to its file under the entries directory, serialised", () => {
    const writes = entryWrites([parseEntry(liveEntry)], "/entries", NO_SIZES);
    expect([...writes.keys()]).toEqual(["/entries/karate.json"]);
    expect(JSON.parse(writes.get("/entries/karate.json") ?? "null")).toMatchObject({ id: "karate" });
  });
});

describe("entryWrites and pinned snapshots", () => {
  it("carries over a snapshot the committed file pins for a source the import lists without one, and nothing else", () => {
    const root = scratch();
    const url = "https://example.org/data/karate.txt";
    const committed = parseEntry({ ...liveEntry, name: "An older name", sources: [{ url, retrieved: "2026-01-01", status: "live", snapshot: { timestamp: "20260101000000", url: waybackUrl("20260101000000", url) } }] });
    writeFileSync(join(root, "karate.json"), serialise(committed));
    const written = parseEntry(JSON.parse(entryWrites([parseEntry(liveEntry)], root, NO_SIZES).get(join(root, "karate.json")) ?? "null"));
    expect(written.sources[0]?.snapshot).toEqual({ timestamp: "20260101000000", url: waybackUrl("20260101000000", url) });
    expect(written.sources[0]?.retrieved).toBe(liveEntry.sources[0]?.retrieved);
    expect(written.name).toBe(liveEntry.name);
  });

  it("carries over the checksum a committed file records for a pin the import keeps, and none for a pin without one", () => {
    const root = scratch();
    const url = "https://example.org/data/karate.txt";
    const sha256 = "a".repeat(SHA256_DIGITS);
    const committed = parseEntry({ ...liveEntry, sources: [{ url, retrieved: "2026-01-01", status: "live", snapshot: { timestamp: "20260101000000", url: waybackUrl("20260101000000", url), sha256, byteLength: PINNED_BYTES } }] });
    writeFileSync(join(root, "karate.json"), serialise(committed));
    const regenerated = parseEntry({ ...liveEntry, sources: [{ url, retrieved: "2026-04-19", status: "live", snapshot: { timestamp: "20260101000000", url: waybackUrl("20260101000000", url) } }] });
    const written = parseEntry(JSON.parse(entryWrites([regenerated], root, NO_SIZES).get(join(root, "karate.json")) ?? "null"));
    expect(written.sources[0]?.snapshot).toMatchObject({ sha256, byteLength: PINNED_BYTES });
  });

  it("records the carried checksum's byte length as the download's size ahead of the size a host states, and the stated size without a checksum", () => {
    const root = scratch();
    const url = "https://example.org/data/karate.txt";
    const sizes = DownloadSizesSchema.parse({ readOn: "2026-10-24", sizes: { [url]: STATED_BYTES } });
    const pin = { timestamp: "20260101000000", url: waybackUrl("20260101000000", url) };
    const committed = parseEntry({ ...liveEntry, sources: [{ url, retrieved: "2026-01-01", status: "live", snapshot: { ...pin, sha256: "a".repeat(SHA256_DIGITS), byteLength: PINNED_BYTES } }] });
    writeFileSync(join(root, "karate.json"), serialise(committed));
    const regenerated = parseEntry({ ...liveEntry, sources: [{ url, retrieved: "2026-04-19", status: "live", snapshot: pin }] });
    const pinned = parseEntry(JSON.parse(entryWrites([regenerated], root, sizes).get(join(root, "karate.json")) ?? "null"));
    expect(pinned.properties["downloadBytes"]).toBe(PINNED_BYTES);
    const empty = scratch();
    const stated = parseEntry(JSON.parse(entryWrites([regenerated], empty, sizes).get(join(empty, "karate.json")) ?? "null"));
    expect(stated.properties["downloadBytes"]).toBe(STATED_BYTES);
    const unsized = parseEntry(JSON.parse(entryWrites([regenerated], empty, NO_SIZES).get(join(empty, "karate.json")) ?? "null"));
    expect(unsized.properties).not.toHaveProperty("downloadBytes");
  });

  it("does not pin a snapshot for a URL the import no longer lists", () => {
    const root = scratch();
    const committed = parseEntry({ ...liveEntry, sources: [{ url: "https://example.org/other", retrieved: "2026-01-01", status: "live", snapshot: { timestamp: "20260101000000", url: waybackUrl("20260101000000", "https://example.org/other") } }] });
    writeFileSync(join(root, "karate.json"), serialise(committed));
    const written = parseEntry(JSON.parse(entryWrites([parseEntry(liveEntry)], root, NO_SIZES).get(join(root, "karate.json")) ?? "null"));
    expect(written.sources[0]?.snapshot).toBeUndefined();
  });
});

describe("reportedIds", () => {
  const report = JSON.stringify({ outcomes: [{ id: "a", outcome: "converted" }, { id: "b", outcome: "not-converted" }, { id: "c" }, "junk", null, { outcome: "converted" }] });

  it("collects the ids of the outcomes the predicate accepts", () => {
    expect([...reportedIds(report, "the report", (outcome) => outcome["outcome"] !== "not-converted")]).toEqual(["a", "c"]);
    expect([...reportedIds(report, "the report", () => true)]).toEqual(["a", "b", "c"]);
  });

  it("refuses a report with no outcomes list, naming it", () => {
    expect(() => reportedIds("{}", "the report", () => true)).toThrow("the report has no outcomes list");
    expect(() => reportedIds("[]", "the report", () => true)).toThrow("the report has no outcomes list");
  });
});

describe("staleEntries", () => {
  it("names the files of earlier ids that are no longer produced, and none without an earlier report", () => {
    expect(staleEntries("/entries", new Set(["a", "b", "c"]), new Set(["b"]))).toEqual(["/entries/a.json", "/entries/c.json"]);
    expect(staleEntries("/entries", undefined, new Set(["b"]))).toEqual([]);
  });
});

describe("apply", () => {
  it("writes every file and removes every stale one", () => {
    const root = scratch();
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "old.json"), "old");
    apply({ writes: new Map([[join(root, "out", "new.json"), "new\n"]]), stale: [join(root, "out", "old.json"), join(root, "out", "never-existed.json")] }, root, false);
    expect(readFileSync(join(root, "out", "new.json"), "utf8")).toBe("new\n");
    expect(existsSync(join(root, "out", "old.json"))).toBe(false);
  });

  it("in check mode writes nothing and passes when the committed files match and no stale file lingers", () => {
    const root = scratch();
    writeFileSync(join(root, "a.json"), "a\n");
    expect(() => {
      apply({ writes: new Map([[join(root, "a.json"), "a\n"]]), stale: [join(root, "gone.json")] }, root, true);
    }).not.toThrow();
  });

  it("in check mode fails naming a file that differs, one that is missing and a stale one that still exists, and still writes nothing", () => {
    const root = scratch();
    writeFileSync(join(root, "differs.json"), "committed\n");
    writeFileSync(join(root, "lingers.json"), "x");
    const output = { writes: new Map([[join(root, "differs.json"), "produced\n"], [join(root, "missing.json"), "m\n"]]), stale: [join(root, "lingers.json")] };
    expect(() => {
      apply(output, root, true);
    }).toThrow(/differs\.json, missing\.json, lingers\.json \(stale\)/);
    expect(readFileSync(join(root, "differs.json"), "utf8")).toBe("committed\n");
    expect(existsSync(join(root, "missing.json"))).toBe(false);
    expect(existsSync(join(root, "lingers.json"))).toBe(true);
  });
});
