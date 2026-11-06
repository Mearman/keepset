import { KeepsetError } from "./errors";
import type { FetchPort } from "./fetch";

const UNAUTHORISED = 401;
const FORBIDDEN = 403;
const BROKER = /^https:\/\/mozilladatacollective\.com\/api\/datasets\/[a-z0-9]+\/download$/;

/**
 * Composes a Mozilla Data Collective authenticated download with an ordinary fetch port. The account must have accepted the dataset's terms. The credential and the temporary download address are never returned in provenance or errors.
 * @param apiKey - The account's API key.
 * @param fallback - The port for all other URLs.
 * @param request - A Web Fetch implementation for the broker and its download.
 * @returns A port that resolves the publisher's stable download endpoint to its file.
 */
export function mozillaDataCollectiveFetch(apiKey: string, fallback: FetchPort, request: typeof fetch = fetch): FetchPort {
  return async (url, init) => {
    if (!BROKER.test(url)) return fallback(url, init);
    let answer: Response;
    try {
      answer = await request(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, ...(init.signal === undefined ? {} : { signal: init.signal }) });
    } catch (error) {
      if (init.signal?.aborted === true) throw init.signal.reason;
      throw error instanceof TypeError ? new TypeError("Mozilla Data Collective's download request failed") : new KeepsetError("Mozilla Data Collective's download request failed");
    }
    if (!answer.ok) {
      const reason = answer.status === UNAUTHORISED || answer.status === FORBIDDEN ? "; check the API key and dataset terms" : "";
      throw new KeepsetError(`Mozilla Data Collective refused the download (HTTP ${String(answer.status)})${reason}`);
    }
    const body: unknown = await answer.json();
    if (typeof body !== "object" || body === null || !("downloadUrl" in body) || typeof body.downloadUrl !== "string") throw new KeepsetError("Mozilla Data Collective returned no download URL");
    let address: URL;
    try {
      address = new URL(body.downloadUrl);
    } catch {
      throw new KeepsetError("Mozilla Data Collective returned an invalid download URL");
    }
    if (address.protocol !== "https:") throw new KeepsetError("Mozilla Data Collective returned a non-HTTPS download URL");
    const headers = new Headers();
    if (init.range !== undefined) headers.set("range", `bytes=${String(init.range.offset)}-${String(init.range.offset + init.range.length - 1)}`);
    try {
      return await request(address, { headers, ...(init.signal === undefined ? {} : { signal: init.signal }) });
    } catch (error) {
      if (init.signal?.aborted === true) throw init.signal.reason;
      throw error instanceof TypeError ? new TypeError("Mozilla Data Collective's file download failed") : new KeepsetError("Mozilla Data Collective's file download failed");
    }
  };
}
