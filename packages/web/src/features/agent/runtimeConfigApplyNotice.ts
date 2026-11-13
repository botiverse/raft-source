import { toast } from "@botiverse/raft-ui";
import type { IntlShape } from "react-intl";
import type { AgentConfigApply } from "../../store/agentStore";

/**
 * Reconciler step 11c: what a saved runtime config change tells the person
 * when the agent is running. The server applies it at the agent's next idle
 * point (`when_idle`), or, from a daemon too old for that, at its next start
 * (`saved`); either way nothing was interrupted, so this is a toast (Raft DS ›
 * Toast: the result of what they just did) whose one action, Restart now, is
 * the agent's ordinary reset, offered only to who may restart it.
 * `newSession`: a runtime switch or a Codex model change, which runs on a new
 * session (and Restart now resets the session, as the confirmation used to).
 */
export function announceRuntimeConfigApply({ configApply, agentActive, agentName, newSession, formatMessage, restartNow }: {
  configApply: AgentConfigApply | undefined;
  agentActive: boolean;
  agentName: string;
  newSession: boolean;
  formatMessage: IntlShape["formatMessage"];
  /** Absent when this person may not restart the agent. */
  restartNow?: (mode: "restart" | "session") => Promise<void>;
}): void {
  const whenIdle = configApply === "when_idle";
  // `restarted` already happened; a stopped agent's change applies when it starts, as before.
  if (!whenIdle && !(configApply === "saved" && agentActive)) return;
  // Raft DS › Toast: the title is one sentence; when it applies is the description.
  const title = formatMessage({ id: "agent.detail.runtimeConfigSavedTitle" }, { name: agentName });
  const description = formatMessage({
    id: !whenIdle ? "agent.detail.runtimeConfigAppliesNextStart" : newSession ? "agent.detail.runtimeConfigNewSessionWhenIdle" : "agent.detail.runtimeConfigAppliesWhenIdle",
  });
  if (!restartNow) {
    toast.success(title, { description });
    return;
  }
  const toastId = toast.success(title, {
    description,
    action: {
      label: formatMessage({ id: "agent.detail.restartNow" }),
      onClick: () => {
        toast.dismiss(toastId);
        void restartNow(newSession ? "session" : "restart").catch(() => {
          toast.warning(formatMessage({ id: "machine.restartFailed" }));
        });
      },
    },
  });
}
