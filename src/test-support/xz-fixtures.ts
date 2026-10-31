/** A tar archive laid out as the Quran speech dataset's download is (`audio_data/<reader>/<surah><ayah>.mp3`, `transcripts.tsv`, `audo_list.txt` and `all_ayat.json`, all at the top), compressed with xz by a reference encoder (CRC-64 checks, one block), as base64. The tab-separated rows of `transcripts.tsv` are a path, a duration in seconds and Arabic text. */
export const QURAN_TAR_XZ_BASE64 = "/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AWBdADCdSKwvSJPu2qddeeyqLyjq8Ue4/HlZ4Sbbo1af0ZpT8zIUogvo5iaRfJB4EkXHGAtjobS2ZyWlu1QyoWQgutu9m9261DwZ0Eme2Pi4nYJXZndBQGyBk0chcuUkkmhZnRqz7FTBvL/1mnOR/+5lfEdxzqIyCycvfBW1B5wbOoOmZ292PR3ho656d7rKA9pSS+kl64Qj9nPzg+0gAmHYAQ1g84vB9DLk55NyTA6wfclx0UzZpdIe3bmO4L2lYqYh1B6x83ZDUGqvoqQbmCQNskw+eQw4kUA3TYToeNBNfMeG0QDNZu6D3K1a8Ly3JzGrtP3HB1JVH9jEX4Ukk41FupdIvIhBfSz+jNkRFiNgio+38GMZIftg5oM46mau9957XC3FrnKY3X7k7nSbIqQneBGbda+b5GHUtXy8Qy6ra8SZ+54AERURNtiO1eTi5Gv1Cc4v2s0vJreqy4jJNEdq7XsA9wMNH7606V0AAfwCgFAAAFTGIFqxxGf7AgAAAAAEWVo=";

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
