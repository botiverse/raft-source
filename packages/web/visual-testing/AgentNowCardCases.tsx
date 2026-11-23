import { useState } from "react";
import { AgentNowCard } from "../src/components/agent/AgentNowCard";
import type { TurnSummaryView } from "../src/components/agent/AgentActivityOverview";
import { useAgentStore } from "../src/store/agentStore";
import fixtureData from "../../visual-testing/shared/fixtureData.json";

// The profile's Recent activity card (AgentNowCard with its recent rows) in a
// phone-wide column, with the rows as AgentRecentActivity lays them out
// (px-5 py-4; its status chip is left out). The rows
// must keep every part readable: what does not fit on the line (a long
// trigger, long actions, a badge as a whole) moves to the next one instead
// of being cut to "…". The "Last turn: …" line above them wraps too.
// Rows: a long trigger with long actions; an error
// ending with "No message sent" (both badges); a short one with only "No
// message sent".

export const AGENT_NOW_CARD_CASE_IDS = [
  "components.members.agent-now-card.recent-rows-narrow",
] as const;

const AGENT_ID = "visual-now-card-agent";
const NOW = fixtureData.locale.nowEpochMillis;
const MINUTE = 60_000;

function turn(id: string, minutesAgo: number, rest: Partial<TurnSummaryView>): TurnSummaryView {
  const startedAt = NOW - minutesAgo * MINUTE;
  return {
    v: 1,
    id,
    startedAt,
    endedAt: startedAt + 2 * MINUTE,
    outcome: "completed",
    actions: [],
    toolCalls: 0,
    problems: [],
    problemCount: 0,
    messagesSent: 0,
    ...rest,
  };
}

/** Newest first; the first is the card's "Last turn", the next three its rows. */
export const AGENT_NOW_CARD_TURNS: readonly TurnSummaryView[] = [
  turn("last", 5, {
    trigger: { display: { kind: "thread", channelName: "proj-raft-computer-reconciler", senderName: "Tenny" } },
    actions: [{ kind: "read_messages", count: 3 }, { kind: "read_file", count: 6 }, { kind: "send_message", count: 1 }],
    toolCalls: 10,
    messagesSent: 1,
    lastReplyMessageId: "visual-reply-last",
  }),
  turn("long", 18, {
    trigger: { display: { kind: "thread", channelName: "proj-raft-computer-reconciler", senderName: "Tenny" } },
    actions: [
      { kind: "read_file", count: 12 },
      { kind: "run_command", count: 7 },
      { kind: "edit_file", count: 4 },
      { kind: "run_checks", count: 2 },
      { kind: "send_message", count: 1 },
    ],
    toolCalls: 26,
    messagesSent: 2,
    lastReplyMessageId: "visual-reply-long",
  }),
  turn("failed", 41, {
    trigger: { display: { kind: "channel", channelName: "proj-runtime", senderName: "Tenny" } },
    outcome: "failed",
    actions: [{ kind: "run_command", count: 3 }, { kind: "read_file", count: 2 }],
    toolCalls: 5,
  }),
  turn("short", 66, {
    trigger: { display: { kind: "dm", senderName: "xxchan" } },
    actions: [{ kind: "read_messages", count: 1 }],
    toolCalls: 1,
  }),
];

function noop() {}

export function AgentNowCardCase({ caseId }: { caseId: string }) {
  useState(() => {
    useAgentStore.setState((state) => ({
      agentActivities: { ...state.agentActivities, [AGENT_ID]: { activity: "online", activityDetail: "", detailKind: "other" } },
    }));
    return true;
  });
  return (
    <main className="min-h-screen bg-layer-canvas font-display text-foreground">
      <section data-visual-case={caseId} className="w-full px-5 py-4">
        <AgentNowCard agentId={AGENT_ID} turns={AGENT_NOW_CARD_TURNS} running={null} onOpenActivity={noop} recentRows={3} />
      </section>
    </main>
  );
}
