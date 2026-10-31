import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeepsetError } from "../errors";
import { DOWNLOAD_ATTEMPTS, downloadRaw } from "./download";

const gzipped = gzipSync("1 2\n");

const STATUS = { ok: 200, partialContent: 206, movedPermanently: 301, found: 302, notFound: 404, notAcceptable: 406 } as const;

/** The body a connection breaks in the middle of, where it breaks, and the strong entity tag a host that reads ranges gives it. */
const DIGITS_REPEATED = 10;
const BROKEN_BODY = new TextEncoder().encode("0123456789".repeat(DIGITS_REPEATED));
const BREAK_AT = 40;
const ETAG = '"v1"';

/** A local server standing in for the hosts recipes download from: no test touches the network. */
let server: Server;
let base: string;
const drops = new Map<string, number>();
/** The range and validator headers each request of a breaking path carried, by path. */
const breaks = new Map<string, { readonly range: string | undefined; readonly ifRange: string | string[] | undefined }[]>();

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/labelled.gz") {
      // What the Wayback Machine and many static hosts do with a .gz file: label it with a transport encoding the platform fetch would undo.
      response.writeHead(STATUS.ok, { "content-encoding": "gzip", "content-type": "text/plain" });
      response.end(gzipped);
    } else if (path === "/truncated") {
      // What the Wayback Machine replays for a capture that stopped at its size limit.
      response.writeHead(STATUS.ok, { warning: '299 wayback content truncated by "length"' });
      response.end("prefix");
    } else if (path.startsWith("/hop/")) {
      const remaining = Number(path.slice("/hop/".length));
      response.writeHead(STATUS.found, { location: remaining === 0 ? "/labelled.gz" : `/hop/${String(remaining - 1)}` });
      response.end();
    } else if (path === "/nowhere") {
      response.writeHead(STATUS.movedPermanently);
      response.end();
    } else if (path === "/agent") {
      response.end(request.headers["user-agent"]);
    } else if (path === "/negotiated") {
      // A host that content-negotiates a download and refuses a request that states no preference, as the VRP-REP host does.
      if (request.headers.accept === undefined) {
        response.writeHead(STATUS.notAcceptable);
        response.end();
      } else {
        response.end("negotiated");
      }
    } else if (path === "/slow") {
      // Never answers, so only an abort ends the request.
    } else if (path.startsWith("/drops/")) {
      // Drops the connection without an answer for the first requests of a path, as a flaky network does, then answers.
      const [, , name, allowed] = path.split("/");
      const key = name ?? "";
      drops.set(key, (drops.get(key) ?? 0) + 1);
      if ((drops.get(key) ?? 0) <= Number(allowed)) {
        request.socket.destroy();
      } else {
        response.end("recovered");
      }
    } else if (path.startsWith("/breaks/")) {
      // Sends the start of the body and drops the connection, then answers the next request as the kind of host the path names: one that reads ranges and resumes, one that does not and sends the whole file again, and one whose file changed, which answers a resumption whole.
      const [, , kind, name] = path.split("/");
      const key = `${kind ?? ""}/${name ?? ""}`;
      const tries = (breaks.get(key)?.length ?? 0) + 1;
      breaks.set(key, [...(breaks.get(key) ?? []), { range: request.headers.range, ifRange: request.headers["if-range"] }]);
      const ranges = kind === "resumes" || kind === "changes" ? { "accept-ranges": "bytes", etag: ETAG } : {};
      if (tries === 1) {
        response.writeHead(STATUS.ok, { "content-length": String(BROKEN_BODY.length), ...ranges });
        response.write(BROKEN_BODY.subarray(0, BREAK_AT), () => {
          request.socket.destroy();
        });
      } else if (kind === "resumes") {
        response.writeHead(STATUS.partialContent, { "content-range": `bytes ${String(BREAK_AT)}-${String(BROKEN_BODY.length - 1)}/${String(BROKEN_BODY.length)}`, ...ranges });
        response.end(BROKEN_BODY.subarray(BREAK_AT));
      } else {
        response.writeHead(STATUS.ok, ranges);
        response.end(BROKEN_BODY);
      }
    } else if (path === "/ranged") {
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? "");
      if (match === null) {
        response.end(BROKEN_BODY);
      } else {
        const [first, last] = [Number(match[1]), Number(match[2])];
        response.writeHead(STATUS.partialContent, { "content-range": `bytes ${String(first)}-${String(last)}/${String(BROKEN_BODY.length)}` });
        response.end(BROKEN_BODY.subarray(first, last + 1));
      }
    } else if (path === "/stalls-mid-body") {
      // Answers, sends the start of a body and then goes silent, as a dead connection does in the middle of a large download.
      response.writeHead(STATUS.ok, { "content-length": "100" });
      response.write("partial");
    } else {
      response.writeHead(STATUS.notFound, "Not Found");
      response.end("missing");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the test server has no TCP address");
  }
  base = `http://127.0.0.1:${String((address satisfies AddressInfo).port)}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe("downloadRaw", () => {
  it("returns the bytes as served, never undoing a Content-Encoding", async () => {
    const response = await downloadRaw(`${base}/labelled.gz`, {});
    expect(response.status).toBe(STATUS.ok);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(gzipped));
  });

  it("reports the server's Content-Encoding on the response, so a caller can tell a transport encoding from a compressed file", async () => {
    expect((await downloadRaw(`${base}/labelled.gz`, {})).headers.get("content-encoding")).toBe("gzip");
  });

  it("reports the Warning header, so a caller can tell a truncated capture from a whole file", async () => {
    expect((await downloadRaw(`${base}/truncated`, {})).headers.get("warning")).toBe('299 wayback content truncated by "length"');
    expect((await downloadRaw(`${base}/agent`, {})).headers.get("warning")).toBeNull();
  });

  it("follows redirects to the final response", async () => {
    const hops = 3;
    const response = await downloadRaw(`${base}/hop/${String(hops)}`, {});
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(gzipped));
  });

  it("refuses a redirect chain past the Fetch Standard's limit", async () => {
    const tooMany = 25;
    await expect(downloadRaw(`${base}/hop/${String(tooMany)}`, {})).rejects.toThrow(/redirected more than 20 times/);
  });

  it("refuses a redirect without a location", async () => {
    await expect(downloadRaw(`${base}/nowhere`, {})).rejects.toThrow(KeepsetError);
  });

  it("gives up a connection that sends nothing, before the answer and in the middle of a body", async () => {
    const stallMilliseconds = 50;
    await expect(downloadRaw(`${base}/slow`, { stallMilliseconds, retryDelayMilliseconds: 1 })).rejects.toThrow(/sent nothing for 50 milliseconds/);
    // The body streams, so a stall in the middle of it fails the reading of the body, once the tries that resume it are used up.
    await expect(downloadRaw(`${base}/stalls-mid-body`, { stallMilliseconds, retryDelayMilliseconds: 1 }).then(async (response) => response.arrayBuffer())).rejects.toThrow(/sent nothing for 50 milliseconds/);
  });

  it("tries again when the connection drops, waits between tries, and gives up after the tries", async () => {
    const retryDelayMilliseconds = 1;
    const recovered = await downloadRaw(`${base}/drops/flaky/2`, { retryDelayMilliseconds });
    expect(await recovered.text()).toBe("recovered");
    expect(drops.get("flaky")).toBe(DOWNLOAD_ATTEMPTS);
    await expect(downloadRaw(`${base}/drops/hopeless/9`, { retryDelayMilliseconds })).rejects.toThrow();
    expect(drops.get("hopeless")).toBe(DOWNLOAD_ATTEMPTS);
  });

  it("resumes a body whose connection breaks from the byte it broke at, asking only for the rest when the host reads ranges", async () => {
    const response = await downloadRaw(`${base}/breaks/resumes/one`, { retryDelayMilliseconds: 1 });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BROKEN_BODY);
    expect(breaks.get("resumes/one")).toEqual([
      { range: undefined, ifRange: undefined },
      { range: `bytes=${String(BREAK_AT)}-`, ifRange: ETAG },
    ]);
  });

  it("skips the bytes already delivered when a host that does not read ranges sends the whole file again", async () => {
    const response = await downloadRaw(`${base}/breaks/restarts/one`, { retryDelayMilliseconds: 1 });
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BROKEN_BODY);
  });

  it("gives the download up rather than join two files when a host that reads ranges answers the resumption whole", async () => {
    const response = await downloadRaw(`${base}/breaks/changes/one`, { retryDelayMilliseconds: 1 });
    await expect(response.arrayBuffer()).rejects.toThrow(/answered 200 OK when the download was resumed at byte 40, so the file may have changed/);
  });

  it("asks for a range when given one, and passes the partial answer through", async () => {
    const response = await downloadRaw(`${base}/ranged`, { range: { offset: 3, length: 4 } });
    expect([response.status, response.headers.get("content-range"), await response.text()]).toEqual([STATUS.partialContent, "bytes 3-6/100", "3456"]);
  });

  it("does not try again for a failure that is not the connection's", async () => {
    await expect(downloadRaw(`${base}/nowhere`, { retryDelayMilliseconds: 1 })).rejects.toThrow(KeepsetError);
    await expect(downloadRaw("ftp://example.org/x", { retryDelayMilliseconds: 1 })).rejects.toThrow(/not an http or https URL/);
  });

  it("passes a failing status through for the recipe to report", async () => {
    const response = await downloadRaw(`${base}/absent`, {});
    expect([response.status, response.statusText]).toEqual([STATUS.notFound, "Not Found"]);
  });

  it("names itself to the server", async () => {
    expect(await (await downloadRaw(`${base}/agent`, {})).text()).toMatch(/^keepset /);
  });

  it("states that it accepts any media type, which a host that content-negotiates a download requires", async () => {
    expect(await (await downloadRaw(`${base}/negotiated`, {})).text()).toBe("negotiated");
  });

  it("stops when the signal aborts", async () => {
    const controller = new AbortController();
    const pending = downloadRaw(`${base}/slow`, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});
