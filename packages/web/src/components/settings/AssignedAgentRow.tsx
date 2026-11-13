import { Badge, Button } from "@botiverse/raft-ui";
import { useCallback, useMemo } from "react";
import { Unplug } from "lucide-react";
import { useIntl } from "react-intl";
import type { ProviderConnectionAssignedAgent } from "@botiverse/raft-shared";
import { formatRuntimeLabelWithStatus } from "../../utils/runtimeAvailabilityLabel";
import { useRuntimeDeprecatedHere } from "../../hooks/useServerRuntimeCatalog";
import AvatarListRow from "../ui/AvatarListRow";
import AvatarSlot from "../ui/AvatarSlot";
import StatusDot from "../ui/StatusDot";
import Tooltip from "../ui/Tooltip";

export function AssignedAgentRow({
  agent,
  canManage,
  busy,
  onOpenAgent,
  onDetachAgent,
}: {
  agent: ProviderConnectionAssignedAgent;
  canManage: boolean;
  busy: boolean;
  onOpenAgent?: (agentId: string) => void;
  onDetachAgent: (agentId: string) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const deprecatedHere = useRuntimeDeprecatedHere();
  const label = agent.displayName || agent.name;
  const statusText = formatMessage({ id: `settings.providers.agentStatus.${agent.status}` });
  const subtitle = [
    formatMessage({ id: "settings.providers.assignedAgentHandle" }, { name: agent.name }),
    formatRuntimeLabelWithStatus(agent.runtime, formatMessage, deprecatedHere(agent.runtime)),
    agent.computerName ?? formatMessage({ id: "settings.providers.assignedAgentNoComputer" }),
  ].join(" · ");
  const handleDetach = useCallback(() => {
    const confirmed = window.confirm(
      formatMessage({ id: "settings.providers.detachConfirm" }, { name: label }),
    );
    if (confirmed) void onDetachAgent(agent.id);
  }, [agent.id, formatMessage, label, onDetachAgent]);
  const handleOpen = useCallback(() => onOpenAgent?.(agent.id), [agent.id, onOpenAgent]);
  const openButtonProps = useMemo(() => {
    const openLabel = formatMessage({ id: "settings.providers.assignedAgentOpen" }, { name: label });
    return { "aria-label": openLabel, title: openLabel };
  }, [formatMessage, label]);

  return (
    <li data-testid={`provider-connection-assigned-agent-${agent.id}`}>
      {agent.deleted ? (
        // Static row: the detach control lives in the primitive's
        // action slot, a sibling of the (absent) row button, so a
        // deleted Agent never nests one interactive target in another.
        <AvatarListRow
          avatar={<AvatarSlot context="list-row" type="agent" agentAvatarUrl={null} className="grayscale opacity-dimmed" />}
          name={<span className="text-foreground-hint line-through">{label}</span>}
          subtitle={subtitle}
          rightContent={(
            <Badge appearance="soft" variant="muted">
              {formatMessage({ id: "settings.providers.assignedAgentDeleted" })}
            </Badge>
          )}
          actionContent={canManage ? (
            <Tooltip content={formatMessage({ id: "settings.providers.assignedAgentDeletedHint" })}>
            <Button
              type="button"
              variant="outline"
              size="md"
              data-slot="button"
              disabled={busy}
              aria-label={formatMessage({ id: "settings.providers.assignedAgentDetach" })}
              onClick={handleDetach}
            >
              <Unplug size={15} />
              {formatMessage({ id: "settings.providers.assignedAgentDetach" })}
            </Button>
            </Tooltip>
          ) : undefined}
          className="bg-fill-muted"
        />
      ) : (
        <AvatarListRow
          avatar={<AvatarSlot context="list-row" type="agent" agentAvatarUrl={null} />}
          name={label}
          subtitle={subtitle}
          rightContent={(
            <>
              <StatusDot activity={agent.status === "active" ? "online" : "offline"} title={statusText} />
              <span
                className="hidden max-w-[min(32rem,42cqw)] truncate align-middle text-mono-meta font-mono text-foreground-hint @md:inline-block"
              >
                {statusText}
              </span>
            </>
          )}
          onClick={handleOpen}
          buttonProps={openButtonProps}
          className="@container"
        />
      )}
    </li>
  );
}
