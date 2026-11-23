import type { MouseEvent as ReactMouseEvent } from "react";
import type { ObjectInboxItem } from "@botiverse/raft-shared";
import { canOpenObjectWindows, openObjectWindow } from "../../features/objectWindows";
import { ARTIFACT_MINI_WINDOW_FLAG_KEY, useServerFeatureFlag } from "../../store/serverFeatureFlags";

import { artifactActivityTarget } from "./artifactActivityRow";
import type { ArtifactOpenSource } from "./artifactAnalytics";
import type { ArtifactLinkTarget } from "./artifactLinks";
import { rememberArtifactCard } from "./artifactOpenIntent";

/**
 * The Artifact mini window (#337 PR3; xxchan and Kirby): in Raft Desktop with
 * artifact_mini_window_v0 on, an Artifact opens in an object window of its
 * own (features/objectWindows), its viewer there (ArtifactObjectWindow.tsx).
 *
 * - "Open in new page" (a message card's ↗, the viewer's ⋯, the Artifacts
 *   home's row menu) becomes "Open in new window", with a window icon, and
 *   opens it in the object window; a plain click on an Artifacts home row
 *   does too. A message card's plain click stays in place.
 * - One window is reused: a plain open replaces the Artifact of the last
 *   window opened that way and raises it; Cmd/Ctrl-click (isNewWindowClick)
 *   opens another. The OS manages the windows.
 *
 * A browser, an older shell or the flag off: none of this, each opener does
 * what it did (openArtifactInWindow answers false). An opener decides with the
 * answer its label was drawn with (useArtifactMiniWindows, passed as `enabled`),
 * so what it says and what it does never differ (the flag's hold after an
 * on -> off re-read included).
 */
export const ARTIFACT_OBJECT_WINDOW_KIND = "artifact";

/** What an Artifact window shows: the Artifact at a version (null: the latest), and what opened it (`artifact_opened`). */
export interface ArtifactWindowPayload {
  target: ArtifactLinkTarget;
  source: ArtifactOpenSource;
}

/** Whether Artifacts open in windows of their own here: Raft Desktop hosting object windows, the flag on (as shown). */
export function useArtifactMiniWindows(): boolean {
  const flag = useServerFeatureFlag(ARTIFACT_MINI_WINDOW_FLAG_KEY);
  return canOpenObjectWindows() && flag.enabled;
}

/** A click that asks for another window: Cmd (macOS) or Ctrl with the primary button, no Shift or Alt. */
export function isNewWindowClick(event: Pick<ReactMouseEvent | MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">): boolean {
  return event.button === 0 && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey;
}

export interface OpenArtifactWindowOptions {
  /** useArtifactMiniWindows() as the opener drew its label: false, and nothing opens. */
  enabled: boolean;
  source: ArtifactOpenSource;
  /** Another window, not the reused one (Cmd/Ctrl-click). */
  additional?: boolean;
  /** The row or button it was opened from: focus goes back there when the window closes. */
  from?: Element | null;
  /** The window's first title, until the viewer names it. */
  title?: string;
}

/**
 * Open `target` in an Artifact window: true when it shows in one, false when
 * the caller shows it its usual way (no object windows here, the flag off,
 * eight already open, the shell refused the window).
 */
export function openArtifactInWindow(target: ArtifactLinkTarget, { enabled, source, additional = false, from = null, title }: OpenArtifactWindowOptions): boolean {
  if (!enabled) return false;
  const payload: ArtifactWindowPayload = { target: { id: target.id, version: target.version }, source };
  return openObjectWindow(ARTIFACT_OBJECT_WINDOW_KIND, payload, { additional, from, title });
}

/** An object window's payload, if it is an Artifact window's (the store keeps it as `unknown`). */
export function artifactWindowPayloadOf(payload: unknown): ArtifactWindowPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { target, source } = payload as Partial<ArtifactWindowPayload>;
  if (!target || typeof target.id !== "string" || (target.version !== null && typeof target.version !== "number")) return null;
  return { target, source: source ?? "other" };
}

/**
 * An Artifacts home row's or tile's Cmd/Ctrl-click where Artifacts open in windows: another Artifact window, the
 * latest version, its focus given back to the row when it closes. True when it opened one (the click is handled).
 */
export function openInAnotherWindow(event: ReactMouseEvent<HTMLElement>, card: { id: ArtifactLinkTarget["id"]; title: string }, enabled: boolean): boolean {
  if (!isNewWindowClick(event)) return false;
  if (!openArtifactInWindow({ id: card.id, version: null }, { enabled, source: "all", additional: true, from: event.currentTarget, title: card.title })) return false;
  event.preventDefault();
  return true;
}

/**
 * An Artifact's Activity row Cmd/Ctrl-clicked where Artifacts open in windows: another Artifact window (its
 * `artifact_opened` is `activity`), focus back to the row when it closes; the row's card is the viewer's head until its
 * data is in. True when it opened one (the row opens nothing else).
 */
export function openActivityRowInAnotherWindow(event: Pick<ReactMouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & { currentTarget: Element }, item: ObjectInboxItem<"artifact">, enabled: boolean): boolean {
  if (!enabled || !isNewWindowClick(event)) return false;
  const target = artifactActivityTarget(item);
  if (!target) return false;
  if (item.summary) rememberArtifactCard(item.summary);
  return openArtifactInWindow(target, { enabled, source: "activity", additional: true, from: event.currentTarget, title: item.summary?.title });
}
