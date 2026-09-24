// Activity-surface telemetry (stdrc #proj-activity:171042a3 2026-06-25:
// "能从数据中分析用户点击 activity 的次数").
//
// The Activity-placement A/B (rail vs sidebar entry point) was REMOVED per
// stdrc 2026-06-30: Activity-on-the-LeftRail is now the unconditional default
// placement. There is no layout variant / PostHog `activity-layout` flag any
// more — Activity always lives on the rail (desktop) / under Chat (mobile).
//
// These helpers still emit product-analytics events through PostHog, just
// without the `variant` dimension. Like all analytics they no-op when PostHog
// is not configured (VITE_POSTHOG_KEY absent).
import { trackEvent } from "./posthog";

/** User opened the Activity surface (from rail or sidebar entry). */
export function trackActivityOpen(from: "rail" | "sidebar"): void {
  trackEvent("activity_open", { from });
}

/** User opened one item from the Activity list. */
export function trackActivityItemOpen(itemKind: string): void {
  trackEvent("activity_item_open", { item_kind: itemKind });
}

/** User marked an Activity item read / done. */
export function trackActivityMark(action: "read" | "done"): void {
  trackEvent("activity_mark", { action });
}
