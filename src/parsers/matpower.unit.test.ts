import { describe, expect, it } from "vitest";
import { parseNative } from "./parse-native";

const matpower = { format: "matpower", encoding: "utf-8" } as const;

const bytes = (...lines: readonly string[]): Uint8Array => new TextEncoder().encode(`${lines.join("\n")}\n`);

/** A two-bus case laid out as the PGLib files are: a comment header, the function line, the scalars, and each table under its column comment, with a trailing comment on a cost row. */
const SMALL = [
  "%% a two-bus case",
  "function mpc = small_case",
  "mpc.version = '2';",
  "mpc.baseMVA = 100.0;",
  "",
  "%% bus data",
  "%\tbus_i\ttype\tPd\tQd\tGs\tBs\tarea\tVm\tVa\tbaseKV\tzone\tVmax\tVmin",
  "mpc.bus = [",
  "\t1\t 3\t 0.0\t 0.0\t 0.0\t 0.0\t 1\t 1.06\t 0.0\t 0.0\t 1\t 1.06\t 0.94;",
  "\t4\t 1\t 21.7\t 12.7\t 0.0\t 5.02e-05\t 1\t 1.0\t 0.0\t 0.0\t 1\t 1.06\t 0.94;",
  "];",
  "",
  "%% generator data",
  "mpc.gen = [",
  "\t1\t 232.4\t -16.9\t 10.0\t 0.0\t 1.06\t 100.0\t 1\t 340\t 0.0;",
  "];",
  "",
  "%% generator cost data",
  "mpc.gencost = [",
  "\t2\t 0.0\t 0.0\t 3\t   0.000000\t   7.920951\t   0.000000; % NG",
  "];",
  "",
  "%% branch data",
  "mpc.branch = [",
  "\t1\t 4\t 0.01938\t 0.05917\t 0.0528\t 472\t 472\t 472\t 0.0\t 0.0\t 1\t -30.0\t 30.0;",
  "];",
];

const genNulls = { Pc1: null, Pc2: null, Qc1min: null, Qc1max: null, Qc2min: null, Qc2max: null, ramp_agc: null, ramp_10: null, ramp_30: null, ramp_q: null, apf: null };
const busNulls = { busType: null, Pd: null, Qd: null, Gs: null, Bs: null, area: null, Vm: null, Va: null, baseKV: null, zone: null, Vmax: null, Vmin: null };
const noGen = { Pg: null, Qg: null, Qmax: null, Qmin: null, Vg: null, mBase: null, status: null, Pmax: null, Pmin: null, ...genNulls, startup: null, shutdown: null, c2: null, c1: null, c0: null };
const noBranch = { r: null, x: null, b: null, rateA: null, rateB: null, rateC: null, ratio: null, angle: null, branchStatus: null, angmin: null, angmax: null };

describe("the MATPOWER parser", () => {
  it("reads buses and generators as nodes, each generator joined to its bus, and branches as edges", () => {
    expect(parseNative(bytes(...SMALL), matpower)).toEqual({
      meta: { name: "small_case", version: "2", baseMVA: 100 },
      nodes: [
        { id: "1", type: "bus", busType: 3, Pd: 0, Qd: 0, Gs: 0, Bs: 0, area: 1, Vm: 1.06, Va: 0, baseKV: 0, zone: 1, Vmax: 1.06, Vmin: 0.94, ...noGen },
        { id: "4", type: "bus", busType: 1, Pd: 21.7, Qd: 12.7, Gs: 0, Bs: 5.02e-5, area: 1, Vm: 1, Va: 0, baseKV: 0, zone: 1, Vmax: 1.06, Vmin: 0.94, ...noGen },
        { id: "generator-1", type: "generator", ...busNulls, Pg: 232.4, Qg: -16.9, Qmax: 10, Qmin: 0, Vg: 1.06, mBase: 100, status: 1, Pmax: 340, Pmin: 0, ...genNulls, startup: 0, shutdown: 0, c2: 0, c1: 7.920951, c0: 0 },
      ],
      edges: [
        { source: "generator-1", target: "1", type: "generator", ...noBranch },
        { source: "1", target: "4", type: "branch", r: 0.01938, x: 0.05917, b: 0.0528, rateA: 472, rateB: 472, rateC: 472, ratio: 0, angle: 0, branchStatus: 1, angmin: -30, angmax: 30 },
      ],
    });
  });

  it("carries the legacy area table in the meta", () => {
    expect(parseNative(bytes(...SMALL, "mpc.areas = [", "\t1\t 1;", "];"), matpower).meta).toEqual({ name: "small_case", version: "2", baseMVA: 100, areas: "1 1" });
  });

  it("refuses a case that disagrees with the format", () => {
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("'2'", "'1'"))), matpower)).toThrow(/expected mpc.version = '2'/);
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("\t4\t 1\t", "\t1\t 1\t"))), matpower)).toThrow(/line 10: the bus number 1 is not a whole number or is given twice/);
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("\t1\t 4\t 0.01938", "\t1\t 5\t 0.01938"))), matpower)).toThrow(/line 25: a branch at bus 5, which the case does not list/);
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("\t2\t 0.0\t 0.0\t 3\t   0.000000\t", "\t2\t 0.0\t 0.0\t 2\t"))), matpower)).toThrow(/line 20: expected a row of mpc.gencost of 7 columns/);
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("\t2\t 0.0\t 0.0\t 3\t", "\t1\t 0.0\t 0.0\t 3\t"))), matpower)).toThrow(/line 20: expected a quadratic polynomial cost/);
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace(" 0.94;", " 0.94"))), matpower)).toThrow(/line 9: expected a row of mpc.bus ending with ;/);
    expect(() => parseNative(bytes(...SMALL, "mpc.dcline = ["), matpower)).toThrow(/the table mpc.dcline is not one the parser reads/);
    expect(() => parseNative(bytes(...SMALL.slice(0, -1)), matpower)).toThrow(/line 24: the table mpc.branch is not closed/);
  });

  it("reads a value written with an exponent", () => {
    expect(parseNative(bytes(...SMALL.map((line) => line.replace("baseMVA = 100.0", "baseMVA = 1.5e+2"))), matpower).meta).toMatchObject({ baseMVA: 150 });
  });

  it("refuses a case with no gencost table", () => {
    const start = SMALL.indexOf("mpc.gencost = [");
    const without = [...SMALL.slice(0, start), ...SMALL.slice(SMALL.indexOf("];", start) + 1)];
    expect(() => parseNative(bytes(...without), matpower)).toThrow(/matpower line 1: the case has no mpc.gencost table/);
  });

  it("refuses Inf as a value that is not a number", () => {
    expect(() => parseNative(bytes(...SMALL.map((line) => line.replace("\t 472\t 472\t 472\t", "\t Inf\t 472\t 472\t"))), matpower)).toThrow(/matpower line 25: expected a value of mpc.branch as a number, found "Inf"/);
  });

  it("refuses a gencost table of twice as many rows as generators", () => {
    const cost = SMALL.find((line) => line.includes("% NG")) ?? "";
    expect(() => parseNative(bytes(...SMALL.flatMap((line) => (line === cost ? [line, line] : [line]))), matpower)).toThrow(/matpower line 19: expected one cost row per generator \(1\), found 2/);
  });
});
