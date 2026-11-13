import { useCallback, useSyncExternalStore } from "react";

// "This person has sent feedback an agent drafted": set when they send a
// `feedback:submit` card's dialog (actionCardIntentFlows.tsx), read by the
// feedback page (settings/AboutFeedbackDialog.tsx), whose agent hint
// (settings/FeedbackAgentHint.tsx) then stops showing: they already know an
// agent can draft it.
//
// Limit: kept in this browser's localStorage, one key per user. Another
// device or browser (or a cleared storage) still shows the tip until the
// person sends a card there; the server does not expose whether a ticket was
// agent-drafted to the list (triage #289). Storage that refuses the write
// keeps the flag for this page only.
//
// No feedback SDK import here: the action card is in the startup bundle.

const STORAGE_KEY_PREFIX = "raft_feedback_agent_draft_sent:";

/** The localStorage key for one user. */
export function agentFeedbackSentStorageKey(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

const listeners = new Set<() => void>();
/** Users whose flag storage refused to keep: true for this page alone. */
const pageOnly = new Set<string>();

function readAgentFeedbackSent(userId: string | null | undefined): boolean {
  if (!userId) return false;
  if (pageOnly.has(userId)) return true;
  try {
    return window.localStorage.getItem(agentFeedbackSentStorageKey(userId)) === "1";
  } catch {
    return false;
  }
}

/** Records that `userId` sent an agent-drafted feedback card in this browser. */
export function markAgentFeedbackSent(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    window.localStorage.setItem(agentFeedbackSentStorageKey(userId), "1");
  } catch {
    pageOnly.add(userId);
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith(STORAGE_KEY_PREFIX)) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Whether `userId` has sent an agent-drafted feedback card in this browser (followed across tabs). */
export function useAgentFeedbackSent(userId: string | null | undefined): boolean {
  const read = useCallback(() => readAgentFeedbackSent(userId), [userId]);
  return useSyncExternalStore(subscribe, read, () => false);
}

/** Tests: forget flags held for the page alone. */
export function resetAgentFeedbackSentForTests(): void {
  pageOnly.clear();
}
