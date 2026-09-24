export const SLACK_BRIDGE_PRODUCTION_PUBLIC_ORIGIN = "https://api.raft.build" as const;

export const SLACK_BRIDGE_PRODUCTION_OAUTH_REDIRECT_URI =
  `${SLACK_BRIDGE_PRODUCTION_PUBLIC_ORIGIN}/api/slack-bridge/oauth/callback` as const;

export const SLACK_BRIDGE_PRODUCTION_EVENTS_REQUEST_URL =
  `${SLACK_BRIDGE_PRODUCTION_PUBLIC_ORIGIN}/api/slack-bridge/events` as const;

export const SLACK_BRIDGE_STAGING_PUBLIC_ORIGIN =
  "https://api-aws-staging.botiverse.dev" as const;

export const SLACK_BRIDGE_STAGING_OAUTH_REDIRECT_URI =
  `${SLACK_BRIDGE_STAGING_PUBLIC_ORIGIN}/api/slack-bridge/oauth/callback` as const;

export const SLACK_BRIDGE_STAGING_EVENTS_REQUEST_URL =
  `${SLACK_BRIDGE_STAGING_PUBLIC_ORIGIN}/api/slack-bridge/events` as const;

/** Scopes consumed by the currently implemented bridge. */
export const SLACK_BRIDGE_ACTIVE_BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "groups:history",
  "groups:read",
  "users:read",
] as const;

/** Product-confirmed follow-up capabilities authorized at initial install. */
export const SLACK_BRIDGE_PREAUTHORIZED_BOT_SCOPES = [
  "files:read",
  "files:write",
  "reactions:read",
  "reactions:write",
] as const;

/** Exact scope set requested on every new production-compatible install. */
export const SLACK_BRIDGE_REQUIRED_BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.customize",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "reactions:read",
  "reactions:write",
  "users:read",
] as const;

export const SLACK_BRIDGE_REQUIRED_BOT_EVENTS = [
  "app_uninstalled",
  "channel_archive",
  "channel_deleted",
  "file_shared",
  "group_archive",
  "group_deleted",
  "message.channels",
  "message.groups",
  "reaction_added",
  "reaction_removed",
  "tokens_revoked",
] as const;

export const SLACK_BRIDGE_PREAUTHORIZED_CAPABILITIES = [
  {
    id: "attachment_transfer",
    defaultEnabled: false,
    scopes: ["files:read", "files:write"],
    events: ["file_shared", "message.channels", "message.groups"],
    disabledBehavior: "caption_marker_only",
  },
  {
    id: "reaction_sync",
    defaultEnabled: false,
    scopes: ["reactions:read", "reactions:write"],
    events: ["reaction_added", "reaction_removed"],
    disabledBehavior: "durable_discard_receipt",
  },
  {
    id: "message_edit_delete_sync",
    defaultEnabled: false,
    scopes: ["channels:history", "groups:history"],
    events: ["message.channels", "message.groups"],
    disabledBehavior: "durable_discard_receipt",
  },
] as const;

export const SLACK_BRIDGE_PRODUCTION_APP_OPERATOR_POLICY = {
  // Public Distribution is required for an OAuth install to target a workspace
  // other than the App's associated development workspace. The App remains
  // unlisted (not published in the Slack Marketplace), and each workspace
  // still applies its own administrator approval policy.
  distribution: "unlisted_public_oauth",
  tokenRotation: "off",
  pkce: "off",
  socketMode: "off",
  orgDeploy: "off",
  interactivity: "off",
} as const;
