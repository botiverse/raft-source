import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  evaluateRuntimeFormV3Condition,
  isPortableRuntimeFormV3Pattern,
  isSupportedRuntimeFormV3Schema,
  runtimeFormV3ScopeKey,
} from "./v3Rules";

type ConformanceTable = {
  cases: Array<{ name: string; condition: { scope: string; schema: unknown }; data: Record<string, unknown>; expected: boolean }>;
  unsupported: Array<{ name: string; schema: unknown }>;
};
const table = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/v3.conditions.conformance.json", import.meta.url)), "utf8")) as ConformanceTable;

test("v3 condition conformance table: every case evaluates to its expected value", () => {
  assert.ok(table.cases.length > 20);
  for (const entry of table.cases) {
    const key = runtimeFormV3ScopeKey(entry.condition.scope);
    assert.notEqual(key, undefined, `${entry.name}: scope`);
    assert.ok(isSupportedRuntimeFormV3Schema(entry.condition.schema), `${entry.name}: supported`);
    assert.equal(evaluateRuntimeFormV3Condition({ key: key!, schema: entry.condition.schema }, entry.data), entry.expected, entry.name);
  }
});

test("v3 condition conformance table: every unsupported schema is reported unsupported", () => {
  for (const entry of table.unsupported) assert.equal(isSupportedRuntimeFormV3Schema(entry.schema), false, entry.name);
});

test("v3 patterns: every pattern in the served v3 fixtures is inside the portable subset", () => {
  const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
  const patterns = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === "object") {
      for (const [key, inner] of Object.entries(value)) {
        if (key === "pattern" && typeof inner === "string") patterns.add(inner);
        collect(inner);
      }
    }
  };
  for (const name of readdirSync(fixturesDir).filter((file) => file.endsWith(".v3.json"))) collect(JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf8")));
  assert.ok(patterns.has("^connection:"));
  for (const pattern of patterns) assert.ok(isPortableRuntimeFormV3Pattern(pattern), pattern);
});

test("v3 scopes: # is the whole values, #/properties/<key> one field, anything else unknown", () => {
  assert.equal(runtimeFormV3ScopeKey("#"), null);
  assert.equal(runtimeFormV3ScopeKey("#/properties/providerId"), "providerId");
  for (const scope of ["#/properties/", "#/properties/a/b", "/providerId", 1, undefined]) assert.equal(runtimeFormV3ScopeKey(scope), undefined, String(scope));
});
