import { PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY, SERVER_LABS_UI_FEATURE_FLAG_KEY, SLACK_BRIDGE_FEATURE_FLAG_KEYS, WIKI_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import { useMemo, useState } from "react";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import SettingsPanel from "./SettingsPanel";
import SettingsNavList from "./SettingsNavList";
import { canOpenSettingsTab } from "./settingsNavigation";
import type { SettingsTabId } from "./settingsNavigation";
import { isSlackBridgeSurfaceEnabled } from "./slackBridgeVisibility";

export function resolveWorkspaceSettingsActiveTab(
  activeTab: SettingsTabId,
  slackBridgeEnabled: boolean,
): SettingsTabId {
  return activeTab === "im-bridges" && !slackBridgeEnabled ? "account" : activeTab;
}

export default function WorkspaceSettingsModal() {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("account");
  const labsUiEnabled = useServerFeatureFlag(SERVER_LABS_UI_FEATURE_FLAG_KEY).enabled;
  const providerConnectionsEnabled = useServerFeatureFlag(PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY).enabled;
  const slackBridgeGate = useServerFeatureFlag(SLACK_BRIDGE_FEATURE_FLAG_KEYS.master);
  const slackBridgeEnabled = isSlackBridgeSurfaceEnabled(slackBridgeGate);
  const wikiEnabled = useServerFeatureFlag(WIKI_FEATURE_FLAG_KEY).enabled;
  const { capabilities, role } = useServerPermissions();
  const hiddenTabIds = useMemo(
    () => {
      const hidden = new Set<SettingsTabId>();
      if (!labsUiEnabled) hidden.add("labs");
      if (!providerConnectionsEnabled || !capabilities.manageExternalAuth) hidden.add("providers");
      if (!wikiEnabled || !capabilities.editServerSettings) hidden.add("wiki");
      if (!canOpenSettingsTab("billing", capabilities)) hidden.add("billing");
      if (!canOpenSettingsTab("administration", capabilities)) hidden.add("administration");
      if (!canOpenSettingsTab("integrations", capabilities, role)) hidden.add("integrations");
      if (!canOpenSettingsTab("mcp", capabilities, role)) hidden.add("mcp");
      if (!slackBridgeEnabled) hidden.add("im-bridges");
      return hidden.size > 0 ? hidden : undefined;
    },
    [capabilities, labsUiEnabled, providerConnectionsEnabled, role, slackBridgeEnabled, wikiEnabled],
  );

  const effectiveActiveTab = resolveWorkspaceSettingsActiveTab(activeTab, slackBridgeEnabled);

  return (
    <div className="flex min-h-0 flex-1">
      <SettingsNavList activeTab={effectiveActiveTab} hiddenTabIds={hiddenTabIds} onSelect={setActiveTab} />
      <div className="flex min-w-0 flex-1">
        <SettingsPanel tab={effectiveActiveTab} />
      </div>
    </div>
  );
}
