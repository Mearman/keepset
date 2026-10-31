import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { KeepsetError } from "../errors";
import type { ByteRange } from "../source-bytes";

/** The most redirects one download follows: the Fetch Standard's own limit (https://fetch.spec.whatwg.org/#http-redirect-fetch, step 5). */
const MAX_REDIRECTS = 20;

/** The status codes that redirect, and so carry a `location` to follow (RFC 9110, section 15.4). */
const REDIRECT_STATUS = { movedPermanently: 301, found: 302, seeOther: 303, temporaryRedirect: 307, permanentRedirect: 308 } as const;
const REDIRECTS: ReadonlySet<number> = new Set(Object.values(REDIRECT_STATUS));

/** The statuses a response has no body with (the Fetch Standard's null body statuses, https://fetch.spec.whatwg.org/#null-body-status), which a Response cannot be built with a body for. */
const NULL_BODY_STATUS = { switchingProtocols: 101, earlyHints: 103, noContent: 204, resetContent: 205, notModified: 304 } as const;
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set(Object.values(NULL_BODY_STATUS));

/** The status of a partial answer to a ranged request, and of a whole one (RFC 9110, sections 15.3.7 and 15.3.1). */
const PARTIAL_CONTENT = 206;
const OK = 200;

/** What the downloader says it is, so a server operator can tell where the traffic comes from. */
const USER_AGENT = "keepset (+https://github.com/Mearman/keepset)";

/** What the downloader accepts: anything, as the file is the recipe's to read. Node's HTTP client sends no `Accept` header of its own, and a server that content-negotiates a download (the VRP-REP host answers 406 to a request without one) refuses it; every other HTTP client sends this, and RFC 9110 reads an absent header as the same. */
const ACCEPT = "*/*";

/** How long a connection may send nothing, at any point of a download, before it is given up as dead. A healthy server of the open data portals recipes read sends something every few seconds even while it prepares a large page, and a socket that has gone silent otherwise holds the download for ever, as one did in the middle of a table of millions of rows. */
export const STALL_MILLISECONDS = 120_000;

/** How many times a download is tried when its connection fails, and how long each retry waits for the one before it (the delay times the attempt number), so a network that drops for a few seconds is waited out and not hammered. A connection that fails in the middle of a body is one of the tries, and the try after it resumes where the body broke off. */
export const DOWNLOAD_ATTEMPTS = 3;
export const RETRY_DELAY_MILLISECONDS = 3000;

/** Options for one download: the signal that aborts it, the range of the file to ask for (the whole file when absent), how long a silent connection is waited on (`STALL_MILLISECONDS`), and how long a retry waits (`RETRY_DELAY_MILLISECONDS`), the last two only shortened by a test. */
export interface DownloadInit {
  readonly signal?: AbortSignal;
  readonly range?: ByteRange;
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
 * @param headers - The request's headers beyond those every request sends.
 * @param signal - Aborts the request.
 * @param stall - How many milliseconds the connection may send nothing, in the head or the body that follows.
 * @returns The response.
 * @throws KeepsetError when the connection stalls.
 */
async function get(url: URL, headers: Readonly<Record<string, string>>, signal: AbortSignal | undefined, stall: number): Promise<IncomingMessage> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    let answered: IncomingMessage | undefined;
    const request = send(
      url,
      { method: "GET", headers: { accept: ACCEPT, "user-agent": USER_AGENT, ...headers }, ...(signal === undefined ? {} : { signal }) },
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

/** A final answer, its body unread, with the status line Node sets on every response a client request receives. */
interface Answer {
  readonly message: IncomingMessage;
  readonly status: number;
  readonly statusText: string;
}

/**
 * Requests one URL, following its redirects by recursion.
 * @param url - The URL to request.
 * @param headers - The request's own headers, sent on every hop.
 * @param init - The request options.
 * @param redirects - How many redirects led here.
 * @returns The final answer.
 */
async function follow(url: URL, headers: Readonly<Record<string, string>>, init: DownloadInit, redirects: number): Promise<Answer> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new KeepsetError(`${url.href} is not an http or https URL`);
  }
  const message = await get(url, headers, init.signal, init.stallMilliseconds ?? STALL_MILLISECONDS);
  const { statusCode: status, statusMessage } = message;
  // Node sets both on every response a client request receives; the types are optional only because IncomingMessage also models server-side requests.
  if (status === undefined || statusMessage === undefined) {
    throw new KeepsetError(`${url.href} answered without a status line`);
  }
  if (!REDIRECTS.has(status)) {
    return { message, status, statusText: statusMessage };
  }
  message.resume();
  const { location } = message.headers;
  if (location === undefined) {
    throw new KeepsetError(`${url.href} answered ${String(status)} without a location`);
  }
  if (redirects === MAX_REDIRECTS) {
    throw new KeepsetError(`${url.href} redirected more than ${String(MAX_REDIRECTS)} times`);
  }

  return follow(new URL(location, url), headers, init, redirects + 1);
}

/** The tries one download has made, shared by its first request and every resumption of its body. */
class Tries {
  /** How many tries have been made, the first among them. */
  private made = 1;

  /**
   * Waits before the next try of a failed connection, or rethrows the failure when no try is left or the failure is not the connection's.
   * @param error - The failure.
   * @param init - The request options.
   * @throws The failure, when it is not to be tried again.
   */
  public async again(error: unknown, init: DownloadInit): Promise<void> {
    if (this.made >= DOWNLOAD_ATTEMPTS || init.signal?.aborted === true || !isConnectionFailure(error)) {
      throw error;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, (init.retryDelayMilliseconds ?? RETRY_DELAY_MILLISECONDS) * this.made);
    });
    this.made += 1;
  }
}

/**
 * Requests a URL until it answers or the tries run out, waiting between tries while the connection fails.
 * @param url - The URL.
 * @param headers - The request's own headers.
 * @param init - The request options.
 * @param tries - The tries made so far, counted on.
 * @returns The answer.
 * @throws The last failure when the tries are used up, or at once for a failure that is not the connection's.
 */
async function open(url: string, headers: Readonly<Record<string, string>>, init: DownloadInit, tries: Tries): Promise<Answer> {
  try {
    return await follow(new URL(url), headers, init, 0);
  } catch (error) {
    await tries.again(error, init);

    return open(url, headers, init, tries);
  }
}

/**
 * The `Range` header asking for the bytes of a file from one offset, to the end of a range or of the file.
 * @param from - The first byte wanted.
 * @param end - The offset just past the last byte wanted, or undefined for the end of the file.
 * @returns The header.
 */
function rangeHeader(from: number, end: number | undefined): Record<string, string> {
  return { range: `bytes=${String(from)}-${end === undefined ? "" : String(end - 1)}` };
}

/**
 * The response's headers as a Headers object, every value kept and an array-valued header appended value by value: the resolution chain reads `content-encoding` (whether the bytes are a transport encoding of the page, which this downloader leaves as served) and `warning` (which the Wayback Machine gives a capture it truncated), and a store reads `accept-ranges`, `content-length` and `content-range`.
 * @param headers - The headers Node parsed.
 * @returns The headers.
 */
function headersOf(headers: IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    for (const each of typeof value === "string" ? [value] : (value ?? [])) {
      result.append(name, each);
    }
  }

  return result;
}

/**
 * The validator a resumption sends as `If-Range`, so a file that changed since the download began is never resumed into: a strong entity tag, or else the last-modified date (RFC 9110, section 13.1.5).
 * @param headers - The first answer's headers.
 * @returns The validator, or undefined when the answer gave none.
 */
function validatorOf(headers: IncomingHttpHeaders): string | undefined {
  const { etag } = headers;
  if (etag !== undefined && !etag.startsWith("W/")) {
    return etag;
  }

  return headers["last-modified"];
}

/**
 * The offset a `Content-Range` header says a partial answer starts at.
 * @param header - The header.
 * @returns The offset, or undefined when the header is absent or not a byte range.
 */
function rangeStartOf(header: string | undefined): number | undefined {
  const match = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(header ?? "");

  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The body of a download as a stream, which resumes where it broke off when its connection fails, as one of the download's tries: a ranged request for the rest when the server answers one, and otherwise the whole file again with the bytes already delivered skipped. A server that said it reads ranges and answers a resumption whole has a file that changed, which fails the download rather than joining two files.
 * @param url - The URL.
 * @param init - The request options.
 * @param first - The first answer.
 * @param tries - The tries made so far, counted on.
 * @returns The body.
 */
function bodyOf(url: string, init: DownloadInit, first: Answer, tries: Tries): ReadableStream<Uint8Array> {
  // The range the body is part of, when the first answer gave the range asked for rather than the whole file.
  const range = first.status === PARTIAL_CONTENT ? init.range : undefined;
  const ranged = range !== undefined;
  const start = range?.offset ?? 0;
  const end = range === undefined ? undefined : range.offset + range.length;
  const validator = validatorOf(first.message.headers);
  const readsRanges = first.message.headers["accept-ranges"] === "bytes";
  let message = first.message;
  let chunks = message[Symbol.asyncIterator]();
  let delivered = 0;
  let skip = 0;

  const resume = async (): Promise<void> => {
    const from = start + delivered;
    const answer = await open(url, { ...rangeHeader(from, end), ...(validator === undefined ? {} : { "if-range": validator }) }, init, tries);
    if (answer.status === PARTIAL_CONTENT && rangeStartOf(answer.message.headers["content-range"]) === from) {
      skip = 0;
    } else if (answer.status === OK && !ranged && !(readsRanges && validator !== undefined)) {
      skip = from;
    } else {
      answer.message.destroy();
      throw new KeepsetError(`${url} answered ${String(answer.status)} ${answer.statusText} when the download was resumed at byte ${String(from)}, so the file may have changed while it was read and the download was given up`);
    }
    message = answer.message;
    chunks = message[Symbol.asyncIterator]();
  };

  /**
   * The next bytes of the body to deliver: the next chunk, past any bytes a whole-file resumption repeats, resuming first when the connection has failed.
   * @returns The bytes, or undefined at the body's end.
   */
  const nextBytes = async (): Promise<Uint8Array | undefined> => {
    let next: IteratorResult<unknown>;
    try {
      next = await chunks.next();
    } catch (error) {
      await tries.again(error, init);
      await resume();

      return nextBytes();
    }
    if (next.done === true) {
      return undefined;
    }
    const { value } = next;
    if (!(value instanceof Uint8Array)) {
      throw new KeepsetError("the response body yielded a chunk that is not bytes");
    }
    const dropped = Math.min(skip, value.length);
    skip -= dropped;
    if (dropped === value.length) {
      return nextBytes();
    }
    delivered += value.length - dropped;

    return new Uint8Array(value.buffer, value.byteOffset + dropped, value.length - dropped);
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const bytes = await nextBytes();
      if (bytes === undefined) {
        controller.close();
      } else {
        controller.enqueue(bytes);
      }
    },
    cancel() {
      message.destroy();
    },
  });
}

/**
 * Downloads a URL's bytes exactly as the server sends them, following redirects; the response carries the server's headers, `Content-Encoding` among them, so the caller can tell a transport encoding from a compressed file. Unlike the platform `fetch`, it never undoes a `Content-Encoding`: servers commonly label a `.gz` file `Content-Encoding: gzip`, and a recipe that unpacks gzip needs the file as published, which is also what its SHA-256 is recorded over. No `Accept-Encoding` is sent, so a server that compresses on the fly has no reason to. The body streams as it arrives, so a file of any size is passed on without being held, and a connection that fails in the middle of it is resumed (see `bodyOf`). With a `range`, the server is asked for those bytes only; it may answer 206 with them or 200 with the whole file, and the caller reads which from the status.
 * @param url - An http or https URL.
 * @param init - The request options.
 * @returns A Response whose body is the raw bytes, with the final status and headers; reading the body fails with the connection's failure when it keeps failing after the tries.
 * @throws KeepsetError when a redirect has no location, leaves http and https, or passes the redirect limit; the connection's failure, after the tries, when it keeps failing or sends nothing for longer than the stall time before the answer.
 */
export async function downloadRaw(url: string, init: DownloadInit): Promise<Response> {
  const tries = new Tries();
  const { range } = init;
  const first = await open(url, range === undefined ? {} : rangeHeader(range.offset, range.offset + range.length), init, tries);
  const head = { status: first.status, statusText: first.statusText, headers: headersOf(first.message.headers) };
  if (NULL_BODY_STATUSES.has(first.status)) {
    first.message.resume();

    return new Response(null, head);
  }

  return new Response(bodyOf(url, init, first, tries), head);
}
