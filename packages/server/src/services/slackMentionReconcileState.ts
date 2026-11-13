import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/).brand<"SlackMentionFingerprint">();
export type SlackMentionFingerprint = z.infer<typeof fingerprintSchema>;

// Persisted at the provider boundary, shared by every replica and Raft server.
export const slackMentionWriteFailuresSchema = z.array(z.object({
  fingerprint: fingerprintSchema,
  slackError: z.string(),
  retryAt: z.iso.datetime(),
}));
export type SlackMentionWriteFailures = z.infer<typeof slackMentionWriteFailuresSchema>;

export const slackHumanMentionSnapshotSchema = z.object({
  candidateSetHash: fingerprintSchema,
  nextAttemptAt: z.iso.datetime(),
  handles: z.array(z.object({ userId: z.string(), providerUsergroupId: z.string(), handle: z.string() })),
  failures: z.array(z.object({ userId: z.string(), slackError: z.string().nullable(), transient: z.boolean() })),
  cleanupFailures: z.array(z.object({ slackError: z.string().nullable() })),
});
export type SlackHumanMentionSnapshot = z.infer<typeof slackHumanMentionSnapshotSchema>;

export const SLACK_MENTION_FAILURE_BACKOFF_MS = 60 * 60_000;
export const SLACK_HUMAN_RECONCILE_INTERVAL_MS = 5 * 60_000;

export function slackMentionFingerprint(value: object): SlackMentionFingerprint {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex") as SlackMentionFingerprint;
}

export class SlackMentionRateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) { super("Slack mention reconciliation rate limited"); }
}

// A plan limitation belongs to the workspace install, not an individual handle.
// Every fresh consent creates an authorization id, even if it reuses a token.
const slackMentionAuthorizationIdSchema = z.uuid().brand<"SlackMentionAuthorizationId">();
export type SlackMentionAuthorizationId = z.infer<typeof slackMentionAuthorizationIdSchema>;
export function newSlackMentionAuthorizationId(): SlackMentionAuthorizationId {
  return slackMentionAuthorizationIdSchema.parse(randomUUID());
}

export const slackMentionCapabilitySchema = z.object({
  authorizationId: slackMentionAuthorizationIdSchema,
  result: z.enum(["unverified", "paid_teams_only"]),
  connectionEpoch: z.number().int().positive(),
  credentialRevision: z.number().int().positive(),
});
export type SlackMentionCapability = z.infer<typeof slackMentionCapabilitySchema>;

export class SlackMentionUnsupportedError extends Error {
  constructor(readonly observedCapability: SlackMentionCapability | null) {
    super("Slack workspace plan does not support usergroups");
  }
}
