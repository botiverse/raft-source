// Product events of the Artifacts UI (RFC-067; xxchan, 2026-10-26,
// #proj-workspace:7c500d89; the registry's `artifact_*` entries). Fixed values
// only: never an Artifact's id, title, name, path or a comment's text. The
// UI renders only with workspace_artifacts_v0 on, and track.ts sends only
// where the person's "Share usage data" and the workspace allow it.
import type { ArtifactCommentAnchor, ArtifactViewerData, ProductEventProperties } from "@botiverse/raft-shared";

import { getProductEventServerId, trackEvent } from "../../analytics/track";

/**
 * The server an event that follows a request belongs to: the one current
 * when the request started (the reader may switch servers while it is out).
 * Take it before the request; pass it to the track call after.
 */
export const eventServer = (): { serverId?: string } => ({ serverId: getProductEventServerId() });

export type ArtifactOpenSource = ProductEventProperties<"artifact_opened">["source"];
export type ArtifactViewerSurface = ProductEventProperties<"artifact_opened">["surface"];
export type ArtifactViewerAction = ProductEventProperties<"artifact_viewer_action">["action"];
type CommentAnchor = ProductEventProperties<"artifact_comment_posted">["anchor"];
type FramedKind = ProductEventProperties<"artifact_frame_loaded">["kind"];

/** The viewer has loaded an Artifact, opened from `source`. */
/** The last opening `artifact_opened` reported (the side card's `openedAt`). */
let reportedOpening: number | null = null;

/**
 * `opening`: which opening this is, where the viewer outlives its mount (the
 * side card, kept open while the reader is in another channel and mounted
 * again on coming back): a remount of an opening already reported is not
 * another open.
 */
export function trackArtifactOpened(data: ArtifactViewerData, source: ArtifactOpenSource, surface: ArtifactViewerSurface, opening?: number): void {
  if (opening !== undefined) {
    if (opening === reportedOpening) return;
    reportedOpening = opening;
  }
  const { author } = data.card;
  trackEvent("artifact_opened", {
    source,
    kind: data.card.kind,
    is_author: author.type === data.viewer.type && author.id === data.viewer.id,
    surface,
  });
}

export function trackArtifactViewerAction(action: ArtifactViewerAction): void {
  trackEvent("artifact_viewer_action", { action });
}

/** A home-change confirmation (move, link sharing off / on): analytics/confirmUndo's event, which the app may not import. */
export type ArtifactConfirmDialog = Extract<ProductEventProperties<"confirm_dialog_closed">["dialog"], `artifact_${string}`>;

export function trackArtifactConfirmDialogClosed(dialog: ArtifactConfirmDialog, result: "confirmed" | "cancelled"): void {
  trackEvent("confirm_dialog_closed", { dialog, result });
}

/** Where a comment points, as the event says it (the anchor's type only, never its text or path). */
export function commentAnchorOf(target: { scope: "artifact" } | { scope: "file"; anchor: ArtifactCommentAnchor | null }): CommentAnchor {
  if (target.scope === "artifact") return "none";
  if (!target.anchor) return "file";
  return target.anchor.type === "page" ? "page_anchor" : "text";
}

export function mentionCountBucket(count: number): ProductEventProperties<"artifact_comment_posted">["mention_count_bucket"] {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  return count <= 3 ? "2-3" : "4+";
}

export function trackArtifactCommentPosted(input: { anchor: CommentAnchor; isReply: boolean; mentions: number }, at: { serverId?: string }): void {
  trackEvent("artifact_comment_posted", {
    anchor: input.anchor,
    is_reply: input.isReply,
    mention_count_bucket: mentionCountBucket(input.mentions),
  }, at);
}

/** A share target's kind as the event says it: a private channel is a channel. */
export function trackArtifactShared(input: { target: "channel" | "private" | "dm" | "thread"; withNote: boolean; widenTo: "server" | "public" | null }, at: { serverId?: string }): void {
  trackEvent("artifact_shared", {
    target: input.target === "private" ? "channel" : input.target,
    with_note: input.withNote,
    widen: input.widenTo ?? "none",
  }, at);
}

export function trackArtifactSavedFromAttachment(at: { serverId?: string }): void {
  trackEvent("artifact_saved_from_attachment", undefined, at);
}

// `artifact_imported` ({ via: "web" }) has no sender yet: the web has no
// import UI (the data source has no import call). CLI imports are counted
// from the server's import audit rows, never by client telemetry.

export function frameDurationBucket(ms: number): ProductEventProperties<"artifact_frame_loaded">["duration_bucket"] {
  if (ms < 500) return "<500ms";
  if (ms < 2000) return "500ms-2s";
  return ms <= 5000 ? "2-5s" : ">5s";
}

export function trackArtifactFrameLoaded(input: { result: ProductEventProperties<"artifact_frame_loaded">["result"]; kind: FramedKind; durationMs: number }): void {
  trackEvent("artifact_frame_loaded", { result: input.result, kind: input.kind, duration_bucket: frameDurationBucket(input.durationMs) });
}
