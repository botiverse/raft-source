import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Separator } from "@botiverse/raft-ui";
import api from "../../api/client";
import { getSocket } from "../../api/socket";
import { AgentNowCard } from "../../components/agent/AgentNowCard";
import type { RunningTurnView, SummaryPage, TurnSummaryView } from "../../components/agent/AgentActivityOverview";
import { registerActivityTrajectoryLiveReload, registerActivityTrajectoryReconnectReload } from "../../utils/activityTrajectoryRecovery";

/** Finished turns the profile lists under what the agent is doing now. */
const RECENT_TURNS = 3;

type Page = { agentId: string; turns: TurnSummaryView[]; running: RunningTurnView | null };

const NO_TURNS: readonly TurnSummaryView[] = [];

/**
 * The profile's "Recent activity" (xxchan, 2026-11-05): the now card, with
 * the profile's status chip (`status`) as its first line and the agent's last
 * few turns one line each; its heading opens the Activity tab. It shows from
 * the start (the status needs no turns) and follows the agent's activity as
 * the Activity overview does: each activity push and each reconnect reload it.
 */
export function AgentRecentActivity({ agentId, onOpenActivity, status }: { agentId: string; onOpenActivity: () => void; status: ReactNode }) {
  // Tagged with its agent: another agent's turns are never shown while this one's load.
  const [page, setPage] = useState<Page | null>(null);
  // The agent shown now: an answer for the one shown before (the panel is reused) is dropped, not stored over this one's.
  const shownAgentId = useRef(agentId);
  useEffect(() => {
    shownAgentId.current = agentId;
  }, [agentId]);
  const load = useCallback(async (id: string) => {
    try {
      // One more than listed: without a running turn the newest is the card's own line.
      const { data } = await api.get<SummaryPage>(`/agents/${id}/activity-summaries`, { params: { limit: RECENT_TURNS + 1 } });
      if (id !== shownAgentId.current) return;
      // The API pages newest first; a running turn's own row (an empty wake it continued) is not a finished one.
      const summaries = Array.isArray(data?.summaries) ? data.summaries : [];
      const runningId = data?.current?.id;
      setPage({ agentId: id, turns: runningId ? summaries.filter((turn) => turn.id !== runningId) : summaries, running: data?.current ?? null });
    } catch {
      // The status still shows; the turns come with the next reload.
    }
  }, []);
  useEffect(() => {
    void load(agentId);
  }, [agentId, load]);
  const shown = page?.agentId === agentId ? page : null;
  useEffect(() => registerActivityTrajectoryLiveReload({ socket: getSocket(), agentId, loadTrajectoryLog: load }), [agentId, load]);
  useEffect(() => registerActivityTrajectoryReconnectReload({ socket: getSocket(), agentId, loadTrajectoryLog: load }), [agentId, load]);
  return (
    <>
      <div className="px-5 py-4" data-testid="agent-recent-activity">
        <AgentNowCard agentId={agentId} turns={shown?.turns ?? NO_TURNS} running={shown?.running ?? null} status={status} onOpenActivity={onOpenActivity} recentRows={RECENT_TURNS} />
      </div>
      <Separator />
    </>
  );
}
