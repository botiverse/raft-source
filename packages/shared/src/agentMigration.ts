import { z } from "zod";

export const AGENT_MIGRATION_STATES = [
  "provisioning",
  "prep",
  "ready",
  "in_transit",
  "arriving",
  "starting",
  "cancel_requested_pre_flip",
  "cancel_requested_post_flip",
  "canceled_pre_flip",
  "canceled_post_flip",
  "completed",
  "aborted",
  "failed",
] as const;

export const agentMigrationSupportRefSchema = z.string().regex(/^mig_[A-Za-z0-9_-]{22}$/);

export const MAX_AGENT_MIGRATION_TRANSPORT_BYTES = 10 * 1024 * 1024 * 1024;
export const MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT = 1_000_000;
export const MAX_AGENT_MIGRATION_TRANSFER_BYTES = MAX_AGENT_MIGRATION_TRANSPORT_BYTES;
export const MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT = 1_000_000;

const boundedTransferCountSchema = z.number().int().nonnegative().max(MAX_AGENT_MIGRATION_TRANSFER_FILE_COUNT);
const boundedExcludedCountSchema = z.number().int().nonnegative().max(MAX_AGENT_MIGRATION_EXCLUDED_REGENERABLE_COUNT);

export const agentMigrationTransferSummarySchema = z.object({
  includedFileCount: boundedTransferCountSchema,
  includedBytes: z.number().int().nonnegative().max(MAX_AGENT_MIGRATION_TRANSFER_BYTES),
  excludedRegenerableCount: boundedExcludedCountSchema,
  excludedRegenerableByCategory: z.object({
    thirdPartyDependencies: boundedExcludedCountSchema,
    caches: boundedExcludedCountSchema,
    buildArtifacts: boundedExcludedCountSchema,
    otherRegenerable: boundedExcludedCountSchema,
  }).strict(),
  keyWorkspaceEntries: z.object({
    memoryMdPresent: z.boolean(),
    notesPresent: z.boolean(),
  }).strict(),
}).strict().superRefine((summary, ctx) => {
  const categorized = Object.values(summary.excludedRegenerableByCategory)
    .reduce((total, count) => total + count, 0);
  if (categorized !== summary.excludedRegenerableCount) {
    ctx.addIssue({
      code: "custom",
      path: ["excludedRegenerableByCategory"],
      message: "excluded regenerable category counts must sum to excludedRegenerableCount",
    });
  }
});

export type AgentMigrationTransferSummary = z.infer<typeof agentMigrationTransferSummarySchema>;

export const agentMigrationUpdatedPayloadSchema = z.object({
  agentId: z.string().uuid(),
  migrationRef: agentMigrationSupportRefSchema,
  state: z.enum(AGENT_MIGRATION_STATES),
  revision: z.number().int().positive(),
  authority: z.enum(["source", "target"]),
  disposition: z.enum(["pre_flip_source_authoritative", "post_flip_target_authoritative"]).nullable(),
  needsAttention: z.boolean(),
  dispatchAttempts: z.number().int().nonnegative(),
  attentionDeadlineAt: z.string().datetime().nullable(),
  sourceAcknowledgedAt: z.string().datetime().nullable(),
  targetAcknowledgedAt: z.string().datetime().nullable(),
  targetOutcome: z.enum(["cleaned", "stopped"]).nullable(),
  canceledAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
}).strict();

export type AgentMigrationUpdatedPayload = z.infer<typeof agentMigrationUpdatedPayloadSchema>;
