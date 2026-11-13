import type { IntlShape } from "react-intl";
import type { AgentTurnStopOutcome } from "../../store/agentStore";
import { showToast } from "../toastBridge";

const OUTCOME_MESSAGE_IDS = {
  interrupted: "agent.detail.stopTurn.interrupted",
  restarted: "agent.detail.stopTurn.restarted",
  not_running: "agent.detail.stopTurn.notRunning",
} as const satisfies Record<AgentTurnStopOutcome, string>;

// Refusals the server explains with a code. Retrying won't help these, so they
// get their own message and no Retry; anything else is a plain failure.
const REFUSAL_MESSAGE_IDS = {
  computer_upgrade_required: "agent.detail.stopTurn.upgradeRequired",
  computer_offline: "agent.detail.stopTurn.computerOffline",
} as const;

function refusalCode(error: unknown): keyof typeof REFUSAL_MESSAGE_IDS | null {
  const code = (error as { response?: { data?: { code?: unknown } } } | null)?.response?.data?.code;
  return typeof code === "string" && code in REFUSAL_MESSAGE_IDS ? code as keyof typeof REFUSAL_MESSAGE_IDS : null;
}

/**
 * Stop an agent's running turn (the agent stays) and say what happened in one
 * short toast. No confirmation: stopping a runaway turn must be quick (Tenny).
 * A failed stop (including the Computer not answering in time) offers Retry;
 * the stop is idempotent.
 */
export async function stopAgentTurnWithFeedback(
  stop: () => Promise<AgentTurnStopOutcome>,
  formatMessage: IntlShape["formatMessage"],
): Promise<void> {
  try {
    const outcome = await stop();
    showToast({ title: formatMessage({ id: OUTCOME_MESSAGE_IDS[outcome] }), type: "success" });
  } catch (error) {
    const refusal = refusalCode(error);
    if (refusal) {
      showToast({ title: formatMessage({ id: REFUSAL_MESSAGE_IDS[refusal] }), type: "error" });
      return;
    }
    showToast({
      title: formatMessage({ id: "agent.detail.stopTurn.failed" }),
      type: "error",
      actionProps: {
        children: formatMessage({ id: "agent.detail.stopTurn.retry" }),
        onClick: () => { void stopAgentTurnWithFeedback(stop, formatMessage); },
      },
    });
  }
}
