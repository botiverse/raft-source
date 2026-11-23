import { useEffect, useState } from "react";
import AgentActivityLog, { RawActivityLog } from "../src/components/agent/AgentActivityLog";
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
  "components.agent-activity-log.status-rows",
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

// Status rows (#proj-raft-ui:59aa78ae): the status word on the first line, the
// explanation (when there is one) below it in the detail style; a sub-agent's
// badge stays on the first line.
function statusRows(): TrajectoryLogEntry[] {
  const at = (seq: number) => START + seq * 1000;
  const rows: TrajectoryLogEntry["entry"][] = [
    { kind: "status", activity: "working", detail: "Message received from #proj-raft-ui:59aa78ae" },
    { kind: "thinking", text: "Reading the status row layout before changing it." },
    { kind: "status", activity: "working", detail: "Running Bash" },
    { kind: "status", activity: "working", detail: "Running Read", subagent: { subagentType: "Explore", taskId: "visual-task" } },
    { kind: "status", activity: "thinking", detail: "" },
    { kind: "status", activity: "error", detail: "The provider returned 529 overloaded; retrying in 30 seconds with the same request so nothing is lost" },
    { kind: "status", activity: "online", detail: "" },
    { kind: "status", activity: "offline", detail: "Stopped by the Computer shutting down", detailKind: "stopped" },
    { kind: "status", activity: "offline", detail: "--dangerously-skip-permissions cannot be used with root/sudo privileges", detailKind: "claude_root_privileges" },
  ];
  return rows.map((entry, seq) => ({ timestamp: at(seq), serverSeq: seq, entry }));
}

function prime(caseId: string) {
  nextSeq = 0;
  if (caseId.endsWith(".status-rows")) {
    useAgentStore.setState({ trajectoryLogs: { [AGENT_ID]: statusRows() }, loadTrajectoryLog: async () => {} } as never);
    return;
  }
  useAgentStore.setState({ trajectoryLogs: {}, loadTrajectoryLog: async () => {} } as never);
  append(MAX_TRAJECTORY_ENTRIES);
  window.__appendActivitySteps = append;
}

export function AgentActivityLogCase({ caseId }: { caseId: string }) {
  useState(() => {
    prime(caseId);
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
        {caseId.endsWith(".status-rows") ? <RawActivityLog agentId={AGENT_ID} /> : <AgentActivityLog agentId={AGENT_ID} />}
      </section>
    </main>
  );
}
