import type { MouseEvent } from "react";
import type { ArtifactCard } from "@botiverse/raft-shared";

import type { ArtifactOpenSource } from "./artifactAnalytics";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { rememberArtifactCard } from "./artifactOpenIntent";
import { findArtifactPlace, setArtifactReturnFocus, useArtifactViewerStore } from "./artifactViewerStore";
import type { ArtifactCommentsOpening } from "./artifactViewerStore";

/**
 * The one way an Artifact clicked inside Raft opens (#proj-workspace:#104,
 * Remy's rule): in the layout it was clicked in, never on its own page.
 * Every opener (a message's card, its chip in the text, "Saved as Artifact",
 * a Files row) calls this; where it shows is findArtifactPlace's: beside the
 * channel panel it belongs to, else the opener's own conversation
 * (`conversationId`, the Files card), else, in the app shell, over the dialog
 * it is in or beside the main area (ShellArtifactHost: a thread Activity
 * opened, Search, Saved). A new surface gets this without wiring anything.
 *
 * Returns false only outside the app shell (a public page, the Artifact's own
 * page): the link is then followed. `source` is what was clicked
 * (`artifact_opened`); in a conversation Activity opened (core's
 * `data-activity-detail`) it is `activity`. `comments`: opened on its comments
 * (a message card's), the list open.
 */
export function openArtifactInPlace(target: ArtifactLinkTarget, from: HTMLElement, source: ArtifactOpenSource, conversationId: string | null = null, comments?: ArtifactCommentsOpening): boolean {
  const place = findArtifactPlace(from, conversationId);
  if (!place) return false;
  setArtifactReturnFocus(from);
  const openedFrom = from.closest("[data-activity-detail]") ? "activity" : source;
  useArtifactViewerStore.getState().openArtifact({ ...target, ...place, source: openedFrom, ...(comments ? { comments } : {}) });
  return true;
}

/** A plain primary click: Cmd/Ctrl, Shift and middle clicks are the browser's own (a new tab or window: its own page). */
export function isPlainPrimaryClick(event: MouseEvent<HTMLElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey;
}

/**
 * What `artifact_opened` says for an Artifact opened from its chip in a
 * message's text: `message_chip`, beside `message_card` for the card under the
 * message (Remy, #proj-workspace:fbc76200; docs/analytics/product-events.md).
 * In a conversation Activity opened it is `activity`, as for any opener.
 */
export const ARTIFACT_CHIP_OPEN_SOURCE: ArtifactOpenSource = "message_chip";

/**
 * A click on an Artifact link (its chip in a message's text, "Saved as
 * Artifact"): a plain primary click opens it in place (openArtifactInPlace)
 * instead of following the link, whose address is the Artifact's page
 * (`artifactUrl`), what Cmd/Ctrl, Shift and middle clicks open. The chip and
 * the card are separate elements, each with its own click: one click opens once.
 */
export function openArtifactOnPlainClick(event: MouseEvent<HTMLElement>, target: ArtifactLinkTarget, source: ArtifactOpenSource = ARTIFACT_CHIP_OPEN_SOURCE): void {
  if (!isPlainPrimaryClick(event)) return;
  if (openArtifactInPlace(target, event.currentTarget, source)) event.preventDefault();
}

/**
 * A message's Artifact card (ArtifactMessageCard): in place, at its pinned
 * version, its card the viewer's header until its data is in. With comments
 * new to the reader, or from its comment count (`toComments`), on its
 * comments: the list open, on the first new one (xxchan, #proj-workspace:72934211).
 */
export function openArtifactCardInPlace(card: ArtifactCard, from: HTMLElement, toComments = false): boolean {
  rememberArtifactCard(card);
  const firstNew = card.unseen && card.unseen.newComments > 0 ? card.unseen.firstNewComment ?? null : null;
  const comments = toComments || firstNew !== null ? { at: firstNew } : undefined;
  return openArtifactInPlace({ id: card.id, version: card.pinned ? card.version : null }, from, "message_card", null, comments);
}
