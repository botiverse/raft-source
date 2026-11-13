import assert from "node:assert/strict";

import {
  AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION,
  AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
  projectAgentLoginIntegrationInventory,
  type AgentLoginIntegrationInventoryScope,
} from "./capabilityInventories";

test("default scope lists MCP Apps (Raft Apps of another type) and no longer excludes Server-managed MCP", () => {
  assert.deepEqual(AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE.includes, ["registered_services", "active_agent_logins", "mcp_apps"]);
  assert.equal((AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE.excludes as readonly string[]).includes("server_managed_mcp_tools"), false);
  assert.equal(
    AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION.copy.scope,
    "Scope: this command lists only installed registered Agent Login services, this Agent's active logins, and the MCP Apps this Agent has (used through their MCP tools).",
  );
  assert.doesNotMatch(AGENT_LOGIN_INTEGRATION_INVENTORY_PROJECTION.copy.exclusion, /MCP/);
});

test("structured inventory fields project into both machine scope and human boundary copy", () => {
  const scopeWithoutActiveLogins = {
    ...AGENT_LOGIN_INTEGRATION_INVENTORY_SCOPE,
    includes: ["registered_services"],
  } satisfies AgentLoginIntegrationInventoryScope;

  const projection = projectAgentLoginIntegrationInventory(scopeWithoutActiveLogins);

  assert.equal(projection.observationScope, scopeWithoutActiveLogins);
  assert.deepEqual(projection.observationScope.includes, [
    "registered_services",
  ]);
  assert.match(projection.copy.scope, /installed registered Agent Login services/);
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
