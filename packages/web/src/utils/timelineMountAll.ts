import { useSyncExternalStore } from "react";

// Asks every virtual timeline to mount all of its rows for a while (raft-ui
// VirtualList with `virtual` off: every row in flow, the row at the top of the
// view kept in place). For work that needs the rows of messages far from the
// view in the DOM, such as "Share as image" of a selection the reader
// scrolled through: the virtual timeline mounts only the rows near the view.
// raft-ui keeps rows mounted only for focus and the text selection, so this
// is the timeline's own. Requests are counted; the last release goes back to
// mounting only the rows near the view.

let requests = 0;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Mount every row of every virtual timeline until the returned release is called (once). */
export function requestAllTimelineRowsMounted(): () => void {
  requests += 1;
  if (requests === 1) emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    requests -= 1;
    if (requests === 0) emit();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): boolean {
  return requests > 0;
}

export function useAllTimelineRowsMounted(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
