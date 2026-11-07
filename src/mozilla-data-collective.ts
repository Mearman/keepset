import { KeepsetError } from "./errors";
import type { FetchPort } from "./fetch";

const UNAUTHORISED = 401;
const FORBIDDEN = 403;
const BROKER = /^https:\/\/mozilladatacollective\.com\/api\/datasets\/[a-z0-9]+\/download$/;

/**
 * Composes a Mozilla Data Collective authenticated download with an ordinary fetch port. The account must have accepted the dataset's terms. The credential and the temporary download address are never returned in provenance or errors.
 * @param apiKey - The account's API key, or undefined when there is none, in which case a source that needs one is refused with an error that says so before any request is made.
 * @param fallback - The port for all other URLs.
 * @param request - A Web Fetch implementation for the broker.
 * @returns A port that resolves the publisher's stable download endpoint to its file.
 */
export function mozillaDataCollectiveFetch(apiKey: string | undefined, fallback: FetchPort, request: typeof fetch = fetch): FetchPort {
  return async (url, init) => {
    if (!BROKER.test(url)) return fallback(url, init);
    if (apiKey === undefined) throw new KeepsetError("This source is a Mozilla Data Collective dataset: set MDC_API_KEY to an account's API key, after accepting the dataset's terms");
    let answer: Response;
    try {
      answer = await request(url, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, ...(init.signal === undefined ? {} : { signal: init.signal }) });
    } catch (error) {
      if (init.signal?.aborted === true) throw init.signal.reason;
      throw error instanceof TypeError ? new TypeError("Mozilla Data Collective's download request failed") : new KeepsetError("Mozilla Data Collective's download request failed");
    }
    if (!answer.ok) {
      await answer.body?.cancel().catch(() => undefined);
      const reason = answer.status === UNAUTHORISED || answer.status === FORBIDDEN ? "; check the API key and dataset terms" : "";
      throw new KeepsetError(`Mozilla Data Collective refused the download (HTTP ${String(answer.status)})${reason}`);
    }
    let body: unknown;
    try {
      body = await answer.json();
    } catch {
      if (init.signal?.aborted === true) throw init.signal.reason;
      throw new KeepsetError("Mozilla Data Collective returned invalid JSON");
    }
    if (typeof body !== "object" || body === null || !("downloadUrl" in body) || typeof body.downloadUrl !== "string") throw new KeepsetError("Mozilla Data Collective returned no download URL");
    let address: URL;
    try {
      address = new URL(body.downloadUrl);
    } catch {
      throw new KeepsetError("Mozilla Data Collective returned an invalid download URL");
    }
    if (address.protocol !== "https:") throw new KeepsetError("Mozilla Data Collective returned a non-HTTPS download URL");
    try {
      const response = await fallback(address.href, init);
      if (response.body === null) return response;
      const reader = response.body.getReader();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) controller.close();
            else controller.enqueue(chunk.value);
          } catch {
            controller.error(init.signal?.aborted === true ? init.signal.reason : new KeepsetError("Mozilla Data Collective's file download failed"));
          }
        },
        async cancel(reason: unknown) { await reader.cancel(reason); },
      });

      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      if (init.signal?.aborted === true) throw init.signal.reason;
      throw error instanceof TypeError ? new TypeError("Mozilla Data Collective's file download failed") : new KeepsetError("Mozilla Data Collective's file download failed");
    }
  };
}
