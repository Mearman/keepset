import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "./http-status";
import { checkReportText, checkSources, classifyProbe, type Findings, findingsOf, HASH_PREFIX_BYTES, interleaveByHost, issueBody, needsIssue, parseCheckReport, type SourceResult } from "./check";
import { canonicalUrlsOf, groupSources, snapshotOf } from "./entries";
import { PoliteClient } from "./polite-client";
import { connectionError, entryWith, FakeClock, liveSource, scriptedNetwork, TEST_POLITENESS } from "./test-support";

const U = "https://x.example/file";
const result = (overrides: Partial<SourceResult> & Pick<SourceResult, "url">): SourceResult => ({ entries: ["e"], recorded: "live", state: "ok", evidence: "HTTP 200", ...overrides });

describe("classifyProbe", () => {
  it("calls an answering source ok and a missing one gone", () => {
    expect(classifyProbe(U, { kind: "answered", status: 200, contentLength: 5, finalUrl: "" })).toEqual({ state: "ok", evidence: "HTTP 200" });
    expect(classifyProbe(U, { kind: "answered", status: 206, contentLength: 5, finalUrl: "" }).state).toBe("ok");
    expect(classifyProbe(U, { kind: "answered", status: 404, contentLength: undefined, finalUrl: "" })).toEqual({ state: "gone", evidence: "HTTP 404" });
    expect(classifyProbe(U, { kind: "answered", status: 410, contentLength: undefined, finalUrl: "" }).state).toBe("gone");
  });

  it("calls a source gone that redirects to the host's own missing-page page, and names the host a refusal came from", () => {
    expect(classifyProbe(U, { kind: "answered", status: HTTP_STATUS.ok, contentLength: 5, finalUrl: "https://x.example/404" })).toEqual({ state: "gone", evidence: "redirects to https://x.example/404" });
    expect(classifyProbe(U, { kind: "answered", status: HTTP_STATUS.forbidden, contentLength: undefined, finalUrl: "http://files.other.example/file" })).toEqual({ state: "blocked", evidence: "HTTP 403 from files.other.example" });
  });

  it("keeps a refusal of this client apart from a missing file, and a busy host apart from both", () => {
    expect(classifyProbe(U, { kind: "answered", status: 403, contentLength: undefined, finalUrl: "" }).state).toBe("blocked");
    expect(classifyProbe(U, { kind: "answered", status: 429, contentLength: undefined, finalUrl: "" }).state).toBe("unreachable");
    expect(classifyProbe(U, { kind: "answered", status: 503, contentLength: undefined, finalUrl: "" }).state).toBe("unreachable");
  });

  it("calls a name that no longer resolves gone and a timeout unreachable", () => {
    expect(classifyProbe(U, { kind: "unreachable", code: "ENOTFOUND" })).toEqual({ state: "gone", evidence: "ENOTFOUND" });
    expect(classifyProbe(U, { kind: "unreachable", code: "ETIMEDOUT" })).toEqual({ state: "unreachable", evidence: "ETIMEDOUT" });
    expect(classifyProbe(U, { kind: "unreachable", code: undefined })).toEqual({ state: "unreachable", evidence: "no answer" });
  });
});

describe("interleaveByHost", () => {
  it("takes one URL from each host in turn and keeps every host's own order", () => {
    const ordered = interleaveByHost(["https://a.example/1", "https://a.example/2", "https://a.example/3", "https://b.example/1", "https://c.example/1", "https://c.example/2"]);
    expect(ordered).toEqual(["https://a.example/1", "https://b.example/1", "https://c.example/1", "https://a.example/2", "https://c.example/2", "https://a.example/3"]);
  });

  it("returns exactly the URLs it was given", () => {
    const urls = ["https://a.example/1", "https://b.example/1", "https://a.example/2"];
    expect([...interleaveByHost(urls)].sort()).toEqual([...urls].sort());
    expect(interleaveByHost([])).toEqual([]);
  });
});

describe("checkSources", () => {
  const statedLength = 10;
  const concurrency = 4;
  const files = [
    { path: "a", entry: entryWith("a", [liveSource("https://one.example/ok"), liveSource("https://one.example/missing")]) },
    { path: "b", entry: entryWith("b", [liveSource("https://two.example/down"), { url: "https://three.example/old", retrieved: "2026-10-01", status: "dead", snapshot: snapshotOf("20200101000000", "https://three.example/old") }]) },
  ];

  it("probes each distinct URL once and returns the results sorted, with the stated length", async () => {
    const network = scriptedNetwork((request) => {
      if (request.url.startsWith("https://two.example")) {
        return connectionError("ENOTFOUND");
      }
      if (request.url.endsWith("/missing")) {
        return new Response(null, { status: 404 });
      }

      return new Response(null, { status: 200, headers: { "content-length": String(statedLength) } });
    });
    const results = await checkSources(new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 }), groupSources(files), concurrency);
    expect(results.map((entry) => [entry.url, entry.recorded, entry.state, entry.contentLength])).toEqual([
      ["https://one.example/missing", "live", "gone", undefined],
      ["https://one.example/ok", "live", "ok", statedLength],
      ["https://three.example/old", "dead", "ok", statedLength],
      ["https://two.example/down", "live", "gone", undefined],
    ]);
    expect(results[0]?.entries).toEqual(["a"]);
  });

  it("never edits anything: it only requests, and reads bytes only from the sources that answered", async () => {
    const network = scriptedNetwork(() => new Response(null, { status: 404 }));
    const results = await checkSources(new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 }), groupSources(files), 2);
    expect([...new Set(network.seen.map((request) => request.method))].every((method) => method === "HEAD" || method === "GET")).toBe(true);
    expect(results.every((entry) => entry.contentHash === undefined)).toBe(true);
  });

  it("hashes the bytes an answering source serves", async () => {
    const body = "0123456789";
    const digest = createHash("sha256").update(body).digest("hex");
    const network = scriptedNetwork((request) => {
      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": String(body.length) } });
      }

      return new Response(body, { status: 206 });
    });
    const results = await checkSources(new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 }), groupSources([{ path: "a", entry: entryWith("a", [liveSource(U)]) }]), 2);
    expect(results[0]?.contentHash).toBe(digest);
    const ranged = network.seen.find((request) => request.method === "GET");
    expect(ranged?.headers.get("range")).toBe(`bytes=0-${String(HASH_PREFIX_BYTES - 1)}`);
  });

  it("leaves a source without a hash, and does not fail the check, when its host drops the connection after the probe answered", async () => {
    const network = scriptedNetwork((request) => {
      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers: { "content-length": "10" } });
      }

      return connectionError("ECONNREFUSED");
    });
    const results = await checkSources(new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 }), groupSources([{ path: "a", entry: entryWith("a", [liveSource(U)]) }]), 2);
    expect(results.map((entry) => [entry.state, entry.contentHash])).toEqual([["ok", undefined]]);
  });

  it("leaves a source without a hash when the answer breaks off before the prefix was read", async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        controller.error(new TypeError("terminated"));
      },
    });
    const network = scriptedNetwork((request) => (request.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "10" } }) : new Response(broken, { status: 206 })));
    const results = await checkSources(new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 }), groupSources([{ path: "a", entry: entryWith("a", [liveSource(U)]) }]), 2);
    expect(results.map((entry) => [entry.state, entry.contentHash])).toEqual([["ok", undefined]]);
  });
});

describe("findingsOf", () => {
  const before = 100;
  const after = 250;
  const baseline = [result({ url: "https://x.example/a", contentLength: before }), result({ url: "https://x.example/b", contentLength: before })];

  it("finds live sources that no longer resolve, dead ones that answer, and lengths that changed", () => {
    const results = [
      result({ url: "https://x.example/a", contentLength: before }),
      result({ url: "https://x.example/b", contentLength: after }),
      result({ url: "https://x.example/c", state: "gone", evidence: "HTTP 404" }),
      result({ url: "https://x.example/d", state: "unreachable", evidence: "ETIMEDOUT" }),
      result({ url: "https://x.example/e", recorded: "dead" }),
      result({ url: "https://x.example/f", recorded: "dead", state: "gone", evidence: "HTTP 404" }),
      result({ url: "https://x.example/g", state: "blocked", evidence: "HTTP 403" }),
    ];
    const findings = findingsOf(results, baseline);
    expect(findings.lost.map((entry) => entry.url)).toEqual(["https://x.example/c", "https://x.example/d"]);
    expect(findings.revived.map((entry) => entry.url)).toEqual(["https://x.example/e"]);
    expect(findings.changed.map(({ result: entry, was, now }) => [entry.url, was, now])).toEqual([["https://x.example/b", before, after]]);
    expect(findings.blocked.map((entry) => entry.url)).toEqual(["https://x.example/g"]);
  });

  it("reports no change without a baseline, or where a length is missing on either side", () => {
    expect(findingsOf([result({ url: "https://x.example/a", contentLength: 5 })], []).changed).toEqual([]);
    expect(findingsOf([result({ url: "https://x.example/a" })], baseline).changed).toEqual([]);
  });
});

/** How many repeats of the sixteen hex characters make one sixty-four-character SHA-256 fixture. */
const SHA_256_HEX_REPEATS = 4;
/** One character short of a full hash fixture, so a fixture that differs from another can carry the difference at its end. */
const HASH_LESS_ONE = 63;
/** A SHA-256 as sixty-four hex characters, spelled out for the fixtures that build one. */
const SHA_256_HEX = "0123456789abcdef".repeat(SHA_256_HEX_REPEATS);
/** How many hex characters of a hash the issue body shows, kept beside the fixture so the two move together. */
const HASH_SHOWN = 12;

describe("needsIssue and issueBody", () => {
  const MANY = 200;
  const FEW = 3;
  const BODY_LIMIT = 4000;
  const HALF = 2;
  const empty: Findings = { lost: [], revived: [], changed: [], content: [], diverged: [], blocked: [] };
  const lost = result({ url: "https://x.example/c", entries: ["one", "two"], state: "gone", evidence: "HTTP 404" });

  it("asks for an issue for a lost, revived or changed source, and not for a source that only refuses this client", () => {
    expect(needsIssue(empty)).toBe(false);
    expect(needsIssue({ ...empty, blocked: [lost] })).toBe(false);
    expect(needsIssue({ ...empty, lost: [lost] })).toBe(true);
    expect(needsIssue({ ...empty, revived: [lost] })).toBe(true);
    expect(needsIssue({ ...empty, changed: [{ result: lost, was: 1, now: 2 }] })).toBe(true);
    expect(needsIssue({ ...empty, content: [{ result: lost, was: SHA_256_HEX, now: `${SHA_256_HEX.slice(0, HASH_LESS_ONE)}9` }] })).toBe(true);
    expect(needsIssue({ ...empty, diverged: [{ result: lost, entry: "one", canonical: lost, differs: "length" }] })).toBe(true);
  });

  it("names each source, its entries and what was observed", () => {
    const body = issueBody({
      ...empty,
      lost: [lost],
      changed: [{ result: lost, was: 100, now: 250 }],
      content: [{ result: lost, was: SHA_256_HEX, now: `9${SHA_256_HEX.slice(0, HASH_LESS_ONE)}` }],
      diverged: [{ result: result({ url: "https://mirror.example/c" }), entry: "one", canonical: result({ url: "https://x.example/c" }), differs: "hash" }],
    });
    expect(body).toContain("- https://x.example/c (one, two): gone, HTTP 404");
    expect(body).toContain("100 bytes, now 250");
    expect(body).toContain(`${SHA_256_HEX.slice(0, HASH_SHOWN)}, now 9${SHA_256_HEX.slice(0, HASH_SHOWN - 1)}`);
    expect(body).toContain("- https://mirror.example/c (one) differs from https://x.example/c in hash");
    expect(body).not.toContain("answering again");
  });

  it("keeps a fair share of every kind of finding within the limit and says how many it left out", () => {
    const many = (count: number, host: string) => Array.from({ length: count }, (_, index) => result({ url: `https://${host}.example/${String(index)}`, entries: ["e"], state: "gone", evidence: "HTTP 404" }));
    const body = issueBody({ ...empty, lost: many(MANY, "lost"), blocked: many(MANY, "blocked"), revived: many(FEW, "revived") }, BODY_LIMIT);
    expect(body.length).toBeLessThanOrEqual(BODY_LIMIT);
    expect(body.match(/revived\.example/g)?.length).toBe(FEW);
    expect(body).toContain(`Recorded live, no longer resolving (${String(MANY)}, `);
    expect(body).toMatch(/- and \d+ more, listed in the check's report/);
    const lostShown = body.match(/lost\.example/g)?.length ?? 0;
    const blockedShown = body.match(/blocked\.example/g)?.length ?? 0;
    expect(lostShown).toBeGreaterThan(0);
    expect(Math.min(lostShown, blockedShown) * HALF).toBeGreaterThanOrEqual(Math.max(lostShown, blockedShown));
  });

  it("lists every finding, with no omission line, when they fit", () => {
    const body = issueBody({ ...empty, lost: [lost] }, BODY_LIMIT);
    expect(body).not.toContain("more, listed in the check's report");
    expect(body).toContain("Recorded live, no longer resolving:");
  });

  it("is free of spaced double hyphens and em-dashes", () => {
    const body = issueBody({ lost: [lost], revived: [lost], changed: [{ result: lost, was: 1, now: 2 }], content: [], diverged: [], blocked: [lost] });
    expect(body).not.toMatch(/\s--\s|\u2014/);
  });
});

describe("the check report", () => {
  it("round-trips through its text, sorted keys and all", () => {
    const results = [result({ url: "https://x.example/a", contentLength: 7 }), result({ url: "https://x.example/b", state: "gone", evidence: "HTTP 404" })];
    const text = checkReportText(results);
    expect(parseCheckReport(text)).toEqual(results);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("refuses text that is not a report", () => {
    expect(() => parseCheckReport("{}")).toThrow();
  });
});

describe("canonicalUrlsOf", () => {
  it("maps each entry to the URL its recipe reads, and nothing for an entry with no one-source recipe", () => {
    const fetchable = entryWith("one", [liveSource("https://a.example/canonical"), liveSource("https://b.example/mirror")], { recipe: { status: "fetchable", source: 0, archive: { kind: "none" }, parser: { format: "csv-table", encoding: "utf-8", delimiter: "comma", skipLines: 0, idColumn: null, numericColumns: [] } } });
    const notFetchable = entryWith("two", [liveSource("https://c.example/any")], { recipe: { status: "not-fetchable", reason: "no parser" } });
    const canonical = canonicalUrlsOf([{ path: "a", entry: fetchable }, { path: "b", entry: notFetchable }]);
    expect(canonical.get("one")).toBe("https://a.example/canonical");
    expect(canonical.has("two")).toBe(false);
  });
});
