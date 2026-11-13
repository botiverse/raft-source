// JSON values: data a contract stores or sends as JSON, typed as such instead
// of a bare `unknown`. Declare object shapes meant to fit it with `type`, not
// `interface`: an interface has no implicit index signature, so it is not
// assignable to `{ [key: string]: JsonValue }`.

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * A deep copy of `value` as a JSON round trip leaves it (what a store hands
 * back). Throws when there is nothing to serialize (`undefined`, a function).
 */
export function cloneJson<T>(value: T): T {
  const text = JSON.stringify(value) as string | undefined;
  if (text === undefined) throw new TypeError("value is not representable as JSON");
  return JSON.parse(text) as T;
}

/**
 * Whether `value` is a JSON value: plain objects and arrays of JSON values,
 * finite numbers, strings, booleans and null, nested at most `maxDepth` deep
 * (a bound for untrusted input, so a hostile document cannot exhaust the stack).
 */
export function isJsonValue(value: unknown, maxDepth = 64): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (maxDepth <= 0 || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, maxDepth - 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value).every((item) => isJsonValue(item, maxDepth - 1));
}
