import { z } from "zod";

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

const opaqueIdSchema = z.string().trim().min(1).max(256);
const positiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const slackBridgeChannelPairSchema = z.strictObject({
  raftChannelId: opaqueIdSchema,
  slackChannelId: opaqueIdSchema,
});

const slackBridgeSnapshotChannelPairSchema = slackBridgeChannelPairSchema.extend({
  bindingEpoch: positiveSafeIntegerSchema.optional(),
});

export const slackBridgeChannelPairRemovalSchema = slackBridgeChannelPairSchema.extend({
  expectedBindingEpoch: positiveSafeIntegerSchema,
});

export const slackBridgePreflightSchema = z.strictObject({
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
});

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

export const slackBridgeRawHealthSchema = z.strictObject({
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
  })).max(500),
  audiences: z.array(z.strictObject({
    bindingId: opaqueIdSchema,
    status: z.enum(["matched", "mismatch", "unavailable"]),
  })).max(500),
  lastVerifiedAt: z.string().datetime({ offset: true }).nullable(),
  failingSurface: z.enum([
    "install",
    "credential",
    "binding",
    "audience",
    "connection",
    "scope",
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
});

export const slackBridgeSetupSnapshotSchema = z.strictObject({
  stage: z.enum(SLACK_BRIDGE_SETUP_STAGES),
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
  rawHealth: slackBridgeRawHealthSchema,
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
});

export const slackBridgeOAuthAuthoritySchema = z.strictObject({
  registrationId: z.string().uuid(),
  serverGrantId: z.string().uuid(),
  grantEpoch: positiveSafeIntegerSchema,
});

/**
 * Versioned read/mutation response shared by Server and Web. OAuth authority
 * stays outside the render snapshot: the adapter may return it to the existing
 * `/oauth/start` endpoint, while the component cannot render or reinterpret it.
 */
export const slackBridgeProvisioningResponseSchema = z.strictObject({
  protocolVersion: z.literal(SLACK_BRIDGE_PROVISIONING_PROTOCOL_VERSION),
  snapshot: slackBridgeSetupSnapshotSchema,
  oauthAuthority: slackBridgeOAuthAuthoritySchema.nullable(),
}).superRefine((response, ctx) => {
  if (response.snapshot.stage === "oauth" && response.oauthAuthority === null) {
    ctx.addIssue({
      code: "custom",
      path: ["oauthAuthority"],
      message: "OAuth stage requires current server-grant authority",
    });
  }
});

export const slackBridgeChannelPairsRequestSchema = z.strictObject({
  pairs: oneToOnePairsSchema(1),
});

export const slackBridgeChannelPairRemovalsRequestSchema = z.strictObject({
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
});

export const slackBridgeDisconnectRequestSchema = z.strictObject({
  expectedConnectionEpoch: positiveSafeIntegerSchema,
});

export const slackBridgeOAuthStartResponseSchema = z.strictObject({
  authorizationUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
  expiresAt: z.string().datetime({ offset: true }),
});

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
