import { useSyncExternalStore } from "react";

// Whether the in-app feedback list's first page is waiting out a degraded
// answer (Hands briefly unavailable, server #12566). The transport sets it;
// the feedback panel shows "Feedback can't load right now. Retrying…".
const listeners = new Set<() => void>();
let degraded = false;

export function setFeedbackListDegraded(next: boolean) {
  if (degraded === next) return;
  degraded = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useFeedbackListDegraded(): boolean {
  return useSyncExternalStore(subscribe, () => degraded, () => false);
}
