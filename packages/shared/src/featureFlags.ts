export const AGENT_MIGRATION_FEATURE_FLAG_KEY = "agent_migration_v0";
/**
 * Legacy key. Kept as the fallback half of the dual read below — production may
 * still have it configured, and dropping it would silently disable anyone it is
 * enabled for. Removal is a separate decision, not this change.
 */
export const ACTIVITY_V2_FEATURE_FLAG_KEY = "activity_v2";

/**
 * Current key for the Activity sync-core cutover.
 *
 * INTERNAL IDENTIFIER ONLY — this string must never surface in the UI, route
 * titles, i18n or user-facing copy (@artin).
 */
export const ACTIVITY_SYNC_CORE_FEATURE_FLAG_KEY = "activity_sync_core";
export const APPLE_WEB_LOGIN_FEATURE_FLAG_KEY = "apple_web_login_v0";
export const CHAT_GRID_LAYOUT_FEATURE_FLAG_KEY = "chat_grid_layout_v0";
export const CHANNEL_MANAGER_ROLE_ACTIONS_FEATURE_FLAG_KEY = "channel_manager_role_actions_v0";
export const PROVIDER_CONNECTIONS_FEATURE_FLAG_KEY = "provider_connections_v0";
export const SERVER_LABS_UI_FEATURE_FLAG_KEY = "server_labs_ui_v0";
export const RUNTIME_ACCOUNT_USAGE_FEATURE_FLAG_KEY = "runtime_account_usage_v0";
export const THREAD_AGENT_FOLLOWER_MANAGEMENT_FEATURE_FLAG_KEY = "thread_agent_follower_management_v0";
export const SERVER_GUEST_FEATURE_FLAG_KEY = "server_guest_v0";
export const PUBLIC_SERVER_FEATURE_FLAG_KEY = "public_server_v0";
export const COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY = "composer_resource_references_v0";

export const SLACK_BRIDGE_FEATURE_FLAG_KEYS = {
  master: "slack_bridge_v0",
  directory: "external_projection_directory",
  binding: "slack_binding_control_plane",
  enqueue: "slack_outbound_enqueue",
  dispatch: "slack_provider_dispatch",
  customAuthorship: "slack_custom_authorship",
  nativeMention: "slack_native_mentions",
  threadDelivery: "slack_thread_delivery",
  privateBinding: "slack_private_binding",
  eventIngress: "slack_event_ingress",
  inboundProjection: "slack_inbound_projection",
  attachmentTransfer: "slack_attachment_transfer",
  reactionSync: "slack_reaction_sync",
} as const;

export type SlackBridgeFeatureFlagKey =
  (typeof SLACK_BRIDGE_FEATURE_FLAG_KEYS)[keyof typeof SLACK_BRIDGE_FEATURE_FLAG_KEYS];

export const TOPBAR_OVERFLOW_FEATURE_FLAG_KEY = "topbar_overflow_v0";
export * from "./featureFlagRolloutGuardrail.js";
