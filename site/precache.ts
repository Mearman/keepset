import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The service worker's precache manifest as buildSite writes it: a version naming the build and the URLs, relative to the site root, to cache on install. */
interface Precache {
  readonly version: string;
  readonly urls: readonly string[];
}

function isPrecache(value: unknown): value is Precache {
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "string" && "urls" in value && Array.isArray(value.urls) && value.urls.every((url) => typeof url === "string");
}

/** The file a precached URL is served from: the site root and every directory URL are served by their index.html. */
function fileOf(url: string): string {
  if (url === "./") {
    return "index.html";
  }

  return url.endsWith("/") ? `${url}index.html` : url;
}

/**
 * Appends a digest of every precached file's bytes to the manifest's version, in place. The service worker answers from a cache named for that version, so a version that tracks only the package and the catalogue leaves returning visitors on stale assets whenever a deploy changes a stylesheet, script or page without a release in between; a content digest changes exactly when something the worker serves changed. Run after the client bundle is written, since the bundle's files are among the precached ones.
 * It also stamps the version on the end of sw.js as a comment. A browser installs a new service worker only when the worker's own bytes differ from the installed one's, and the worker reads its version from precache.json at run time, so without the stamp a deploy that changes only pages or assets would never reach a returning visitor.
 * @param outDir - The built site directory, holding precache.json, sw.js and every file the manifest names.
 * @returns The version written.
 */
export function finalisePrecache(outDir: string): string {
  const manifestPath = join(outDir, "precache.json");
  const parsed: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!isPrecache(parsed)) {
    throw new Error("precache.json is not a precache manifest");
  }
  const digest = createHash("sha256");
  for (const url of [...parsed.urls].sort()) {
    // The URL goes into the digest too, so moving content between two files changes the version as well.
    digest.update(url).update("\0").update(readFileSync(join(outDir, fileOf(url)))).update("\0");
  }
  const version = `${parsed.version}+${digest.digest("hex")}`;
  writeFileSync(manifestPath, JSON.stringify({ version, urls: parsed.urls }));
  appendFileSync(join(outDir, "sw.js"), `\n// precache ${version}\n`);

  return version;
}
