import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Archive } from "lucide-react";
import { RadioGroup, RadioGroupItem } from "@botiverse/raft-ui";
import { isExternalAgentRuntime } from "@botiverse/raft-shared";
import type { AgentArchiveWorkspaceChoice } from "@botiverse/raft-shared";
import ConfirmDialog from "../ConfirmDialog";
import Banner from "../ui/Banner";
import type { MessageId } from "../../i18n/messages";
import { useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import { useMachineStore } from "../../store/machineStore";
import { archiveRequestErrorMessage } from "./archiveApi";

const OPTIONS: Array<{ choice: AgentArchiveWorkspaceChoice; labelId: MessageId; descId: MessageId }> = [
  { choice: "keep", labelId: "agent.archive.option.keep", descId: "agent.archive.option.keepDesc" },
  { choice: "delete", labelId: "agent.archive.option.delete", descId: "agent.archive.option.deleteDesc" },
];

/**
 * Archive an agent (the former delete). Agents with a workspace on a Computer
 * choose whether it stays there or is deleted.
 */
export function AgentArchiveDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { formatMessage } = useIntl();
  const deleteAgent = useAgentStore((s) => s.deleteAgent);
  const [choice, setChoice] = useState<AgentArchiveWorkspaceChoice>("keep");
  const hasComputerWorkspace = Boolean(agent.machineId) && agent.external !== true && !isExternalAgentRuntime(agent.runtime);
  const name = agent.displayName || agent.name;
  const computer = useMachineStore((s) => s.machines.find((machine) => machine.id === agent.machineId)?.name) ?? "";

  const handleChoiceChange = useCallback((value: string) => setChoice(value as AgentArchiveWorkspaceChoice), []);

  const handleArchive = useCallback(async () => {
    try {
      await deleteAgent(agent.id, hasComputerWorkspace ? choice : "keep");
    } catch (err: unknown) {
      throw new Error(archiveRequestErrorMessage(err, formatMessage) ?? formatMessage({ id: "agent.archive.failed" }));
    }
  }, [agent.id, choice, deleteAgent, formatMessage, hasComputerWorkspace]);

  return (
    <ConfirmDialog
      title={formatMessage({ id: "agent.archive.title" }, { name })}
      maxWidthClass="max-w-md"
      plainMessage
      message={(
        <div className="stack-y-3" data-testid="agent-archive-dialog">
          <p>{formatMessage({ id: "agent.archive.description" })}</p>
          {hasComputerWorkspace && (
            <RadioGroup
              value={choice}
              onValueChange={handleChoiceChange}
              aria-label={formatMessage({ id: "agent.archive.workspaceQuestion" })}
              className="gap-0"
            >
              {/* DS Radio rows: 44 tall, the whole row clicks; label 15/20 600,
                  description 13/18 ink-2. */}
              {OPTIONS.map((option) => (
                <label key={option.choice} className="flex min-h-11 items-start gap-3 py-3">
                  <RadioGroupItem
                    value={option.choice}
                    className="shrink-0"
                    data-testid={`agent-archive-option-${option.choice}`}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-subhead font-semibold text-foreground">
                      {formatMessage({ id: option.labelId })}
                    </span>
                    <span className="text-footnote font-normal text-foreground-muted">
                      {formatMessage({ id: option.descId }, { computer })}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          )}
          {/* Deleting the workspace cannot be undone: the red-soft banner. */}
          {choice === "delete" && (
            <Banner intent="destructive" density="sm" withIcon>
              {formatMessage({ id: "agent.archive.deleteWarning" })}
            </Banner>
          )}
        </div>
      )}
      chromeLocale="active"
      confirmLabel={formatMessage({ id: "agent.archive.confirm" })}
      loadingLabel={formatMessage({ id: "agent.detail.deleting" })}
      confirmIcon={<Archive size={14} />}
      confirmVariant={choice === "delete" ? "danger" : "warning"}
      onConfirm={handleArchive}
      onClose={onClose}
    />
  );
}
