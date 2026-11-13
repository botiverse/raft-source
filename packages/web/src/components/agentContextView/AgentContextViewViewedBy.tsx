import { useIntl } from "react-intl";
import { PanelSection } from "@botiverse/raft-ui";
import type { AgentContextViewOutcome, AgentContextViewRecord } from "@botiverse/raft-shared";

import type { MessageId } from "../../i18n/messages/en";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import { useAgentStore } from "../../store/agentStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import AvatarSlot from "../ui/AvatarSlot";

const OUTCOME_COPY: Record<Exclude<AgentContextViewOutcome, "ok">, MessageId> = {
  cancelled: "agentContextView.outcome.cancelled",
  refused: "agentContextView.outcome.refused",
  no_computer: "agentContextView.outcome.noComputer",
  offline: "agentContextView.outcome.offline",
  old_daemon: "agentContextView.outcome.oldDaemon",
  agent_moved: "agentContextView.outcome.agentMoved",
  not_found: "agentContextView.outcome.notFound",
  expired: "agentContextView.outcome.expired",
  unsupported_runtime: "agentContextView.outcome.unsupportedRuntime",
  too_large: "agentContextView.outcome.tooLarge",
  read_failed: "agentContextView.outcome.readFailed",
  context_mismatch: "agentContextView.outcome.readFailed",
  media_removed: "agentContextView.outcome.readFailed",
  newer_session_format: "agentContextView.outcome.readFailed",
  not_recorded: "agentContextView.outcome.readFailed",
};

/** The viewer's face: a person from the member list, an agent from the agent list; one no longer there gets the placeholder. */
function ViewerAvatar({ viewerId, agent }: { viewerId: string | null; agent: boolean }) {
  const member = useServerStore((s) => (viewerId && !agent ? s.members.find((m) => m.userId === viewerId) : undefined));
  const agentAvatarUrl = useAgentStore((s) => (viewerId && agent ? s.agents.find((a) => a.id === viewerId)?.avatarUrl ?? null : null));
  // An agent's search or read (`viewerKind: "agent"`): its own avatar, not a person's placeholder.
  if (agent) return <AvatarSlot context="list-row" type="agent" agentAvatarUrl={agentAvatarUrl} />;
  return (
    <AvatarSlot
      context="list-row"
      type="human"
      humanPlaceholder={!member}
      humanAvatarUrl={member?.avatarUrl ?? null}
    />
  );
}

/**
 * Viewed by (spec §9, §10): every attempt at this message's context, newest
 * first, each row only who, when and how it ended. A view that ended as asked
 * says nothing more; any other outcome is named, `cancelled` included (an
 * attempt with no recorded end). Someone no longer a member of the Server (or
 * a Guest) is unnamed: the Server sends no viewer for them.
 */
export function AgentContextViewViewedBy({ views }: { views: AgentContextViewRecord[] }) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const me = useAuthStore((s) => s.user?.id ?? null);
  if (views.length === 0) return null;
  return (
    <PanelSection data-testid="agent-context-view-viewed-by">
      <h3 className="mb-2 text-sm font-semibold text-foreground-muted">{formatMessage({ id: "agentContextView.viewedBy" })}</h3>
      <ul className="grid gap-2">
        {views.map((row, index) => {
          const name = row.viewer?.name ?? formatMessage({ id: "agentContextView.formerMember" });
          const you = row.viewerKind !== "agent" && row.viewer !== null && row.viewer.id === me;
          // An outcome a newer Server added and this build doesn't know: the row without it.
          const outcome: MessageId | undefined = row.outcome === "ok" ? undefined : OUTCOME_COPY[row.outcome];
          return (
            <li key={`${row.at}:${index}`} className="flex items-start gap-3" data-testid="agent-context-view-viewed-by-row" data-outcome={row.outcome}>
              <ViewerAvatar viewerId={row.viewer?.id ?? null} agent={row.viewerKind === "agent"} />
              <div className="grid min-w-0 flex-1 grid-cols-1">
                {/* First line: who and when (the name may truncate, the time never). */}
                <div className="flex min-w-0 items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-foreground-muted" data-testid="agent-context-view-viewed-by-name">
                    {formatMessage(
                      { id: you ? "agentContextView.viewerRow.you" : "agentContextView.viewerRow.name" },
                      { name: <span key="name" className={row.viewer ? "text-foreground" : undefined}>{name}</span> },
                    )}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-foreground-muted">{formatShortDateTime(row.at)}</span>
                </div>
                {/* Second line: how it ended, unless ok; muted, wrapping, never cut. */}
                {outcome ? (
                  <span className="text-sm break-words text-foreground-muted" data-testid="agent-context-view-viewed-by-outcome">{formatMessage({ id: outcome })}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-sm text-foreground-muted">{formatMessage({ id: "agentContextView.viewedByNote" })}</p>
    </PanelSection>
  );
}
