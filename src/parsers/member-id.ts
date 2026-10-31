import { NativeParseError } from "../errors";

/**
 * The id a recipe's pattern gives a file of a multi-file table parser: the capture group of the pattern, which must match the file's whole path.
 * @param format - The parser's format, for the error.
 * @param path - The file's path in the archive.
 * @param idPattern - The recipe's regular expression, with one capture group.
 * @param position - The file's 1-based position among the files, for the error.
 * @returns The id.
 * @throws NativeParseError when the path does not match the pattern or the capture is empty.
 */
export function memberId(format: string, path: string, idPattern: string, position: number): string {
  const id = new RegExp(`^(?:${idPattern})$`, "u").exec(path)?.[1];
  if (id === undefined || id === "") {
    throw new NativeParseError(format, position, `the path ${path} gives no id by the pattern ${idPattern}`);
  }

  return id;
}
