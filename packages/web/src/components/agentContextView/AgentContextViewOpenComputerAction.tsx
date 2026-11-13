import { useIntl } from "react-intl";
import { BannerAction, Button } from "@botiverse/raft-ui";

import { useAgentContextViewComputerLink } from "./useAgentContextViewComputerLink";

/**
 * The banner's Open computer, where the fix is on that Computer (a session
 * newer than its Raft can read: update Raft there). Nothing where the viewer
 * can't open that Computer's page (useAgentContextViewComputerLink).
 */
export function AgentContextViewOpenComputerAction({ computerId }: { computerId: string | null }) {
  const { formatMessage } = useIntl();
  const open = useAgentContextViewComputerLink(computerId);
  if (!open) return null;
  return (
    <BannerAction>
      <Button variant="default" size="md" onClick={open} data-testid="agent-context-view-open-computer">
        {formatMessage({ id: "agent.status.openComputer" })}
      </Button>
    </BannerAction>
  );
}
