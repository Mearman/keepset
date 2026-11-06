import { describe, expect, it } from "vitest";
import { mozillaDataCollectiveFetch } from "./mozilla-data-collective";

const endpoint = "https://mozilladatacollective.com/api/datasets/example123/download";
const signed = "https://storage.example/file?signature=secret";

describe("Mozilla Data Collective fetch", () => {
  it("posts the credential to the broker, downloads the returned URL and delegates other sources", async () => {
    const requests: { url: string; method: string | undefined; auth: string | null; range: string | null }[] = [];
    const request: typeof fetch = async (url, init) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url, method: init?.method, auth: headers.get("authorization"), range: headers.get("range") });

      return Promise.resolve(requests.length === 1 ? Response.json({ downloadUrl: signed }) : new Response("file"));
    };
    const fallback = async () => Promise.resolve(new Response("other"));
    const port = mozillaDataCollectiveFetch("key", fallback, request);
    expect(await (await port(endpoint, {range: {offset: 3, length: 4}})).text()).toBe("file");
    expect(requests).toEqual([
      {url: endpoint, method: "POST", auth: "Bearer key", range: null},
      {url: signed, method: undefined, auth: null, range: "bytes=3-6"},
    ]);
    expect(await (await port("https://example.org/other", {})).text()).toBe("other");
  });

  it("reports refusals and hides the signed address on connection errors", async () => {
    const refused: typeof fetch = async () => Promise.resolve(new Response(null, {status: 429}));
    await expect(mozillaDataCollectiveFetch("key", refused, refused)(endpoint, {})).rejects.toThrow("HTTP 429");
    let calls = 0;
    const broken: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return Promise.resolve(Response.json({downloadUrl: signed}));

      return Promise.reject(new Error(signed));
    };
    await expect(mozillaDataCollectiveFetch("key", broken, broken)(endpoint, {})).rejects.toThrow("file download failed");
  });

  it("does not expose a malformed broker response in its error", async () => {
    const malformed: typeof fetch = async () => Promise.resolve(new Response(`{ "downloadUrl": "${signed}"`));
    await expect(mozillaDataCollectiveFetch("key", malformed, malformed)(endpoint, {})).rejects.toMatchObject({ message: "Mozilla Data Collective returned invalid JSON" });
  });
});
