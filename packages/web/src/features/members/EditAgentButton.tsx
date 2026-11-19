import { Button } from "@botiverse/raft-ui";
import { Pencil } from "lucide-react";
import { useCallback } from "react";
import type { MouseEvent } from "react";
import { useIntl } from "react-intl";
import Tooltip from "../../components/ui/Tooltip";
import type { Agent } from "../../store/agentStore";

/**
 * Edit agent on an agent's tile or row (raft-design Members): a raft-ui ghost
 * icon Button with lucide's Pencil, the profile's Runtime config pencil, that
 * opens the same Edit runtime config dialog. It sits beside the tile's or
 * row's button, never inside it (no button in a button): the caller places
 * it over the tile's corner or the row's trailing column, in a wrapper named
 * `group/edit`. With a mouse it shows while that wrapper is hovered or holds
 * the focus; by touch (pointer: coarse) it is always there.
 */
export function EditAgentButton({ agent, onEdit, className = "" }: {
  agent: Agent;
  onEdit: (agent: Agent) => void;
  className?: string;
}) {
  const { formatMessage } = useIntl();
  const click = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    onEdit(agent);
  }, [agent, onEdit]);
  return (
    <Tooltip content={formatMessage({ id: "members.page.editAgent" })}>
      <Button
        variant="ghost"
        size="icon-md"
        aria-label={formatMessage({ id: "members.page.editAgentNamed" }, { name: agent.displayName || agent.name })}
        data-testid={`member-edit-${agent.id}`}
        onClick={click}
        className={`text-foreground-muted transition-opacity pointer-fine:opacity-0 pointer-fine:group-hover/edit:opacity-100 pointer-fine:group-focus-within/edit:opacity-100 data-popup-open:opacity-100 ${className}`.trim()}
      >
        <Pencil />
      </Button>
    </Tooltip>
  );
}
