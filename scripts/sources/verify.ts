/* Whether a pinned snapshot serves its bytes back. `fetchDataset` reads a dead source from the raw `id_` form of its snapshot, so a pin is only a fallback if that URL answers with the captured bytes: a capture can be recorded and never be indexed, or be served as the Wayback Machine's own page. Everything outside reaches this through the polite client and the clock, so a unit test drives it with stand-ins. */

import { rawSnapshotUrl } from "../../src/entry";
import { HTTP_STATUS, isSuccess } from "./http-status";
import type { Clock } from "./pacing";
import { type PoliteClient, RequestFailure } from "./polite-client";
import { statedLength } from "./probe";

/** How many bytes of a replay and of the live source are read for the comparison: enough to tell a table from an HTML page and one file from another, small enough that a request for the start of a large download stays cheap. */
export const FIRST_BYTES = 1024;

/** How many times a fresh capture is looked up in all, and the wait before the second look (each later wait doubles it). The Wayback Machine indexes a capture some time after Save Page Now returns, so the first look may find nothing; the waits add up to a few minutes, and a capture still not served after that is treated as failed, so the pin is not accepted. */
export const VERIFY_ATTEMPTS = 4;
export const VERIFY_BACKOFF_MILLISECONDS = 30_000;

/** The marker of the Wayback Machine's own pages (its 404, its error and block pages): the title every one of them carries. A replay of an archived page never has it unless the archived page is the Wayback Machine's. */
const WAYBACK_PAGE_TITLE = "<title>Wayback Machine</title>";

/** The request headers of a lookup: the stored representation. */
const STORED_HEADERS = { "accept-encoding": "identity" };

/** The live source is asked for only the start of the file. A replay is not: the Wayback Machine answers a range request for a recent capture with its own 404 page while the same capture answers a plain request, so a replay is read from its start and dropped after the first bytes. */
const LIVE_HEADERS = { ...STORED_HEADERS, range: `bytes=0-${String(FIRST_BYTES - 1)}` };

/** The capture timestamp in the URL a raw replay finally answered from, after the Wayback Machine's redirects. */
const LANDING_TIMESTAMP = /^https:\/\/web\.archive\.org\/web\/(\d{14})id_\//;

/**
 * Why a pin does not serve its bytes:
 * - `not-served`: the raw form does not answer with the capture (a 404, an answer from a URL that is not a capture).
 * - `wayback-page`: it answers 200 with the Wayback Machine's own page, not the captured bytes.
 * - `other-capture`: a pin to one capture answers with the capture of another moment (named in the verdict's `landed`), so a recipe would read other bytes than the pin names.
 * - `differs-from-source`: the live source answers with a different kind of file, a different length or different first bytes than the capture.
 */
export type FailureReason = "not-served" | "wayback-page" | "other-capture" | "differs-from-source";

/**
 * What a look at one pin came to. `busy` says nothing about the pin (the archive is throttling or failing, or the connection dropped), so the pin stays as it was and is looked at again later.
 */
export type Verdict =
  | { readonly kind: "verified"; readonly notes: readonly string[] }
  | { readonly kind: "failed"; readonly reason: FailureReason; readonly evidence: string; readonly landed?: string }
  | { readonly kind: "busy"; readonly evidence: string };

/** What a request's answer carries that the verification reads: the final status and URL, the headers and the first bytes of the body. `bytes` is undefined when the body stream failed. */
interface Head {
  readonly status: number;
  readonly url: string;
  readonly headers: Headers;
  readonly bytes: Uint8Array | undefined;
}

/**
 * The next bytes of a body stream, read one chunk at a time because that is how a stream yields them.
 * @param reader - The body's reader.
 * @param chunks - The chunks read so far.
 * @param length - How many bytes they hold.
 * @returns At most `FIRST_BYTES` bytes, or undefined when the stream failed.
 */
async function readChunks(reader: ReadableStreamDefaultReader<Uint8Array>, chunks: readonly Uint8Array[], length: number): Promise<Uint8Array | undefined> {
  if (length >= FIRST_BYTES) {
    return join(chunks, length);
  }
  try {
    const { done, value } = await reader.read();
    if (done) {
      return join(chunks, length);
    }

    return await readChunks(reader, [...chunks, value], length + value.length);
  } catch {
    return undefined;
  }
}

/**
 * The first bytes of a response's body, then the rest of the body is dropped.
 * @param response - The response.
 * @returns At most `FIRST_BYTES` bytes, or undefined when the body stream failed.
 */
async function readPrefix(response: Response): Promise<Uint8Array | undefined> {
  const reader = response.body?.getReader();
  const prefix = reader === undefined ? new Uint8Array() : await readChunks(reader, [], 0);
  await reader?.cancel().catch(() => undefined);

  return prefix;
}

/**
 * The chunks read joined into one array of at most `FIRST_BYTES` bytes.
 * @param chunks - The chunks, in order.
 * @param length - How many bytes they hold in all.
 * @returns The joined prefix.
 */
function join(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }

  return joined.subarray(0, FIRST_BYTES);
}

/**
 * Requests the start of a URL.
 * @param client - The polite client.
 * @param url - The URL.
 * @param headers - The request headers.
 * @returns What it answered, or undefined when the connection failed on every attempt.
 */
async function look(client: PoliteClient, url: string, headers: Readonly<Record<string, string>>): Promise<Head | undefined> {
  try {
    const response = await client.request(url, { method: "GET", headers });

    return { status: response.status, url: response.url, headers: response.headers, bytes: await readPrefix(response) };
  } catch (error) {
    if (error instanceof RequestFailure) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Whether an answer is the Wayback Machine's own page and not a replay of a capture: a replay carries `memento-datetime` (RFC 7089), the Wayback Machine's replay errors name themselves in `x-archive-wayback-runtime-error`, and its pages carry its title.
 * @param head - The answer from the raw form of a snapshot.
 * @returns True when the answer is not a replay.
 */
export function isWaybackPage(head: Pick<Head, "bytes" | "headers">): boolean {
  const prefix = head.bytes === undefined ? "" : new TextDecoder().decode(head.bytes);

  return !head.headers.has("memento-datetime") || head.headers.has("x-archive-wayback-runtime-error") || prefix.includes(WAYBACK_PAGE_TITLE);
}

/** The media type of a page. */
const HTML = "text/html";

/** A media type, `type/subtype`, each an HTTP token (RFC 9110, section 8.3.1). */
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;

/** The media type of a `Content-Type`, without its parameters. A header sent more than once reaches `Headers` as one value joined with commas (Zenodo's file downloads send it twice), and the Fetch standard's MIME type extraction takes the last type named, so this does too; a piece that is not a media type (the tail of a quoted parameter holding a comma) is passed over. */
function mediaType(headers: Headers): string | undefined {
  return headers
    .get("content-type")
    ?.split(",")
    .map((value) => value.split(";")[0]?.trim().toLowerCase())
    .findLast((type) => type !== undefined && MEDIA_TYPE.test(type));
}

/**
 * How a replay compares with the live source it was captured from.
 * @param replay - The raw replay.
 * @param live - The live source's answer to the same request.
 * @returns The differences found; empty when the media type, the stated length and the first bytes agree, or when the two cannot be compared (either side states a content encoding, so the bytes read are not the stored ones, or either body could not be read).
 */
export function differences(replay: Head, live: Head): string[] {
  const { bytes: replayBytes } = replay;
  const { bytes: liveBytes } = live;
  if (replay.headers.has("content-encoding") || live.headers.has("content-encoding") || replayBytes === undefined || liveBytes === undefined) {
    return [];
  }
  const found: string[] = [];
  const replayType = mediaType(replay.headers);
  const liveType = mediaType(live.headers);
  if (replayType !== undefined && liveType !== undefined && replayType !== liveType) {
    found.push(`the capture is ${replayType} and the source is ${liveType}`);
  }
  const replayLength = statedLength(replay);
  const liveLength = statedLength(live);
  // A page's length moves with its dynamic parts (a "last checked" date, a session token), so for HTML only the type and the first bytes are held to the source.
  if (replayType !== HTML && replayLength !== undefined && liveLength !== undefined && replayLength !== liveLength) {
    found.push(`the capture is ${String(replayLength)} bytes and the source ${String(liveLength)}`);
  }
  const shared = Math.min(replayBytes.length, liveBytes.length);
  if (!replayBytes.subarray(0, shared).every((byte, index) => byte === liveBytes[index])) {
    found.push("the first bytes differ");
  }

  return found;
}

/** What one look at the raw form of a snapshot is judged against. */
export interface Pin {
  readonly url: string;
  readonly timestamp: string;
  /** Whether the source still serves the file, so its first bytes are there to compare. A source every entry records `dead` is not asked. */
  readonly live: boolean;
  /** Whether a difference from the live source fails the pin. A capture made or found in this run is held to the source as it is now; one recorded earlier is not, because the source may have changed since, and a difference is only noted. */
  readonly compareStrictly: boolean;
}

/**
 * One look at a pin's raw form, judged.
 * @param client - The polite client.
 * @param pin - The pin and how strictly to compare it.
 * @param live - The live source's first bytes, when it answers; looked up once by the caller so retries do not repeat it.
 * @returns The verdict.
 */
async function judge(client: PoliteClient, pin: Pin, live: Head | undefined): Promise<Verdict> {
  const replay = await look(client, rawSnapshotUrl(pin.timestamp, pin.url), STORED_HEADERS);
  if (replay === undefined) {
    return { kind: "busy", evidence: "the raw snapshot could not be reached" };
  }
  if (replay.status === HTTP_STATUS.tooManyRequests || replay.status >= HTTP_STATUS.internalServerError || replay.bytes === undefined) {
    return { kind: "busy", evidence: replay.bytes === undefined ? "the raw snapshot's body could not be read" : `HTTP ${String(replay.status)}` };
  }
  if (!isSuccess(replay.status)) {
    return { kind: "failed", reason: "not-served", evidence: `the raw snapshot answered HTTP ${String(replay.status)}${isWaybackPage(replay) ? " with the Wayback Machine's page" : ""}` };
  }
  if (isWaybackPage(replay)) {
    return { kind: "failed", reason: "wayback-page", evidence: `the raw snapshot answered HTTP ${String(replay.status)} with the Wayback Machine's page` };
  }
  const landed = LANDING_TIMESTAMP.exec(replay.url)?.[1];
  if (landed === undefined) {
    return { kind: "failed", reason: "not-served", evidence: `the raw snapshot answered from ${replay.url}` };
  }
  // A day-only pin is resolved by the Wayback Machine to the nearest capture; a full timestamp names one capture.
  if (pin.timestamp.length === landed.length && landed !== pin.timestamp) {
    return { kind: "failed", reason: "other-capture", evidence: `the raw snapshot answered with the capture of ${landed}`, landed };
  }
  const notes = live === undefined ? [] : differences(replay, live);
  if (notes.length > 0 && pin.compareStrictly) {
    return { kind: "failed", reason: "differs-from-source", evidence: notes.join("; ") };
  }

  return { kind: "verified", notes };
}

/**
 * Whether a failed verdict may still be a capture the Wayback Machine has not indexed or served yet.
 * @param verdict - A verdict of the `failed` kind.
 * @returns True when the failure is one indexing may clear.
 */
function mayBeLagging(verdict: Extract<Verdict, { kind: "failed" }>): boolean {
  return verdict.reason === "not-served" || verdict.reason === "wayback-page";
}

/**
 * Requests a pin's raw snapshot and says whether it serves the captured bytes.
 * @param ports - The polite client, and the clock that waits between lookups.
 * @param pin - The pin.
 * @param attempts - How many lookups at most. A fresh capture gets `VERIFY_ATTEMPTS`, since indexing lags it; a pin recorded earlier gets one, since waiting does not change what an old capture serves.
 * @returns Verified when the raw form answers with the capture's bytes (`notes` holds any difference from the live source tolerated for an older pin); failed with the reason when a lookup that cannot be indexing lag, or the last one, does not; busy when the archive could not give an answer.
 */
export async function verifyPin(ports: Readonly<{ client: PoliteClient; clock: Clock }>, pin: Pin, attempts: number): Promise<Verdict> {
  const live = pin.live ? await look(ports.client, pin.url, LIVE_HEADERS) : undefined;

  return lookAgain({ ports, pin, live: live !== undefined && isSuccess(live.status) ? live : undefined, attempts, attempt: 1 });
}

/** One round of looking at a pin, and the rounds after it while the answer may still change. */
interface Round {
  readonly ports: Readonly<{ client: PoliteClient; clock: Clock }>;
  readonly pin: Pin;
  readonly live: Head | undefined;
  /** How many lookups at most. */
  readonly attempts: number;
  /** Which look this is, from 1. */
  readonly attempt: number;
}

/**
 * One look at the pin, and the looks after it while the answer may still change.
 * @param round - The round's inputs and bounds.
 * @returns The verdict.
 */
async function lookAgain(round: Round): Promise<Verdict> {
  const verdict = await judge(round.ports.client, round.pin, round.live);
  if (round.attempt >= round.attempts || (verdict.kind !== "busy" && !(verdict.kind === "failed" && mayBeLagging(verdict)))) {
    return verdict;
  }
  await round.ports.clock.sleep(VERIFY_BACKOFF_MILLISECONDS * 2 ** (round.attempt - 1));

  return lookAgain({ ...round, attempt: round.attempt + 1 });
}
