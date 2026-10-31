import { createHash } from "node:crypto";
import { CrosswalkSchema } from "crossmap";
import { describe, expect, it } from "vitest";
import { createCatalogue, type Dataset } from "../catalogue";
import { parseEntry } from "../entry";
import { CatalogueSyntaxError, RecipeError } from "../errors";
import { fixtureIndex, socrataEntry, streamedEntry } from "../test-support/entries";
import { fetchEntry, roundTripEntry, streamEntry, type FetchPort, type NodeSink, type StreamedNode } from "./fetch-dataset";
import { inseparableRule } from "./stream-dataset";

const now = (): Date => new Date("2026-10-21T12:00:00.000Z");
const resource = "https://data.example.org/resource/abcd-1234.csv";
const header = "case_id,status,borough\n";
const rows = ["a1,Open,Camden\n", 'a2,Closed,"Isle ""of"" Dogs"\n', "a3,Open,Hackney\n", "a4,Open,Barnet\n", "a5,Closed,Brent\n"];

const datasetWith = (entry: unknown): Dataset => createCatalogue({ ...fixtureIndex, entries: [entry] }).listDatasets()[0] ?? expect.unreachable("the fixture catalogue lists its one entry");

/** What happened, in order: each request the port answered and each call the sink received. */
type Event = { readonly request: string } | { readonly meta: Readonly<Record<string, unknown>> } | { readonly nodes: readonly StreamedNode[] };

/** An event log and the function that adds to it. */
function eventLog(): { readonly events: readonly Event[]; readonly record: (event: Event) => void } {
  const events: Event[] = [];

  return {
    events,
    record: (event) => {
      events.push(event);
    },
  };
}

/** The fixture crosswalk's rules but the one that maps the borough, for a test that maps it its own way. */
const rulesBesideBorough = socrataEntry.crosswalk.rules.filter((rule) => rule.from !== "nodes[].borough");

/** A sink that drops what it receives. */
const ignoring: NodeSink = { meta: () => undefined, nodes: () => undefined };
const ignore = (): void => undefined;

/** The row of a lossy number that a scale by a tenth does not give back exactly, and its place in the table. */
const LOSSY_ROW = 3;
/** The row of a latitude out of range, and of an id repeated from an earlier page. */
const OUT_OF_RANGE_ROW = 2;
const REPEATED_ROW = 3;
/** A count the fixture entry records that the five fixture rows do not have. */
const RECORDED_COUNT = 9;

/**
 * A stand-in Socrata resource answering its count and its pages by offset, logging each request to a shared event list.
 * @param all - The rows.
 * @param record - Logs an event.
 * @param page - What a page of a given offset says, given what it honestly holds.
 * @returns The port.
 */
function resourceServing(all: readonly string[], record: (event: Event) => void, page: (offset: number, honest: string) => string = (_offset, honest) => honest): FetchPort {
  return async (url) => {
    record({ request: url });
    if (url.includes("select=count")) {
      return Promise.resolve(new Response(`"count"\n"${String(all.length)}"\n`));
    }
    const offset = Number(/offset=(\d+)/.exec(url)?.[1]);
    const limit = Number(/limit=(\d+)/.exec(url)?.[1]);

    return Promise.resolve(new Response(page(offset, header + all.slice(offset, offset + limit).join(""))));
  };
}

/** A sink that logs what it receives, and waits a turn before returning, as a sink that writes to a file does. */
function loggingSink(record: (event: Event) => void): NodeSink {
  return {
    meta: (meta) => {
      record({ meta });
    },
    nodes: async (nodes) => {
      record({ nodes });
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}

async function failure(run: Readonly<Promise<unknown>>): Promise<RecipeError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof RecipeError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected a RecipeError");
}

describe("streamEntry", () => {
  it("hands on the meta and then each page's nodes, requesting a page only after the sink has had the one before", async () => {
    const { events, record } = eventLog();
    const streamed = await streamEntry(datasetWith(streamedEntry), loggingSink(record), { fetch: resourceServing(rows, record), now });
    const { pageSize } = socrataEntry.recipe.paging;
    const page = (index: number): string => `${resource}?%24order=%3Aid&%24limit=${String(pageSize)}&%24offset=${String(index * pageSize)}`;
    expect(events).toEqual([
      { meta: { id: "streamed-cases", name: "Streamed cases" } },
      { request: `${resource}?%24select=count(*)` },
      { request: page(0) },
      {
        nodes: [
          { id: "a1", status: "Open", territory: "Camden" },
          { id: "a2", status: "Closed", territory: 'Isle "of" Dogs' },
        ],
      },
      { request: page(1) },
      {
        nodes: [
          { id: "a3", status: "Open", territory: "Hackney" },
          { id: "a4", status: "Open", territory: "Barnet" },
        ],
      },
      { request: page(2) },
      { nodes: [{ id: "a5", status: "Closed", territory: "Brent" }] },
    ]);
    expect(streamed.counts).toEqual(new Map([["nodes", rows.length]]));
    expect(streamed.meta).toEqual({ id: "streamed-cases", name: "Streamed cases" });
  });

  it("gives the nodes and the provenance a document fetch of the same recipe gives", async () => {
    const nodes: StreamedNode[] = [];
    const streamed = await streamEntry(
      datasetWith(streamedEntry),
      {
        meta: () => undefined,
        nodes: (page) => {
          nodes.push(...page);
        },
      },
      { fetch: resourceServing(rows, ignore), now },
    );
    const held = await fetchEntry(datasetWith({ ...streamedEntry, recipe: socrataEntry.recipe }), { fetch: resourceServing(rows, ignore), now });
    expect({ meta: streamed.meta, nodes }).toEqual(held.data);
    expect(streamed.provenance).toEqual(held.provenance);
    expect(streamed.provenance.sha256).toBe(createHash("sha256").update(header + rows.join("")).digest("hex"));
  });

  it("warns when the node count differs from the one the entry records", async () => {
    const recorded = await streamEntry(datasetWith({ ...streamedEntry, expectedCounts: { nodes: RECORDED_COUNT } }), ignoring, { fetch: resourceServing(rows, ignore), now });
    expect(recorded.warnings).toEqual([`nodes: the entry records ${String(RECORDED_COUNT)}, the fetched result has ${String(rows.length)}`]);
  });

  it("fails at the validate step on an id an earlier page already had, naming its place in the whole table, after handing on only the pages before it", async () => {
    const { events, record } = eventLog();
    const repeated = ["a1,Open,Camden\n", "a2,Open,Camden\n", "a3,Open,Camden\n", "a1,Open,Camden\n"];
    const error = await failure(streamEntry(datasetWith(streamedEntry), loggingSink(record), { fetch: resourceServing(repeated, record), now }));
    expect(error.step).toBe("validate");
    expect(error.message).toContain(`nodes.${String(REPEATED_ROW)}.id: duplicate node id "a1"`);
    expect(events.filter((event) => "nodes" in event)).toHaveLength(1);
  });

  it("fails at the validate step on a node the category's node shape refuses, naming its place in the whole table", async () => {
    const latitude = { ...streamedEntry, recipe: { ...streamedEntry.recipe, parser: { ...streamedEntry.recipe.parser, numericColumns: [{ column: "borough", factor: 1 }] } }, crosswalk: { ...socrataEntry.crosswalk, rules: [...rulesBesideBorough, { op: "move", from: "nodes[].borough", to: "nodes[].lat" }] } };
    const error = await failure(streamEntry(datasetWith(latitude), ignoring, { fetch: resourceServing(["a1,Open,10\n", "a2,Open,20\n", "a3,Open,95\n"], ignore), now }));
    expect(error.step).toBe("validate");
    expect(error.message).toContain(`nodes.${String(OUT_OF_RANGE_ROW)}.lat:`);
  });

  it("refuses a recipe that does not stream, and fetchEntry refuses one that does, before any request", async () => {
    const { events, record } = eventLog();
    const notStreamed = await failure(streamEntry(datasetWith(socrataEntry), loggingSink(record), { fetch: resourceServing(rows, record), now }));
    expect(notStreamed.step).toBe("recipe");
    const held = await failure(fetchEntry(datasetWith(streamedEntry), { fetch: resourceServing(rows, record), now }));
    expect(held.step).toBe("recipe");
    expect(held.message).toMatch(/streamDataset/);
    expect(events).toEqual([]);
  });

  it("refuses a crosswalk that cannot run a page at a time before any request", async () => {
    const { events, record } = eventLog();
    const conditional = { ...streamedEntry, crosswalk: { ...socrataEntry.crosswalk, rules: [...rulesBesideBorough, { op: "move", from: "nodes[].borough", to: "nodes[].territory", when: { kind: "exists", operand: { kind: "reference", key: "meta.name" } } }] } };
    const error = await failure(streamEntry(datasetWith(conditional), loggingSink(record), { fetch: resourceServing(rows, record), now }));
    expect(error.step).toBe("crosswalk");
    expect(error.message).toMatch(/has a when/);
    expect(events).toEqual([]);
  });
});

describe("inseparableRule", () => {
  const crosswalk = (rules: readonly unknown[]): ReturnType<typeof CrosswalkSchema.parse> => CrosswalkSchema.parse({ source: "csv-table", target: "tasks/v1", rules });

  it("accepts rules over the meta alone and over one node's fields alone", () => {
    expect(inseparableRule(crosswalk([{ op: "move", from: "meta", to: "meta" }, { op: "move", from: "nodes[].id", to: "nodes[].id" }, { op: "scale", from: "nodes[].minutes", to: "nodes[].duration", factor: 60 }]))).toBeUndefined();
  });

  it("names a rule that reaches outside the meta and the nodes", () => {
    expect(inseparableRule(crosswalk([{ op: "move", from: "meta", to: "meta" }, { op: "move", from: "table", to: "nodes" }]))).toMatch(/rule 1 \(move\) reads or writes table and nodes/);
  });
});

describe("a streamed recipe in the entry schema", () => {
  it("must read a CSV paged source through the csv-table parser with no archive, for a category with a streamed form", () => {
    const issues = (entry: unknown): readonly string[] => {
      try {
        parseEntry(entry);

        return [];
      } catch (error) {
        if (error instanceof CatalogueSyntaxError) {
          return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
        }
        throw error;
      }
    };
    expect(issues(streamedEntry)).toEqual([]);
    const unpaged = Object.fromEntries(Object.entries(streamedEntry.recipe).filter(([key]) => key !== "paging"));
    expect(issues({ ...streamedEntry, recipe: unpaged })).toEqual([expect.stringMatching(/^recipe\.stream: a streamed recipe reads a CSV paged source/)]);
    expect(issues({ ...streamedEntry, recipe: { ...streamedEntry.recipe, archive: { kind: "gzip" } } })).toEqual([expect.stringMatching(/^recipe\.stream:/)]);
    expect(issues({ ...streamedEntry, category: "graph/v1", crosswalk: { ...socrataEntry.crosswalk, target: "graph/v1" } })).toEqual([expect.stringMatching(/^recipe\.stream: graph\/v1 has no streamed form/)]);
  });

  it("selects the id column and every column the parser keeps when it selects Socrata fields", () => {
    const selecting = (select: readonly string[]): unknown => ({ ...streamedEntry, recipe: { ...streamedEntry.recipe, paging: { kind: "socrata-resource", pageSize: 2, select } } });
    expect(() => parseEntry(selecting(["case_id", "status", "borough"]))).not.toThrow();
    expect(() => parseEntry(selecting(["case_id", "status"]))).toThrow(/must select borough/);
  });
});

describe("roundTripEntry on a streamed recipe", () => {
  const lossy = {
    ...streamedEntry,
    recipe: { ...streamedEntry.recipe, parser: { ...streamedEntry.recipe.parser, numericColumns: [{ column: "borough", factor: 1 }] } },
    crosswalk: { ...socrataEntry.crosswalk, rules: [...rulesBesideBorough, { op: "scale", from: "nodes[].borough", to: "nodes[].prize", factor: 0.1 }] },
  };
  const lossyRows = ["a1,Open,1\n", "a2,Open,2\n", "a3,Open,4\n", "a4,Open,3\n", "a5,Open,8\n"];
  const requests = (events: readonly Event[]): readonly string[] => events.flatMap((event) => ("request" in event ? [event.request] : []));

  it("holds page by page over the whole table", async () => {
    expect(await roundTripEntry(datasetWith(streamedEntry), { fetch: resourceServing(rows, ignore), now })).toMatchObject({ holds: true, provenance: { byteLength: new TextEncoder().encode(header + rows.join("")).length } });
  });

  it("reports the node count and a warning for a recorded count that differs, as streamEntry does", async () => {
    const entry = datasetWith({ ...streamedEntry, expectedCounts: { nodes: RECORDED_COUNT } });
    const report = await roundTripEntry(entry, { fetch: resourceServing(rows, ignore), now });
    const streamed = await streamEntry(entry, ignoring, { fetch: resourceServing(rows, ignore), now });
    expect(report.counts).toEqual(new Map([["nodes", rows.length]]));
    expect(report.warnings).toEqual([`nodes: the entry records ${String(RECORDED_COUNT)}, the fetched result has ${String(rows.length)}`]);
    expect(report.warnings).toEqual(streamed.warnings);
    expect(report.counts).toEqual(streamed.counts);
  });

  it("asks the network for each request of the table once, the same requests a stream makes", async () => {
    const roundTrip = eventLog();
    await roundTripEntry(datasetWith(streamedEntry), { fetch: resourceServing(rows, roundTrip.record), now });
    const stream = eventLog();
    await streamEntry(datasetWith(streamedEntry), ignoring, { fetch: resourceServing(rows, stream.record), now });
    expect(requests(roundTrip.events)).toEqual(requests(stream.events));
    expect(new Set(requests(roundTrip.events)).size).toBe(requests(roundTrip.events).length);
  });

  it("names the first path that differs in the whole table and still counts every node", async () => {
    const { events, record } = eventLog();
    const report = await roundTripEntry(datasetWith(lossy), { fetch: resourceServing(lossyRows, record), now });
    expect(report).toMatchObject({ holds: false, path: `nodes[${String(LOSSY_ROW)}].borough`, provenance: { byteLength: new TextEncoder().encode(header + lossyRows.join("")).length } });
    expect(report.counts).toEqual(new Map([["nodes", lossyRows.length]]));
    expect(requests(events).filter((request) => request.includes("offset=4"))).toHaveLength(1);
  });

  it("fails at the validate step on a node the category refuses, as streamEntry does", async () => {
    const latitude = { ...streamedEntry, recipe: { ...streamedEntry.recipe, parser: { ...streamedEntry.recipe.parser, numericColumns: [{ column: "borough", factor: 1 }] } }, crosswalk: { ...socrataEntry.crosswalk, rules: [...rulesBesideBorough, { op: "move", from: "nodes[].borough", to: "nodes[].lat" }] } };
    const error = await failure(roundTripEntry(datasetWith(latitude), { fetch: resourceServing(["a1,Open,10\n", "a2,Open,20\n", "a3,Open,95\n"], ignore), now }));
    expect(error.step).toBe("validate");
    expect(error.message).toContain(`nodes.${String(OUT_OF_RANGE_ROW)}.lat:`);
  });
});

describe("a Socrata recipe that selects fields", () => {
  it("requests only those fields in each page", async () => {
    const { events, record } = eventLog();
    const selecting = { ...streamedEntry, recipe: { ...streamedEntry.recipe, paging: { kind: "socrata-resource", pageSize: rows.length, select: ["case_id", "status", "borough"] } } };
    await streamEntry(datasetWith(selecting), ignoring, { fetch: resourceServing(rows, record), now });
    expect(events).toContainEqual({ request: `${resource}?%24select=case_id%2Cstatus%2Cborough&%24order=%3Aid&%24limit=${String(rows.length)}&%24offset=0` });
  });
});
