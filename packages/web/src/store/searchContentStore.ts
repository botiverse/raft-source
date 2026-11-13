import { asArtifactReviewId, parseArtifactId } from "@botiverse/raft-shared";
import type { ArtifactCommentId, ArtifactReviewId } from "@botiverse/raft-shared";

import { useUIStore } from "./uiStore";
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
//
// kind="artifact" is an Artifact opened from its Activity row (xxchan, Remy):
// the viewer in the detail slot beside the list, as a conversation row opens
// its conversation. `version` pins the version the row is about (`&version=`),
// else the latest; `review` (`&review=`) the review (S8) a review's row is
// about, whose comments the viewer shows. `comment` is the comment a comment's
// row is about, which the viewer lands on (#proj-workspace:#82); not in the
// address: a landing is the opening's, as a jump is. An Artifact's slot is not
// written as `?open=artifact:<id>` any more but as the one Artifact address
// (`?artifact=<id>`, `&version=`, `&review=`: components/layout/
// artifactOpenAddress.ts, #proj-workspace:#240); parseSearchOpenParam still
// reads the retired form, which the URL sync replaces in place.
//
// kind="task" is a task conversation opened from its Activity row or a Search
// hit (stdrc): the task in the detail slot, not its dialog. `id` is the task's
// id, so a task opened from inside it (a task ref) is the slot too, with or
// without a conversation yet; the task itself rides in threadStore's
// `taskModal` slot and its own `?task=` param (useRightPanelUrlSync), which
// restore it on reload beside `?open=task:<taskId>`. Search's carries the hit
// opened in `messageId` (`&msg=`), so that hit stays the selected result; the
// focus in the task itself is the taskModal's.

export type SearchContentKind = "channel" | "dm" | "agent" | "human" | "machine" | "thread" | "artifact" | "task";

export interface SearchContentSlot {
  kind: SearchContentKind;
  id: string;
  // Optional scroll/highlight anchor; valid when kind is channel | dm | thread (task: Search's hit).
  messageId?: string;
  // The pinned version; valid when kind is artifact (absent: the latest).
  version?: number;
  // The review whose comments it shows; valid when kind is artifact (absent: all of them).
  review?: ArtifactReviewId;
  // The comment it lands on; valid when kind is artifact (absent: none).
  comment?: ArtifactCommentId;
}

interface SearchContentState {
  slot: SearchContentSlot | null;
  /** Counts opens: names the jump to the slot's `messageId`, so opening the
   *  same message again restarts its located highlight (states.md#located). */
  openNonce: number;
  open: (slot: SearchContentSlot) => void;
  close: () => void;
  consumeMessageFocus: (kind: SearchContentKind, id: string) => void;
}

export const useSearchContentStore = create<SearchContentState>((set) => ({
  slot: null,
  openNonce: 0,
  open: (slot) => {
    useUIStore.getState().restoreThreadLayout();
    set((state) => ({ slot, openNonce: state.openNonce + 1 }));
  },
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
    && kind !== "artifact"
    && kind !== "task"
  ) return null;
  if (!id) return null;
  // An Artifact's slot names a bare Artifact id, `pt_…` as its row does (a short id is read as that).
  if (kind === "artifact") {
    const artifactId = parseArtifactId(id);
    return artifactId === null ? null : { kind, id: artifactId };
  }
  return { kind, id };
}

export function formatSearchOpenParam(slot: SearchContentSlot): string {
  return `${slot.kind}:${slot.id}`;
}

/** The param an Artifact slot's pinned version rides in, beside `?artifact=<id>` (and the retired `?open=artifact:<id>`). */
export const SEARCH_OPEN_VERSION_PARAM = "version";

/** The param an Artifact slot's review rides in, beside `?artifact=<id>` (and the retired `?open=artifact:<id>`). */
export const SEARCH_OPEN_REVIEW_PARAM = "review";

/**
 * An Artifact slot's `&review=`: an opaque id (the server's uuid) of 1 to 64 `A-Z a-z 0-9 _ -`,
 * minted here, where the address is checked; else none. The server answers one that isn't a
 * review of the Artifact with `review: null` (the list says so).
 */
export function parseSearchOpenReview(value: string | null): ArtifactReviewId | undefined {
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? asArtifactReviewId(value) : undefined;
}

/** An Artifact slot's `&version=`: a positive integer in decimal, else none (the latest). */
export function parseSearchOpenVersion(value: string | null): number | undefined {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const version = Number(value);
  return Number.isSafeInteger(version) ? version : undefined;
}
