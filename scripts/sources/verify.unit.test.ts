import { describe, expect, it } from "vitest";
import { HTTP_STATUS } from "./http-status";
import { PoliteClient } from "./polite-client";
import { connectionError, FakeClock, scriptedNetwork, TEST_POLITENESS } from "./test-support";
import { differences, FIRST_BYTES, isWaybackPage, VERIFY_ATTEMPTS, VERIFY_BACKOFF_MILLISECONDS, verifyPin } from "./verify";

const U = "https://x.example/file.csv";
const TS = "20261021014848";
const RAW = `https://web.archive.org/web/${TS}id_/${U}`;

/** A replay that serves the captured bytes: the memento headers a replay answers with (RFC 7089) and a landing URL naming the capture it answered from. */
const replay = (body: string, options: Readonly<{ status?: number; headers?: Record<string, string>; landing?: string }> = {}): Response => {
  const response = new Response(body, { status: options.status ?? HTTP_STATUS.partialContent, headers: { "memento-datetime": "Wed, 21 Oct 2026 01:48:48 GMT", "content-type": "text/csv", ...options.headers } });
  Object.defineProperty(response, "url", { value: options.landing ?? RAW });

  return response;
};

/** The live source's answer to the same first-bytes request. */
const live = (body: string): Response => new Response(body, { status: 206, headers: { "content-type": "text/csv" } });

/** The Wayback Machine's own 404 page, as the raw form of a capture that is not served answers. A fresh Response per request, as a real answer is. */
const waybackPage = (): Response => new Response('<!DOCTYPE html><html lang="en"><head><title>Wayback Machine</title></head></html>', { status: 404, headers: { "content-type": "text/html" } });

describe("isWaybackPage", () => {
  it("takes a replay by its memento header and rejects the Wayback Machine's own pages", () => {
    expect(isWaybackPage({ headers: new Headers({ "memento-datetime": "Wed, 21 Oct 2026 01:48:48 GMT" }), bytes: new TextEncoder().encode("a,b\n1,2\n") })).toBe(false);
    expect(isWaybackPage({ headers: new Headers(), bytes: new TextEncoder().encode("a,b\n1,2\n") })).toBe(true);
    expect(isWaybackPage({ headers: new Headers({ "memento-datetime": "Wed, 21 Oct 2026 01:48:48 GMT" }), bytes: new TextEncoder().encode("<title>Wayback Machine</title>") })).toBe(true);
    expect(isWaybackPage({ headers: new Headers({ "memento-datetime": "Wed, 21 Oct 2026 01:48:48 GMT", "x-archive-wayback-runtime-error": "RobotAccessControlException" }), bytes: new Uint8Array() })).toBe(true);
  });
});

describe("the requests a verification makes", () => {
  it("asks the source for the start of the file and the replay for the file, since the Wayback Machine 404s a range request for some captures", async () => {
    const seen: { url: string; range: string | null }[] = [];
    const network = scriptedNetwork((request) => {
      seen.push({ url: request.url, range: request.headers.get("range") });

      return request.url === RAW ? replay("a,b\n1,2\n") : live("a,b\n1,2\n");
    });
    const client = new PoliteClient(network.fetch, new FakeClock(), { ...TEST_POLITENESS, attempts: 1 });
    await verifyPin({ client, clock: new FakeClock() }, { url: U, timestamp: TS, live: true, compareStrictly: true }, 1);
    expect(seen.find((request) => request.url === RAW)?.range).toBeNull();
    expect(seen.find((request) => request.url === U)?.range).toBe(`bytes=0-${String(FIRST_BYTES - 1)}`);
  });
});

describe("differences", () => {
  const both = (replayBody: string, liveBody: string, headers: Readonly<{ replay?: Record<string, string>; live?: Record<string, string> }> = {}) =>
    differences(
      { status: 206, url: RAW, headers: new Headers({ "content-type": "text/csv", ...headers.replay }), bytes: new TextEncoder().encode(replayBody) },
      { status: 206, url: U, headers: new Headers({ "content-type": "text/csv", ...headers.live }), bytes: new TextEncoder().encode(liveBody) },
    );

  it("finds nothing when the media type, the stated length and the first bytes agree, and nothing to compare when a side states a content encoding", () => {
    expect(both("a,b\n1,2\n", "a,b\n1,2\n")).toEqual([]);
    expect(both("a,b\n", "a,b\n1,2\n")).toEqual([]);
    expect(differences({ status: 206, url: RAW, headers: new Headers({ "content-type": "text/csv", "content-encoding": "gzip" }), bytes: new Uint8Array() }, { status: 206, url: U, headers: new Headers({ "content-type": "text/csv" }), bytes: new Uint8Array() })).toEqual([]);
  });

  it("does not hold an HTML page to the source's stated length, since a page's length moves with its dynamic parts", () => {
    const html = { "content-type": "text/html; charset=utf-8" };
    expect(both("<p>x</p>", "<p>x</p>", { replay: { ...html, "content-length": "17768" }, live: { ...html, "content-length": "17758" } })).toEqual([]);
    expect(both("<p>x</p>", "<p>y</p>", { replay: html, live: html })).toEqual(["the first bytes differ"]);
  });

  it("reads a Content-Type sent more than once, which Headers joins with commas, as the last type it names", () => {
    const repeated = new Headers({ "content-type": "application/octet-stream" });
    repeated.append("content-type", "application/octet-stream");
    const body = new TextEncoder().encode("PK");
    const head = (headers: Headers, url: string) => ({ status: 206, url, headers, bytes: body });
    expect(differences(head(new Headers({ "content-type": "application/octet-stream" }), RAW), head(repeated, U))).toEqual([]);
    const changed = new Headers({ "content-type": "text/plain" });
    changed.append("content-type", "application/zip; charset=binary");
    expect(differences(head(new Headers({ "content-type": "application/zip" }), RAW), head(changed, U))).toEqual([]);
    const quoted = new Headers({ "content-type": 'text/csv; header="a,b"' });
    expect(differences(head(new Headers({ "content-type": "text/csv" }), RAW), head(quoted, U))).toEqual([]);
  });

  it("names a different media type, a different stated length and different first bytes", () => {
    expect(both("a,b\n", "a,b\n", { replay: { "content-type": "text/html" } })).toEqual(["the capture is text/html and the source is text/csv"]);
    expect(both("a,b\n", "a,b\n", { replay: { "content-range": "bytes 0-1023/12" }, live: { "content-range": "bytes 0-1023/13" } })).toEqual(["the capture is 12 bytes and the source 13"]);
    expect(both("a,b\n1,2\n", "a,b\n3,4\n")).toEqual(["the first bytes differ"]);
  });
});

describe("verifyPin", () => {
  /** A pin on U at TS, live and compared strictly, as a capture made in this run is. */
  const pin = { url: U, timestamp: TS, live: true, compareStrictly: true } as const;

  it("verifies a raw snapshot that serves the source's own bytes", async () => {
    const clock = new FakeClock();
    const client = new PoliteClient(scriptedNetwork((request) => (request.url === RAW ? replay("a,b\n1,2\n") : live("a,b\n1,2\n"))).fetch, clock, { ...TEST_POLITENESS, attempts: 1 });
    const verdict = await verifyPin({ client, clock }, pin, 1);
    expect(verdict).toEqual({ kind: "verified", notes: [] });
  });

  it("fails a raw snapshot that answers 404 with the Wayback Machine's page, and fails a capture that replays as another moment", async () => {
    const clock = new FakeClock();
    const notServed = new PoliteClient(scriptedNetwork((request) => (request.url === RAW ? waybackPage() : live("a,b\n1,2\n"))).fetch, clock, { ...TEST_POLITENESS, attempts: 1 });
    expect(await verifyPin({ client: notServed, clock }, pin, 1)).toEqual({ kind: "failed", reason: "not-served", evidence: "the raw snapshot answered HTTP 404 with the Wayback Machine's page" });
    const servedOwnPage = new PoliteClient(scriptedNetwork((request) => (request.url === RAW ? replay("<title>Wayback Machine</title>", { headers: { "content-type": "text/html" } }) : live("a,b\n1,2\n"))).fetch, clock, { ...TEST_POLITENESS, attempts: 1 });
    expect(await verifyPin({ client: servedOwnPage, clock }, pin, 1)).toMatchObject({ kind: "failed", reason: "wayback-page" });
    const otherLanding = `https://web.archive.org/web/20261021014999id_/${U}`;
    const otherCapture = new PoliteClient(scriptedNetwork((request) => (request.url === RAW ? replay("a,b\n1,2\n", { landing: otherLanding }) : live("a,b\n1,2\n"))).fetch, clock, { ...TEST_POLITENESS, attempts: 1 });
    expect(await verifyPin({ client: otherCapture, clock }, pin, 1)).toMatchObject({ kind: "failed", reason: "other-capture" });
  });

  it("holds a fresh capture to the live source and notes a difference an older pin tolerates", async () => {
    const clock = new FakeClock();
    const script = (request: Readonly<{ url: string }>) => (request.url === RAW ? replay("a,b\n1,2\n", { headers: { "content-type": "text/html" } }) : live("a,b\n1,2\n"));
    const client = new PoliteClient(scriptedNetwork(script).fetch, clock, { ...TEST_POLITENESS, attempts: 1 });
    expect(await verifyPin({ client, clock }, pin, 1)).toMatchObject({ kind: "failed", reason: "differs-from-source" });
    expect(await verifyPin({ client, clock }, { ...pin, compareStrictly: false }, 1)).toMatchObject({ kind: "verified", notes: ["the capture is text/html and the source is text/csv"] });
  });

  it("asks again while the answer may be indexing lag, then accepts the capture", async () => {
    const clock = new FakeClock();
    let looks = 0;
    const client = new PoliteClient(
      scriptedNetwork((request) => {
        if (request.url !== RAW) {
          return live("a,b\n1,2\n");
        }
        looks += 1;

        return looks === 1 ? waybackPage() : replay("a,b\n1,2\n");
      }).fetch,
      clock,
      { ...TEST_POLITENESS, attempts: 1 },
    );
    const verdict = await verifyPin({ client, clock }, pin, VERIFY_ATTEMPTS);
    expect(verdict).toEqual({ kind: "verified", notes: [] });
    expect(looks).toBe(2);
    expect(clock.sleeps).toContain(VERIFY_BACKOFF_MILLISECONDS);
  });

  it("stops asking once the attempts are spent and reports the capture not served", async () => {
    const clock = new FakeClock();
    let looks = 0;
    const client = new PoliteClient(
      scriptedNetwork((request) => {
        if (request.url !== RAW) {
          return live("a,b\n1,2\n");
        }
        looks += 1;

        return waybackPage();
      }).fetch,
      clock,
      { ...TEST_POLITENESS, attempts: 1 },
    );
    expect(await verifyPin({ client, clock }, pin, VERIFY_ATTEMPTS)).toMatchObject({ kind: "failed", reason: "not-served" });
    expect(looks).toBe(VERIFY_ATTEMPTS);
  });

  it("calls a busy archive busy, without failing the pin", async () => {
    const clock = new FakeClock();
    const throttled = new PoliteClient(scriptedNetwork((request) => (request.url === RAW ? new Response(null, { status: HTTP_STATUS.tooManyRequests }) : live("a,b\n1,2\n"))).fetch, clock, { ...TEST_POLITENESS, attempts: 1 });
    expect(await verifyPin({ client: throttled, clock }, pin, 1)).toMatchObject({ kind: "busy" });
    const down = new PoliteClient(scriptedNetwork((request) => (request.url === RAW ? connectionError("ECONNREFUSED") : live("a,b\n1,2\n"))).fetch, clock, { ...TEST_POLITENESS, attempts: 1 });
    expect(await verifyPin({ client: down, clock }, pin, 1)).toMatchObject({ kind: "busy" });
  });

  it("does not ask a dead source for its bytes", async () => {
    const clock = new FakeClock();
    const seen: string[] = [];
    const client = new PoliteClient(
      scriptedNetwork((request) => {
        seen.push(request.url);

        return request.url === RAW ? replay("a,b\n1,2\n") : new Response(null, { status: 500 });
      }).fetch,
      clock,
      { ...TEST_POLITENESS, attempts: 1 },
    );
    expect(await verifyPin({ client, clock }, { ...pin, live: false }, 1)).toEqual({ kind: "verified", notes: [] });
    expect(seen).toEqual([RAW]);
  });

  it("reads only the first bytes of a long body", async () => {
    const clock = new FakeClock();
    let cancelled = false;
    const long = new Response(new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode("a,b\n"));
        controller.enqueue(new TextEncoder().encode("1,2\n".repeat(FIRST_BYTES)));
      },
      cancel: () => {
        cancelled = true;
      },
    }), { status: HTTP_STATUS.partialContent, headers: { "memento-datetime": "Wed, 21 Oct 2026 01:48:48 GMT", "content-type": "text/csv" } });
    Object.defineProperty(long, "url", { value: RAW });
    const client = new PoliteClient(scriptedNetwork((request) => (request.url === RAW ? long : live("a,b\n1,2\n"))).fetch, clock, { ...TEST_POLITENESS, attempts: 1 });
    expect(await verifyPin({ client, clock }, pin, 1)).toMatchObject({ kind: "verified" });
    expect(cancelled).toBe(true);
  });
});
