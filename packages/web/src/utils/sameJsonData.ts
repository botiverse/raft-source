/**
 * Whether two values read from JSON hold the same data: primitives by
 * `Object.is`, arrays by position, plain objects by their own keys (a key
 * holding `undefined` is not an absent key). Anything else (a Date, a Map, a
 * class instance) is equal only to itself.
 */
export function sameJsonData(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let index = 0; index < a.length; index += 1) {
      if (!sameJsonData(a[index], b[index])) return false;
    }
    return true;
  }
  const prototypeA: unknown = Object.getPrototypeOf(a);
  const prototypeB: unknown = Object.getPrototypeOf(b);
  if ((prototypeA !== Object.prototype && prototypeA !== null) || (prototypeB !== Object.prototype && prototypeB !== null)) return false;
  const keysA = Object.keys(a);
  if (keysA.length !== Object.keys(b).length) return false;
  const recordA = a as Record<string, unknown>;
  const recordB = b as Record<string, unknown>;
  for (const key of keysA) {
    if (!Object.hasOwn(recordB, key) || !sameJsonData(recordA[key], recordB[key])) return false;
  }
  return true;
}
