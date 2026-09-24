import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
  AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
  projectAgentLoginIntegrationInventory,
  type AgentLoginIntegrationInventoryScope,
} from "./capabilityInventories.js";

test("default projected exclusion preserves the exact negative-list boundary", () => {
  assert.equal(
    AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION.copy.exclusion,
    "Not your runtime capability inventory: it does not list runtime tools (including Server-managed MCP), Computer-local tools, browser sessions, or arbitrary CLIs.",
  );
});

test("structured inventory fields project into both machine scope and human boundary copy", () => {
  const scopeWithoutActiveLogins = {
    ...AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
    includes: ["built_in_raft_apps", "registered_services"],
  } satisfies AgentLoginIntegrationInventoryScope;

  const projection = projectAgentLoginIntegrationInventory(scopeWithoutActiveLogins);

  assert.equal(projection.observationScope, scopeWithoutActiveLogins);
  assert.deepEqual(projection.observationScope.includes, [
    "built_in_raft_apps",
    "registered_services",
  ]);
  assert.match(projection.copy.scope, /built-in Raft apps and installed registered Agent Login services/);
  assert.doesNotMatch(projection.copy.scope, /active logins/);
});

test("excluded surfaces and absence meaning are rendered from their structured roles", () => {
  const reducedScope = {
    ...AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
    excludes: ["runtime_tools", "server_managed_mcp_tools"],
  } as const satisfies AgentLoginIntegrationInventoryScope;

  const projection = projectAgentLoginIntegrationInventory(reducedScope);

  assert.match(projection.copy.exclusion, /runtime tools \(including Server-managed MCP\)/);
  assert.doesNotMatch(projection.copy.exclusion, /browser sessions|arbitrary CLIs/);
  assert.match(projection.copy.boundary, /absence below means only "not listed in this inventory"/);
});
