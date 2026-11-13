// A personal assistant a server owner/admin paused (#10654). While
// `assistantPausedAt` is set nothing wakes it (no chat, no doorbell, no brief)
// until its owner presses Start, which is `POST /agents/:id/start`. Pause and
// resume emit `agent:updated`; the web re-reads the agent list.
//
// Raft DS: the state is an agent state chip (a soft Badge with the offline
// presence light and its word; Status › Agent state chips) and an info Banner
// (Banner › Variants: information, not an error) with at most one bordered
// button (Banner › Rules: `variant="default" size="sm"`, never pink).

import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Badge, Banner, BannerAction, BannerDescription, BannerTitle, Button, Spinner } from "@botiverse/raft-ui";
import { Info } from "lucide-react";
import StatusDot from "../components/ui/StatusDot";
import { useAgentStore } from "../store/agentStore";
import { useAuthStore } from "../store/authStore";
import type { Agent } from "../store/agentStore";
import { formatRelativeTime } from "../utils/relativeTime";

type PausedBy = { id: string; name: string } | null;

/** This agent's pause, or null while it is not paused (or not an assistant). */
export function useAssistantPause(agentId: string): { pausedAt: string; pausedBy: PausedBy } | null {
  const pausedAt = useAgentStore((s) => s.agents.find((a) => a.id === agentId)?.assistantPausedAt ?? null);
  const pausedBy = useAgentStore((s) => s.agents.find((a) => a.id === agentId)?.assistantPausedBy ?? null);
  return pausedAt ? { pausedAt, pausedBy } : null;
}

/** A personal assistant: the payload names its owner, or it is paused (only an assistant can be). */
export function isPersonalAssistant(agent: Pick<Agent, "assistantOwnerUserId" | "assistantPausedAt">): boolean {
  return Boolean(agent.assistantOwnerUserId || agent.assistantPausedAt);
}

/** The signed-in person owns this assistant (the payload names them, or, without that field, created it). */
export function useIsAssistantOwner(agentId: string): boolean {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const ownerId = useAgentStore((s) => {
    const agent = s.agents.find((a) => a.id === agentId);
    if (!agent) return null;
    return agent.assistantOwnerUserId ?? (agent.creatorType === "user" ? agent.creatorId : null);
  });
  return Boolean(userId && ownerId === userId);
}

/**
 * "Paused by {name} · {time}", without the name for a viewer who isn't sent
 * it (a regular member), and without the time when it can't be read.
 */
export function useAssistantPausedLine(pausedAt: string, pausedBy: PausedBy): string {
  const intl = useIntl();
  const time = formatRelativeTime(pausedAt, intl.locale);
  const name = pausedBy?.name?.trim() || null;
  if (name && time) return intl.formatMessage({ id: "assistant.paused.byAt" }, { name, time });
  if (name) return intl.formatMessage({ id: "assistant.paused.by" }, { name });
  if (time) return intl.formatMessage({ id: "assistant.paused.at" }, { time });
  return intl.formatMessage({ id: "assistant.paused.chip" });
}

/** The agent state chip for a paused assistant: the offline light and "Paused". */
export function AssistantPausedChip({ className }: { className?: string }) {
  const { formatMessage } = useIntl();
  return (
    <Badge appearance="soft" variant="muted" className={className} data-testid="assistant-paused-chip">
      <StatusDot presence="offline" className="shrink-0" aria-hidden="true" />
      {formatMessage({ id: "assistant.paused.chip" })}
    </Badge>
  );
}

/**
 * The notice: who paused it and when, that it won't reply or run its brief,
 * and, for its owner only, Start. Admins and members see the state and no
 * Start (only the owner can lift the pause). Renders nothing while not paused.
 */
export function AssistantPausedNotice({ agentId, isOwner, className }: {
  agentId: string;
  /** Defaults to whether the signed-in person owns it (useIsAssistantOwner). */
  isOwner?: boolean;
  className?: string;
}) {
  const pause = useAssistantPause(agentId);
  const ownsIt = useIsAssistantOwner(agentId);
  if (!pause) return null;
  return <PausedNotice agentId={agentId} isOwner={isOwner ?? ownsIt} pausedAt={pause.pausedAt} pausedBy={pause.pausedBy} className={className} />;
}

function PausedNotice({ agentId, isOwner, pausedAt, pausedBy, className }: { agentId: string; isOwner: boolean; pausedAt: string; pausedBy: PausedBy; className?: string }) {
  const { formatMessage } = useIntl();
  const resumeAssistant = useAgentStore((s) => s.resumeAssistant);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const line = useAssistantPausedLine(pausedAt, pausedBy);
  const handleStart = useCallback(() => {
    setStarting(true);
    setFailed(false);
    resumeAssistant(agentId).then(
      () => setStarting(false),
      () => {
        setStarting(false);
        setFailed(true);
      },
    );
  }, [agentId, resumeAssistant]);

  return (
    <Banner status="info" className={className} data-testid="assistant-paused-notice">
      <Info aria-hidden="true" />
      <BannerTitle>{line}</BannerTitle>
      <BannerDescription>
        {formatMessage({ id: isOwner ? "assistant.paused.ownerBody" : "assistant.paused.otherBody" })}
        {failed && (
          <span className="mt-1 block" role="alert" data-testid="assistant-paused-start-error">
            {formatMessage({ id: "assistant.paused.startFailed" })}
          </span>
        )}
      </BannerDescription>
      {isOwner && (
        <BannerAction>
          <Button
            variant="default"
            size="md"
            onClick={handleStart}
            disabled={starting}
            aria-busy={starting}
            data-testid="assistant-paused-start"
          >
            {starting && <Spinner aria-hidden="true" />}
            {formatMessage({ id: starting ? "assistant.paused.starting" : "assistant.paused.start" })}
          </Button>
        </BannerAction>
      )}
    </Banner>
  );
}
