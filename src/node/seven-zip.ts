/* Node's 7z reader: 7-Zip itself, compiled to WebAssembly (the `7z-wasm` package), run in a worker thread on the file the store keeps the archive in. 7-Zip reads that file through Emscripten's NODEFS, which passes each read to the real file, so the archive is never copied into memory; it decodes a solid block from its start, holding its dictionary, and writes only the members asked for into a temporary folder, from which each is read back when it is reached. A worker keeps the decoding off the event loop, so a long archive does not stall the process and an abort ends it at once. */

import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { ExtractedMembers, SevenZipPort } from "../archive";
import { ArchiveError } from "../errors";
import type { SourceBytes } from "../source-bytes";

/** Where the reader's worker mounts the archive's folder and the extraction's folder in 7-Zip's file system. */
const ARCHIVE_MOUNT = "/archive";
const OUTPUT_MOUNT = "/output";
/** The names, inside the extraction's folder, of the list of members to extract and of the folder they are extracted into. */
const LIST_FILE = "members.txt";
const MEMBERS_FOLDER = "members";

/** The lines of a technical listing (`-slt`) the reader reads: a record starts at its path and says whether it is a directory in its attributes, whose first letter is `D` for one. */
const LISTING_LINES = "^(?:Path|Attributes) = ";
const PATH_LINE = "Path = ";
const ATTRIBUTES_LINE = "Attributes = ";
const DIRECTORY_ATTRIBUTE = "D";

/** 7-Zip's exit status for success (https://7-zip.opensource.jp/chm/cmdline/exit_codes.htm): anything else, a warning included, is reported as a failure, as a recipe fails loudly. */
const SUCCESS = 0;

/**
 * The script the worker runs, as source: it instantiates 7-Zip from the module the reader compiled once (through Emscripten's `instantiateWasm` hook, so no worker compiles it again), mounts the folders it is given through NODEFS, runs one command and posts back the exit status, the output lines that match the pattern it is given, every error line, and the size 7-Zip's memory grew to. WebAssembly memory only grows, so its final size is the most the command held. It is evaluated rather than loaded from a file so the package ships no separate worker entry, and it holds no logic beyond running the command: the reader parses what it posts.
 */
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const keep = new RegExp(workerData.keep, "u");
const stdout = [];
const stderr = [];
let memory;
const instantiateWasm = (imports, success) => {
  WebAssembly.instantiate(workerData.compiled, imports).then((instance) => {
    memory = instance.exports.memory;
    success(instance, workerData.compiled);
  });
  return {};
};
require(workerData.module)({ instantiateWasm, print: (line) => { if (keep.test(line)) stdout.push(line); }, printErr: (line) => { stderr.push(line); } }).then((sevenZip) => {
  for (const [point, root] of workerData.mounts) {
    sevenZip.FS.mkdir(point);
    sevenZip.FS.mount(sevenZip.NODEFS, { root }, point);
  }
  const code = sevenZip.callMain(workerData.args);
  parentPort.postMessage({ code, stdout, stderr, heapBytes: memory === undefined ? 0 : memory.buffer.byteLength });
});
`;

/** What the worker posts back. */
const RunReportSchema = z.object({ code: z.number().int(), stdout: z.array(z.string()), stderr: z.array(z.string()), heapBytes: z.number().int().nonnegative() }).strict();

/** One 7-Zip command the reader ran, and what it reported: the arguments, the exit status and the most memory it held. */
export interface SevenZipRun {
  readonly args: readonly string[];
  readonly code: number;
  readonly heapBytes: number;
}

/** What the reader can be given: where it makes its temporary folders (the system's temporary directory by default), and an observer told of each command it runs, which a test uses to measure the memory 7-Zip held. */
export interface SevenZipReaderOptions {
  readonly directory?: string;
  readonly observe?: (run: Readonly<SevenZipRun>) => void;
}

/** The path `7z-wasm` resolves to, which the worker loads, and its WebAssembly binary beside it: resolved from this module, so the package's own dependency is the one found. */
const SEVEN_ZIP_MODULE = createRequire(import.meta.url).resolve("7z-wasm");
const SEVEN_ZIP_BINARY = join(dirname(SEVEN_ZIP_MODULE), "7zz.wasm");

/** The one call of the WebAssembly JavaScript API the reader makes. Node provides the global, but neither its typings nor the ES library declare it (only the DOM and web worker libraries do, which a Node program does not load), so the call is declared here; the compiled module is opaque to the reader, which only hands it to a worker. */
declare const WebAssembly: { readonly compile: (binary: Uint8Array) => Promise<object> };

/** 7-Zip's binary compiled, once for the process and only when a 7z archive is first read: a compiled module passes to a worker without being compiled again. */
let compiledSevenZip: Promise<object> | undefined;

/**
 * 7-Zip's binary, compiled on the first call.
 * @returns The compiled module.
 */
async function compiled(): Promise<object> {
  compiledSevenZip ??= readFile(SEVEN_ZIP_BINARY).then(async (binary) => await WebAssembly.compile(binary));

  return compiledSevenZip;
}

/**
 * Runs one 7-Zip command in a worker thread.
 * @param args - The command's arguments.
 * @param mounts - Each mount point in 7-Zip's file system and the real folder mounted there.
 * @param signal - Ends the worker, and so the command, when it aborts.
 * @param observe - Told of the command once it has reported.
 * @returns The exit status, the listing lines kept and the error lines.
 * @throws The signal's reason when it aborts; ArchiveError when the worker fails or ends without reporting.
 */
async function runSevenZip(args: readonly string[], mounts: readonly (readonly [string, string])[], signal: AbortSignal | undefined, observe: SevenZipReaderOptions["observe"]): Promise<z.infer<typeof RunReportSchema>> {
  signal?.throwIfAborted();
  const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { module: SEVEN_ZIP_MODULE, compiled: await compiled(), keep: LISTING_LINES, args, mounts } });
  let abort: (() => void) | undefined;
  try {
    const report = await new Promise<unknown>((resolve, reject) => {
      abort = () => {
        const reason: unknown = signal?.reason;
        reject(reason instanceof Error ? reason : new ArchiveError(`7-Zip was aborted: ${String(reason)}`, { cause: reason }));
      };
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", resolve);
      worker.once("error", (error: unknown) => {
        reject(new ArchiveError(`7-Zip failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
      });
      worker.once("exit", (code) => {
        reject(new ArchiveError(`7-Zip ended with status ${String(code)} before reporting`));
      });
    });
    const parsed = RunReportSchema.parse(report);
    observe?.({ args, code: parsed.code, heapBytes: parsed.heapBytes });

    return parsed;
  } finally {
    if (abort !== undefined) {
      signal?.removeEventListener("abort", abort);
    }
    await worker.terminate();
  }
}

/**
 * Fails a command that did not succeed, with what 7-Zip said.
 * @param report - The command's report.
 * @param doing - What the command was doing, for the message.
 * @throws ArchiveError when the status is not success.
 */
function assertSucceeded(report: Readonly<z.infer<typeof RunReportSchema>>, doing: string): void {
  if (report.code !== SUCCESS) {
    const said = report.stderr.map((line) => line.trim()).filter((line) => line !== "");
    throw new ArchiveError(`not a readable 7z archive: 7-Zip ${doing} ended with status ${String(report.code)}: ${said.join("; ")}`);
  }
}

/**
 * The file a source's bytes are in: the store's own file when it keeps one, or else a temporary copy written from its chunks (an archive held in memory, such as a member of another archive), deleted on release.
 * @param source - The archive.
 * @param directory - Where a copy's folder is made.
 * @returns The file's path, and what releases it.
 */
async function fileOf(source: Readonly<SourceBytes>, directory: string): Promise<{ readonly path: string; readonly release: () => Promise<void> }> {
  if (source.file !== undefined) {
    return { path: source.file, release: async () => Promise.resolve() };
  }
  const folder = await mkdtemp(join(directory, "keepset-7z-"));
  const release = async (): Promise<void> => {
    await rm(folder, { recursive: true, force: true });
  };
  const path = join(folder, "archive.7z");
  try {
    await pipeline(Readable.from(source.chunks()), createWriteStream(path));
  } catch (error) {
    await release();
    throw error;
  }

  return { path, release };
}

/**
 * Reads a technical listing's lines into the member paths that are files.
 * @param lines - The `Path` and `Attributes` lines, in order.
 * @returns Every path whose record does not mark it a directory, in order.
 * @throws ArchiveError when an attributes line comes before any path.
 */
function filesListed(lines: readonly string[]): string[] {
  const records: { path: string; directory: boolean }[] = [];
  for (const line of lines) {
    if (line.startsWith(PATH_LINE)) {
      records.push({ path: line.slice(PATH_LINE.length), directory: false });
      continue;
    }
    const record = records.at(-1);
    if (record === undefined) {
      throw new ArchiveError(`7-Zip listed attributes before any path: ${line}`);
    }
    record.directory = line.slice(ATTRIBUTES_LINE.length).startsWith(DIRECTORY_ATTRIBUTE);
  }

  return records.filter((record) => !record.directory).map((record) => record.path);
}

/**
 * Node's 7z reader.
 * @param options - Where temporary folders are made, and an observer of each command run.
 * @returns The reader.
 */
export function sevenZipReader(options: Readonly<SevenZipReaderOptions> = {}): SevenZipPort {
  const directory = options.directory ?? tmpdir();

  return {
    async list(source, signal) {
      const file = await fileOf(source, directory);
      try {
        const report = await runSevenZip(["l", "-t7z", "-slt", "-ba", "-bsp0", "-sccUTF-8", `${ARCHIVE_MOUNT}/${basename(file.path)}`], [[ARCHIVE_MOUNT, dirname(file.path)]], signal, options.observe);
        assertSucceeded(report, "listing the archive");

        return filesListed(report.stdout);
      } finally {
        await file.release();
      }
    },
    async extract(source, paths, signal) {
      const unlistable = paths.find((path) => /[\r\n]/u.test(path));
      if (unlistable !== undefined) {
        throw new ArchiveError(`the 7z member ${JSON.stringify(unlistable)} has a line break in its path, which 7-Zip's list of members to extract cannot name`);
      }
      const wanted = new Set(paths);
      const output = await mkdtemp(join(directory, "keepset-7z-out-"));
      const release = async (): Promise<void> => {
        await rm(output, { recursive: true, force: true });
      };
      try {
        const file = await fileOf(source, directory);
        try {
          await writeFile(join(output, LIST_FILE), paths.map((path) => `${path}\n`).join(""), "utf8");
          // `-spd` takes each listed name literally, so a member whose name holds `*` or `?` is extracted alone rather than as a wildcard.
          const report = await runSevenZip(
            ["x", "-t7z", "-y", "-spd", "-scsUTF-8", "-sccUTF-8", "-bso0", "-bsp0", `-o${OUTPUT_MOUNT}/${MEMBERS_FOLDER}`, `${ARCHIVE_MOUNT}/${basename(file.path)}`, `@${OUTPUT_MOUNT}/${LIST_FILE}`],
            [
              [ARCHIVE_MOUNT, dirname(file.path)],
              [OUTPUT_MOUNT, output],
            ],
            signal,
            options.observe,
          );
          assertSucceeded(report, "extracting members");
        } finally {
          await file.release();
        }
      } catch (error) {
        await release();
        throw error;
      }
      const members = join(output, MEMBERS_FOLDER);
      const extracted: ExtractedMembers = {
        async read(path) {
          const where = join(members, path);
          const inside = relative(members, where);
          if (!wanted.has(path) || inside.startsWith("..") || isAbsolute(inside)) {
            throw new ArchiveError(`the 7z member ${path} was not extracted`);
          }
          try {
            return new Uint8Array(await readFile(where));
          } catch (error) {
            throw new ArchiveError(`7-Zip did not extract the 7z member ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        },
        close: release,
      };

      return extracted;
    },
  };
}
