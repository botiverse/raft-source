import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Settings } from "lucide-react";
import { PanelAction } from "@botiverse/raft-ui";
import Tooltip from "../components/ui/Tooltip";
import { useProfileStore } from "../store/profileStore";
import type { AssistantRecord } from "./assistantClient";

const TOOLTIP_CONTENT_PROPS = { side: "bottom" as const };

/**
 * The header's settings entry (#proj-assistant:#21, Artea af3f1bc4, Kirby
 * 4f20e4e7): opens the assistant's profile panel, as an agent's avatar does,
 * on its Profile tab. Under the profile, the owner's 「Assistant」 section
 * (AssistantOwnerSection) holds Assistant Permissions, showing the otter,
 * Extra Instructions, WeChat and Delete Assistant: one place, not a menu of
 * dialogs. Every assistant is named Ottie and the name is fixed, so there is
 * no rename.
 */
export function AssistantSettingsButton({ assistant }: { assistant: AssistantRecord }) {
  const { formatMessage } = useIntl();
  const openProfile = useProfileStore((s) => s.openProfile);
  const label = formatMessage({ id: "assistant.settings.label" });
  const agentId = assistant.agentId;
  const open = useCallback(() => {
    openProfile("agent", agentId, { defaultAgentTabIntent: "profile" });
  }, [agentId, openProfile]);
  return (
    <Tooltip content={label} contentProps={TOOLTIP_CONTENT_PROPS}>
      <PanelAction aria-label={label} onClick={open} data-testid="assistant-settings-trigger">
        <Settings />
      </PanelAction>
    </Tooltip>
  );
}
