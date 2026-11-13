import { create } from "zustand";
import { registerServerReset } from "./serverResetRegistry";

// The search hit a person opened (task #83): the message a search result
// jumped to keeps the query's words marked in the conversation (MessageItem,
// same matcher as the result rows). Transient client state, keyed by message
// id: the query is not written to the conversation's URL.
//
// Lifetime: set when a message result is opened (col 3 of /search, or in chat
// from the ⌘K overlay / a conversation's own search). It clears
//   - when the person leaves that conversation: `anchors` say what the URL
//     shows while the opened conversation is on screen (`?open=channel:<id>`
//     in col 3 of /search, a `/channel/<id>` path in chat, `?thread=<parent
//     channel>:<parent>` for a thread in chat, ...). Once the URL has shown
//     one and then no longer does, the mark goes (closing the result, Back,
//     another conversation, opening search again);
//   - when the jump never lands: a mark whose anchors the URL does not show
//     yet expires on the next URL change that still does not show them (a
//     navigation the unsaved-draft prompt cancelled, then going elsewhere);
//   - when they start a new search (edit the query), or open another result;
//   - on a server switch.

export type SearchHitAnchor =
  /** A route segment followed by its id: `/channel/<id>`, `/dm/<id>`. */
  | { route: "channel" | "dm"; id: string }
  /** A search param with this exact value: `open=thread:<id>`, `thread=<ch>:<msg>`. */
  | { param: "open" | "thread"; value: string };

export interface SearchHitMark {
  messageId: string;
  query: string;
  anchors: readonly SearchHitAnchor[];
  /** The URL has shown an anchor since the mark was set. */
  seen: boolean;
}

interface SearchHitMarkState {
  mark: SearchHitMark | null;
  /** `url` is the router location (`pathname + search`) at the open. */
  setMark: (mark: { messageId: string; query: string; anchors: readonly SearchHitAnchor[]; url: string }) => void;
  clear: () => void;
  /** Follows the router location (`pathname + search`): see the lifetime above. */
  syncWithUrl: (url: string) => void;
}

export function urlShowsSearchHitAnchor(url: string, anchors: readonly SearchHitAnchor[]): boolean {
  const parsed = new URL(url, "http://localhost");
  const segments = parsed.pathname.split("/").map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  return anchors.some((anchor) => {
    if ("param" in anchor) return parsed.searchParams.get(anchor.param) === anchor.value;
    return segments.some((segment, index) => segment === anchor.route && segments[index + 1] === anchor.id);
  });
}

export const useSearchHitMarkStore = create<SearchHitMarkState>((set, get) => ({
  mark: null,
  setMark: ({ messageId, query, anchors, url }) => {
    const trimmed = query.trim();
    if (!messageId || !trimmed || anchors.length === 0) {
      set({ mark: null });
      return;
    }
    // Opening the result already on screen leaves the URL as it is, so no
    // URL change would ever mark it seen: read it now.
    const seen = urlShowsSearchHitAnchor(url, anchors);
    set({ mark: { messageId, query: trimmed, anchors, seen } });
  },
  clear: () => {
    if (get().mark) set({ mark: null });
  },
  syncWithUrl: (url) => {
    const mark = get().mark;
    if (!mark) return;
    if (urlShowsSearchHitAnchor(url, mark.anchors)) {
      if (!mark.seen) set({ mark: { ...mark, seen: true } });
      return;
    }
    // Left the conversation, or the jump did not land on this change.
    set({ mark: null });
  },
}));

registerServerReset(() => {
  useSearchHitMarkStore.setState({ mark: null });
});
