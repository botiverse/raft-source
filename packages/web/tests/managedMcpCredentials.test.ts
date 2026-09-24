import assert from "node:assert/strict";
import test from "node:test";
import {
  buildManagedMcpCredentialPatch,
  managedMcpHeadersForCreate,
  managedMcpHeadersIncomplete,
} from "../src/components/agent/managedMcpCredentials";
import type {
  ManagedMcpHeaderDraft,
} from "../src/components/agent/managedMcpCredentials";

function row(
  id: number,
  name: string,
  value: string,
  persistedName: string | null,
): ManagedMcpHeaderDraft {
  return { id, name, value, persistedName };
}

test("managed MCP header drafts allow blank unchanged secrets but require renamed or new values", () => {
  assert.equal(managedMcpHeadersIncomplete([row(1, "Authorization", "", "Authorization")]), false);
  assert.equal(managedMcpHeadersIncomplete([row(1, "X-New", "", null)]), true);
  assert.equal(managedMcpHeadersIncomplete([row(1, "X-Renamed", "", "X-Old")]), true);
  assert.equal(managedMcpHeadersIncomplete([
    row(1, "Authorization", "one", null),
    row(2, "authorization", "two", null),
  ]), true);
});

test("managed MCP credential patches preserve unchanged rows and explicitly replace, add, or remove others", () => {
  assert.deepEqual(buildManagedMcpCredentialPatch([
    row(1, "Authorization", "", "Authorization"),
    row(2, "X-Renamed", "renamed-value", "X-Old"),
    row(3, "X-New", "new-value", null),
  ], ["Authorization", "X-Old", "X-Removed"]), {
    upsertHeaders: { "X-Renamed": "renamed-value", "X-New": "new-value" },
    removeHeaderNames: ["X-Old", "X-Removed"],
  });
});

test("managed MCP create headers include every entered value", () => {
  assert.deepEqual(managedMcpHeadersForCreate([
    row(1, "Authorization", "Bearer token", null),
    row(2, "X-Key", "secret", null),
  ]), { Authorization: "Bearer token", "X-Key": "secret" });
});
