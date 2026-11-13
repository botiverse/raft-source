import { useEffect, useState } from "react";
import AgentActivityLog from "../src/components/agent/AgentActivityLog";
import { useAgentStore } from "../src/store/agentStore";
import type { TrajectoryLogEntry } from "../src/store/agentStore";
import { MAX_TRAJECTORY_ENTRIES } from "../src/store/events/agentActivityEvents";

// The Activity tab's raw log following its newest step (raft-design
// "Following the newest", #triage:44ed2937): a full log (500 steps, the live
// cap) in the 440px side column. `window.__appendActivitySteps(n)` adds steps
// as the live stream does (the oldest drop off the top), so a browser check
// can scroll and append; `.new-steps` lands scrolled up with 3 new steps, the
// pill showing.

export const AGENT_ACTIVITY_LOG_CASE_IDS = [
  "components.agent-activity-log.follow",
  "components.agent-activity-log.new-steps",
] as const;

const AGENT_ID = "visual-activity-agent";
const START = Date.UTC(2026, 10, 9, 9, 0, 0);
const TOOLS = ["Bash", "Read", "Edit", "Grep"];

function step(seq: number): TrajectoryLogEntry {
  const timestamp = START + seq * 1000;
  if (seq % 3 === 0) return { timestamp, serverSeq: seq, entry: { kind: "thinking", text: `Step ${seq}: checking what the last change did before the next one.` } };
  return { timestamp, serverSeq: seq, entry: { kind: "tool_start", toolName: TOOLS[seq % TOOLS.length]!, toolInput: `step ${seq}: packages/web/src/components/agent/AgentActivityLog.tsx` } };
}

let nextSeq = 0;
function append(count: number) {
  const added = Array.from({ length: count }, () => step(nextSeq++));
  useAgentStore.setState((state) => ({
    trajectoryLogs: { ...state.trajectoryLogs, [AGENT_ID]: [...(state.trajectoryLogs[AGENT_ID] ?? []), ...added].slice(-MAX_TRAJECTORY_ENTRIES) },
  }));
}

declare global {
  interface Window { __appendActivitySteps?: (count: number) => void }
}

function prime() {
  nextSeq = 0;
  useAgentStore.setState({ trajectoryLogs: {}, loadTrajectoryLog: async () => {} } as never);
  append(MAX_TRAJECTORY_ENTRIES);
  window.__appendActivitySteps = append;
}

export function AgentActivityLogCase({ caseId }: { caseId: string }) {
  useState(() => {
    prime();
    return true;
  });
  useEffect(() => {
    if (!caseId.endsWith(".new-steps")) return;
    // Scrolled up a little once the log has settled, then three steps arrive.
    let arrive: ReturnType<typeof setTimeout> | undefined;
    const scrollUp = setTimeout(() => {
      const log = document.querySelector<HTMLElement>("[data-visual-case] [role='region']");
      if (log) log.scrollTop = log.scrollHeight - log.clientHeight - 400;
      arrive = setTimeout(() => append(3), 200);
    }, 300);
    return () => {
      clearTimeout(scrollUp);
      clearTimeout(arrive);
    };
  }, [caseId]);
  return (
    <main className="flex h-screen justify-end bg-layer-sidebar">
      <section data-visual-case={caseId} className="flex h-full w-[440px] min-w-0 flex-col border-s border-line-seam bg-layer-canvas">
        <AgentActivityLog agentId={AGENT_ID} />
      </section>
    </main>
  );
}
