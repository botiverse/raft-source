// Asks the live composer of one conversation to take focus. A notice stacked
// above the composer that goes away (the activation banner's Dismiss) hands
// focus to the next element, the composer's frame, so it never falls to the
// document (Raft Design System › Banner, Accessibility). The frame, not its
// field: focusing a textarea opens a phone's keyboard. Keyed by channelId, so
// a channel and an open thread panel each answer only for their own composer.

import { requestFocus } from "../../utils/focusRequest";
import type { FocusReason } from "../../utils/focusRequest";

type FrameGetter = () => HTMLElement | null;

// The composers mounted per conversation; the latest one mounted answers.
const composerFrames = new Map<string, FrameGetter[]>();

/** A composer registers its frame while mounted; call the returned function as it unmounts. */
export function registerComposerFocusTarget(channelId: string, getFrame: FrameGetter): () => void {
  const frames = composerFrames.get(channelId) ?? [];
  composerFrames.set(channelId, [...frames, getFrame]);
  if (awaited?.channelId === channelId) {
    const { wanted, until } = awaited;
    awaited = null;
    if (Date.now() <= until) focusUnlessInside(getFrame, wanted);
  }
  return () => {
    const rest = (composerFrames.get(channelId) ?? []).filter((frame) => frame !== getFrame);
    if (rest.length > 0) composerFrames.set(channelId, rest);
    else composerFrames.delete(channelId);
  };
}

export function requestComposerFocus(channelId: string, reason: FocusReason): void {
  requestFocus(() => composerFrames.get(channelId)?.at(-1)?.(), { reason });
}

/** How long requestComposerFocusOnceShown waits for the conversation's composer to be drawn. */
const AWAIT_COMPOSER_MS = 10_000;

/** The composer may hold focus already (its own autofocus as it mounted): then it stays in its field. */
function focusUnlessInside(getFrame: FrameGetter, wanted: () => boolean): void {
  const frame = getFrame();
  if (frame?.contains(frame.ownerDocument.activeElement) || !wanted()) return;
  requestFocus(getFrame, { reason: "user" });
}

let awaited: { channelId: string; wanted: () => boolean; until: number } | null = null;

/**
 * requestComposerFocus for a conversation the person just asked to open, whose
 * composer may not be drawn yet (a toast's View opening a DM): focuses it now if
 * it is there, else as it registers, within AWAIT_COMPOSER_MS. requestFocus
 * alone waits one frame, too short for a page that is still loading. `wanted`
 * is the press's watchFocusIntent (with `repeat`), asked again then: a press
 * of the person's own, or focus they moved, since means focus stays put.
 */
export function requestComposerFocusOnceShown(channelId: string, wanted: () => boolean): void {
  awaited = null;
  const latest = composerFrames.get(channelId)?.at(-1);
  if (latest) {
    focusUnlessInside(latest, wanted);
    return;
  }
  awaited = { channelId, wanted, until: Date.now() + AWAIT_COMPOSER_MS };
}
