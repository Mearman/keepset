import { describe, expect, it } from "vitest";
import { NativeParseError } from "../errors";
import { numberReader } from "./number-lines";

const read = numberReader("example");
const LINE = 4;

describe("the shared number reader", () => {
  it("reads a decimal with or without an exponent as a number", () => {
    const expected: Record<string, number> = { "1.5e+3": 1500, "7.12506E+007": 71250600, "5.02e-05": 0.0000502, "-.5": -0.5, "12": 12 };
    for (const [field, value] of Object.entries(expected)) {
      expect(read.scientific(field, LINE, "a weight")).toBe(value);
    }
  });

  it("refuses what is not a number, naming the format, line and field", () => {
    for (const field of ["", "e5", "1e", "1e+", "1.5x", "NaN", "Infinity", "0x10"]) {
      expect(() => read.scientific(field, LINE, "a weight")).toThrow(new NativeParseError("example", LINE, `expected a weight as a number, found ${JSON.stringify(field)}`));
    }
  });

  it("leaves decimal refusing an exponent", () => {
    expect(() => read.decimal("1.5e+3", LINE, "a weight")).toThrow(/example line 4: expected a weight as a number/);
  });
});
