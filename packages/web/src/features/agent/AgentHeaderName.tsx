import { PanelTitle } from "@botiverse/raft-ui";
import Tooltip from "../../components/ui/Tooltip";
import { useIntl } from "react-intl";
import { Pencil } from "lucide-react";
import type { Agent } from "../../store/agentStore";
import { INFO_ICON_BUTTON_CLASS } from "./agentDetailClassNames";

/**
 * The profile header's name. It is the agent's display name (falling back to
 * the @name); its pencil opens the profile edit dialog on the name field.
 */
export function AgentHeaderName({ agent, onEdit }: { agent: Agent; onEdit?: () => void }) {
  const { formatMessage } = useIntl();
  // P4b: a managed bot's name follows the app's live name, not the grant-time
  // snapshot stored on the agent row.
  const liveName = agent.managedByAppInstallId
    ? (agent.managedByApp ? agent.managedByApp.name : (agent.displayName || agent.name))
    : (agent.displayName || agent.name);
  return (
    <>
      <Tooltip content={liveName}>
        {/* PanelTitle source (cindyz 2026-10-10): the detail-block name follows the
            panel-title spec (17 / selected weight / heading family) so the same
            name reads identically in the header and the body. */}
        <PanelTitle className="min-w-0">{liveName}</PanelTitle>
      </Tooltip>
      {onEdit && (
        <Tooltip content={formatMessage({ id: "agent.detail.editDisplayName" })}>
          <button
            type="button"
            aria-label={formatMessage({ id: "agent.detail.editDisplayName" })}
            onClick={onEdit}
            className={INFO_ICON_BUTTON_CLASS}
          >
            <Pencil size={14} />
          </button>
        </Tooltip>
      )}
    </>
  );
}
