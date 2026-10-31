import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  const LENGTH = 1000;
  const STRIDE = 7;
  const BYTE_RANGE = 256;
  const THIRDS = 3;
  const OVERSIZE = 4;
  const bytes = Uint8Array.from({ length: LENGTH }, (_, index) => (index * STRIDE) % BYTE_RANGE);
  const whole = createHash("sha256").update(bytes).digest("hex");

  it("gives the digest of the whole input however it is sliced, including slices that do not divide its length", () => {
    for (const slice of [1, STRIDE, Math.floor(LENGTH / THIRDS), LENGTH - 1, LENGTH, LENGTH * OVERSIZE]) {
      expect(sha256Hex(bytes, slice)).toBe(whole);
    }
  });

  it("gives the digest of the empty input", () => {
    expect(sha256Hex(new Uint8Array(0))).toBe(createHash("sha256").update("").digest("hex"));
  });
});
