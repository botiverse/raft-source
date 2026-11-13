import { useCallback, useSyncExternalStore } from "react";

/**
 * Deep links v1: where a phone's "Open in the Raft app" row goes when the
 * page has a composer. The row sits directly above whatever holds the bottom
 * of the page, within thumb reach. Above the tab bar that is the shell's own
 * bottom strip (ShellFrame `bottomStrip`); above a composer it has to be
 * inside the panel that owns the composer, so a conversation's and a thread's
 * footer each start with a slot (OpenInAppRowSlot) and the row is drawn in
 * the newest one mounted: the thread's while a thread covers its
 * conversation, the conversation's again once it closes. In the page's flow
 * in both places, so it never covers a message.
 */
const slots: HTMLElement[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function registerOpenInAppRowSlot(element: HTMLElement): () => void {
  slots.push(element);
  notify();
  return () => {
    const index = slots.lastIndexOf(element);
    if (index >= 0) slots.splice(index, 1);
    notify();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function newestSlot(): HTMLElement | null {
  return slots.at(-1) ?? null;
}

function noSlot(): null {
  return null;
}

/** A callback ref for a slot's element (React 19 ref cleanup). */
export function useOpenInAppRowSlotRef(): (element: HTMLElement | null) => (() => void) | undefined {
  return useCallback((element: HTMLElement | null) => (element ? registerOpenInAppRowSlot(element) : undefined), []);
}

/** The newest mounted slot, or null on a page without a composer. */
export function useOpenInAppRowSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, newestSlot, noSlot);
}
