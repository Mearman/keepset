import { createHash } from "node:crypto";

/** How many bytes are given to the hash at a time. `Hash.update` refuses a buffer of 2 GiB or more (`RangeError: data is too long`), so a download larger than that is hashed in slices; one GiB is half the limit, and the digest of the slices is the digest of the whole. */
const BYTES_PER_KIBIBYTE = 1024;
const BYTES_PER_GIBIBYTE = BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;
export const HASH_SLICE_BYTES = BYTES_PER_GIBIBYTE;

/**
 * The SHA-256 of bytes as lowercase hex, of any length that fits in memory.
 * @param bytes - The bytes.
 * @param sliceBytes - How many bytes to give the hash at a time.
 * @returns The digest.
 */
export function sha256Hex(bytes: Uint8Array, sliceBytes: number = HASH_SLICE_BYTES): string {
  const hash = createHash("sha256");
  for (let start = 0; start < bytes.length; start += sliceBytes) {
    hash.update(bytes.subarray(start, start + sliceBytes));
  }

  return hash.digest("hex");
}
