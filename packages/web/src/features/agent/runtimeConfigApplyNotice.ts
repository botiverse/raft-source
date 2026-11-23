import { toast } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import type { AgentConfigApply } from "../../store/agentStore";

/**
 * Reconciler step 11c + #proj-runtime:#80: what a saved runtime config change
 * tells the person when the agent is running.
 * - `applied` / `restarted`: running agent applied/restarted immediately —
 *   plain confirmation toast with no manual restart button.
 * - `when_idle`: older Computer without `agent:config-interrupt-v1` while busy
 *   — plain informational toast saying it applies after the current turn, with
 *   no "Switch now" button.
 * - `saved`: stopped/inactive agent (or temporarily offline machine whose
 *   config re-syncs automatically on reconnect) — no restart prompt.
 */
export function announceRuntimeConfigApply({ configApply, agentActive, agentName, newSession = false, formatMessage }: {
  configApply: AgentConfigApply | undefined;
  agentActive: boolean;
  agentName: string;
  newSession?: boolean;
  formatMessage: IntlShape["formatMessage"];
}): void {
  if (configApply === "applied" || configApply === "restarted") {
    if (!agentActive) return;
    const title = formatMessage({ id: "agent.detail.runtimeConfigSavedTitle" }, { name: agentName });
    toast.success(title, {
      description: formatMessage({ id: "agent.detail.runtimeConfigAppliedNow" }),
    });
    return;
  }
  if (configApply !== "when_idle") return;
  const title = formatMessage({ id: "agent.detail.runtimeConfigSavedTitle" }, { name: agentName });
  const description = formatMessage({
    id: newSession ? "agent.detail.runtimeConfigNewSessionWhenIdle" : "agent.detail.runtimeConfigAppliesWhenIdle",
  });
  toast.success(title, { description });
}
