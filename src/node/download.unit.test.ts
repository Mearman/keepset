import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KeepsetError } from "../errors";
import { DOWNLOAD_ATTEMPTS, downloadRaw } from "./download";

const gzipped = gzipSync("1 2\n");

const STATUS = { ok: 200, movedPermanently: 301, found: 302, notFound: 404, notAcceptable: 406 } as const;

/** A local server standing in for the hosts recipes download from: no test touches the network. */
let server: Server;
let base: string;
const drops = new Map<string, number>();

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "/";
    if (path === "/labelled.gz") {
      // What the Wayback Machine and many static hosts do with a .gz file: label it with a transport encoding the platform fetch would undo.
      response.writeHead(STATUS.ok, { "content-encoding": "gzip", "content-type": "text/plain" });
      response.end(gzipped);
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
    await expect(downloadRaw(`${base}/stalls-mid-body`, { stallMilliseconds, retryDelayMilliseconds: 1 })).rejects.toThrow(/sent nothing for 50 milliseconds/);
  });

  it("tries again when the connection drops, waits between tries, and gives up after the tries", async () => {
    const retryDelayMilliseconds = 1;
    const recovered = await downloadRaw(`${base}/drops/flaky/2`, { retryDelayMilliseconds });
    expect(await recovered.text()).toBe("recovered");
    expect(drops.get("flaky")).toBe(DOWNLOAD_ATTEMPTS);
    await expect(downloadRaw(`${base}/drops/hopeless/9`, { retryDelayMilliseconds })).rejects.toThrow();
    expect(drops.get("hopeless")).toBe(DOWNLOAD_ATTEMPTS);
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
