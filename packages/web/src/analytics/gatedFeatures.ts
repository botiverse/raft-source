// Gated features whose use leaves nothing on the server (tygg, 2026-11-08,
// #proj-o11y:a5f3094f; AndyLok counts them, Nova owns the registry): Drafts
// (the drafts live in this browser) and agent read progress (a display). The
// other gated features are counted from Postgres and traces
// (docs/analytics/product-events.md, "Gated features").
import type { ProductEventProperties } from "@botiverse/raft-shared";
import type { DraftPlace } from "../utils/draftPlaces";
import { currentRouteKind } from "../utils/draftPlaces";
import { trackEvent } from "./track";

type DraftCountBucket = ProductEventProperties<"drafts_page_viewed">["drafts"];
type ReadProgressShown = ProductEventProperties<"agent_read_progress_shown">;

export function draftCountBucket(count: number): DraftCountBucket {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  return count <= 5 ? "2-5" : "6+";
}

/** Once per opening of the Drafts page, with how many drafts it listed. */
export function trackDraftsPageViewed(count: number): void {
  trackEvent("drafts_page_viewed", { drafts: draftCountBucket(count) });
}

/** A row took the person to its conversation; only the kind of place goes out. */
export function trackDraftsItemOpened(place: DraftPlace): void {
  const kind = place.kind === "channel"
    ? (currentRouteKind(place.channelId, place.routeKind) === "dm" ? "dm" : "channel")
    : place.kind;
  trackEvent("drafts_item_opened", { place: kind });
}

/** Per page load: a conversation's faces, or its not-reaching line, count once. */
const readProgressShown = new Set<string>();

function readProgressPartShown(scopeId: string, part: ReadProgressShown["part"], conversation: ReadProgressShown["conversation"]): void {
  const key = `${part}:${scopeId}`;
  if (readProgressShown.has(key)) return;
  readProgressShown.add(key);
  trackEvent("agent_read_progress_shown", { part, conversation });
}

/**
 * What agent read progress has generated in one open conversation now
 * (`scopeId` null: the feature is off there). Each part counts the first time
 * it is generated: a face placed on a loaded row, or the line rendered,
 * whether or not it is scrolled into view (not an impression).
 */
export function trackAgentReadProgressShown(
  scopeId: string | null,
  conversation: ReadProgressShown["conversation"],
  shown: { faces: boolean; notReachingLine: boolean },
): void {
  if (!scopeId) return;
  if (shown.faces) readProgressPartShown(scopeId, "faces", conversation);
  if (shown.notReachingLine) readProgressPartShown(scopeId, "not_reaching_line", conversation);
}

export function resetGatedFeatureTrackingForTests(): void {
  readProgressShown.clear();
}
