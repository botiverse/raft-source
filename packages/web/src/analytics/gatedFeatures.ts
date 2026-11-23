// Gated features whose use leaves nothing on the server (tygg, 2026-11-08,
// #proj-o11y:a5f3094f; AndyLok counts them, Nova owns the registry): Drafts
// (the drafts live in this browser). The other gated features are counted
// from Postgres and traces (docs/analytics/product-events.md, "Gated features").
import type { ProductEventProperties } from "@botiverse/raft-shared";
import type { DraftPlace } from "../utils/draftPlaces";
import { currentRouteKind } from "../utils/draftPlaces";
import { trackEvent } from "./track";

type DraftCountBucket = ProductEventProperties<"drafts_page_viewed">["drafts"];

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
