import assert from "node:assert/strict";
import {
  SETTINGS_TABS,
  legacySettingsRouteRedirectSlug,
  normalizeSettingsTab,
  settingsRouteSlugForTab,
  settingsTabIdForRouteSlug,
} from "../src/components/settings/settingsNavigation";

test("MCP Apps are managed from Settings → Applications (no MCP Servers page)", () => {
  assert.ok(!SETTINGS_TABS.some((tab) => (tab.id as string) === "mcp"), "Settings has no MCP Servers tab");
});

test("Old MCP Servers settings links redirect to Applications", () => {
  assert.equal(settingsTabIdForRouteSlug("applications"), "integrations");
  assert.equal(settingsRouteSlugForTab("integrations"), "applications");
  assert.equal(normalizeSettingsTab("integrations"), "integrations");
  assert.equal(legacySettingsRouteRedirectSlug("integrations"), "applications");
  for (const legacy of ["mcp-servers", "mcp"]) {
    assert.equal(settingsTabIdForRouteSlug(legacy), "integrations", `${legacy} opens Applications`);
    assert.equal(normalizeSettingsTab(legacy), "integrations", `${legacy} normalizes to Applications`);
    assert.equal(legacySettingsRouteRedirectSlug(legacy), "applications", `${legacy} redirects to the canonical Applications slug`);
  }
  assert.equal(legacySettingsRouteRedirectSlug("applications"), null, "the canonical slug does not redirect");
});
