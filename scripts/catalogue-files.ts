import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository's root and the catalogue directory in it, which the scripts that read or write the catalogue's files share. */
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
export const catalogueDir = join(repoRoot, "catalogue");

/**
 * Lists every `.json` file under a directory, recursively, in path order.
 * @param dir - The directory.
 * @returns Absolute paths.
 */
export function jsonFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".json"))
    .sort()
    .map((path) => join(dir, path));
}
