import assert from "node:assert/strict";
import test from "node:test";
import { formatManagedMcpRuntimeToolName } from "./managedMcp.js";

test("managed MCP runtime tool names are stable, bounded, and server-scoped", () => {
  const first = formatManagedMcpRuntimeToolName("12345678-aaaa-bbbb-cccc-123456789012", "issues/search");
  assert.equal(first, formatManagedMcpRuntimeToolName("12345678-aaaa-bbbb-cccc-123456789012", "issues/search"));
  assert.notEqual(first, formatManagedMcpRuntimeToolName("87654321-aaaa-bbbb-cccc-123456789012", "issues/search"));
  assert.notEqual(first, formatManagedMcpRuntimeToolName("12345678-dddd-eeee-ffff-123456789012", "issues/search"));
  assert.match(first, /^mcp_12345678_issues_search_[0-9a-f]{8}$/u);
  assert.ok(first.length < 80);
});
