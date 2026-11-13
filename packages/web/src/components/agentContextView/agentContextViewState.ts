import type { AgentContextView, AgentContextViewFailureReason, AgentContextViewStatusReason, AgentContextViewTooLargeCause } from "@botiverse/raft-shared";
import { openAgentContextView, useAgentContextViewStore } from "../../store/agentContextViewStore";
import type { OpenAgentContextView } from "../../store/agentContextViewStore";
import { loadAgentContextViewStatus, useAgentContextViewStatusStore } from "./agentContextViewStatus";
import type { AgentContextViewStatusEntry } from "./agentContextViewStatus";
import { agentContextViewKey, loadAgentContextView, loadAgentContextViewedByOnly } from "./agentContextViewResult";
import type { AgentContextViewAnswer } from "./agentContextViewResult";
import { useAuthStore } from "../../store/authStore";

/**
 * What the panel body shows, from the status and (once the status says
 * `available`) the view's answer:
 * - `loading`: no answer yet;
 * - `content`: the restored context;
 * - `banner`: it failed to load or can't be shown (DS feedback: an orange
 *   Banner where the content would be), with Retry only where asking again
 *   can help;
 * - `empty`: a conclusion, not a failure (EmptyState, no button);
 * - `gone`: the Server says 404 now (the flag went off, access was lost): the
 *   panel closes, as the menu would no longer offer it.
 *
 * The view request can answer the status's reasons too (the Computer went
 * offline since): each is said as the status would say it.
 */
export type AgentContextViewBodyState =
  | { kind: "loading" }
  | { kind: "gone" }
  | { kind: "content"; context: AgentContextView }
  | { kind: "banner"; reason: AgentContextViewBannerReason; retry: boolean; tooLargeCause?: AgentContextViewTooLargeCause }
  | { kind: "empty"; reason: "unsupported_runtime" | "no_session" | "no_computer" };

export type AgentContextViewBannerReason =
  | "offline" | "old_daemon" | "status_failed" | "agent_moved" | "not_found" | "expired" | "too_large" | "read_failed"
  | "context_mismatch" | "media_removed" | "newer_session_format" | "not_recorded";

/**
 * Whether asking again can help: not where the fix is elsewhere (update the
 * Computer) or the answer won't change. `too_large` (the request's size, or a
 * Kimi session's records since its last compaction), `context_mismatch` and
 * `media_removed` are what the session holds: the same answer every time.
 * `not_recorded`: Raft didn't record the request when it was sent, and
 * nothing records it later.
 */
const BANNER_RETRY: Record<AgentContextViewBannerReason, boolean> = {
  offline: true,
  old_daemon: false,
  status_failed: true,
  agent_moved: true,
  not_found: false,
  expired: true,
  too_large: false,
  read_failed: true,
  context_mismatch: false,
  media_removed: false,
  newer_session_format: false,
  not_recorded: false,
};

function reasonState(reason: AgentContextViewStatusReason | AgentContextViewFailureReason): AgentContextViewBodyState {
  switch (reason) {
    case "unsupported_runtime":
    case "no_session":
    case "no_computer": return { kind: "empty", reason };
    case "offline":
    case "old_daemon":
    case "agent_moved":
    case "not_found":
    case "expired":
    case "too_large":
    case "read_failed":
    case "context_mismatch":
    case "media_removed":
    case "newer_session_format":
    case "not_recorded": return { kind: "banner", reason, retry: BANNER_RETRY[reason] };
    // A reason this build doesn't know yet (a newer Server or daemon): said as a read failure, with Retry.
    default: return { kind: "banner", reason: "read_failed", retry: true };
  }
}

export function agentContextViewBodyState(entry: AgentContextViewStatusEntry | undefined, answer: AgentContextViewAnswer | null = null): AgentContextViewBodyState {
  const status = entry?.status;
  if (status === null) return { kind: "gone" };
  if (status === undefined) return entry?.failed && !entry.pending ? { kind: "banner", reason: "status_failed", retry: true } : { kind: "loading" };
  if (status.state === "unavailable") return reasonState(status.reason);
  if (!answer || answer.kind === "loading") return { kind: "loading" };
  if (answer.kind === "gone") return { kind: "gone" };
  if (answer.kind === "ok") return { kind: "content", context: answer.context };
  const state = reasonState(answer.reason);
  return state.kind === "banner" && state.reason === "too_large" && answer.tooLargeCause ? { ...state, tooLargeCause: answer.tooLargeCause } : state;
}

/**
 * Ask for the agent's status again (unless a fresh answer is kept; `force`:
 * Retry). A 404 now (the flag went off, access was lost) closes the view
 * opened for that agent: there is no View Context for this person any more.
 */
export async function refreshAgentContextViewStatus(agentId: string, options: { force?: boolean } = {}) {
  await loadAgentContextViewStatus(agentId, options);
  const open = useAgentContextViewStore.getState().open;
  if (open?.agentId === agentId && useAgentContextViewStatusStore.getState().byAgent[agentId]?.status === null) {
    useAgentContextViewStore.getState().close();
  }
}

/**
 * Make sure the status of `view`'s agent is current (`force`: ask anyway, as
 * Retry does) and, if it says `available` while `view` is still the one open,
 * ask for the context: one audited attempt per opening, a new one on Retry.
 */
export async function askAgentContextView(view: OpenAgentContextView, options: { force?: boolean } = {}) {
  await refreshAgentContextViewStatus(view.agentId, options);
  const open = useAgentContextViewStore.getState().open;
  if (!open || agentContextViewKey(open) !== agentContextViewKey(view)) return;
  const status = useAgentContextViewStatusStore.getState().byAgent[view.agentId]?.status;
  if (status?.state === "available") {
    await loadAgentContextView(view, useAuthStore.getState().user?.id ?? null, options);
    return;
  }
  // It can't be shown now (the reason is the status's): nothing asked of the Computer, but Viewed by
  // still lists the attempts so far, under the reason. Nothing for the 404 (the panel closes) or a failed status.
  if (status?.state === "unavailable") await loadAgentContextViewedByOnly(view);
}

/** Open the context view for one agent message (its menu's View Context): its status, then its context. */
export function openAgentContextViewFor(view: OpenAgentContextView) {
  openAgentContextView(view);
  void askAgentContextView(view);
}
