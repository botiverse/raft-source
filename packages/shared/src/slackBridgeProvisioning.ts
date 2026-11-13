import { z } from "zod";
import { lazySchema } from "./lazySchema";


/** Why a held Slack delivery cannot be confirmed yet: Raft rechecks Slack every 15 minutes. */
export const SLACK_PAIR_CONFIRMATION_DETAILS = ["history_limited", "metadata_missing", "marker_unconfirmed"] as const;
export type SlackPairConfirmationDetail = (typeof SLACK_PAIR_CONFIRMATION_DETAILS)[number];

export const SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION = 1 as const;

export const SLACK_BRIDGE_SETUP_STAGES = [
  "connect",
  "oauth",
  "channels",
  "preflight",
  "enable",
  "health",
] as const;

export const SLACK_BRIDGE_PREFLIGHT_CHECK_IDS = [
  "oauth",
  "endpoint",
  "scope",
  "audience",
] as const;

const opaqueIdSchema = lazySchema("opaqueIdSchema", () => z.string().trim().min(1).max(256));
const positiveSafeIntegerSchema = lazySchema("positiveSafeIntegerSchema", () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export const slackBridgeChannelPairSchema = lazySchema("slackBridgeChannelPairSchema", () => z.strictObject({
  raftChannelId: opaqueIdSchema,
  slackChannelId: opaqueIdSchema,
}));

// Declared before the snapshot pair schema below, which is built while this
// module loads and refers to it.
/** Safe, additive setup diagnostics; never carries provider response bodies. */
export const slackBridgeProvisioningFailureReasonSchema = lazySchema("slackBridgeProvisioningFailureReasonSchema", () => z.enum([
  "privacy_mismatch",
  "not_member",
  "channel_unavailable",
  "provider_unavailable",
]));
export type SlackBridgeProvisioningFailureReason = z.infer<typeof slackBridgeProvisioningFailureReasonSchema>;

const slackBridgeSnapshotChannelPairSchema = lazySchema("slackBridgeSnapshotChannelPairSchema", () => slackBridgeChannelPairSchema.extend({
  bindingEpoch: positiveSafeIntegerSchema.optional(),
  /** Set when a saved pair no longer matches current channel authority. */
  invalidReason: slackBridgeProvisioningFailureReasonSchema.optional(),
}));

export const slackBridgeChannelPairRemovalSchema = lazySchema("slackBridgeChannelPairRemovalSchema", () => slackBridgeChannelPairSchema.extend({
  expectedBindingEpoch: positiveSafeIntegerSchema,
}));

export const slackBridgePreflightSchema = lazySchema("slackBridgePreflightSchema", () => z.strictObject({
  state: z.enum(["pending", "passed", "failed"]),
  checks: z.array(z.strictObject({
    id: z.enum(SLACK_BRIDGE_PREFLIGHT_CHECK_IDS),
    state: z.enum(["passed", "failed", "unverified"]),
  })).max(SLACK_BRIDGE_PREFLIGHT_CHECK_IDS.length),
}).superRefine((preflight, ctx) => {
  const seen = new Set<string>();
  for (let index = 0; index < preflight.checks.length; index += 1) {
    const check = preflight.checks[index]!;
    if (seen.has(check.id)) {
      ctx.addIssue({ code: "custom", path: ["checks", index, "id"], message: "Preflight check ids must be unique" });
    }
    seen.add(check.id);
  }
  if (
    preflight.state === "passed"
    && (
      seen.size !== SLACK_BRIDGE_PREFLIGHT_CHECK_IDS.length
      || preflight.checks.some((check) => check.state !== "passed")
    )
  ) {
    ctx.addIssue({ code: "custom", path: ["checks"], message: "Passed preflight requires the closed passed check set" });
  }
}));

function oneToOnePairsSchema(minimum: number) {
  return z.array(slackBridgeChannelPairSchema).min(minimum).max(500).superRefine((pairs, ctx) => {
    const raftIds = new Set<string>();
    const slackIds = new Set<string>();
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index]!;
      if (raftIds.has(pair.raftChannelId)) {
        ctx.addIssue({ code: "custom", path: [index, "raftChannelId"], message: "Raft channels must be unique" });
      }
      if (slackIds.has(pair.slackChannelId)) {
        ctx.addIssue({ code: "custom", path: [index, "slackChannelId"], message: "Slack channels must be unique" });
      }
      raftIds.add(pair.raftChannelId);
      slackIds.add(pair.slackChannelId);
    }
  });
}

/** RFC 082 §4.6: the kinds of a card message's Slack notice to its pair's admins. */
export const SLACK_CARD_EDIT_NOTICE_KINDS = ["not_confirmed", "latest_update_not_shown", "updates_cannot_be_shown", "edit_waiting"] as const;

export const slackBridgeRawHealthSchema = lazySchema("slackBridgeRawHealthSchema", () => z.strictObject({
  install: z.strictObject({
    state: z.enum([
      "pending",
      "active",
      "reauth_required",
      "disconnected",
      "revoked",
      "quarantined",
    ]),
    epochs: z.strictObject({
      grant: opaqueIdSchema,
      connection: opaqueIdSchema,
      scope: opaqueIdSchema,
      credential: opaqueIdSchema,
    }),
  }).nullable(),
  credential: z.strictObject({
    state: z.enum(["active", "persist_unknown", "revoked"]),
  }).nullable(),
  bindings: z.array(z.strictObject({
    id: opaqueIdSchema,
    state: z.enum(["active", "paused", "revoked", "quarantined"]),
    bindingEpoch: positiveSafeIntegerSchema,
    stateReason: z.string().trim().min(1).max(160).nullable(),
    recoveryAction: z.enum([
      "none",
      "unarchive_slack_channel",
      "select_replacement_slack_channel",
      "reinstall_slack_app",
      "reauthorize_slack_app",
      "migrate_slack_channel_audience",
      "review_and_resume_binding",
    ]),
  })).max(500),
  audiences: z.array(z.strictObject({
    bindingId: opaqueIdSchema,
    status: z.enum(["matched", "mismatch", "unavailable"]),
  })).max(500),
  lastVerifiedAt: z.string().datetime({ offset: true }).nullable(),
  agentMentionSync: z.strictObject({
    state: z.enum(["synced", "degraded"]),
    slackError: z.string().trim().min(1).max(160).nullable(),
    expected: z.number().int().min(0),
    actual: z.number().int().min(0),
    observedAt: z.string().datetime({ offset: true }),
  }).nullable(),
  attachmentSourceIssues: z.array(z.strictObject({
    raftChannelId: opaqueIdSchema,
    reason: z.enum(["unavailable", "size_mismatch"]),
  })).max(500).optional(),
  outboundDeliveries: z.array(z.strictObject({
    raftChannelId: opaqueIdSchema,
    bindingId: opaqueIdSchema,
    bindingEpoch: positiveSafeIntegerSchema,
    deliveryId: opaqueIdSchema,
    providerAttempts: positiveSafeIntegerSchema,
    state: z.enum(["dead", "outcome_unknown", "retry_wait"]),
    retryRequested: z.boolean(),
  })).max(500).optional(),
  outboundPairBlocks: z.array(z.strictObject({
    raftChannelId: opaqueIdSchema,
    bindingId: opaqueIdSchema,
    since: z.string().datetime({ offset: true }),
    nextRetryAt: z.string().datetime({ offset: true }).nullable(),
    reason: z.enum(["connection", "credentials", "configuration", "invite_app", "reauthorize", "unarchive", "check_channel"]),
    /** Negotiated separately because older setup clients parse strict objects. */
    action: z.literal("workspace_admin").optional(),
    /**
     * Why Raft cannot yet confirm whether the held message reached Slack (`reason` stays
     * "configuration" for older clients). Negotiated separately (`?confirmationHint=1`), as `action`.
     */
    detail: z.enum(SLACK_PAIR_CONFIRMATION_DETAILS).optional(),
  })).max(500).optional(),
  /**
   * RFC 082 §4.6: what a card message's Slack copy needs its pair's admins to
   * know, one entry per pair and kind (deduplicated across the pair's
   * messages): `not_confirmed` ("not confirmed in Slack", never "failed" or
   * "synced"; a card's unknown outcome at least T old), `latest_update_not_shown`
   * (Slack refused a card's current latest update), `updates_cannot_be_shown`
   * (the safe fallback for a stored card message that has files anyway: a send
   * with both is refused, so only a row stored before that, or by a path that
   * skipped it, has them), `edit_waiting` (a card's edit is held; `reason` is
   * its hint, as a pair block's). Each is present only while one of the pair's
   * cards qualifies. Only pairs the viewer can see. Negotiated separately
   * (`?cardEditNotices=1`).
   */
  cardEditNotices: z.array(z.strictObject({
    raftChannelId: opaqueIdSchema,
    bindingId: opaqueIdSchema,
    kind: z.enum(SLACK_CARD_EDIT_NOTICE_KINDS),
    reason: z.enum(["connection", "credentials", "configuration", "invite_app", "reauthorize", "unarchive", "check_channel"]).optional(),
    since: z.string().datetime({ offset: true }),
  })).max(2000).optional(),
  /** Negotiated separately for strict clients predating verified ingress. */
  inboundIsolated: z.array(z.strictObject({
    raftChannelId: opaqueIdSchema,
    bindingId: opaqueIdSchema,
    bindingEpoch: positiveSafeIntegerSchema,
    eventId: opaqueIdSchema,
    reason: z.string().regex(/^[a-z][a-z0-9_]{0,159}$/u),
    firstFailureAt: z.string().datetime({ offset: true }).nullable(),
    heldAt: z.string().datetime({ offset: true }).nullable(),
  })).max(500).optional(),
  inboundIsolatedSummary: z.strictObject({
    count: z.number().int().nonnegative().safe(),
    oldestFirstFailureAt: z.string().datetime({ offset: true }).nullable(),
    undisplayed: z.number().int().nonnegative().safe(),
  }).optional(),
  inboundIsolatedGroups: z.array(z.strictObject({
    raftChannelId: opaqueIdSchema,
    bindingId: opaqueIdSchema,
    bindingEpoch: positiveSafeIntegerSchema,
    reason: z.string().regex(/^[a-z][a-z0-9_]{0,159}$/u),
    count: z.number().int().positive().safe(),
  })).max(5000).optional(),
  failingSurface: z.enum([
    "install",
    "credential",
    "binding",
    "audience",
    "connection",
    "scope",
    "delivery",
  ]).nullable(),
}).superRefine((health, ctx) => {
  const bindingIds = new Set<string>();
  for (let index = 0; index < health.bindings.length; index += 1) {
    const id = health.bindings[index]!.id;
    if (bindingIds.has(id)) {
      ctx.addIssue({ code: "custom", path: ["bindings", index, "id"], message: "Binding ids must be unique" });
    }
    bindingIds.add(id);
  }

  const audienceBindingIds = new Set<string>();
  for (let index = 0; index < health.audiences.length; index += 1) {
    const bindingId = health.audiences[index]!.bindingId;
    if (!bindingIds.has(bindingId)) {
      ctx.addIssue({ code: "custom", path: ["audiences", index, "bindingId"], message: "Audience must reference a returned binding" });
    }
    if (audienceBindingIds.has(bindingId)) {
      ctx.addIssue({ code: "custom", path: ["audiences", index, "bindingId"], message: "Audience binding ids must be unique" });
    }
    audienceBindingIds.add(bindingId);
  }
  const isolatedIds = new Set<string>();
  for (const [index, group] of (health.inboundIsolatedGroups ?? []).entries()) {
    if (!health.bindings.some(row => row.id === group.bindingId && row.bindingEpoch === group.bindingEpoch)) {
      ctx.addIssue({ code: "custom", path: ["inboundIsolatedGroups", index, "bindingId"], message: "Held group must reference a returned binding epoch" });
    }
  }
  for (const [index, event] of (health.inboundIsolated ?? []).entries()) {
    const binding = health.bindings.find((row) => row.id === event.bindingId);
    if (!binding || binding.bindingEpoch !== event.bindingEpoch) {
      ctx.addIssue({ code: "custom", path: ["inboundIsolated", index, "bindingId"], message: "Held event must reference a returned binding epoch" });
    }
    if (isolatedIds.has(event.eventId)) {
      ctx.addIssue({ code: "custom", path: ["inboundIsolated", index, "eventId"], message: "Held event ids must be unique" });
    }
    isolatedIds.add(event.eventId);
  }
}));

export const slackBridgeSetupSnapshotSchema = lazySchema("slackBridgeSetupSnapshotSchema", () => z.strictObject({
  stage: z.enum(SLACK_BRIDGE_SETUP_STAGES),
  needsSlackReauthorization: z.boolean().optional(),
  workspaceName: z.string().trim().min(1).max(200).nullable(),
  raftChannels: z.array(z.strictObject({
    id: opaqueIdSchema,
    name: z.string().trim().min(1).max(200),
  })).max(500),
  slackChannels: z.array(z.strictObject({
    id: opaqueIdSchema,
    name: z.string().trim().min(1).max(200),
    privacyClass: z.enum(["public", "private"]).optional(),
    isMember: z.boolean().optional(),
  })).max(500),
  channelPairs: z.array(slackBridgeSnapshotChannelPairSchema).max(500).superRefine((pairs, ctx) => {
    const raftIds = new Set<string>();
    const slackIds = new Set<string>();
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index]!;
      if (raftIds.has(pair.raftChannelId)) {
        ctx.addIssue({ code: "custom", path: [index, "raftChannelId"], message: "Raft channels must be unique" });
      }
      if (slackIds.has(pair.slackChannelId)) {
        ctx.addIssue({ code: "custom", path: [index, "slackChannelId"], message: "Slack channels must be unique" });
      }
      raftIds.add(pair.raftChannelId);
      slackIds.add(pair.slackChannelId);
    }
  }),
  preflight: slackBridgePreflightSchema.nullable(),
  rawHealth: slackBridgeRawHealthSchema.nullable(),
}).superRefine((snapshot, ctx) => {
  const raftChannelIds = new Set<string>();
  for (let index = 0; index < snapshot.raftChannels.length; index += 1) {
    const id = snapshot.raftChannels[index]!.id;
    if (raftChannelIds.has(id)) {
      ctx.addIssue({ code: "custom", path: ["raftChannels", index, "id"], message: "Raft channel ids must be unique" });
    }
    raftChannelIds.add(id);
  }

  const slackChannelIds = new Set<string>();
  for (let index = 0; index < snapshot.slackChannels.length; index += 1) {
    const id = snapshot.slackChannels[index]!.id;
    if (slackChannelIds.has(id)) {
      ctx.addIssue({ code: "custom", path: ["slackChannels", index, "id"], message: "Slack channel ids must be unique" });
    }
    slackChannelIds.add(id);
  }

  for (let index = 0; index < snapshot.channelPairs.length; index += 1) {
    const pair = snapshot.channelPairs[index]!;
    if (!raftChannelIds.has(pair.raftChannelId)) {
      ctx.addIssue({ code: "custom", path: ["channelPairs", index, "raftChannelId"], message: "Pair must reference a returned Raft channel" });
    }
    if (!slackChannelIds.has(pair.slackChannelId)) {
      ctx.addIssue({ code: "custom", path: ["channelPairs", index, "slackChannelId"], message: "Pair must reference a returned Slack channel" });
    }
  }
}));

export const slackBridgeOAuthAuthoritySchema = lazySchema("slackBridgeOAuthAuthoritySchema", () => z.strictObject({
  registrationId: z.string().uuid(),
  serverGrantId: z.string().uuid(),
  grantEpoch: positiveSafeIntegerSchema,
}));

/**
 * Versioned read/mutation response shared by Server and Web. OAuth authority
 * stays outside the render snapshot: the adapter may return it to the existing
 * `/oauth/start` endpoint, while the component cannot render or reinterpret it.
 * It is null whenever the viewer may not start OAuth, including a read-only
 * member looking at the `oauth` stage; the Server refuses to send a manager
 * the `oauth` stage without it.
 */
export const slackBridgeProvisioningResponseSchema = lazySchema("slackBridgeProvisioningResponseSchema", () => z.strictObject({
  protocolVersion: z.literal(SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION),
  snapshot: slackBridgeSetupSnapshotSchema,
  oauthAuthority: slackBridgeOAuthAuthoritySchema.nullable(),
}));

export const slackBridgeChannelPairsRequestSchema = lazySchema("slackBridgeChannelPairsRequestSchema", () => z.strictObject({
  pairs: oneToOnePairsSchema(1),
}));

export const slackBridgeChannelPairRemovalsRequestSchema = lazySchema("slackBridgeChannelPairRemovalsRequestSchema", () => z.strictObject({
  pairs: z.array(slackBridgeChannelPairRemovalSchema).min(1).max(500).superRefine((pairs, ctx) => {
    const raftIds = new Set<string>();
    const slackIds = new Set<string>();
    for (let index = 0; index < pairs.length; index += 1) {
      const pair = pairs[index]!;
      if (raftIds.has(pair.raftChannelId)) {
        ctx.addIssue({ code: "custom", path: [index, "raftChannelId"], message: "Raft channels must be unique" });
      }
      if (slackIds.has(pair.slackChannelId)) {
        ctx.addIssue({ code: "custom", path: [index, "slackChannelId"], message: "Slack channels must be unique" });
      }
      raftIds.add(pair.raftChannelId);
      slackIds.add(pair.slackChannelId);
    }
  }),
}));

export const slackBridgeDisconnectRequestSchema = lazySchema("slackBridgeDisconnectRequestSchema", () => z.strictObject({
  expectedConnectionEpoch: positiveSafeIntegerSchema,
}));

export const slackBridgeOAuthStartResponseSchema = lazySchema("slackBridgeOAuthStartResponseSchema", () => z.strictObject({
  authorizationUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
  expiresAt: z.string().datetime({ offset: true }),
}));

export type SlackBridgeSetupStage = (typeof SLACK_BRIDGE_SETUP_STAGES)[number];
export type SlackBridgePreflightCheckId = (typeof SLACK_BRIDGE_PREFLIGHT_CHECK_IDS)[number];
export type SlackBridgeChannelPair = z.infer<typeof slackBridgeChannelPairSchema>;
export type SlackBridgeChannelPairRemoval = z.infer<typeof slackBridgeChannelPairRemovalSchema>;
export type SlackBridgeDisconnectRequest = z.infer<typeof slackBridgeDisconnectRequestSchema>;
export type SlackBridgePreflight = z.infer<typeof slackBridgePreflightSchema>;
export type SlackBridgeRawHealth = z.infer<typeof slackBridgeRawHealthSchema>;
export type SlackBridgeSetupSnapshot = z.infer<typeof slackBridgeSetupSnapshotSchema>;
export type SlackBridgeOAuthAuthority = z.infer<typeof slackBridgeOAuthAuthoritySchema>;
export type SlackBridgeProvisioningResponse = z.infer<typeof slackBridgeProvisioningResponseSchema>;
export type SlackBridgeChannelPairsRequest = z.infer<typeof slackBridgeChannelPairsRequestSchema>;
export type SlackBridgeChannelPairRemovalsRequest = z.infer<typeof slackBridgeChannelPairRemovalsRequestSchema>;
export type SlackBridgeOAuthStartResponse = z.infer<typeof slackBridgeOAuthStartResponseSchema>;

