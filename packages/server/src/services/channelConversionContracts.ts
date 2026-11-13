import { z } from "zod";

const count = z.number().int().nonnegative();
const nullableId = z.string().nullable();
const ids = z.array(z.string());

export const conversionArchiveSnapshotSchema = z.object({
  archivedAt: nullableId, archivedByUserId: nullableId, archivedByAgentId: nullableId,
});
export const conversionTaskInventorySchema = z.object({
  directTaskCount: count, threadTaskCount: count, totalCount: count,
  canonicalDirectTaskCount: count.optional(), canonicalThreadTaskCount: count.optional(),
  canonicalTaskCount: count.optional(), shadowOnlyTaskCount: count.optional(),
});
export const conversionPrepareOutputSchema = z.object({
  canonicalChannelId: z.string(), canonicalServerId: z.string(), canonicalName: z.string(),
  canonicalDescription: nullableId, canonicalType: z.string(), canonicalParentMessageId: nullableId,
  canonicalCreatedAt: z.string(), jointChannelId: z.string(), jointCanonicalChannelId: z.string(),
  jointCreatedByServerId: z.string(), jointCreatedByUserId: nullableId, jointStatus: z.string(),
  localChannelId: z.string(), projectionServerId: z.string(), projectionJointChannelId: z.string(),
  projectionRole: z.string(), projectionStatus: z.string(), projectionJoinedByUserId: nullableId,
  projectionDisconnectedByUserId: nullableId,
});
export const conversionThreadProjectionSchema = z.object({
  localThreadId: z.string(), canonicalThreadId: z.string(), canonicalServerId: z.string(),
  canonicalParentMessageId: z.string(), jointChannelId: z.string(), jointCreatedByServerId: z.string(),
  jointCreatedByUserId: nullableId, jointStatus: z.string(), projectionServerId: z.string(),
  role: z.string(), status: z.string(), joinedByUserId: nullableId, disconnectedByUserId: nullableId,
});
export const conversionAudienceSchema = z.object({
  threadIds: ids, retainedUserIds: ids, lostUserIds: ids, retainedAgentIds: ids, lostAgentIds: ids,
  sourceType: z.enum(["channel", "private"]),
});
export const conversionAudienceLedgerSchema = z.object({
  epoch: z.string(), sourceType: z.enum(["channel", "private"]), scopeCount: count,
  retainedUserCount: count, lostUserCount: count, retainedAgentCount: count, lostAgentCount: count,
  checksum: z.string(),
});
export const conversionCleanupLedgerSchema = z.object({
  epoch: z.string(), scopeCount: count, checksum: z.string(), lostUserCount: count, lostAgentCount: count,
  followRows: count, pinRows: count, inboxRows: count, readCursorRows: count, displayPrefRows: count,
  notificationFactRows: count, suppressionRows: count, muteRows: count,
  activityRowRows: count, activityChangeRows: count, activityScopeRows: count, pushRows: count,
  agentFollowRows: count, agentNotificationFactRows: count, agentReadCursorRows: count,
});
export const conversionUploadScopeSchema = z.object({ sessionIds: ids, transferIntentIds: ids, reservationIds: ids });
export type ConversionArchiveSnapshot = z.infer<typeof conversionArchiveSnapshotSchema>;
export type ConversionTaskInventory = z.infer<typeof conversionTaskInventorySchema>;
export type ConversionPrepareOutput = z.infer<typeof conversionPrepareOutputSchema>;
export type ConversionThreadProjection = z.infer<typeof conversionThreadProjectionSchema>;
export type ConversionAudienceResult = z.infer<typeof conversionAudienceSchema>;
export type ConversionAudienceLedger = z.infer<typeof conversionAudienceLedgerSchema>;
export type ConversionCleanupLedger = z.infer<typeof conversionCleanupLedgerSchema>;
export type ConversionUploadScope = z.infer<typeof conversionUploadScopeSchema>;
export type ConversionCleanupCounter = {
  [K in keyof ConversionCleanupLedger]: ConversionCleanupLedger[K] extends number ? K : never
}[keyof ConversionCleanupLedger];

export const CONVERSION_RESOURCE_DESCRIPTORS = [
  { family: "messages", label: "Messages", pendingChannel: false, legacyLedger: true },
  { family: "tasks", label: "Tasks", pendingChannel: false, legacyLedger: false },
  { family: "attachments", label: "Attachments", pendingChannel: true, legacyLedger: true },
  { family: "upload_sessions", label: "UploadSessions", pendingChannel: false, legacyLedger: true },
  { family: "upload_reservations", label: "UploadReservations", pendingChannel: false, legacyLedger: true },
  { family: "transfer_intents", label: "TransferIntents", pendingChannel: false, legacyLedger: true },
] as const;
export type ConversionResourceDescriptor = typeof CONVERSION_RESOURCE_DESCRIPTORS[number];
export type ConversionResourceFamily = ConversionResourceDescriptor["family"];
export type ConversionResourceScope = "parent" | "thread";
const resourceSchema = z.object({ moved: count, cursor: nullableId, checksum: nullableId });
export type ConversionResourceProgress = z.infer<typeof resourceSchema>;
export type ConversionResources = Partial<Record<ConversionResourceScope, Partial<Record<ConversionResourceFamily, ConversionResourceProgress>>>>;

const progressSchema = z.object({
  version: z.literal(1).default(1), ledgerVersion: z.literal(2).optional(), finalizedAt: z.string().optional(),
  lockedAt: z.string().optional(), preparedAt: z.string().optional(), preparedThreads: count.optional(),
  preparedThreadsCursor: z.string().optional(), preparedTaskConversations: count.optional(), verifiedAt: z.string().optional(),
  audienceCutoverAt: z.string().optional(), residualCleanupAt: z.string().optional(),
  rollbackAt: z.string().optional(), rollbackState: z.enum(["restored", "retained"]).optional(),
  sourceLock: z.enum(["released", "retained"]).optional(), retryState: z.enum(["running", "awaiting_retry"]).optional(),
  previousState: z.string().optional(), taskRowsAffected: count.optional(), threadTaskRowsAffected: count.optional(),
  promotedTaskIds: ids.optional(), canonicalChannelId: z.string().optional(), jointChannelId: z.string().optional(),
  sourceArchiveSnapshot: conversionArchiveSnapshotSchema.optional(), taskInventory: conversionTaskInventorySchema.optional(),
  audienceCutover: conversionAudienceSchema.optional(), audienceCutoverLedger: conversionAudienceLedgerSchema.optional(),
  residualCleanupLedger: conversionCleanupLedgerSchema.optional(), persistedPrepareOutput: conversionPrepareOutputSchema.optional(),
  threadProjectionMap: z.array(conversionThreadProjectionSchema).optional(), uploadScope: conversionUploadScopeSchema.optional(),
  cleanupBatchNumber: count.optional(), residualCleanupDeferred: z.boolean().optional(),
  completionBroadcastAt: nullableId.optional(), relockedAt: z.string().optional(), failedAt: z.string().optional(),
  awaitingRetryAt: z.string().optional(), errorClass: z.string().optional(), errorPhase: z.string().optional(),
  errorCode: z.string().optional(), uploadCount: count.optional(), taskIdentityPreservedAt: z.string().optional(),
  canonicalCopyStarted: z.boolean().optional(), externalBindingsPaused: count.optional(),
});
/** Internal state: no legacy keys or unvalidated JSON may enter phase functions. */
export type ConversionProgress = z.infer<typeof progressSchema> & { resources: ConversionResources };

const wireObject = z.record(z.string(), z.unknown());
/** Rolling compatibility boundary for previously persisted jobs. New typed fields
 * win over their legacy aliases; malformed present state fails closed. */
export function parseConversionProgress(value: unknown): ConversionProgress {
  const row = wireObject.parse(value ?? {});
  const resources: ConversionResources = {};
  const typed = row.resources === undefined ? {} : wireObject.parse(row.resources);
  for (const scope of ["parent", "thread"] as const) {
    const typedScope = typed[scope] === undefined ? {} : wireObject.parse(typed[scope]);
    for (const descriptor of CONVERSION_RESOURCE_DESCRIPTORS) {
      const legacyKey = `moved${scope === "parent" ? "Parent" : "Thread"}${descriptor.label}`;
      const candidate = typedScope[descriptor.family] ?? (row[legacyKey] === undefined ? undefined : {
        moved: row[legacyKey], cursor: row[`${legacyKey}Cursor`] ?? null, checksum: row[`${legacyKey}Checksum`] ?? null,
      });
      if (candidate !== undefined) (resources[scope] ??= {})[descriptor.family] = resourceSchema.parse(candidate);
    }
  }
  return { ...progressSchema.parse({ ...row, version: 1 }), resources };
}

export type ConversionScopeInput = { serverId: string; sourceChannelId: string; canonicalChannelId?: string | null };
export function conversionScopeIds(input: ConversionScopeInput): string[] {
  return [input.sourceChannelId, ...(input.canonicalChannelId ? [input.canonicalChannelId] : [])];
}
