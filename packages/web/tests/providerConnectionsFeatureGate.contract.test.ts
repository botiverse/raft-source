import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function readSource(path: string): string {
  return readFileSync(new URL(`../src/${path}`, import.meta.url), "utf8");
}

test("provider connection settings and Agent selectors stay behind the server feature gate", () => {
  const settingsModal = readSource("components/settings/WorkspaceSettingsModal.tsx");
  const settingsPanel = readSource("components/settings/SettingsPanel.tsx");
  const providerSettings = readSource("components/settings/ProviderConnectionsSettings.tsx");
  const sidebar = readSource("components/layout/Sidebar.tsx");
  const createAgent = readSource("components/agent/CreateAgentDialog.tsx");
  const agentDetail = readSource("components/agent/AgentDetailPanel.tsx");

  assert.match(settingsModal, /if \(!providerConnectionsEnabled \|\| !capabilities\.manageExternalAuth\) hidden\.add\("providers"\)/);
  assert.match(settingsPanel, /requestedSettingsTab === "providers" && \(!providerConnectionsEnabled \|\| !capabilities\.manageExternalAuth\)/);
  assert.match(providerSettings, /if \(!featureEnabled\) return null/);
  assert.match(sidebar, /\.\.\.\(providerConnectionsEnabled && canManageExternalAuth\s*\? \[\{ id: "providers"/);
  assert.match(createAgent, /providerConnectionCatalog\.featureEnabled\s*&&/);
  assert.match(agentDetail, /providerConnectionCatalog\.featureEnabled\s*&&/);
  assert.match(agentDetail, /!providerConnectionCatalog\.featureEnabled\s*\|\|/);
});
