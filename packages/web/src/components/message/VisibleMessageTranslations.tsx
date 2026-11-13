import { useMemo, useState, useSyncExternalStore } from "react";
import type { Message } from "../../store/messageStore";
import { useTranslationBatch } from "../../hooks/useTranslationBatch";

// The rows a timeline currently shows (plus its lookahead), for read-side
// enrichment such as translation. It changes while the reader scrolls, so it
// lives in a small store owned by the panel instead of the panel's React
// state: only the subscriber below re-renders when it changes, never the
// whole chat/thread panel (which re-rendered the composer and every other
// child on each change of the window).

export type VisibleMessageWindowStore = {
  /** Stable identity: pass it straight to `onVisibleMessageWindowChange`. */
  readonly set: (messageIds: readonly string[]) => void;
  readonly get: () => readonly string[];
  readonly subscribe: (listener: () => void) => () => void;
};

const NO_IDS: readonly string[] = [];

export function createVisibleMessageWindowStore(): VisibleMessageWindowStore {
  let ids = NO_IDS;
  let key = "";
  const listeners = new Set<() => void>();
  return {
    set(messageIds) {
      const nextKey = messageIds.join("|");
      if (nextKey === key) return;
      key = nextKey;
      ids = messageIds.length > 0 ? [...messageIds] : NO_IDS;
      for (const listener of listeners) listener();
    },
    get: () => ids,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** One store per mounted panel. */
export function useVisibleMessageWindowStore(): VisibleMessageWindowStore {
  const [store] = useState(createVisibleMessageWindowStore);
  return store;
}

/**
 * Requests translations for the messages in the panel's visible window
 * (`leading`, when given, is always included first: a thread's parent).
 * Renders nothing; it exists so the window subscription re-renders only it.
 */
export function VisibleMessageTranslations({
  store,
  messages,
  leading = null,
}: {
  store: VisibleMessageWindowStore;
  messages: readonly Message[];
  leading?: Message | null;
}) {
  const visibleIds = useSyncExternalStore(store.subscribe, store.get, store.get);
  const translationMessages = useMemo(() => {
    const idSet = new Set(visibleIds);
    const visible = visibleIds.length > 0 ? messages.filter((message) => idSet.has(message.id)) : [];
    return leading ? [leading, ...visible] : visible;
  }, [leading, messages, visibleIds]);
  useTranslationBatch(translationMessages);
  return null;
}
