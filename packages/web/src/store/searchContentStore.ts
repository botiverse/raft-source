import { create } from "zustand";
import { registerServerReset } from "./serverResetRegistry";

// Picked entity for the /search page's master/detail layout.
//
// Per stdrc #proj-uiux:c2313b1d task #311 msg=b61ab472 (2026-05-26): Search
// becomes a 3-column surface like Chat. Column count mirrors chat exactly
// per msg=23857aa4 — search must show the same N columns at every viewport
// breakpoint as chat does:
//   col 1 = LeftRail
//   col 2 = MessageSearchPage (input + results list) — peer of chat sidebar
//   col 3 = picked entity (channel / DM / agent / human / machine / **thread**)
//   col 4 = right-panel overlays (thread / profile opened from inside col 3)
//
// Thread-as-search-hit (stdrc msg=54304d0e) goes **directly into col 3**,
// not into col 4. col 4 only appears when the user is inside col 3 channel
// and opens a thread from there — same as chat-mode.
//
// `messageId` is the scroll/highlight anchor and is valid for:
//   - kind="channel": scroll to the matched message in the channel
//   - kind="dm":      scroll to the matched message in the DM (was a bug
//                     previously misclassified as kind="channel")
//   - kind="thread":  scroll to the matched reply inside the thread
// Not meaningful for kind="agent" / "human" / "machine" (entity pages, no msg anchor).
// Mirrored to URL as `?open=<kind>:<id>&msg=<msgId>` — `&msg=` is the
// existing channel-scope permalink param, reused uniformly here.

export type SearchContentKind = "channel" | "dm" | "agent" | "human" | "machine" | "thread";

export interface SearchContentSlot {
  kind: SearchContentKind;
  id: string;
  // Optional scroll/highlight anchor; valid when kind is channel | dm | thread.
  messageId?: string;
}

interface SearchContentState {
  slot: SearchContentSlot | null;
  open: (slot: SearchContentSlot) => void;
  close: () => void;
  consumeMessageFocus: (kind: SearchContentKind, id: string) => void;
}

export const useSearchContentStore = create<SearchContentState>((set) => ({
  slot: null,
  open: (slot) => set({ slot }),
  close: () => set({ slot: null }),
  consumeMessageFocus: (kind, id) => set((state) => {
    if (
      !state.slot
      || state.slot.kind !== kind
      || state.slot.id !== id
      || !state.slot.messageId
    ) return state;
    return { slot: { ...state.slot, messageId: undefined } };
  }),
}));

registerServerReset(() => {
  useSearchContentStore.setState({ slot: null });
});

// Parse `?open=` value into a slot. Returns null on malformed input.
export function parseSearchOpenParam(value: string | null): SearchContentSlot | null {
  if (!value) return null;
  const colon = value.indexOf(":");
  if (colon <= 0 || colon === value.length - 1) return null;
  const kind = value.slice(0, colon);
  const id = value.slice(colon + 1);
  if (
    kind !== "channel"
    && kind !== "dm"
    && kind !== "agent"
    && kind !== "human"
    && kind !== "machine"
    && kind !== "thread"
  ) return null;
  if (!id) return null;
  return { kind, id };
}

export function formatSearchOpenParam(slot: SearchContentSlot): string {
  return `${slot.kind}:${slot.id}`;
}
