import { Card, CopyableCode, CopyableCodeAction, CopyableCodeRoot, TextLink } from "@botiverse/raft-ui";
import { useIntl } from "react-intl";
import { useMachineStore } from "../../store/machineStore";
import { useServerStore } from "../../store/serverStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { agentComputerRestartCommand } from "./agentComputerCommands";
import StatusDot from "../../components/ui/StatusDot";
import Tooltip from "../../components/ui/Tooltip";
import { useAgentComputerOffline } from "../../components/agent/useAgentComputerOffline";
import { useOpenAgentComputer } from "../../components/agent/useOpenAgentComputer";

/**
 * The agent profile's card while its Computer is offline (#triage:#206;
 * raft-design agent-profile, Its computer is offline), in place of Start:
 * which Computer, since when, and the same two steps for everyone: turn that
 * computer on and keep it awake, then open Raft Desktop on it or run the
 * Computer page's restart command. Diagnostics stay on the Computer page.
 */
export function AgentComputerOfflineCard({ agentId }: { agentId: string }) {
  const { formatMessage } = useIntl();
  const { machineId, open: openComputer } = useOpenAgentComputer(agentId);
  const offline = useAgentComputerOffline(machineId);
  const observedAtMs = useMachineStore((s) => (machineId ? s.computerOfflineObservedAt[machineId] ?? null : null));
  // Offline only from a refused Start: when it went offline is unknown, so no time.
  const fromRefusal = useMachineStore((s) => (machineId ? s.computerOfflineFromRefusal[machineId] === true : false));
  const { formatMessageTime } = useTimeFormatter();
  const serverSlug = useServerStore((s) => s.current?.slug);
  if (!offline) return null;
  const { machine, owner } = offline;
  const since = fromRefusal ? null : observedAtMs ?? machine.lastHeartbeat;
  const computer = (
    <TextLink key="computer" type="button" variant="strong" onClick={openComputer ?? undefined} data-testid="agent-computer-offline-card-computer">
      {machine.name}
    </TextLink>
  );
  const title = since
    ? formatMessage({ id: "agent.computerOffline.cardTitle" }, { computer, time: formatMessageTime(since) })
    : formatMessage({ id: "agent.computerOffline.cardTitleNoTime" }, { computer });
  const powerStep = owner
    ? formatMessage({ id: "agent.computerOffline.stepPowerOwner" }, {
      owner: <span key="owner" className="font-semibold" data-testid="agent-computer-offline-owner">{owner.name}</span>,
      computer: machine.name,
    })
    : formatMessage({ id: "agent.computerOffline.stepPower" }, { computer: machine.name });
  // The Computer page's recovery command: it also starts a stopped service.
  const command = agentComputerRestartCommand(machine, serverSlug);
  const copyLabel = formatMessage({ id: "machine.detail.copyCommand" });
  return (
    <Card className="stack-y-3 p-4" data-testid="agent-computer-offline-card">
      <div className="flex items-center gap-2 text-callout font-semibold text-foreground">
        <StatusDot presence="offline" className="shrink-0" />
        <span className="min-w-0">{title}</span>
      </div>
      <ol className="list-decimal stack-y-2 pl-5 text-subhead text-foreground">
        <li data-testid="agent-computer-offline-step-power">{powerStep}</li>
        <li data-testid="agent-computer-offline-step-run">
          {formatMessage({ id: "agent.computerOffline.stepRun" })}
          {command && (
            // Uncontrolled, as SsoCopyValue: the root keeps its own Copied state.
            <CopyableCodeRoot className="mt-1.5">
              <CopyableCode data-testid="agent-computer-offline-command">{command}</CopyableCode>
              <Tooltip content={copyLabel}>
                <CopyableCodeAction aria-label={copyLabel} className="shrink-0" />
              </Tooltip>
            </CopyableCodeRoot>
          )}
        </li>
      </ol>
    </Card>
  );
}
