import { parseArgs } from "node:util";
// Through the package's own name, as cli/keepset.ts imports the library: an `instanceof` check needs the very class the library throws, not a second copy bundled into the command.
import { KeepsetError, NAME_SEPARATOR, type Archive, type ArchiveMember, type Dataset, type DatasetQuery, type NamespaceNode, type SyntaxIssue } from "keepset";
import type { FetchedDataset, NodeSink, Provenance, RoundTripReport, StreamedDataset } from "keepset/node";

/**
 * Says which archive file or files a recipe reads, for the `info` output.
 * @param selector - The recipe's member selector.
 * @returns The path, the extensions a name ends with, or the pattern a path matches.
 */
function selectorText(selector: ArchiveMember): string {
  if ("path" in selector) {
    return selector.path;
  }

  return "pattern" in selector ? `matching ${selector.pattern}` : `ending ${selector.extensions.join(" or ")}`;
}

/**
 * Says how a download unpacks, for the `show` output.
 * @param archive - The archive layout.
 * @returns Its kind, the member or members it selects and any inner archive.
 */
function archiveText(archive: Archive): string {
  const innerText = "inner" in archive && archive.inner !== undefined ? `, inner ${archive.inner.kind}${"member" in archive.inner ? `, member ${selectorText(archive.inner.member)}` : ""}` : "";
  const memberText = "member" in archive ? `, member ${selectorText(archive.member)}${innerText}` : "members" in archive ? `, members ${selectorText(archive.members)}` : "parts" in archive ? `, parts ${archive.parts.map((part) => `${part.name} from ${selectorText(part.member)}`).join(", ")}` : "files" in archive ? `, files ${selectorText(archive.files)}${innerText}` : "";

  return `${archive.kind}${memberText}`;
}

/** The library calls the command delegates to: every command is one of these plus argument parsing and output formatting, injected so the command's own layer is tested alone. */
export interface CliLibrary {
  readonly listDatasets: (query: DatasetQuery) => readonly Dataset[];
  readonly getDataset: (id: string) => Dataset;
  readonly listNamespaces: (path?: string) => readonly NamespaceNode[];
  readonly validateDataset: (dataset: Dataset) => readonly SyntaxIssue[];
  readonly fetchDataset: (id: string) => Promise<FetchedDataset>;
  readonly streamDataset: (id: string, sink: NodeSink) => Promise<StreamedDataset>;
  readonly roundTripDataset: (id: string) => Promise<RoundTripReport>;
  readonly countTarget: (dataset: FetchedDataset) => ReadonlyMap<string, number>;
  /** The Save Page Now requests a fetch's provenance leaves to make: one for each download read from its live URL. */
  readonly captureRequests: (provenance: Provenance) => readonly string[];
  /** Sends one of those requests to the Internet Archive. */
  readonly requestCapture: (saveUrl: string) => Promise<void>;
}

/** Everything the command touches outside its arguments and the library. */
export interface CliIo {
  readonly writeStdout: (text: string) => void;
  readonly writeStderr: (text: string) => void;
  readonly writeFile: (path: string, text: string) => void;
  /** Opens a file to be written a piece at a time, for a result too large to hold as one text; each write resolves once the piece may be followed by the next. */
  readonly openFile: (path: string) => FileWriter;
  readonly version: string;
}

/** A file being written a piece at a time. */
export interface FileWriter {
  readonly write: (text: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

/** The command finished and its answer is yes: a result was printed, an entry is valid, a round trip holds. */
export const EXIT_OK = 0;
/** The command ran and its answer is no: an entry is invalid, or a round trip does not hold. */
export const EXIT_NO = 1;
/** No answer: bad usage, an unknown or ambiguous dataset, or a recipe that failed. */
export const EXIT_FAILED = 2;

const usage = `Usage: keepset <command> [options]

Commands:
  search [text] [--kind <kind>] [--domain <domain>] [--subject <subject>]
         [--namespace <path>] [--category <id>] [--json]
                      list the datasets whose id, alias, namespace, name,
                      description, domain, subjects or tags contain the text,
                      filtered by kind, domain, subject, namespace (and every namespace beneath it,
                      segment aliases allowed) or category
  namespaces [path] [--json]
                      list the namespaces directly beneath a path, or the
                      outermost ones, each with how many datasets it holds,
                      tab-separated
  show <dataset> [--json]
                      print a dataset's metadata, recipe and crosswalk
  fetch <dataset> [--out <file>] [--no-archive]
                      run the dataset's recipe and write the normalised result
                      to <file> (default <id>.json), with its provenance beside
                      it in <file without .json>.provenance.json; a table too
                      large to hold is streamed into the file a page at a time.
                      A source is read from its pinned Internet Archive snapshot
                      first, then the closest capture the Archive holds, then its
                      live URL; a source read live is also sent to the Archive to
                      capture, so the next fetch starts from a snapshot, unless
                      --no-archive is given
  validate <dataset>  check the entry against the entry schema and its
                      crosswalk against crossmap's validation
  roundtrip <dataset> fetch the dataset and check that decoding the encoded
                      native document gives it back

A <dataset> is an entry id, an alias, or a qualified name such as
suitesparse/gset/g53, written with / between the namespace and the name. Any
leading part of the namespace may be dropped (gset/g53, g53) while the name
still means one dataset; an entry's own id always means that entry.

Options:
  --help, -h          print this help
  --version, -v       print the version

Exit status: 0 for a result, a valid entry or a round trip that holds; 1 for an
invalid entry or a round trip that does not hold; 2 when there is no answer:
bad usage, an unknown or ambiguous dataset or namespace or a recipe that failed.
`;

/** The parsed command line. */
interface CommandLine {
  readonly values: { readonly kind?: string; readonly domain?: string; readonly subject?: string; readonly namespace?: string; readonly category?: string; readonly json?: boolean; readonly out?: string; readonly "no-archive"?: boolean; readonly help?: boolean; readonly version?: boolean };
  readonly positionals: readonly string[];
}

function parseCommandLine(args: readonly string[]): CommandLine {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      kind: { type: "string" },
      domain: { type: "string" },
      subject: { type: "string" },
      namespace: { type: "string" },
      category: { type: "string" },
      json: { type: "boolean" },
      out: { type: "string" },
      "no-archive": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}

/**
 * JSON as the command prints it: two-space indented, with a trailing newline.
 * @param value - The value.
 * @returns The text.
 */
/** The spaces each level of the JSON the command writes is indented by. */
const JSON_INDENT = 2;

function json(value: unknown): string {
  return `${JSON.stringify(value, undefined, JSON_INDENT)}\n`;
}

/**
 * Indents every line of a text after its first, so a value stringified on its own sits at its depth in an enclosing document.
 * @param text - The text.
 * @param spaces - How many spaces deeper it sits.
 * @returns The indented text.
 */
function indented(text: string, spaces: number): string {
  return text.replaceAll("\n", `\n${" ".repeat(spaces)}`);
}

/**
 * Writes a streamed result to a file as it arrives, as the same text `json` gives the whole `{ meta, nodes }` document, so a streamed fetch's file is byte for byte the file a held fetch of the same nodes would write.
 * @param file - The file.
 * @returns The sink that writes the meta and the nodes, and the step that ends the document.
 */
function jsonDocumentSink(file: FileWriter): { readonly sink: NodeSink; readonly end: () => Promise<void> } {
  let written = 0;
  // The indent of the document's own keys, and of each node in the nodes array.
  const one = " ".repeat(JSON_INDENT);
  const two = " ".repeat(2 * JSON_INDENT);

  return {
    sink: {
      meta: async (meta) => file.write(`{\n${one}"meta": ${indented(JSON.stringify(meta, undefined, JSON_INDENT), JSON_INDENT)},\n${one}"nodes": [`),
      nodes: async (nodes) => file.write(nodes.map((node) => `${written++ === 0 ? "\n" : ",\n"}${two}${indented(JSON.stringify(node, undefined, JSON_INDENT), 2 * JSON_INDENT)}`).join("")),
    },
    end: async () => {
      await file.write(written === 0 ? "]\n}\n" : `\n${one}]\n}\n`);
      await file.close();
    },
  };
}

/**
 * One line per dataset for `search`: id, name, category and whether its recipe can run, tab-separated so the output pipes into other tools.
 * @param datasets - The datasets.
 * @returns The text.
 */
export function formatSearch(datasets: readonly Dataset[]): string {
  return datasets.map(({ entry }) => `${entry.id}\t${entry.name}\t${entry.category}\t${entry.recipe.status}\n`).join("");
}

/**
 * One line per namespace for `namespaces`: path and the number of datasets it holds, tab-separated so the output pipes into other tools.
 * @param nodes - The namespaces.
 * @returns The text.
 */
export function formatNamespaces(nodes: readonly NamespaceNode[]): string {
  return nodes.map((node) => `${node.path}\t${String(node.count)}\n`).join("");
}

/**
 * The human-readable form of `show`: the descriptor, sources, licence, citations, recipe and crosswalk rules, one labelled section after another.
 * @param dataset - The dataset.
 * @returns The text.
 */
export function formatShow(dataset: Dataset): string {
  const { entry, crosswalk } = dataset;
  const lines = [`${entry.name} (${entry.id})`];
  if (entry.description !== undefined) {
    lines.push("", entry.description);
  }
  lines.push("", `category: ${entry.category} (kind ${dataset.kind})`, `catalogue: ${dataset.catalogue.id} ${dataset.catalogue.version}`);
  if (entry.namespace !== undefined) {
    lines.push(`namespace: ${entry.namespace.join(NAME_SEPARATOR)}`);
  }
  if (entry.aliases !== undefined) {
    lines.push(`aliases: ${entry.aliases.join(", ")}`);
  }
  if (entry.sameDataAs !== undefined) {
    lines.push(`same data as: ${entry.sameDataAs.join(", ")}`);
  }
  if (entry.subjects !== undefined) {
    lines.push(`subjects: ${entry.subjects.join(", ")}`);
  }
  if (entry.domain !== undefined) {
    lines.push(`domain: ${entry.domain}`);
  }
  if (entry.tags.length > 0) {
    lines.push(`tags: ${entry.tags.join(", ")}`);
  }
  const { licence } = entry;
  lines.push(`licence: ${licence.kind === "spdx" ? licence.id : licence.kind === "custom" ? `${licence.name} <${licence.url}>` : "not recorded by the source"}`);
  lines.push("", "sources:");
  for (const [index, source] of entry.sources.entries()) {
    const checksum = source.snapshot?.sha256 === undefined ? "" : `, sha256 ${source.snapshot.sha256}, ${String(source.snapshot.byteLength)} bytes`;
    const snapshot = source.snapshot === undefined ? "" : `, snapshot ${source.snapshot.timestamp}${checksum}`;
    lines.push(`  [${String(index)}] ${source.url} (${source.status}, retrieved ${source.retrieved}${snapshot})`);
  }
  if (entry.citations.length > 0) {
    lines.push("", "citations:");
    for (const citation of entry.citations) {
      const link = citation.doi === undefined ? (citation.url === undefined ? "" : ` <${citation.url}>`) : ` doi:${citation.doi}`;
      lines.push(`  ${citation.text}${link}`);
    }
  }
  const { recipe } = entry;
  lines.push("", "recipe:");
  if (recipe.status === "not-fetchable") {
    lines.push(`  not fetchable: ${recipe.reason}`);
  } else {
    const { format, ...options } = recipe.parser;
    if ("files" in recipe) {
      lines.push(`  files: ${String(recipe.files.length)}, each downloaded from its own source`, ...recipe.files.map((file) => `    ${file.path}: source [${String(file.source)}], archive ${archiveText(file.archive)}`));
    } else {
      lines.push(`  source: [${String(recipe.source)}]${recipe.stream === true ? ", streamed" : ""}`, `  archive: ${archiveText(recipe.archive)}`);
    }
    lines.push(`  parser: ${format} ${JSON.stringify(options)}`);
  }
  lines.push("", `crosswalk: ${crosswalk.source} -> ${crosswalk.target}`);
  for (const rule of crosswalk.rules) {
    lines.push(`  ${rule.op} ${rule.from} -> ${rule.to}`);
  }
  for (const rule of crosswalk.oneWay) {
    lines.push(rule.op === "drop" ? `  drop ${rule.from} (encode)` : `  default ${rule.to} = ${JSON.stringify(rule.value)} (${rule.direction})`);
  }
  const counts = Object.entries(entry.expectedCounts);
  if (counts.length > 0) {
    lines.push("", `expected counts: ${counts.map(([key, count]) => `${key} ${String(count)}`).join(", ")}`);
  }
  const properties = Object.entries(entry.properties);
  if (properties.length > 0) {
    lines.push("", "properties:", ...properties.map(([key, value]) => `  ${key}: ${JSON.stringify(value)}`));
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Where `fetch` writes provenance: beside the result, `.json` replaced by `.provenance.json` (or the suffix appended to a path without one).
 * @param out - The result path.
 * @returns The provenance path.
 */
export function provenancePath(out: string): string {
  return out.endsWith(".json") ? `${out.slice(0, -".json".length)}.provenance.json` : `${out}.provenance.json`;
}

/**
 * Formats a list of validation issues, one per line.
 * @param issues - The issues.
 * @returns The text.
 */
function formatIssues(issues: readonly SyntaxIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}\n`).join("");
}

/**
 * Asks the Internet Archive to capture each source a fetch had to read live, once the result is written so the request never delays it. Saying so on stderr is what lets a person who does not want it stop it next time; a request that cannot be sent is a warning, because the fetch itself succeeded.
 * @param provenance - What the fetch recorded.
 * @param library - The library calls.
 * @param io - Output.
 */
async function requestCaptures(provenance: Provenance, library: CliLibrary, io: CliIo): Promise<void> {
  await Promise.all(
    library.captureRequests(provenance).map(async (request) => {
      io.writeStderr(`no snapshot was readable, so the source was read live: asking the Internet Archive to capture it (${request}); --no-archive stops this\n`);
      try {
        await library.requestCapture(request);
      } catch (error) {
        io.writeStderr(`warning: could not send the capture request: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }),
  );
}

/**
 * Runs the command. A KeepsetError from the library (an unknown dataset, a failing recipe) is the command's failure to answer and becomes exit status 2 with its message; anything else is a bug and propagates.
 * @param args - The arguments after the command name.
 * @param library - The library calls.
 * @param io - Output.
 * @returns The exit status.
 */
export async function run(args: readonly string[], library: CliLibrary, io: CliIo): Promise<number> {
  let parsed: CommandLine;
  try {
    parsed = parseCommandLine(args);
  } catch (error) {
    // parseArgs reports an unknown option or a missing option value as a TypeError carrying the reason; that is bad usage, not a failure of the command.
    io.writeStderr(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);

    return EXIT_FAILED;
  }
  const { values, positionals } = parsed;
  if (values.version === true) {
    io.writeStdout(`${io.version}\n`);

    return EXIT_OK;
  }
  if (values.help === true) {
    io.writeStdout(usage);

    return EXIT_OK;
  }
  const [command, ...rest] = positionals;
  const reject = (message: string): number => {
    io.writeStderr(`${message}\n\n${usage}`);

    return EXIT_FAILED;
  };
  try {
    if (command === "search") {
      if (rest.length > 1) {
        return reject("search takes at most one text argument; quote a phrase");
      }
      const [text] = rest;
      const query: DatasetQuery = {
        ...(text === undefined ? {} : { text }),
        ...(values.kind === undefined ? {} : { kind: values.kind }),
        ...(values.domain === undefined ? {} : { domain: values.domain }),
        ...(values.subject === undefined ? {} : { subject: values.subject }),
        ...(values.namespace === undefined ? {} : { namespace: values.namespace }),
        ...(values.category === undefined ? {} : { category: values.category }),
      };
      const datasets = library.listDatasets(query);
      io.writeStdout(values.json === true ? json(datasets.map((dataset) => dataset.entry)) : formatSearch(datasets));

      return EXIT_OK;
    }
    if (command === "namespaces") {
      if (rest.length > 1) {
        return reject("namespaces takes at most one path");
      }
      const [path] = rest;
      if (path !== undefined && library.listDatasets({ namespace: path }).length === 0) {
        io.writeStderr(`no namespace ${JSON.stringify(path)} in the catalogue\n`);

        return EXIT_FAILED;
      }
      const nodes = library.listNamespaces(path);
      io.writeStdout(values.json === true ? json(nodes) : formatNamespaces(nodes));

      return EXIT_OK;
    }
    const [name, ...extra] = rest;
    if (command === undefined) {
      return reject("expected a command");
    }
    if (!["show", "fetch", "validate", "roundtrip"].includes(command)) {
      return reject(`unknown command ${command}`);
    }
    if (name === undefined || extra.length > 0) {
      return reject(`${command} takes exactly one dataset`);
    }
    // The name typed may be an alias or a qualified name; everything the command prints or writes uses the entry's own id, so a name containing / never becomes part of a file path.
    const dataset = library.getDataset(name);
    const { id } = dataset.entry;
    if (command === "show") {
      io.writeStdout(values.json === true ? json(dataset) : formatShow(dataset));

      return EXIT_OK;
    }
    if (command === "validate") {
      const issues = library.validateDataset(dataset);
      if (issues.length > 0) {
        io.writeStdout(formatIssues(issues));

        return EXIT_NO;
      }
      io.writeStdout(`${id} is valid\n`);

      return EXIT_OK;
    }
    const { recipe } = dataset.entry;
    if (command === "fetch" && recipe.status === "fetchable" && !("files" in recipe) && recipe.stream === true) {
      const out = values.out ?? `${id}.json`;
      const document = jsonDocumentSink(io.openFile(out));
      const streamed = await library.streamDataset(id, document.sink);
      await document.end();
      io.writeFile(provenancePath(out), json(streamed.provenance));
      for (const warning of streamed.warnings) {
        io.writeStderr(`warning: ${warning}\n`);
      }
      const counts = [...streamed.counts].map(([key, count]) => `${key} ${String(count)}`).join(", ");
      io.writeStdout(`wrote ${out} (${counts}, streamed) and ${provenancePath(out)}\n`);
      if (values["no-archive"] !== true) {
        await requestCaptures(streamed.provenance, library, io);
      }

      return EXIT_OK;
    }
    if (command === "fetch") {
      const fetched = await library.fetchDataset(id);
      const out = values.out ?? `${id}.json`;
      io.writeFile(out, json(fetched.data));
      io.writeFile(provenancePath(out), json(fetched.provenance));
      for (const warning of fetched.warnings) {
        io.writeStderr(`warning: ${warning}\n`);
      }
      const counts = [...library.countTarget(fetched)].map(([key, count]) => `${key} ${String(count)}`).join(", ");
      io.writeStdout(`wrote ${out} (${counts}) and ${provenancePath(out)}\n`);
      if (values["no-archive"] !== true) {
        await requestCaptures(fetched.provenance, library, io);
      }

      return EXIT_OK;
    }
    const report = await library.roundTripDataset(id);
    if (report.holds) {
      io.writeStdout(`${id}: the round trip holds\n`);

      return EXIT_OK;
    }
    io.writeStdout(`${id}: the round trip does not hold at ${report.path === "" ? "(root)" : report.path}: ${report.message}\n`);

    return EXIT_NO;
  } catch (error) {
    if (error instanceof KeepsetError) {
      io.writeStderr(`${error.message}\n`);

      return EXIT_FAILED;
    }
    throw error;
  }
}
