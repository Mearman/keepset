/* 7z fixtures made with real 7-Zip in the test itself (the `7z-wasm` package, so no system 7z is needed), and the naive reference a 7z reader is checked against: the whole archive held in 7-Zip's in-memory file system and every member extracted there. */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import SevenZip, { type SevenZipModule } from "7z-wasm";

/** One file put in a test archive: its path, with `/` between segments, and its bytes. */
export interface SevenZipFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** How 7-Zip compresses a fixture: as one solid block or a block per file, by which method, with what dictionary, and how hard. */
export interface SevenZipSettings {
  readonly solid: boolean;
  readonly method: "LZMA" | "LZMA2";
  readonly dictionaryBytes: number;
  readonly level: number;
}

/** 7-Zip loaded, and every line it has printed to its error stream. */
interface Loaded {
  readonly instance: SevenZipModule;
  readonly errors: readonly string[];
}

/**
 * Loads 7-Zip with its error stream kept, so a failed command is seen and says why; its other output is let go.
 * @returns The module and the lines it prints as errors.
 */
async function loaded(): Promise<Loaded> {
  const errors: string[] = [];
  const instance = await SevenZip({
    print: () => undefined,
    printErr: (line) => {
      errors.push(line);
    },
  });

  return { instance, errors };
}

/**
 * Runs one 7-Zip command, failing the test when it does not succeed.
 * @param seven - The module and its output.
 * @param args - The command.
 */
function run(seven: Readonly<Loaded>, args: readonly string[]): void {
  const from = seven.errors.length;
  // 7z-wasm's types declare `callMain` as returning nothing, though Emscripten's returns the exit status, so failure is told by what 7-Zip writes to its error stream, which it writes to for every warning and error and for nothing else.
  seven.instance.callMain([...args]);
  const said = seven.errors.slice(from).filter((line) => line.trim() !== "");
  if (said.length > 0) {
    throw new Error(`7-Zip ${args.join(" ")} failed: ${said.join("\n")}`);
  }
}

/**
 * 7-Zip's switches for a fixture's settings.
 * @param settings - The settings.
 * @returns The switches.
 */
function switches(settings: Readonly<SevenZipSettings>): string[] {
  return ["-t7z", `-ms=${settings.solid ? "on" : "off"}`, `-mx=${String(settings.level)}`, `-m0=${settings.method}:d=${String(settings.dictionaryBytes)}b`, "-bso0", "-bsp0"];
}

/**
 * Compresses files on disk into a 7z archive on disk, through 7-Zip's NODEFS, so neither the files nor the archive is held in memory.
 * @param folder - The folder whose contents are archived, each file under its path from the folder.
 * @param archive - Where the archive is written, outside the folder.
 * @param settings - How the archive is compressed.
 */
export async function sevenZipFolder(folder: string, archive: string, settings: Readonly<SevenZipSettings>): Promise<void> {
  const seven = await loaded();
  seven.instance.FS.mkdir("/in");
  seven.instance.FS.mount(seven.instance.NODEFS, { root: folder }, "/in");
  seven.instance.FS.mkdir("/out");
  seven.instance.FS.mount(seven.instance.NODEFS, { root: dirname(archive) }, "/out");
  seven.instance.FS.chdir("/in");
  run(seven, ["a", ...switches(settings), `/out/${archive.slice(dirname(archive).length + 1)}`, "."]);
}

/**
 * A 7z archive of files, made by 7-Zip.
 * @param files - The files, in the order they are given to 7-Zip.
 * @param settings - How the archive is compressed.
 * @returns The archive's bytes.
 */
export async function sevenZip(files: readonly SevenZipFile[], settings: Readonly<SevenZipSettings>): Promise<Uint8Array> {
  const folder = await mkdtemp(join(tmpdir(), "keepset-7z-fixture-"));
  try {
    const input = join(folder, "in");
    for (const file of files) {
      mkdirSync(dirname(join(input, file.path)), { recursive: true });
      writeFileSync(join(input, file.path), file.bytes);
    }
    const archive = join(folder, "fixture.7z");
    await sevenZipFolder(input, archive, settings);

    return new Uint8Array(await readFile(archive));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/**
 * The naive reference: the whole archive written into 7-Zip's in-memory file system, every member extracted there, and every file read back.
 * @param archive - The archive's bytes.
 * @returns Each file's bytes by its path.
 */
export async function extractAllInMemory(archive: Uint8Array): Promise<Map<string, Uint8Array>> {
  const seven = await loaded();
  const { FS } = seven.instance;
  FS.writeFile("/whole.7z", archive);
  run(seven, ["x", "-y", "-bso0", "-bsp0", "-o/all", "/whole.7z"]);
  const files = new Map<string, Uint8Array>();
  const walk = (folder: string, prefix: string): void => {
    for (const name of FS.readdir(folder)) {
      if (name === "." || name === "..") {
        continue;
      }
      const path = `${folder}/${name}`;
      if (FS.isDir(FS.stat(path).mode)) {
        walk(path, `${prefix}${name}/`);
      } else {
        files.set(`${prefix}${name}`, FS.readFile(path));
      }
    }
  };
  walk("/all", "");

  return files;
}
