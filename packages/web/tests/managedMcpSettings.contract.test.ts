import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  legacySettingsRouteRedirectSlug,
  normalizeSettingsTab,
  settingsRouteSlugForTab,
  settingsTabIdForRouteSlug,
} from "../src/components/settings/settingsNavigation";

const readSource = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Server MCP configuration lives in global Settings while Agent MCP shows read-only usage", () => {
  const navigation = readSource("src/components/settings/settingsNavigation.ts");
  const englishMessages = readSource("src/i18n/messages/en.ts");
  const chineseMessages = readSource("src/i18n/messages/zh-cn.ts");
  const settingsPanel = readSource("src/components/settings/SettingsPanel.tsx");
  const sidebar = readSource("src/components/layout/Sidebar.tsx");
  const agentPanel = readSource("src/components/agent/AgentDetailPanel.tsx");
  const mcpPanel = readSource("src/components/agent/AgentMcpTab.tsx");

  assert.match(navigation, /id: "integrations", label: "Applications", title: "Applications"[\s\S]*id: "mcp", label: "MCP Servers", title: "MCP Servers"/u);
  assert.match(englishMessages, /"settings\.tabs\.mcp": "MCP Servers"/u);
  assert.match(chineseMessages, /"settings\.tabs\.mcp": "MCP 服务器"/u);
  assert.match(settingsPanel, /settingsTab === "mcp" && <McpSettingsSection \/>/u);
  assert.match(settingsPanel, /<AgentMcpTab[\s\S]*?scope="server"[\s\S]*?canManageServer=\{capabilities\.manageIntegrations\}/u);
  assert.doesNotMatch(settingsPanel, /Server admin access is required to manage MCP connections/u);
  assert.match(sidebar, /id: "integrations"[\s\S]*settings\/applications[\s\S]*id: "mcp"[\s\S]*settings\/mcp-servers/u);
  assert.match(agentPanel, /<AgentMcpTab agentId=\{agent\.id\}/u);
  assert.match(mcpPanel, /scope === "server" \? "\/mcp\/servers" : `\/mcp\/agents\/\$\{agentId\}`/u);
  assert.match(mcpPanel, /scope === "server" && canManageServer/u);
  assert.match(mcpPanel, /scope === "server" && canManageServer && catalog && catalog\.recommendations\.length > 0/u);
  assert.match(mcpPanel, /scope === "server" && canManageServer && draft/u);
  assert.match(mcpPanel, /scope === "server" && canManageServer && deleteTarget/u);
  assert.match(mcpPanel, /server\.usage !== null/u);
  assert.match(mcpPanel, /agent\.mcpUsage\.emptyDescription/u);
  assert.match(mcpPanel, /id: "settings\.mcp\.deleteConfirmMessage"[\s\S]*name: deleteTarget\.name/u);
  assert.doesNotMatch(mcpPanel, /This removes it from every Agent runtime and usage view/u);
  assert.match(englishMessages, /"settings\.mcp\.deleteConfirmMessage": "Delete \{name\}\? This removes it from every Agent runtime and usage view\."/u);
  assert.match(chineseMessages, /"settings\.mcp\.deleteConfirmMessage": "删除 \{name\}？这会将它从所有 Agent 运行时和使用记录视图中移除。"/u);
  assert.doesNotMatch(mcpPanel, /pendingCount|Apply &amp; restart|assignmentDrafts/u);
  assert.doesNotMatch(mcpPanel, /<select/u);
  assert.match(mcpPanel, /<SelectTrigger className="w-full">/u);
  assert.match(mcpPanel, /const added = catalog\.servers\.some/u);
  assert.match(mcpPanel, /disabled=\{added\}/u);
  assert.match(mcpPanel, /id: added \? "agent\.mcp\.added" : "agent\.mcp\.add"/u);
  assert.match(englishMessages, /"agent\.mcp\.added": "Added"/u);
  assert.match(englishMessages, /"agent\.mcp\.add": "Add"/u);
  assert.match(mcpPanel, /max-h-80 overflow-y-auto/u);
  assert.match(mcpPanel, /grid grid-cols-1 sm:grid-cols-2/u);
  assert.match(mcpPanel, /line-clamp-2 text-xs leading-4/u);
  assert.match(mcpPanel, /aria-label=\{formatMessage\(\{ id: "agent\.mcp\.aboutTool" \}, \{ name: label \}\)\}/u);
  assert.match(englishMessages, /"agent\.mcp\.aboutTool": "About \{name\}"/u);
  assert.match(mcpPanel, /normalizeManagedMcpToolDescription\(tool\.description\)/u);
  assert.match(mcpPanel, /max-h-64 w-80[\s\S]*?bg-white[\s\S]*?font-normal/u);
  assert.match(mcpPanel, /new BroadcastChannel\(MANAGED_MCP_OAUTH_RESULT_CHANNEL\)/u);
  assert.match(mcpPanel, /event\.data[\s\S]*MANAGED_MCP_OAUTH_RESULT_CHANNEL[\s\S]*void load\(\)/u);
  assert.doesNotMatch(mcpPanel, /waitForPopupClose|Date\.now|setInterval/u);
});

test("Settings exposes canonical Applications and MCP Servers route slugs", () => {
  assert.equal(settingsTabIdForRouteSlug("applications"), "integrations");
  assert.equal(settingsTabIdForRouteSlug("mcp-servers"), "mcp");
  assert.equal(settingsRouteSlugForTab("integrations"), "applications");
  assert.equal(settingsRouteSlugForTab("mcp"), "mcp-servers");
  assert.equal(normalizeSettingsTab("integrations"), "integrations");
  assert.equal(legacySettingsRouteRedirectSlug("integrations"), "applications");
  assert.equal(legacySettingsRouteRedirectSlug("mcp"), null);
});
