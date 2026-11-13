// Sequencing over store answers that may be synchronous (the CLI's SQLite
// ledger) or asynchronous. The seen policy is written once with these
// helpers: over a synchronous store every step runs synchronously, so the
// CLI's synchronous callers and an awaiting caller run the same code in the
// same order.

import type { MaybePromise } from "../../maybePromise";

export function isPromise<T>(value: MaybePromise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

/** `f(value)`, synchronously when `value` is not a promise. */
export function andThen<A, B>(value: MaybePromise<A>, f: (a: A) => MaybePromise<B>): MaybePromise<B> {
  return isPromise(value) ? value.then(f) : f(value);
}

/** Map `items` one after another (never concurrently), preserving order. */
export function mapInOrder<A, B>(items: readonly A[], f: (item: A) => MaybePromise<B>): MaybePromise<B[]> {
  const results: B[] = [];
  const step = (index: number): MaybePromise<B[]> => {
    if (index >= items.length) return results;
    return andThen(f(items[index] as A), (result) => {
      results.push(result);
      return step(index + 1);
    });
  };
  return step(0);
}

/**
 * The value of a step run over a synchronous store. Throws when the store
 * answered asynchronously: a synchronous caller cannot wait for it.
 */
export function expectSync<T>(value: MaybePromise<T>): T {
  if (isPromise(value)) {
    // A rejected promise must not go unhandled behind this error.
    value.catch(() => {});
    throw new Error("command state store answered asynchronously to a synchronous caller");
  }
  return value;
}
