/**
 * Runs an asynchronous step on each item in turn, each starting only once the one before it has finished, as an async iterable of the results: a reader that takes one result at a time holds one at a time, and a step that reads a range of a file or asks a server for one never runs beside another.
 * @param items - The items, taken one at a time as the results are asked for.
 * @param step - What to do with each.
 * @returns Each item's result, in order.
 */
export function inTurn<Item, Result>(items: Readonly<Iterable<Item>>, step: (item: Item) => Promise<Result>): AsyncIterable<Result> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = items[Symbol.iterator]();

      return {
        next: async (): Promise<IteratorResult<Result, undefined>> => {
          const next = iterator.next();

          return next.done === true ? { done: true, value: undefined } : { done: false, value: await step(next.value) };
        },
      };
    },
  };
}

/**
 * The ranges that cut a span of bytes into pieces of one size, the last of them shorter when the size does not divide the span.
 * @param size - The span's length.
 * @param pieceBytes - The size of each piece.
 * @returns Each piece's offset and length, in order.
 */
export function* piecesOf(size: number, pieceBytes: number): Generator<{ readonly offset: number; readonly length: number }, void, undefined> {
  for (let offset = 0; offset < size; offset += pieceBytes) {
    yield { offset, length: Math.min(pieceBytes, size - offset) };
  }
}
