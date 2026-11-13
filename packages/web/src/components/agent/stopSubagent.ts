import type { IntlShape } from "react-intl";
import api from "../../api/client";
import { showToast } from "../toastBridge";

/** #proj-runtime:#41: how a stop-this-subagent request ended (`AgentSubagentInterruptOutcome`). */
type SubagentStopOutcome = "interrupted" | "not_running" | "unsupported";

const OUTCOME_MESSAGE_IDS = {
  interrupted: "activity.subagents.stop.interrupted",
  not_running: "activity.subagents.stop.notRunning",
  unsupported: "activity.subagents.stop.unsupported",
} as const satisfies Record<SubagentStopOutcome, string>;

// Refusals the server explains with a code: retrying won't help these.
const REFUSAL_MESSAGE_IDS = {
  computer_upgrade_required: "activity.subagents.stop.upgradeRequired",
  computer_offline: "agent.detail.stopTurn.computerOffline",
} as const;

function refusalCode(error: unknown): keyof typeof REFUSAL_MESSAGE_IDS | null {
  const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === "string" && code in REFUSAL_MESSAGE_IDS ? code as keyof typeof REFUSAL_MESSAGE_IDS : null;
}

/**
 * Whether a viewer may stop this agent's subagents: Stop turn's runtime
 * authority, a live agent, and the one runtime that can stop a single
 * subagent (Codex, Claude Code, Kimi). The server checks the authority again.
 */
export function canStopSubagentsOf(agent: { runtime: string; deletedAt?: string | null }, canControlAgentRuntime: boolean): boolean {
  return canControlAgentRuntime && !agent.deletedAt && SUBAGENT_STOP_RUNTIMES.has(agent.runtime);
}

/**
 * The runtimes that can stop one subagent: Codex (turn/interrupt on its
 * thread), Claude Code (stop_task), Kimi (through its task; one another
 * subagent started answers `unsupported`), Qoder (OAR's `stopTask`).
 */
const SUBAGENT_STOP_RUNTIMES: ReadonlySet<string> = new Set(["codex", "claude", "kimi-sdk", "qoder"]);

export async function stopSubagent(agentId: string, subagentTaskId: string): Promise<SubagentStopOutcome> {
  const { data } = await api.post(`/agents/${agentId}/subagents/${encodeURIComponent(subagentTaskId)}/interrupt`);
  const outcome = (data as { outcome?: string }).outcome;
  return outcome === "interrupted" || outcome === "unsupported" ? outcome : "not_running";
}

/**
 * Stop one running subagent (the agent and its other subagents keep running)
 * and say what happened in one short toast, as Stop Current Turn does: no
 * confirmation, Retry on a plain failure (the stop is idempotent).
 */
export async function stopSubagentWithFeedback(agentId: string, subagentTaskId: string, formatMessage: IntlShape["formatMessage"]): Promise<void> {
  try {
    const outcome = await stopSubagent(agentId, subagentTaskId);
    showToast({ title: formatMessage({ id: OUTCOME_MESSAGE_IDS[outcome] }), type: outcome === "interrupted" ? "success" : "info" });
  } catch (error) {
    const refusal = refusalCode(error);
    if (refusal) {
      showToast({ title: formatMessage({ id: REFUSAL_MESSAGE_IDS[refusal] }), type: "error" });
      return;
    }
    showToast({
      title: formatMessage({ id: "activity.subagents.stop.failed" }),
      type: "error",
      actionProps: {
        children: formatMessage({ id: "agent.detail.stopTurn.retry" }),
        onClick: () => { void stopSubagentWithFeedback(agentId, subagentTaskId, formatMessage); },
      },
    });
  }
}
