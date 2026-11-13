import { Select, SelectContent, SelectIcon, SelectList, SelectTrigger, SelectValue } from "@botiverse/raft-ui";
import type { AgentContextViewGrantCreated } from "@botiverse/raft-shared";
import { useCallback, useId, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import ConfirmDialog from "../../../components/ConfirmDialog";
import Banner from "../../../components/ui/Banner";
import FormField from "../../../components/ui/FormField";
import type { Agent } from "../../../store/agentStore";
import type { SelectOption } from "../shared/selectOptions";
import { renderSelectItems } from "../shared/renderSelectItems";
import { grantContextView } from "./contextViewGrantsApi";

/**
 * Grant Access: pick one of the server's ordinary agents (the caller passes
 * them: no personal assistants, no App Bots, none that already has access)
 * and confirm. Before the confirm, the warning says what the grant reaches
 * (Warden, #13530): it is server-wide for that agent; whoever controls the
 * agent (its creator, who may be an ordinary member, and anyone on its
 * Computer) can read what it reads; and it covers only messages that agent
 * can see.
 */
export function GrantContextViewDialog({
  serverId,
  candidates,
  onGranted,
  onClose,
}: {
  serverId: string;
  candidates: readonly Agent[];
  onGranted: (result: AgentContextViewGrantCreated) => void;
  onClose: () => void;
}) {
  const { formatMessage } = useIntl();
  const fieldId = useId();
  const [agentId, setAgentId] = useState("");
  const options = useMemo<SelectOption[]>(
    () => candidates.map((agent) => ({ value: agent.id, label: agent.displayName || agent.name })),
    [candidates],
  );
  const picked = candidates.find((agent) => agent.id === agentId) ?? null;
  const handleValueChange = useCallback((value: string | null) => setAgentId(value ?? ""), []);
  const handleConfirm = useCallback(async () => {
    if (!agentId) return;
    onGranted(await grantContextView(serverId, agentId));
  }, [agentId, onGranted, serverId]);

  return (
    <ConfirmDialog
      title={formatMessage({ id: "settings.contextViewGrants.grantTitle" })}
      size="md"
      plainMessage
      confirmVariant="accent"
      confirmLabel={formatMessage({ id: "settings.contextViewGrants.grantConfirm" })}
      loadingLabel={formatMessage({ id: "settings.contextViewGrants.granting" })}
      confirmDisabled={!picked}
      confirmTestId="context-view-grant-confirm"
      onConfirm={handleConfirm}
      onClose={onClose}
      message={(
        <div className="stack-y-4">
          <FormField label={formatMessage({ id: "settings.contextViewGrants.agentLabel" })} htmlFor={fieldId}>
            <Select value={agentId} onValueChange={handleValueChange} items={options} disabled={options.length === 0}>
              <SelectTrigger id={fieldId} className="w-full" data-testid="context-view-grant-agent">
                <SelectValue placeholder={formatMessage({
                  id: options.length > 0 ? "settings.contextViewGrants.agentPlaceholder" : "settings.contextViewGrants.noCandidates",
                })} />
                <SelectIcon />
              </SelectTrigger>
              <SelectContent>
                <SelectList>{renderSelectItems(options)}</SelectList>
              </SelectContent>
            </Select>
          </FormField>
          <Banner intent="warning" withIcon live={false} data-testid="context-view-grant-disclosure">
            {formatMessage(
              { id: "settings.contextViewGrants.disclosure" },
              { agent: picked ? picked.displayName || picked.name : formatMessage({ id: "settings.contextViewGrants.thisAgent" }) },
            )}
          </Banner>
        </div>
      )}
    />
  );
}
