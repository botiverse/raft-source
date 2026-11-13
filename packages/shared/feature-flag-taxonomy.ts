/**
 * Narrow Feature Flag Admin import leaf. Keep the operator app from importing
 * the shared package root (and its server-facing exports) merely to decide
 * which Slack Bridge product capabilities are visible.
 */
export const SLACK_BRIDGE_PRODUCT_FEATURE_FLAG_KEYS = {
  bridge: "slack_bridge_v0",
} as const;

/** Old rows stay in storage during rolling upgrades but are not operator switches. */
export const SLACK_BRIDGE_RETIRED_FEATURE_FLAG_KEYS = [
  "slack_attachment_transfer",
  "slack_reaction_sync",
] as const;
