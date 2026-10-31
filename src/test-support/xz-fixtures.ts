/** A tar archive laid out as the Quran speech dataset's download is (`audio_data/<reader>/<surah><ayah>.mp3`, `transcripts.tsv`, `audo_list.txt` and `all_ayat.json`, all at the top), compressed with xz by a reference encoder (CRC-64 checks, one block), as base64. `transcripts.tsv` has a header row and, for each recording, a path, a duration in seconds and Arabic text, as the real table writes them: the duration cell ends in a line break, so the text begins the next line. */
export const QURAN_TAR_XZ_BASE64 = "/Td6WFoAAATm1rRGBMCHA4BQIQEWAAAAAAAAAD1Ty/LgJ/8Bf10AMJ1IrC9Ik+7ap1157KovKOrxR7j8eVnhJtujVp/RmlPzMhSiC+jmJpF8kHgSRccYC2OhtLZnJaW7VDKhZCC6272b3brUPBnQSZ7Y+Lidgldmd0FAbIGTRyFy5SSSaFmdGrPsVMG8v/Wac5H/7mV8R3HOojILJy98FbUHnCFcLAv8lImFsnk/e6kWS9ocmyaZDNqY4KocBog8aUZwgPBrI60hKKRFv+nxSbaixxHM5bp7rGtczQxc0+KcOsRLanZLiIj+KXnhVDaQ1kWagUe0rsM7uAfV1d00fOWx7gG+bhhpBuUrDnUs5t4i13HmpP7tyxXJZxwidSJwkQflm2kxk5kT6ljNhQHtjvjXvOT2VjOKcYpi/eDFmtfkg9FNVr4gsr+cI+uKq9jsa2MAtvB7wG8owpV5uSnLQb8pLJs6SZReomNVRy2B2PnMssrD/N9tyMB5p5j4jl1RFp33OpPCW3gdgegsMVn71WjdH/aLHlc+94Rw9grhILmat9uSWAAAAOCXFYyvR1cnAAGjA4BQAADGVZiascRn+wIAAAAABFla";

/** The two lines `first line` and `second line`, each ending with a line feed, compressed with xz by a reference encoder (CRC-32 check, one block), as base64. */
export const TWO_LINES_XZ_BASE64 = "/Td6WFoAAAFpIt42AgAhARAAAACocI6GAQAWZmlyc3QgbGluZQpzZWNvbmQgbGluZQoAACxaRV0AASsXhc0l1ZBCmQ0BAAAAAAFZWg==";

/**
 * Decodes a base64 fixture.
 * @param base64 - The fixture.
 * @returns Its bytes.
 */
export function fixtureBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}
