import { randomBytes } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { updateCrc32 } from "./crc32";

/** Lengths around the sliced update's eight-byte step, so the step and the byte-at-a-time tail are both exercised at every remainder, and a length far past it. */
const SLICE = 8;
const STEPS_AROUND = 3;
/** A length of many steps and a remainder, as a real piece of data is. */
const LONG_LENGTH = 4097;
const LENGTHS = [...Array.from({ length: SLICE * STEPS_AROUND }, (_, length) => length), LONG_LENGTH];
/** The CRC-32/ISO-HDLC check value: the CRC of the ASCII digits 1 to 9, as the catalogue of parametrised CRC algorithms lists it. */
const CHECK_VALUE = 0xcbf43926;

describe("updateCrc32", () => {
  it("gives zlib's CRC-32 for data of every length around its step", () => {
    for (const length of LENGTHS) {
      const bytes = randomBytes(length);
      expect(updateCrc32(0, bytes)).toBe(crc32(bytes));
    }
  });

  it("gives the same CRC-32 however the data is cut into pieces, at any offset into its backing buffer", () => {
    const bytes = randomBytes(LENGTHS.at(-1) ?? expect.unreachable("the lengths are listed"));
    for (let cut = 0; cut <= SLICE * 2; cut += 1) {
      expect(updateCrc32(updateCrc32(0, bytes.subarray(0, cut)), bytes.subarray(cut))).toBe(crc32(bytes));
    }
  });

  it("gives the check value of the CRC-32 the catalogue of parametrised CRCs lists", () => {
    expect(updateCrc32(0, new TextEncoder().encode("123456789"))).toBe(CHECK_VALUE);
  });
});
