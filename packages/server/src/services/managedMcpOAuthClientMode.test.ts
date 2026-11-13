import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import { managedMcpOAuthClientModeForApp, requireManagedMcpOAuthClientModeForApp } from "./managedMcpOAuthClientMode";
import type { McpAppTemplate } from "./mcpAppTemplates";

const catalog = vi.hoisted(() => ({ rows: {} as Record<string, Pick<McpAppTemplate, "oauthClientMode">>, readable: true, lookups: [] as string[] }));

vi.mock("./mcpAppTemplates", () => ({
  findMcpAppTemplateRow: async (key: string) => {
    catalog.lookups.push(key);
    return catalog.readable ? catalog.rows[key] ?? null : "unavailable";
  },
}));

const app = (fields: Partial<Parameters<typeof managedMcpOAuthClientModeForApp>[0]> = {}) => ({
  endpointUrl: "https://mcp.asana.com/sse", templateKey: "asana", sourceKind: "template" as const, provider: "custom" as const, ...fields,
});

beforeEach(() => {
  catalog.rows = {};
  catalog.readable = true;
  catalog.lookups = [];
});

test("a sign-in follows the admin-set mode and refuses rather than loosen it when the row cannot be confirmed", async () => {
  catalog.rows.asana = { oauthClientMode: "registered" };
  assert.equal(await requireManagedMcpOAuthClientModeForApp(app()), "registered");

  catalog.readable = false;
  assert.equal(await managedMcpOAuthClientModeForApp(app()), null, "the view says it cannot confirm, not the bundled either");
  await assert.rejects(requireManagedMcpOAuthClientModeForApp(app()), { code: "managed_mcp_unreachable" });

  catalog.readable = true;
  delete catalog.rows.asana;
  await assert.rejects(requireManagedMcpOAuthClientModeForApp(app()), { code: "managed_mcp_unreachable" }, "a missing or unparseable row is not either");
});

test("an older template App named only by provider follows its template's mode", async () => {
  catalog.rows.notion = { oauthClientMode: "registered" };
  const legacy = app({ endpointUrl: "https://mcp.notion.com/mcp", templateKey: null, sourceKind: null, provider: "notion" });
  assert.equal(await requireManagedMcpOAuthClientModeForApp(legacy), "registered");
  assert.deepEqual(catalog.lookups, ["notion"]);
});

test("an App added by URL, or under a provider policy, needs no catalog", async () => {
  catalog.readable = false;
  assert.equal(await requireManagedMcpOAuthClientModeForApp(app({ endpointUrl: "https://example.com/mcp", templateKey: null, sourceKind: "url" })), "either");
  assert.equal(await requireManagedMcpOAuthClientModeForApp(app({ templateKey: null, sourceKind: null, provider: "custom" })), "either");
  assert.equal(await requireManagedMcpOAuthClientModeForApp(app({ endpointUrl: "https://docsmcp.googleapis.com/mcp/v1", templateKey: "google-docs" })), "registered");
  assert.deepEqual(catalog.lookups, []);
});
