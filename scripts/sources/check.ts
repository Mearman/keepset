/* The liveness check's decisions, apart from its files: what a probe of a source means, which sources are findings, and what the report and the tracking issue say. The check never edits an entry. */

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../../src/serialise";
import type { SourceGroup } from "./entries";
import { HTTP_STATUS, isClientError, isRefusal, isSuccess } from "./http-status";
import { type PoliteClient, RequestFailure } from "./polite-client";
import { isDefinitiveFailure, type Probe, probe, redirectsToMissingPage, statusEvidence } from "./probe";

/** What a probe of a source means for the catalogue: `ok` it answers; `gone` the host says it does not exist (404, 410, another client error, or a name that no longer resolves); `blocked` the host refuses this client (401, 403), which says nothing about whether a visitor can reach it; `unreachable` the host failed to answer properly on every attempt (a busy or failing host, a timeout). */
export const SOURCE_STATES = ["ok", "gone", "blocked", "unreachable"] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

/** How many hex characters of a hash the tracking issue shows: enough to identify it in the report, short enough for a line of sources. */
const HASH_DISPLAY_LENGTH = 12;

/** How many bytes of a source the check reads to hash, after a probe answers: a prefix this large tells two different files of one dataset apart at the cost of a bounded read per source, whatever the file's size, and a host that ignores the range request is cut off after it rather than read whole. */
export const HASH_PREFIX_BYTES = 1_048_576;

/** One source URL's result: what the catalogue records about it, what the probe found, the length the host stated and the hash of the bytes it served. */
export const SourceResultSchema = z
  .object({
    url: z.url(),
    entries: z.array(z.string().min(1)).min(1),
    recorded: z.enum(["live", "dead"]),
    state: z.enum(SOURCE_STATES),
    evidence: z.string().min(1),
    contentLength: z.int().min(0).optional(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();
export type SourceResult = z.infer<typeof SourceResultSchema>;

const ReportSchema = z.object({ sources: z.array(SourceResultSchema) }).strict();

/**
 * The meaning of one probe.
 * @param url - The URL that was probed.
 * @param looked - What the probe found.
 * @returns The state, and the observation it rests on.
 */
export function classifyProbe(url: string, looked: Probe): { state: SourceState; evidence: string } {
  if (looked.kind === "unreachable") {
    const evidence = looked.code ?? "no answer";

    return { state: isDefinitiveFailure(looked.code) ? "gone" : "unreachable", evidence };
  }
  const { status } = looked;
  const evidence = statusEvidence(status, url, looked.finalUrl);
  if (isSuccess(status)) {
    return redirectsToMissingPage(url, looked.finalUrl) ? { state: "gone", evidence: `redirects to ${looked.finalUrl}` } : { state: "ok", evidence };
  }
  if (isRefusal(status)) {
    return { state: "blocked", evidence };
  }
  if (isClientError(status) && status !== HTTP_STATUS.tooManyRequests) {
    return { state: "gone", evidence };
  }

  return { state: "unreachable", evidence };
}

/**
 * Orders URLs so consecutive ones are on different hosts where they can be: one URL from each host in turn, then the next of each. A pool of workers taking URLs in this order spreads over the hosts instead of queueing behind the one that has most of the catalogue.
 * @param urls - The URLs.
 * @returns The same URLs, interleaved by host, each host's own order kept.
 */
export function interleaveByHost(urls: readonly string[]): string[] {
  const queues = new Map<string, string[]>();
  for (const url of urls) {
    const { host } = new URL(url);
    queues.set(host, [...(queues.get(host) ?? []), url]);
  }
  const ordered: string[] = [];
  for (let round = 0; ordered.length < urls.length; round++) {
    for (const queue of queues.values()) {
      const next = queue[round];
      if (next !== undefined) {
        ordered.push(next);
      }
    }
  }

  return ordered;
}

/**
 * The answer to a request for the first bytes of a source.
 * @param client - The polite client.
 * @param url - The URL that answered the probe.
 * @returns The answer, or undefined when the connection failed on every attempt.
 */
async function requestPrefix(client: PoliteClient, url: string): Promise<Response | undefined> {
  try {
    return await client.request(url, { headers: { accept: "*/*", range: `bytes=0-${String(HASH_PREFIX_BYTES - 1)}` } });
  } catch (error) {
    if (error instanceof RequestFailure) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Reads the first bytes a source serves and hashes them, so a mirror can be compared with the copy it stands in for and an earlier reading with today's. A host that ignores the range request has its answer cut off after the prefix rather than read whole.
 * @param client - The polite client, which paces per host.
 * @param url - The URL that answered.
 * @returns The SHA-256 of the bytes read, hex, or undefined when the host failed to answer this request or the answer broke off before the prefix was read: a source that answered the probe and then dropped the connection is a source without a hash, not a failed check.
 */
export async function contentHashOf(client: PoliteClient, url: string): Promise<string | undefined> {
  const response = await requestPrefix(client, url);
  if (response === undefined || !response.ok || response.body === null) {
    return undefined;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = response.body.getReader();
  const prefix: Uint8Array[] = [];
  let length = 0;

  /**
   * Takes the next chunk of the answer, recursing rather than looping so the bytes are read one await at a time.
   * @returns False when the answer broke off with an error before the prefix was read; true once the prefix is long enough or the answer ends.
   */
  const take = async (): Promise<boolean> => {
    if (length >= HASH_PREFIX_BYTES) {
      return true;
    }
    const chunk = await reader.read().catch(() => undefined);
    if (chunk === undefined) {
      return false;
    }
    if (chunk.done) {
      return true;
    }
    prefix.push(chunk.value);
    length += chunk.value.length;

    return take();
  };
  const readable = await take();
  await reader.cancel().catch(() => undefined);
  if (!readable) {
    return undefined;
  }
  const digest = createHash("sha256");
  for (const chunk of prefix) {
    digest.update(chunk);
  }

  return digest.digest("hex");
}

/**
 * Probes every source URL of the catalogue.
 * @param client - The polite client, which paces per host.
 * @param groups - The catalogue's source groups.
 * @param concurrency - How many URLs are in flight at once.
 * @returns One result per URL, sorted by URL.
 */
export async function checkSources(client: PoliteClient, groups: readonly SourceGroup[], concurrency: number): Promise<SourceResult[]> {
  const byUrl = new Map(groups.map((group) => [group.url, group]));
  const queue = interleaveByHost(groups.map((group) => group.url));
  const results: SourceResult[] = [];
  const worker = async (): Promise<void> => {
    const url = queue.shift();
    if (url === undefined) {
      return;
    }
    const group = byUrl.get(url);
    if (group === undefined) {
      throw new Error(`${url} was queued without a group`);
    }
    const looked = await probe(client, url);
    const classified = classifyProbe(url, looked);
    const hashable = looked.kind === "answered" && isSuccess(looked.status) && !redirectsToMissingPage(url, looked.finalUrl);
    results.push({
      url,
      entries: [...group.entryIds],
      recorded: group.live ? "live" : "dead",
      ...classified,
      ...(looked.kind === "answered" && looked.contentLength !== undefined && isSuccess(looked.status) ? { contentLength: looked.contentLength } : {}),
      ...(hashable ? { contentHash: await contentHashOf(client, url) } : {}),
    });

    return worker();
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  return results.sort((left, right) => (left.url < right.url ? -1 : 1));
}

/**
 * The report file's text.
 * @param results - The results.
 * @returns The file text, in the committed JSON form.
 */
export function checkReportText(results: readonly SourceResult[]): string {
  return canonicalJson({ sources: results });
}

/**
 * Parses a report written by an earlier check, for its content lengths.
 * @param text - The report file's text.
 * @returns The results.
 * @throws The schema's error when the text is not a report.
 */
export function parseCheckReport(text: string): SourceResult[] {
  return ReportSchema.parse(JSON.parse(text)).sources;
}

/** A source whose stated length differs from the one an earlier check recorded. */
export interface LengthChange {
  readonly result: SourceResult;
  readonly was: number;
  readonly now: number;
}

/** A source whose bytes differ from the ones an earlier check read, whether or not the stated length moved. */
export interface ContentChange {
  readonly result: SourceResult;
  readonly was: string;
  readonly now: string;
}

/** A mirror whose answer no longer matches the copy it stands in for. */
export interface DivergedMirror {
  readonly result: SourceResult;
  /** The entry whose canonical source the mirror serves alongside. */
  readonly entry: string;
  readonly canonical: SourceResult;
  /** What differed: the stated length, the bytes' hash, or both. */
  readonly differs: "length" | "hash" | "both";
}

/** What the check found that the catalogue does not yet reflect. */
export interface Findings {
  /** Recorded `live` but no longer resolving (`gone` or `unreachable`). */
  readonly lost: readonly SourceResult[];
  /** Recorded `dead` but answering again. */
  readonly revived: readonly SourceResult[];
  /** Answering, with a different length than the earlier check recorded. */
  readonly changed: readonly LengthChange[];
  /** Answering, with different bytes than the earlier check read. */
  readonly content: readonly ContentChange[];
  /** Answering, but no longer the copy of the canonical source the mirror stands in for. */
  readonly diverged: readonly DivergedMirror[];
  /** Recorded `live` and refusing this client; not a finding on its own, listed for a person to look at. */
  readonly blocked: readonly SourceResult[];
}

/**
 * Sorts the results into what needs a person's attention.
 * @param results - This check's results.
 * @param baseline - The earlier check's results, when there is one.
 * @returns The findings.
 */
export function findingsOf(results: readonly SourceResult[], baseline: readonly SourceResult[], canonical: ReadonlyMap<string, string> = new Map()): Findings {
  const earlier = new Map(baseline.map((result) => [result.url, result]));
  const byUrl = new Map(results.map((result) => [result.url, result]));
  const changed: LengthChange[] = [];
  const content: ContentChange[] = [];
  for (const result of results) {
    const was = earlier.get(result.url);
    if (result.state === "ok" && result.contentLength !== undefined && was?.contentLength !== undefined && was.contentLength !== result.contentLength) {
      changed.push({ result, was: was.contentLength, now: result.contentLength });
    }
    if (result.state === "ok" && result.contentHash !== undefined && was?.contentHash !== undefined && was.contentHash !== result.contentHash) {
      content.push({ result, was: was.contentHash, now: result.contentHash });
    }
  }
  const diverged: DivergedMirror[] = [];
  for (const result of results) {
    if (result.state !== "ok" || result.contentHash === undefined) {
      continue;
    }
    for (const entry of result.entries) {
      const canonicalUrl = canonical.get(entry);
      if (canonicalUrl === undefined || canonicalUrl === result.url) {
        continue;
      }
      const canonicalResult = byUrl.get(canonicalUrl);
      if (canonicalResult?.state !== "ok") {
        continue;
      }
      const lengthDiffers = result.contentLength !== undefined && canonicalResult.contentLength !== undefined && result.contentLength !== canonicalResult.contentLength;
      const hashDiffers = canonicalResult.contentHash !== undefined && result.contentHash !== canonicalResult.contentHash;
      if (lengthDiffers && hashDiffers) {
        diverged.push({ result, entry, canonical: canonicalResult, differs: "both" });
      } else if (lengthDiffers) {
        diverged.push({ result, entry, canonical: canonicalResult, differs: "length" });
      } else if (hashDiffers) {
        diverged.push({ result, entry, canonical: canonicalResult, differs: "hash" });
      }
    }
  }

  return {
    lost: results.filter((result) => result.recorded === "live" && (result.state === "gone" || result.state === "unreachable")),
    revived: results.filter((result) => result.recorded === "dead" && result.state === "ok"),
    changed,
    content,
    diverged,
    blocked: results.filter((result) => result.recorded === "live" && result.state === "blocked"),
  };
}

/**
 * Whether the findings call for a tracking issue: a source lost, revived or changed in length. A source that merely refuses this client does not.
 * @param findings - The findings.
 * @returns True when there is something to track.
 */
export function needsIssue(findings: Findings): boolean {
  return findings.lost.length > 0 || findings.revived.length > 0 || findings.changed.length > 0 || findings.content.length > 0 || findings.diverged.length > 0;
}

const list = (results: readonly SourceResult[], describe: (result: SourceResult) => string): string[] => results.map((result) => `- ${result.url} (${result.entries.join(", ")}): ${describe(result)}`);

/** The blank line that separates the sections of the tracking issue's body. */
const SECTION_BREAK = "\n\n";

/** The most characters GitHub accepts in an issue body. */
export const ISSUE_BODY_LIMIT = 65_536;

/** One kind of finding in the tracking issue: its heading and one line for each source. */
interface FindingSection {
  readonly heading: string;
  readonly lines: readonly string[];
}

/**
 * How many lines of each section fit in a character budget when the sections share it fairly: a section that needs less than an equal share keeps all its lines and the rest is shared between the larger ones, so one large kind of finding cannot crowd another out.
 * @param sections - The sections, each with its heading and lines.
 * @param budget - The characters available for every heading and line, a newline after each counted.
 * @returns How many lines of each section are kept, in the sections' order.
 */
function linesKept(sections: readonly FindingSection[], budget: number): number[] {
  const kept = sections.map(() => 0);
  const order = sections.map((_section, index) => index).sort((left, right) => (sections[left]?.lines.length ?? 0) - (sections[right]?.lines.length ?? 0));
  let remaining = budget - sections.reduce((sum, section) => sum + section.heading.length + 1, 0);
  order.forEach((index, position) => {
    const section = sections[index];
    if (section === undefined) {
      return;
    }
    const share = remaining / (order.length - position);
    let used = 0;
    for (const line of section.lines) {
      if (used + line.length + 1 > share) {
        break;
      }
      used += line.length + 1;
      kept[index] = (kept[index] ?? 0) + 1;
    }
    remaining -= used;
  });

  return kept;
}

/**
 * The tracking issue's body. Entries are not edited by the check: a source recorded `live` that is gone is marked `dead` with its pinned snapshot in a reviewed change. A body that would pass GitHub's limit keeps a fair share of each kind of finding and says how many were left out.
 * @param findings - The findings.
 * @param limit - The most characters the body may have.
 * @returns Markdown.
 */
export function issueBody(findings: Findings, limit: number = ISSUE_BODY_LIMIT): string {
  const intro = "The scheduled source check found sources whose live state no longer matches what the catalogue records. It edits no entry. Mark a gone source `dead` and pin its snapshot (`scripts/archive-sources.ts` finds or requests one) in a reviewed change.";
  const sections: FindingSection[] = [
    { heading: "Recorded live, no longer resolving:", lines: list(findings.lost, (result) => `${result.state}, ${result.evidence}`) },
    { heading: "Recorded dead, answering again:", lines: list(findings.revived, (result) => result.evidence) },
    { heading: "Stated length changed since the last check:", lines: findings.changed.map(({ result, was, now }) => `- ${result.url} (${result.entries.join(", ")}): ${String(was)} bytes, now ${String(now)}`) },
    { heading: "Bytes changed since the last check at the same stated length or with none stated:", lines: findings.content.map(({ result, was, now }) => `- ${result.url} (${result.entries.join(", ")}): ${was.slice(0, HASH_DISPLAY_LENGTH)}, now ${now.slice(0, HASH_DISPLAY_LENGTH)}`) },
    { heading: "A mirror no longer serves the copy its canonical source does:", lines: findings.diverged.map(({ result, entry, canonical, differs }) => `- ${result.url} (${entry}) differs from ${canonical.url} in ${differs}`) },
    { heading: "Refusing this client, which does not show they are gone:", lines: list(findings.blocked, (result) => result.evidence) },
  ].filter((section) => section.lines.length > 0);
  const omission = (count: number): string => `- and ${String(count)} more, listed in the check's report`;
  const countedHeading = (heading: string, total: number, shown: number): string => `${heading.slice(0, -1)} (${String(total)}, ${String(shown)} shown):`;
  /** What a truncated section adds beyond its kept lines, at the widest numbers a count can have: the counts in its heading, the omission line, and the line breaks that separate it from the next section. */
  const widest = Number.MAX_SAFE_INTEGER;
  const truncationOverhead = countedHeading("", widest, widest).length + omission(widest).length + SECTION_BREAK.length + 1;
  const kept = linesKept(sections, limit - intro.length - SECTION_BREAK.length - sections.length * truncationOverhead);
  const rendered = sections.map((section, index) => {
    const shown = kept[index] ?? 0;
    const left = section.lines.length - shown;
    const heading = left === 0 ? section.heading : countedHeading(section.heading, section.lines.length, shown);

    return [heading, ...section.lines.slice(0, shown), ...(left === 0 ? [] : [omission(left)])].join("\n");
  });

  return `${[intro, ...rendered].join(SECTION_BREAK)}\n`;
}
