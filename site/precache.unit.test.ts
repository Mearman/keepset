import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { finalisePrecache } from "./precache";

const directories: string[] = [];
afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** A site directory holding the shell files and one listing page, with a precache manifest naming them. */
function site(css: string): string {
  const outDir = mkdtempSync(join(tmpdir(), "keepset-precache-"));
  directories.push(outDir);
  mkdirSync(join(outDir, "domains"), { recursive: true });
  writeFileSync(join(outDir, "index.html"), "<html>home</html>");
  writeFileSync(join(outDir, "domains", "index.html"), "<html>domains</html>");
  writeFileSync(join(outDir, "app.css"), css);
  writeFileSync(join(outDir, "sw.js"), "self.addEventListener();");
  writeFileSync(join(outDir, "precache.json"), JSON.stringify({ version: "1.2.3+cat@1", urls: ["./", "app.css", "domains/"] }));

  return outDir;
}

describe("finalisePrecache", () => {
  it("writes the same version for the same bytes", () => {
    expect(finalisePrecache(site("a{}"))).toBe(finalisePrecache(site("a{}")));
  });

  it("changes the version when a precached file's bytes change", () => {
    expect(finalisePrecache(site("a{}"))).not.toBe(finalisePrecache(site("b{}")));
  });

  it("keeps the build's version as the prefix and the urls unchanged in the manifest it writes", () => {
    const outDir = site("a{}");
    const version = finalisePrecache(outDir);
    expect(version).toMatch(/^1\.2\.3\+cat@1\+[0-9a-f]{64}$/);
    expect(JSON.parse(readFileSync(join(outDir, "precache.json"), "utf8"))).toEqual({ version, urls: ["./", "app.css", "domains/"] });
  });

  it("changes the version when a directory URL's page changes", () => {
    const outDir = site("a{}");
    const before = finalisePrecache(outDir);
    writeFileSync(join(outDir, "precache.json"), JSON.stringify({ version: "1.2.3+cat@1", urls: ["./", "app.css", "domains/"] }));
    writeFileSync(join(outDir, "domains", "index.html"), "<html>changed</html>");
    expect(finalisePrecache(outDir)).not.toBe(before);
  });

  it("stamps the version on the service worker, so its bytes differ whenever the version does", () => {
    const first = site("a{}");
    const second = site("b{}");
    const firstVersion = finalisePrecache(first);
    finalisePrecache(second);
    expect(readFileSync(join(first, "sw.js"), "utf8")).toBe(`self.addEventListener();\n// precache ${firstVersion}\n`);
    expect(readFileSync(join(first, "sw.js"), "utf8")).not.toBe(readFileSync(join(second, "sw.js"), "utf8"));
  });

  it("refuses a precache manifest of the wrong shape", () => {
    const outDir = site("a{}");
    writeFileSync(join(outDir, "precache.json"), JSON.stringify({ version: 1, urls: [] }));
    expect(() => finalisePrecache(outDir)).toThrow("precache.json is not a precache manifest");
  });
});
