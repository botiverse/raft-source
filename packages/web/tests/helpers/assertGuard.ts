// node:assert with bounded failure output, for the web Vitest runs.
//
// vitest.config.ts aliases `node:assert`, `assert`, `node:assert/strict` and
// `assert/strict` to assertGuardLegacy.ts / assertGuardStrict.ts, which build
// their exports here. Why: a failing node:assert comparison without a message
// builds its message at construction with util.inspect at depth 1000, every
// array item and getters invoked (util.inspect.defaultOptions is ignored), and
// in Node 24 strictEqual / deepStrictEqual / partialDeepStrictEqual append the
// same full diff even to a caller's message. Handed a jsdom node and its React
// fiber tree, one failure grew a worker past 10 GiB. Vitest then formats and
// diffs err.actual / err.expected again.
//
// The comparison is unchanged: every wrapped function calls the real one with
// the original operands. Only the message argument differs: a sentinel Error,
// which node:assert throws as is instead of building an AssertionError, so a
// failure never inspects anything. The guard then throws its own
// AssertionError (same operator, code, generatedMessage) whose actual /
// expected are short summaries read from own data properties only (no getter
// is called), plus the first nested difference. A caller's Error message
// passes straight through, as natively. throws / rejects / match / fail /
// ifError and `new Assert()` instances are the real, unguarded ones.
//
// Guard: tests/assertGuard.test.ts.
import type NodeAssert from "node:assert";

type AssertModule = typeof NodeAssert;
type AnyFunction = (...args: unknown[]) => unknown;

const realLegacy = process.getBuiltinModule("node:assert") as unknown as AssertModule;
const realStrict = realLegacy.strict as unknown as AssertModule;
const RealAssertionError = realLegacy.AssertionError;

// node:assert throws an Error-instance message as is. Object.create skips the
// stack capture; the guard only compares it by identity.
const SENTINEL: Error = Object.create(Error.prototype);

const LIMITS = {
  depth: 3,
  keys: 20,
  items: 20,
  string: 200,
  total: 2000,
};

const UNPRINTABLE = "[value could not be summarised]";

// Native operator and generated-message header per real function.
interface Comparison {
  operator: string;
  header: string;
  // The value-only calls (ok) have an implicit expected value.
  arity: 1 | 2;
  expected?: unknown;
}

function comparisons(real: AssertModule): Map<unknown, Comparison> {
  const map = new Map<unknown, Comparison>();
  const add = (fn: unknown, comparison: Comparison) => {
    if (typeof fn === "function") map.set(fn, comparison);
  };
  add(real.ok, { operator: "==", header: "The expression evaluated to a falsy value:", arity: 1, expected: true });
  add(real.equal, { operator: "==", header: "Expected values to be loosely equal:", arity: 2 });
  add(real.notEqual, { operator: "!=", header: 'Expected "actual" to be loosely unequal to "expected":', arity: 2 });
  add(real.deepEqual, { operator: "deepEqual", header: "Expected values to be loosely deep-equal:", arity: 2 });
  add(real.notDeepEqual, {
    operator: "notDeepEqual",
    header: 'Expected "actual" not to be loosely deep-equal to "expected":',
    arity: 2,
  });
  add(real.strictEqual, { operator: "strictEqual", header: "Expected values to be strictly equal:", arity: 2 });
  add(real.notStrictEqual, {
    operator: "notStrictEqual",
    header: 'Expected "actual" to be strictly unequal to "expected":',
    arity: 2,
  });
  add(real.deepStrictEqual, {
    operator: "deepStrictEqual",
    header: "Expected values to be strictly deep-equal:",
    arity: 2,
  });
  add(real.notDeepStrictEqual, {
    operator: "notDeepStrictEqual",
    header: 'Expected "actual" not to be strictly deep-equal to "expected":',
    arity: 2,
  });
  add(real.partialDeepStrictEqual, {
    operator: "partialDeepStrictEqual",
    header: "Expected values to be partially and strictly deep-equal:",
    arity: 2,
  });
  return map;
}

// ---------------------------------------------------------------------------
// Summariser: own data properties only, bounded depth / width / length.

function ownData(target: object, key: PropertyKey): { found: boolean; value?: unknown; getter?: boolean } {
  const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
  if (!descriptor) return { found: false };
  if ("value" in descriptor) return { found: true, value: descriptor.value };
  return { found: true, getter: true };
}

function constructorName(value: object): string | undefined {
  const proto = Reflect.getPrototypeOf(value);
  if (proto === null) return "null prototype";
  const ctor = ownData(proto, "constructor");
  if (typeof ctor.value !== "function") return undefined;
  const name = ownData(ctor.value, "name").value;
  return typeof name === "string" && name ? name : undefined;
}

function shortString(text: string, limit = LIMITS.string): string {
  if (text.length <= limit) return JSON.stringify(text);
  return `${JSON.stringify(text.slice(0, limit))}… (${text.length} chars)`;
}

function isDomNode(value: object): boolean {
  const NodeCtor = (globalThis as { Node?: unknown }).Node;
  if (typeof NodeCtor !== "function") return false;
  return value instanceof (NodeCtor as new () => object);
}

// jsdom's own accessors (tagName, id, className, nodeName): bounded, no user code.
function summariseDomNode(node: object): string {
  const read = (key: string): unknown => {
    try {
      return (node as Record<string, unknown>)[key];
    } catch {
      return undefined;
    }
  };
  const nodeName = read("nodeName");
  const tag = read("tagName");
  if (typeof tag !== "string") {
    return `<${typeof nodeName === "string" ? nodeName.slice(0, 40) : "node"}> (DOM node)`;
  }
  let label = tag.toLowerCase().slice(0, 40);
  const id = read("id");
  if (typeof id === "string" && id) label += `#${id.slice(0, 60)}`;
  const className = read("className");
  if (typeof className === "string" && className.trim()) {
    label += className
      .trim()
      .split(/\s+/)
      .slice(0, 5)
      .map((name) => `.${name.slice(0, 40)}`)
      .join("");
  }
  return `<${label}> (DOM node)`;
}

const FIBER_KEYS = ["stateNode", "memoizedProps"];

function looksLikeFiber(value: object): boolean {
  if (!FIBER_KEYS.every((key) => ownData(value, key).found)) return false;
  return ownData(value, "return").found || ownData(value, "child").found;
}

function summariseFiber(fiber: object): string {
  const type = ownData(fiber, "type").value;
  let name: unknown = type;
  if (typeof type === "function") name = ownData(type, "name").value;
  else if (type && typeof type === "object") name = ownData(type, "displayName").value;
  return `[React fiber${typeof name === "string" && name ? ` ${name.slice(0, 60)}` : ""}]`;
}

class Budget {
  used = 0;
  get exhausted(): boolean {
    return this.used >= LIMITS.total;
  }
  take(text: string): string {
    this.used += text.length;
    return text;
  }
}

function summariseValue(value: unknown, depth: number, ancestors: object[], budget: Budget): string {
  switch (typeof value) {
    case "string":
      return budget.take(shortString(value));
    case "number":
      return budget.take(Object.is(value, -0) ? "-0" : String(value));
    case "bigint":
      return budget.take(`${value}n`);
    case "boolean":
    case "undefined":
      return budget.take(String(value));
    case "symbol":
      return budget.take(shortString(value.toString(), 80));
    case "function": {
      const name = ownData(value, "name").value;
      return budget.take(`[Function${typeof name === "string" && name ? ` ${name.slice(0, 60)}` : ""}]`);
    }
  }
  if (value === null) return budget.take("null");
  const object = value as object;
  if (ancestors.includes(object)) return budget.take("[Circular]");
  if (isDomNode(object)) return budget.take(summariseDomNode(object));
  if (looksLikeFiber(object)) return budget.take(summariseFiber(object));
  const name = constructorName(object);
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) return budget.take(`[${name ?? "binary"}]`);
  if (object instanceof Date) {
    const time = Date.prototype.getTime.call(object);
    return budget.take(Number.isNaN(time) ? "Invalid Date" : new Date(time).toISOString());
  }
  if (object instanceof RegExp) {
    const source = ownData(object, "source").value;
    return budget.take(typeof source === "string" ? `/${source.slice(0, LIMITS.string)}/` : "[RegExp]");
  }
  if (object instanceof Map || object instanceof Set) {
    return budget.take(`${name ?? (object instanceof Map ? "Map" : "Set")}(${Reflect.apply(sizeGetter(object), object, [])}) {…}`);
  }
  if (object instanceof Promise) return budget.take("[Promise]");
  if (object instanceof WeakMap || object instanceof WeakSet) return budget.take(`[${name ?? "Weak collection"}]`);

  if (depth >= LIMITS.depth) return budget.take(Array.isArray(object) ? "[Array]" : `[${name ?? "Object"}]`);
  ancestors.push(object);
  try {
    if (Array.isArray(object)) return summariseArray(object, depth, ancestors, budget);
    return summariseObject(object, name, depth, ancestors, budget);
  } finally {
    ancestors.pop();
  }
}

function sizeGetter(collection: Map<unknown, unknown> | Set<unknown>): () => number {
  const proto = collection instanceof Map ? Map.prototype : Set.prototype;
  return Reflect.getOwnPropertyDescriptor(proto, "size")!.get as () => number;
}

function summariseArray(array: unknown[], depth: number, ancestors: object[], budget: Budget): string {
  const length = ownData(array, "length").value as number;
  const parts: string[] = [];
  budget.take("[]");
  for (let index = 0; index < length && index < LIMITS.items; index += 1) {
    if (budget.exhausted) break;
    const item = ownData(array, String(index));
    parts.push(!item.found ? "<empty>" : item.getter ? budget.take("[Getter]") : summariseValue(item.value, depth + 1, ancestors, budget));
    budget.take(", ");
  }
  if (parts.length < length) parts.push(`… ${length - parts.length} more`);
  return `[${parts.join(", ")}]`;
}

function summariseObject(
  object: object,
  name: string | undefined,
  depth: number,
  ancestors: object[],
  budget: Budget,
): string {
  const isError = object instanceof Error;
  const keys = Reflect.ownKeys(object).filter((key) => !(isError && (key === "message" || key === "stack")));
  const parts: string[] = [];
  const prefix = name && name !== "Object" ? `${name} ` : "";
  budget.take(`${prefix}{}`);
  if (isError) {
    const message = ownData(object, "message").value;
    if (typeof message === "string") parts.push(budget.take(`message: ${shortString(message)}`));
  }
  let shown = 0;
  for (const key of keys) {
    if (shown >= LIMITS.keys || budget.exhausted) break;
    const label = typeof key === "symbol" ? `[${key.toString().slice(0, 60)}]` : key.slice(0, 60);
    const entry = ownData(object, key);
    const rendered = entry.getter ? budget.take("[Getter]") : summariseValue(entry.value, depth + 1, ancestors, budget);
    parts.push(budget.take(`${label}: `) + rendered);
    shown += 1;
  }
  if (shown < keys.length) parts.push(`… ${keys.length - shown} more keys`);
  return `${prefix}{ ${parts.join(", ")} }`;
}

/** Bounded, getter-free description of any value; never throws. */
export function summarise(value: unknown): string {
  try {
    const text = summariseValue(value, 0, [], new Budget());
    return text.length > LIMITS.total + 200 ? `${text.slice(0, LIMITS.total)}… (truncated)` : text;
  } catch {
    // Proxies, revoked proxies, exotic hosts: never let the summary hide the failure.
    return UNPRINTABLE;
  }
}

// Swappable in tests only, to prove a throwing summariser still fails the assertion.
let summariser: (value: unknown) => string = summarise;
export function setSummariserForTest(next: ((value: unknown) => string) | null): void {
  summariser = next ?? summarise;
}

function safeSummary(value: unknown): string {
  try {
    const text = summariser(value);
    return typeof text === "string" ? text : UNPRINTABLE;
  } catch {
    return UNPRINTABLE;
  }
}

// First difference between two operands, so a nested mismatch stays readable
// when the summaries collapse it ({ items: [[Object]] } on both sides). Own
// data properties only, by Object.is (so only for the strict, full operators:
// strictEqual, deepStrictEqual); a getter on either side is skipped, as are
// pairs already being walked (cycles) and anything below DIFF_DEPTH; at most
// DIFF_VISITS values are visited. A hint for the reader, not the
// comparison: the real node:assert has already decided.
const DIFF_VISITS = 2000;
const DIFF_DEPTH = 10;
const DIFF_KEYS = 200;

function pathPart(key: PropertyKey, isArray: boolean): string {
  if (isArray && typeof key === "string") return `[${key}]`;
  if (typeof key === "symbol") return `[${key.toString().slice(0, 60)}]`;
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key.slice(0, 60))}]`;
}

function isWalkable(value: unknown): value is object {
  return typeof value === "object" && value !== null && !isDomNode(value) && !looksLikeFiber(value);
}

function findDifference(left: unknown, right: unknown): { path: string; left: string; right: string } | undefined {
  let visits = 0;
  const walking = new WeakMap<object, object>();
  const walk = (a: unknown, b: unknown, path: string, depth: number): { path: string; left: string; right: string } | undefined => {
    visits += 1;
    if (visits > DIFF_VISITS || Object.is(a, b)) return undefined;
    if (!isWalkable(a) || !isWalkable(b) || Array.isArray(a) !== Array.isArray(b)) {
      return { path, left: summarise(a), right: summarise(b) };
    }
    if (depth >= DIFF_DEPTH || walking.get(a) === b) return undefined;
    walking.set(a, b);
    const isArray = Array.isArray(a);
    let keys: PropertyKey[];
    if (isArray) {
      const lengthA = ownData(a, "length").value as number;
      const lengthB = ownData(b, "length").value as number;
      if (lengthA !== lengthB) return { path: `${path}.length`, left: String(lengthA), right: String(lengthB) };
      keys = Array.from({ length: Math.min(lengthA, DIFF_KEYS) }, (_, index) => String(index));
    } else {
      const own = Reflect.ownKeys(a).slice(0, DIFF_KEYS);
      const seen = new Set(own);
      keys = [...own, ...Reflect.ownKeys(b).slice(0, DIFF_KEYS).filter((key) => !seen.has(key))];
    }
    for (const key of keys) {
      const entryA = ownData(a, key);
      const entryB = ownData(b, key);
      const at = path + pathPart(key, isArray);
      if (entryA.getter || entryB.getter) continue;
      if (entryA.found !== entryB.found) {
        return { path: at, left: entryA.found ? summarise(entryA.value) : "<missing>", right: entryB.found ? summarise(entryB.value) : "<missing>" };
      }
      const found = walk(entryA.value, entryB.value, at, depth + 1);
      if (found || visits > DIFF_VISITS) return found;
    }
    return undefined;
  };
  try {
    return walk(left, right, "", 0);
  } catch {
    return undefined;
  }
}

function differenceHint(comparison: Comparison, left: unknown, right: unknown): string {
  try {
    const difference = findDifference(left, right);
    // At the root the actual / expected lines already show the difference.
    if (difference) return difference.path ? `\nfirst difference at ${difference.path}: ${difference.left} vs ${difference.right}` : "";
    if (comparison.operator === "strictEqual" && isWalkable(left) && isWalkable(right)) {
      return "\nsame own data, different references";
    }
  } catch {
    // Proxies and exotic hosts: the hint is optional.
  }
  return "";
}

// ---------------------------------------------------------------------------
// Wrappers.

function boundedFailure(
  comparison: Comparison,
  args: unknown[],
  callerMessage: unknown,
  hasCallerMessage: boolean,
  stackStartFn: AnyFunction,
): Error {
  const actual = safeSummary(args[0]);
  const expected = comparison.arity === 1 ? String(comparison.expected) : safeSummary(args[1]);
  let message: string;
  if (hasCallerMessage) {
    message = String(callerMessage);
  } else {
    message =
      comparison.arity === 1
        ? `${comparison.header}\nactual: ${actual}`
        : `${comparison.header}\nactual: ${actual}\nexpected: ${expected}`;
    // Object.is leaves: right for the strict, full comparisons only (loose
    // deepEqual allows 1 vs "1", partialDeepStrictEqual allows extra keys).
    if (comparison.operator === "strictEqual" || comparison.operator === "deepStrictEqual") {
      message += differenceHint(comparison, args[0], args[1]);
    }
  }
  // operator is set afterwards: given strictEqual / deepStrictEqual and a
  // message, the constructor appends its own (inspect-built) diff.
  const error = new RealAssertionError({ message, actual, expected, stackStartFn });
  error.operator = comparison.operator;
  error.generatedMessage = !hasCallerMessage;
  return error;
}

function wrap(realFn: AnyFunction, comparison: Comparison, name: string): AnyFunction {
  const guarded = function (this: unknown, ...args: unknown[]): unknown {
    const messageIndex = comparison.arity;
    // Too few operands (native ERR_MISSING_ARGS, or ok()'s own message) and a
    // caller's Error message (thrown as is) never inspect: pass straight through.
    if (args.length < messageIndex || args[messageIndex] instanceof Error) return Reflect.apply(realFn, this, args);
    const callerMessage = args[messageIndex];
    // As natively, an undefined or null message means "generate one".
    const hasCallerMessage = callerMessage !== undefined && callerMessage !== null;
    const forwarded = [...args.slice(0, messageIndex), SENTINEL, ...args.slice(messageIndex + 1)];
    try {
      return Reflect.apply(realFn, this, forwarded);
    } catch (error) {
      if (error !== SENTINEL) throw error;
      // Summaries and the difference hint never throw (safeSummary, differenceHint).
      throw boundedFailure(comparison, args, callerMessage, hasCallerMessage, guarded);
    }
  };
  Object.defineProperty(guarded, "name", { value: name });
  return guarded;
}

/** A node:assert (or node:assert/strict) look-alike whose comparisons fail with bounded output. */
function build(real: AssertModule, table: Map<unknown, Comparison>): Record<string, unknown> {
  const okComparison = table.get(real.ok)!;
  const callable = wrap(real.ok as AnyFunction, okComparison, real === realStrict ? "strict" : "ok");
  const target = callable as unknown as Record<string, unknown>;
  for (const key of Object.keys(real)) {
    const value = (real as unknown as Record<string, unknown>)[key];
    const comparison = table.get(value);
    target[key] = comparison ? wrap(value as AnyFunction, comparison, key) : value;
  }
  return target;
}

const legacyTable = comparisons(realLegacy);
// strict.equal is the real strictEqual etc.; map by identity.
const strictTable = comparisons(realStrict);

const guardedStrict = build(realStrict, new Map([...legacyTable, ...strictTable]));
const guardedLegacy = build(realLegacy, legacyTable);
guardedStrict.strict = guardedStrict;
guardedLegacy.strict = guardedStrict;

export const assertGuardLegacy = guardedLegacy as unknown as AssertModule;
export const assertGuardStrict = guardedStrict as unknown as AssertModule;
export const realAssertForTest = { legacy: realLegacy, strict: realStrict };
