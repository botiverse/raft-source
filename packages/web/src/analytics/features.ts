// `feature_action`: one event for every feature in the feature map (cindyz,
// #proj-analytics:4dc6995c; Nova owns the registry). A feature is tracked by
// calling this where it opens and where it completes; the dashboard's feature
// file says what counts as using it.
import type { ProductEventProperties, ProductFeature } from "@botiverse/raft-shared";
import { trackEvent } from "./track";

type FeatureAction = ProductEventProperties<"feature_action">;

/** `options.serverId` pins the server for a step that completes after a wait (the current one otherwise). */
export function trackFeature(
  feature: ProductFeature,
  action: FeatureAction["action"],
  details: Omit<FeatureAction, "feature" | "action"> = {},
  options: { serverId?: string } = {},
): void {
  trackEvent("feature_action", { feature, action, ...details }, options);
}
