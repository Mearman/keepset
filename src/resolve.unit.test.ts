import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CAPTURE_HAND_OFF_MILLISECONDS, captureRequestFor, captureRequestsFor, requestCapture, resolveSource } from "./resolve";
import { KeepsetError, UnreachableSourceError } from "./errors";
import { snapshotOf } from "../scripts/sources/entries";
import type { Source } from "./entry";
import type { FetchPort } from "./fetch";
import { memoryStore } from "./source-bytes";

const URL_LIVE = "https://x.example/data.csv";
const PIN = "20240101000000";
const CLOSEST = "20250601000000";
const NOT_FOUND = 404;
const OK = 200;

const live = (overrides: Partial<Source> = {}): Source => ({ url: URL_LIVE, retrieved: "2026-10-01", status: "live", ...overrides });
const dead = (): Source => ({ url: URL_LIVE, retrieved: "2026-10-01", status: "dead", snapshot: snapshotOf(PIN, URL_LIVE) });
const raw = (timestamp: string): string => `https://web.archive.org/web/${timestamp}id_/${URL_LIVE}`;
const availability = (): string => `https://archive.org/wayback/available?${new URLSearchParams({ url: URL_LIVE }).toString()}`;

/** A port answering by URL from a table, 404 for a URL it does not hold, and recording every request in order. */
function served(table: Readonly<Record<string, string | Response>>): { readonly port: FetchPort; readonly requested: string[] } {
  const requested: string[] = [];
  const port: FetchPort = async (url) => {
    requested.push(url);
    const answer = table[url];

    return Promise.resolve(answer === undefined ? new Response(null, { status: NOT_FOUND }) : typeof answer === "string" ? new Response(answer, { status: OK }) : answer);
  };

  return { port, requested };
}

/** Where the chain keeps what a tier gives: in memory, hashed whole, as a reader that reads from the first byte to the last asks. */
const keeping = { store: memoryStore(async (bytes) => Promise.resolve(createHash("sha256").update(bytes).digest("hex"))), randomAccess: false } as const;

const closestAnswer = (timestamp: string): Response => Response.json({ archived_snapshots: { closest: { available: true, status: "200", timestamp } } });

describe("resolveSource", () => {
  it("reads a pinned snapshot first, and asks nothing else", async () => {
    const { port, requested } = served({ [raw(PIN)]: "pinned" });
    const resolved = await resolveSource(live({ snapshot: snapshotOf(PIN, URL_LIVE) }), { port, ...keeping });
    expect(new TextDecoder().decode(await resolved.source.bytes())).toBe("pinned");
    expect(resolved.tier).toBe("pinned snapshot");
    expect(resolved.url).toBe(raw(PIN));
    expect(requested).toEqual([raw(PIN)]);
  });

  it("falls to the closest capture the Archive names when there is no pin", async () => {
    const { port, requested } = served({ [availability()]: closestAnswer(CLOSEST), [raw(CLOSEST)]: "captured" });
    const resolved = await resolveSource(live(), { port, ...keeping });
    expect(new TextDecoder().decode(await resolved.source.bytes())).toBe("captured");
    expect(resolved.tier).toBe("closest snapshot");
    expect(requested).toEqual([availability(), raw(CLOSEST)]);
  });

  it("falls to the closest capture when the pin does not serve, and to the live URL last", async () => {
    const { port, requested } = served({ [availability()]: Response.json({ archived_snapshots: {} }), [URL_LIVE]: "live bytes" });
    const resolved = await resolveSource(live({ snapshot: snapshotOf(PIN, URL_LIVE) }), { port, ...keeping });
    expect(new TextDecoder().decode(await resolved.source.bytes())).toBe("live bytes");
    expect(resolved.tier).toBe("live source");
    expect(requested).toEqual([raw(PIN), availability(), URL_LIVE]);
  });

  it("does not request the closest capture twice when it is the pin that failed", async () => {
    const { port, requested } = served({ [availability()]: closestAnswer(PIN), [URL_LIVE]: "live bytes" });
    await resolveSource(live({ snapshot: snapshotOf(PIN, URL_LIVE) }), { port, ...keeping });
    expect(requested.filter((url) => url === raw(PIN))).toHaveLength(1);
  });

  it("never reads the live URL of a dead source, and names every tier that failed", async () => {
    const { port, requested } = served({});
    await expect(resolveSource(dead(), { port, ...keeping })).rejects.toThrow(KeepsetError);
    await expect(resolveSource(dead(), { port, ...keeping })).rejects.toThrow(/pinned snapshot/);
    expect(requested).not.toContain(URL_LIVE);
  });

  it("treats an availability API that refuses as no capture, not as a failure of the fetch", async () => {
    const { port } = served({ [availability()]: new Response(null, { status: 429 }), [URL_LIVE]: "live bytes" });
    expect((await resolveSource(live(), { port, ...keeping })).tier).toBe("live source");
  });

  it("ignores a closest capture whose page did not answer 200", async () => {
    const closestError = Response.json({ archived_snapshots: { closest: { available: true, status: "404", timestamp: CLOSEST } } });
    const { port, requested } = served({ [availability()]: closestError, [URL_LIVE]: "live bytes" });
    await resolveSource(live(), { port, ...keeping });
    expect(requested).not.toContain(raw(CLOSEST));
  });

  it("passes over a capture the Archive says it truncated, to the next tier, and names it when no tier remains", async () => {
    const truncated = (): Response => new Response("prefix of the file", { status: OK, headers: { warning: '299 wayback content truncated by "length"' } });
    const { port, requested } = served({ [availability()]: closestAnswer(CLOSEST), [raw(CLOSEST)]: truncated(), [URL_LIVE]: "whole file" });
    const resolved = await resolveSource(live(), { port, ...keeping });
    expect(new TextDecoder().decode(await resolved.source.bytes())).toBe("whole file");
    expect(resolved.tier).toBe("live source");
    expect(requested).toEqual([availability(), raw(CLOSEST), URL_LIVE]);
    await expect(resolveSource(dead(), { port: served({ [raw(PIN)]: truncated(), [availability()]: Response.json({ archived_snapshots: {} }) }).port, ...keeping })).rejects.toThrow(/truncated capture/);
  });

  it("rethrows an abort instead of trying the next tier", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    controller.abort(reason);
    const port: FetchPort = async () => Promise.reject(reason);
    await expect(resolveSource(live({ snapshot: snapshotOf(PIN, URL_LIVE) }), { port, signal: controller.signal, ...keeping })).rejects.toBe(reason);
  });
});

describe("resolveSource's transport encodings", () => {
  const page = "<html>page</html>";
  const gzipped = async (text: string): Promise<Uint8Array> => new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
  const gzipLabelled = async (text: string): Promise<Response> => new Response(await gzipped(text), { status: OK, headers: { "content-encoding": "gzip" } });

  it("undoes a gzip transport encoding of a page, so a capture replayed gzip-encoded and one replayed plain give the same bytes", async () => {
    const { port } = served({ [raw(PIN)]: await gzipLabelled(page) });
    expect(new TextDecoder().decode(await (await resolveSource(live({ snapshot: snapshotOf(PIN, URL_LIVE) }), { port, ...keeping })).source.bytes())).toBe(page);
    const plain = served({ [raw(PIN)]: page });
    expect(new TextDecoder().decode(await (await resolveSource(live({ snapshot: snapshotOf(PIN, URL_LIVE) }), { port: plain.port, ...keeping })).source.bytes())).toBe(page);
  });

  it("leaves a compressed file as published, even when the server labels it gzip-encoded", async () => {
    const file = "https://x.example/data.csv.gz";
    const bytes = await gzipped(page);
    const port: FetchPort = async () => Promise.resolve(new Response(bytes, { status: OK, headers: { "content-encoding": "gzip" } }));
    expect(await (await resolveSource({ url: file, retrieved: "2026-10-01", status: "live" }, { port, ...keeping })).source.bytes()).toEqual(bytes);
  });

  it("leaves bytes that are not gzip data alone when the label says gzip, as after a browser's platform fetch has decoded them", async () => {
    const port: FetchPort = async () => Promise.resolve(new Response(page, { status: OK, headers: { "content-encoding": "gzip" } }));
    expect(new TextDecoder().decode(await (await resolveSource({ url: URL_LIVE, retrieved: "2026-10-01", status: "live" }, { port, ...keeping })).source.bytes())).toBe(page);
  });
});

describe("captureRequestFor", () => {
  const download = (fetchedUrl: string, status: Source["status"]): Parameters<typeof captureRequestFor>[0] => ({ source: { url: URL_LIVE, status }, fetchedUrl });

  it("names the Save Page Now request exactly when a live source was read live", () => {
    expect(captureRequestFor(download(URL_LIVE, "live"))).toBe(`https://web.archive.org/save/${URL_LIVE}`);
    expect(captureRequestFor(download(raw(PIN), "live"))).toBeUndefined();
    expect(captureRequestFor(download(raw(PIN), "dead"))).toBeUndefined();
  });

  it("names each live download of a collection once", () => {
    const provenance = {
      entryId: "e",
      catalogue: { id: "c", version: "1" },
      category: "graph/v1",
      retrievedAt: "2026-10-21",
      files: [
        { ...download(URL_LIVE, "live"), sha256: "0", byteLength: 0, path: "a", instances: [] },
        { ...download(URL_LIVE, "live"), sha256: "0", byteLength: 0, path: "b", instances: [] },
        { ...download(raw(PIN), "live"), sha256: "0", byteLength: 0, path: "c", instances: [] },
      ],
    } as unknown as Parameters<typeof captureRequestsFor>[0];
    expect(captureRequestsFor(provenance)).toEqual([`https://web.archive.org/save/${URL_LIVE}`]);
  });
});

describe("resolveSource's failure kinds", () => {
  it("throws UnreachableSourceError when no tier got an HTTP answer", async () => {
    const port: FetchPort = async () => Promise.reject(new TypeError("Failed to fetch"));
    await expect(resolveSource(live(), { port, ...keeping })).rejects.toBeInstanceOf(UnreachableSourceError);
  });

  it("throws a plain KeepsetError when a host answered with an error", async () => {
    const { port } = served({});
    const error = await resolveSource(dead(), { port, ...keeping }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(KeepsetError);
    expect(error).not.toBeInstanceOf(UnreachableSourceError);
  });
});

describe("requestCapture", () => {
  it("lets go of a request after the hand-off and counts that as sent", async () => {
    vi.useFakeTimers();
    try {
      const send: FetchPort = async (_url, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      const sent = requestCapture(`https://web.archive.org/save/${URL_LIVE}`, send);
      await vi.advanceTimersByTimeAsync(CAPTURE_HAND_OFF_MILLISECONDS);
      await expect(sent).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when the request cannot be sent at all", async () => {
    const send: FetchPort = async () => Promise.reject(new TypeError("offline"));
    await expect(requestCapture("https://web.archive.org/save/x", send)).rejects.toThrow("offline");
  });

  it("throws the abort's own reason when the caller aborts", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const send: FetchPort = async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(reason);
        });
      });
    const sent = requestCapture("https://web.archive.org/save/x", send, controller.signal);
    controller.abort(reason);
    await expect(sent).rejects.toBe(reason);
  });
});
