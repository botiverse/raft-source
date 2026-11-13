// Deferred construction for contract schemas.
//
// The Agent API contracts define several hundred zod schemas at module top
// level. Building them all costs ~55 MiB and ~0.3 s, which every short-lived
// `raft` call paid even though one call touches one or two routes. A schema
// wrapped in `lazySchema` is built on first use instead.
//
// Identity matters: zod keys internal maps by schema object (toJSONSchema's
// `seen`, the metadata registry) and its per-instance closures capture the
// instance they were built on. So the lazy value is not a wrapper around the
// real schema; it is a placeholder object that BECOMES the real schema. Its
// prototype is a Proxy, so the first property read, write, `in` check or
// `instanceof` on the placeholder misses its (empty) own properties and lands
// in the Proxy, which builds the schema, re-runs that schema's zod constructor
// on the placeholder itself (same def, same constructor), and swaps in the real
// prototype. From then on the placeholder is an ordinary zod instance and the
// Proxy is out of the prototype chain; the throwaway build is dropped.
//
// Blind spot: operations that read only OWN properties never reach the Proxy,
// so before the first build they see an empty object: `Object.keys(schema)`,
// `{ ...schema }`, `Object.hasOwn(schema, k)`, `JSON.stringify(schema)`.
// Nothing in the repo does that to a contract schema (zod itself reads
// properties through normal lookups); if you need to, call
// `warmContractSchemas()` first. After the build these operations match an
// eagerly built schema (lazySchema.test.ts pins this).
//
// Long-lived processes (the server) call `warmContractSchemas()` once at
// startup: every registered schema is built there, so a construction error
// fails the deploy rather than the first request to some route, and no request
// pays the build latency.
//
// The contract files are rewritten mechanically by
// `scripts/lazy-contract-schemas.ts`; do not hand-wrap or hand-unwrap.

import { globalRegistry } from "zod";

type ZodLike = { _zod: { def: unknown; constr: (this: object, def: unknown) => unknown; parent?: unknown } };

const registered: Array<{ name: string; build: () => void; isBuilt: () => boolean }> = [];

export function lazySchema<T extends object>(name: string, factory: () => T): T {
  const placeholder = {} as T;
  let state: "pending" | "building" | "built" = "pending";

  const build = (): void => {
    if (state === "built") return;
    if (state === "building") throw new Error(`lazySchema(${name}): schema is used while it is being built (circular top-level reference)`);
    state = "building";
    const built = factory() as unknown as ZodLike;
    // Adopt the real prototype first so the constructor's own `in` / property
    // checks on the placeholder no longer reach this Proxy.
    Object.setPrototypeOf(placeholder, Object.getPrototypeOf(built));
    const result = built._zod.constr.call(placeholder, built._zod.def);
    if (result !== placeholder) throw new Error(`lazySchema(${name}): zod constructor did not initialise in place`);
    // `.describe()` / `.meta()` record on the instance they ran on.
    if (built._zod.parent !== undefined) (placeholder as unknown as ZodLike)._zod.parent = built._zod.parent;
    const meta = globalRegistry.get(built as never);
    if (meta) globalRegistry.add(placeholder as never, meta as never);
    state = "built";
  };

  Object.setPrototypeOf(placeholder, new Proxy({}, {
    get: (_target, key, receiver) => {
      build();
      return Reflect.get(placeholder, key, receiver);
    },
    set: (_target, key, value, receiver) => {
      build();
      return Reflect.set(placeholder, key, value, receiver);
    },
    has: (_target, key) => {
      build();
      return Reflect.has(placeholder, key);
    },
    getPrototypeOf: () => {
      build();
      return Reflect.getPrototypeOf(placeholder);
    },
  }));
  registered.push({ name, build, isBuilt: () => state === "built" });
  return placeholder;
}

/** Builds every lazy schema registered so far; returns how many there are. */
export function warmContractSchemas(): number {
  for (const schema of registered) schema.build();
  return registered.length;
}

/** Registered vs. already-built lazy schemas (for tests and startup traces). */
export function lazySchemaStats(): { registered: number; built: number } {
  return {
    registered: registered.length,
    built: registered.filter((schema) => schema.isBuilt()).length,
  };
}
