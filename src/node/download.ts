import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { KeepsetError } from "../errors";

/** The most redirects one download follows: the Fetch Standard's own limit (https://fetch.spec.whatwg.org/#http-redirect-fetch, step 5). */
const MAX_REDIRECTS = 20;

/** The status codes that redirect, and so carry a `location` to follow (RFC 9110, section 15.4). */
const REDIRECT_STATUS = { movedPermanently: 301, found: 302, seeOther: 303, temporaryRedirect: 307, permanentRedirect: 308 } as const;
const REDIRECTS: ReadonlySet<number> = new Set(Object.values(REDIRECT_STATUS));

/** What the downloader says it is, so a server operator can tell where the traffic comes from. */
const USER_AGENT = "keepset (+https://github.com/Mearman/keepset)";

/** What the downloader accepts: anything, as the file is the recipe's to read. Node's HTTP client sends no `Accept` header of its own, and a server that content-negotiates a download (the VRP-REP host answers 406 to a request without one) refuses it; every other HTTP client sends this, and RFC 9110 reads an absent header as the same. */
const ACCEPT = "*/*";

/** How long a connection may send nothing, at any point of a download, before it is given up as dead. A healthy server of the open data portals recipes read sends something every few seconds even while it prepares a large page, and a socket that has gone silent otherwise holds the download for ever, as one did in the middle of a table of millions of rows. */
export const STALL_MILLISECONDS = 120_000;

/** How many times a download is tried when its connection fails, and how long each retry waits for the one before it (the delay times the attempt number), so a network that drops for a few seconds is waited out and not hammered. */
export const DOWNLOAD_ATTEMPTS = 3;
export const RETRY_DELAY_MILLISECONDS = 3000;

/** Options for one download: the signal that aborts it, how long a silent connection is waited on (`STALL_MILLISECONDS`), and how long a retry waits (`RETRY_DELAY_MILLISECONDS`), the last two only shortened by a test. */
export interface DownloadInit {
  readonly signal?: AbortSignal;
  readonly stallMilliseconds?: number;
  readonly retryDelayMilliseconds?: number;
}

/** The failure of a connection that sent nothing for the stall time. */
class StalledError extends KeepsetError {}

/**
 * Whether a failure is the connection's and may pass: a stall, or a socket error such as a reset, a broken pipe or a timeout, which carries an `E` code. A bad URL, a redirect that leads nowhere and an abort are not.
 * @param error - The failure.
 * @returns True when asking again may succeed.
 */
function isConnectionFailure(error: unknown): boolean {
  return error instanceof StalledError || (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && /^E[A-Z]+$/.test(error.code) && error.code !== "ERR_INVALID_URL");
}

/**
 * Sends one GET and resolves with the response head, its body still unread.
 * @param url - The URL.
 * @param signal - Aborts the request.
 * @param stall - How many milliseconds the connection may send nothing, in the head or the body that follows.
 * @returns The response.
 * @throws KeepsetError when the connection stalls.
 */
async function get(url: URL, signal: AbortSignal | undefined, stall: number): Promise<IncomingMessage> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    let answered: IncomingMessage | undefined;
    const request = send(
      url,
      { method: "GET", headers: { accept: ACCEPT, "user-agent": USER_AGENT }, ...(signal === undefined ? {} : { signal }) },
      (response) => {
        answered = response;
        resolve(response);
      },
    );
    request.setTimeout(stall, () => {
      const dead = new StalledError(`${url.href} sent nothing for ${String(stall)} milliseconds, so the connection was given up as dead`);
      // Once the head has arrived the failure belongs to the body being read, which the response reports; before it, to the request.
      (answered ?? request).destroy(dead);
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Reads a response body to the end.
 * @param response - The response.
 * @returns The body's bytes.
 */
async function readBody(response: IncomingMessage): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response) {
    if (!(chunk instanceof Uint8Array)) {
      throw new KeepsetError("the response body yielded a chunk that is not bytes");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

/**
 * Requests one URL, following its redirects by recursion.
 * @param url - The URL to request.
 * @param init - The request options.
 * @param redirects - How many redirects led here.
 * @returns The final response.
 */
async function follow(url: URL, init: DownloadInit, redirects: number): Promise<Response> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new KeepsetError(`${url.href} is not an http or https URL`);
  }
  const response = await get(url, init.signal, init.stallMilliseconds ?? STALL_MILLISECONDS);
  const { statusCode: status, statusMessage } = response;
  // Node sets both on every response a client request receives; the types are optional only because IncomingMessage also models server-side requests.
  if (status === undefined || statusMessage === undefined) {
    throw new KeepsetError(`${url.href} answered without a status line`);
  }
  if (!REDIRECTS.has(status)) {
    // The one header the resolution chain reads: whether the bytes are a transport encoding of the page, which this downloader leaves as served.
    const contentEncoding = response.headers["content-encoding"];

    return new Response(await readBody(response), { status, statusText: statusMessage, ...(contentEncoding === undefined ? {} : { headers: { "content-encoding": contentEncoding } }) });
  }
  response.resume();
  const { location } = response.headers;
  if (location === undefined) {
    throw new KeepsetError(`${url.href} answered ${String(status)} without a location`);
  }
  if (redirects === MAX_REDIRECTS) {
    throw new KeepsetError(`${url.href} redirected more than ${String(MAX_REDIRECTS)} times`);
  }

  return follow(new URL(location, url), init, redirects + 1);
}

/**
 * Downloads a URL's bytes exactly as the server sends them, following redirects; the response carries the server's `Content-Encoding`, so the caller can tell a transport encoding from a compressed file. Unlike the platform `fetch`, it never undoes a `Content-Encoding`: servers commonly label a `.gz` file `Content-Encoding: gzip`, and a recipe that unpacks gzip needs the file as published, which is also what its SHA-256 is recorded over. No `Accept-Encoding` is sent, so a server that compresses on the fly has no reason to.
 * @param url - An http or https URL.
 * @param init - The request options.
 * @returns A Response holding the raw bytes, with the final status.
 * @throws KeepsetError when a redirect has no location, leaves http and https, or passes the redirect limit; the connection's failure, after the tries, when it keeps failing or sends nothing for longer than the stall time.
 */
export async function downloadRaw(url: string, init: DownloadInit): Promise<Response> {
  return tryDownload(url, init, 1);
}

/**
 * One try of a download, and the tries after it while the connection fails.
 * @param url - The URL.
 * @param init - The request options.
 * @param attempt - Which try this is, from 1.
 * @returns The response.
 * @throws The last failure when the tries are used up, or at once for a failure that is not the connection's.
 */
async function tryDownload(url: string, init: DownloadInit, attempt: number): Promise<Response> {
  try {
    return await follow(new URL(url), init, 0);
  } catch (error) {
    if (attempt >= DOWNLOAD_ATTEMPTS || init.signal?.aborted === true || !isConnectionFailure(error)) {
      throw error;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, (init.retryDelayMilliseconds ?? RETRY_DELAY_MILLISECONDS) * attempt);
    });

    return tryDownload(url, init, attempt + 1);
  }
}
