import { Button } from "@botiverse/raft-ui";
import { Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import api from "../../../api/client";
import ConfirmDialog from "../../ConfirmDialog";
import { ConnectedAppEditorActionRow } from "../../../features/apps/connected-apps/ConnectedAppEditorActionRow";
import { mcpAppErrorMessage } from "./mcpAppApi";
import type { McpAppView } from "./mcpAppApi";

/** Delete an MCP App, after a confirmation that says what goes with it. */
export function McpAppDangerZone({ view, onDeleted }: { view: McpAppView; onDeleted: () => void }) {
  const { formatMessage } = useIntl();
  const [confirming, setConfirming] = useState(false);
  const handleRequest = useCallback(() => setConfirming(true), []);
  const handleClose = useCallback(() => setConfirming(false), []);
  const handleConfirm = useCallback(async () => {
    try {
      await api.delete(`/mcp/apps/${view.id}`);
    } catch (error) {
      throw new Error(mcpAppErrorMessage(error, formatMessage));
    }
    onDeleted();
  }, [formatMessage, onDeleted, view.id]);
  return (
    <>
      {/* The ordinary App editor's delete row (ConnectedAppEditorActionRow), with an MCP App's copy. */}
      <ConnectedAppEditorActionRow
        testId="mcp-app-delete-card"
        title={formatMessage({ id: "settings.connectedApps.deleteApp" })}
        description={formatMessage({ id: "settings.mcpApp.danger.deleteDescription" })}
        action={(
          <Button type="button" size="md" variant="danger" onClick={handleRequest} data-testid="mcp-app-delete">
            <Trash2 size={16} />
            {formatMessage({ id: "settings.connectedApps.delete" })}
          </Button>
        )}
      />
      {confirming ? (
        <ConfirmDialog
          title={formatMessage({ id: "settings.mcpApp.danger.deleteConfirmTitle" }, { name: view.profile.name })}
          message={formatMessage({ id: "settings.mcpApp.danger.deleteConfirmMessage" }, { agents: view.agentsSummary.total, connections: view.connections.length })}
          confirmLabel={formatMessage({ id: "settings.connectedApps.deleteApp" })}
          confirmTestId="mcp-app-delete-confirm"
          onConfirm={handleConfirm}
          onClose={handleClose}
          closeOnConfirm={false}
          layer={1}
        />
      ) : null}
    </>
  );
}
