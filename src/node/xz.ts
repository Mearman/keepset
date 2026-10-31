import xzDecompress from "xz-decompress";
import { ArchiveError } from "../errors";

/**
 * Turns an async iterable of chunks into the web stream the decoder reads. The stream pulls one chunk only when the decoder asks for input (its queue holds none ahead), so the source is read no faster than the decoder takes it, and cancelling the stream closes the iterable.
 * @param chunks - The chunks.
 * @returns A stream of them.
 */
function streamOf(chunks: Readonly<AsyncIterable<Uint8Array>>): ReadableStream<Uint8Array> {
  const iterator = chunks[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const next = await iterator.next();
        if (next.done === true) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      },
      async cancel() {
        await iterator.return?.();
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * Decompresses xz data as it arrives: one stream or several concatenated ones, as `xz -d` reads them, with the stream padding the format allows between them. The decoder is `xz-decompress`, the XZ Embedded decoder compiled to WebAssembly, which reads a compressed chunk only when it needs input, so what is held is the decoder's dictionary (the size the stream's header names) and one chunk each way, whatever the size of the data. It checks the format's own integrity fields (the block headers, check values, index and footer), and fails on input that ends inside a stream or holds anything but padding or another stream after one, so a download cut short or corrupted never yields a prefix of the file as the whole of it.
 *
 * `xz-decompress` allows one decoder at a time in a process and holds it until its stream finishes, fails or is cancelled. Iterating the stream with `for await` cancels it when the loop ends early, so a reader that stops taking chunks only has to return the generator.
 * @param compressed - The compressed bytes, in order, cut anywhere.
 * @returns The decompressed bytes, in order.
 * @throws ArchiveError when the data is not valid xz, ends early or holds anything after the last stream but padding.
 */
export async function* unxz(compressed: Readonly<AsyncIterable<Uint8Array>>): AsyncGenerator<Uint8Array, void, undefined> {
  try {
    yield* new xzDecompress.XzReadableStream(streamOf(compressed));
  } catch (error) {
    throw new ArchiveError(`not valid xz data: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
