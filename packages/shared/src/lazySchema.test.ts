import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { afterEach, test, vi } from "vitest";
import { z } from "zod";

const SCRIPT = resolve(__dirname, "../scripts/lazy-contract-schemas.ts");

// Every module the rewrite wrapped (scripts/lazy-contract-schemas.ts --list).
const CONTRACT_MODULES: string[] = (JSON.parse(
  spawnSync(process.execPath, ["--import", "@oxc-node/core/register", SCRIPT, "--list"], { encoding: "utf8" }).stdout,
) as string[]).map((module) => `./${module}`);

async function importContracts(): Promise<Record<string, unknown>[]> {
  return Promise.all(CONTRACT_MODULES.map((path) => import(path) as Promise<Record<string, unknown>>));
}

function jsonSchemaOf(schema: z.ZodType): unknown {
  try {
    return {
      input: z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
      output: z.toJSONSchema(schema, { io: "output", unrepresentable: "any" }),
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// Every exported schema plus every route's request/response parts, keyed by a
// stable path, as JSON Schema. The route parts reach the module-private
// schemas that no export exposes.
function contractJsonSchemas(modules: Record<string, unknown>[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  modules.forEach((mod, index) => {
    for (const [name, value] of Object.entries(mod)) {
      if (value instanceof z.ZodType) out.set(`${CONTRACT_MODULES[index]}:${name}`, jsonSchemaOf(value));
    }
  });
  const agentApi = modules[CONTRACT_MODULES.indexOf("./agentApiContract")]!;
  const routes = agentApi.agentApiContract as Record<string, { request: Record<string, z.ZodType>; response: Record<string, unknown> }>;
  for (const [key, route] of Object.entries(routes)) {
    for (const [part, schema] of Object.entries(route.request)) out.set(`route:${key}:request.${part}`, jsonSchemaOf(schema));
    for (const [part, schema] of Object.entries(route.response)) {
      if (schema instanceof z.ZodType) out.set(`route:${key}:response.${part}`, jsonSchemaOf(schema));
    }
  }
  return out;
}

afterEach(() => {
  vi.doUnmock("./lazySchema");
  vi.resetModules();
});

test("the shared sources are fully rewritten by scripts/lazy-contract-schemas.ts", () => {
  assert.ok(CONTRACT_MODULES.includes("./agentApiContract") && CONTRACT_MODULES.length >= 20, CONTRACT_MODULES.join(", "));
  const result = spawnSync(process.execPath, ["--import", "@oxc-node/core/register", SCRIPT, "--check"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("importing the contracts builds no schema until one is used", async () => {
  vi.resetModules();
  const modules = await importContracts();
  const agentApi = modules[CONTRACT_MODULES.indexOf("./agentApiContract")];
  const { lazySchemaStats } = await import("./lazySchema");
  const before = lazySchemaStats();
  assert.ok(before.registered >= 360, `expected the contract schemas to be lazy, got ${before.registered}`);
  assert.equal(before.built, 0, "an import-time access forces schemas; keep top-level code off schema properties");

  const route = (agentApi!.agentApiContract as Record<string, { request: { query: z.ZodType } }>).historyRead;
  route.request.query.safeParse({});
  const after = lazySchemaStats();
  assert.ok(after.built > 0 && after.built < 40, `one route should build only its own schemas, built ${after.built}`);
});

test("lazy schemas produce the same JSON Schema as eagerly built ones", async () => {
  vi.resetModules();
  vi.doMock("./lazySchema", () => ({
    lazySchema: (_name: string, factory: () => unknown) => factory(),
    warmContractSchemas: () => 0,
    lazySchemaStats: () => ({ registered: 0, built: 0 }),
  }));
  const eager = contractJsonSchemas(await importContracts());
  vi.doUnmock("./lazySchema");
  vi.resetModules();
  const lazy = contractJsonSchemas(await importContracts());

  assert.ok(eager.size > 300, `expected the contract surface, got ${eager.size} schemas`);
  assert.deepEqual([...lazy.keys()].sort(), [...eager.keys()].sort());
  for (const [key, schema] of eager) assert.deepEqual(lazy.get(key), schema, key);
});

test("after warm-up, own-property reads match an eager build", async () => {
  vi.resetModules();
  vi.doMock("./lazySchema", () => ({
    lazySchema: (_name: string, factory: () => unknown) => factory(),
    warmContractSchemas: () => 0,
    lazySchemaStats: () => ({ registered: 0, built: 0 }),
  }));
  const eager = ownKeysOfSchemas(await importContracts());
  vi.doUnmock("./lazySchema");
  vi.resetModules();
  const lazyModules = await importContracts();
  const { warmContractSchemas } = await import("./lazySchema");
  // Before the build, own-property reads see the empty placeholder (the
  // documented blind spot); after it they must match.
  warmContractSchemas();
  const lazy = ownKeysOfSchemas(lazyModules);

  assert.ok(eager.size > 200, `expected the exported schemas, got ${eager.size}`);
  assert.deepEqual(lazy, eager);
});

// zod 4.6 installs prototype methods as "materialize bound on first read"
// getters (util.defineBound), so any `.nullable()` / `.extend()` / … call
// leaves an enumerable own `bound <name>` function on the schema it was
// called on. WHICH schemas carry those caches depends on evaluation order
// (which dependent factory ran first), not on lazy-vs-eager construction —
// both sides materialize the same way, just at different times. They are
// method caches, not schema data, so the comparison drops them.
function dataOwnKeys(schema: object): string[] {
  return Object.entries(schema)
    .filter(([key, value]) => !(typeof value === "function" && (value as Function).name === `bound ${key}`))
    .map(([key]) => key)
    .sort();
}

function ownKeysOfSchemas(modules: Record<string, unknown>[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  modules.forEach((mod, index) => {
    for (const [name, value] of Object.entries(mod)) {
      if (value instanceof z.ZodType) out.set(`${CONTRACT_MODULES[index]}:${name}`, dataOwnKeys(value));
    }
  });
  return out;
}

test("warmContractSchemas builds every registered schema", async () => {
  vi.resetModules();
  await importContracts();
  const { lazySchemaStats, warmContractSchemas } = await import("./lazySchema");
  const count = warmContractSchemas();
  assert.deepEqual(lazySchemaStats(), { registered: count, built: count });
});
