import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import {
  buildLaunchPlan,
  currentDate,
  hydrateRuntimeConfig,
  WIKI_AGENT_WORKSPACE_ENABLED,
  WIKI_AGENT_WORKSPACE_ENV,
  WIKI_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index.js";
import {
  agents,
  channelAgents,
  channels,
  messages,
  reminders,
  servers,
  wikiBindings,
} from "../db/schema.js";
import { createMessage } from "./messageService.js";
import {
  getReminderById,
  listReminders,
  type ReminderRow,
} from "../apps/reminder/service.js";
import {
  cancelAppReminder,
  cancelMatchingAppReminders as cancelMatchingSchedules,
  createAppReminder,
  replaceAppReminder,
} from "../apps/reminder/crud.js";
import { computeNextFire, type Recurrence } from "./recurrence.js";
import { evaluateFeatureFlag } from "./featureFlagService.js";
import {
  coverageHighWater,
  coverageIncludesSeq,
  isIngestPublication,
  listManifestArtifacts,
  parseWikiManifest,
  publishWikiManifest,
  readWikiArtifactMarkdown,
  readWikiManifest,
  resetWikiManifest,
  WikiManifestConflictError,
  WikiManifestValidationError,
  type WikiCoverage,
  type WikiManifest,
  type WikiManifestArtifact,
  type WikiManifestSnapshot,
  type WikiRevisionBody,
} from "./wikiManifestService.js";

export type WikiStatus = "setup_required" | "ready_uninitialized" | "initializing" | "active" | "error";

export class WikiError extends Error {
  constructor(
    public readonly code:
      | "not_found"
      | "bad_request"
      | "forbidden"
      | "conflict"
      | "storage_unavailable"
      | "daemon_upgrade_required"
      | "workspace_unavailable",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WikiError";
  }
}

type WikiBindingRow = typeof wikiBindings.$inferSelect;

type WikiScheduleSummary = {
  id: string;
  title: string;
  fireAt: Date;
  recurrence: unknown;
} | null;

export type WikiScheduleSyncInstruction =
  | { kind: "upsert"; row: ReminderRow }
  | { kind: "cancel"; ownerAgentId: string; reminderId: string; version: number };

type WikiScheduleSync = (instruction: WikiScheduleSyncInstruction) => Promise<void>;

async function flushWikiScheduleSync(
  changes: readonly WikiScheduleSyncInstruction[],
  sync: WikiScheduleSync | undefined,
): Promise<void> {
  if (!sync) return;
  for (const change of changes) {
    try {
      await sync(change);
    } catch (error) {
      // Durable lifecycle and pending arm state remain authoritative. The arm
      // watchdog/snapshot retry; Wiki never falls back to firing on Server.
      const id = change.kind === "upsert" ? change.row.id : change.reminderId;
      const version = change.kind === "upsert" ? change.row.version : change.version;
      console.warn(`[Wiki] Failed to sync reminder ${id}@${version}:`, error);
    }
  }
}

type WikiMaintenanceSchedulePayload =
  | {
    kind: "wiki.incremental_discovery";
    version: 1;
    wikiSpaceId: string;
    serverId: string;
  }
  | {
    kind: "wiki.ingest_request";
    version: 1;
    wikiSpaceId: string;
    serverId: string;
    requestedByType: "user" | "agent" | "system";
    requestedById: string | null;
  }
  | {
    kind: "wiki.lint";
    version: 1;
    wikiSpaceId: string;
    serverId: string;
  };

const WIKI_DAILY_SCAN_REMINDER_TITLE = "Scan Wiki public source updates";
const WIKI_WEEKLY_LINT_REMINDER_TITLE = "Audit Wiki integrity with the canonical lint skill";
const WIKI_MANUAL_SCAN_REMINDER_TITLE = "Refresh Wiki now";
const LEGACY_WIKI_AGENT_WORKSPACE_SEED_ENV = "SLOCK_WIKI_AGENT_WORKSPACE_SEED";
const WIKI_DAILY_SCAN_ANCHOR_CONTENT = "Wiki daily scan reminder anchor. On wake, run the canonical ingest skill against new eligible public source and publish through the Wiki manifest API.";
const WIKI_WEEKLY_LINT_ANCHOR_CONTENT = "Wiki weekly lint reminder anchor. On wake, run the canonical lint skill against the current Manifest, Index, Log, and every Page. Publish only source-backed repairs through the Wiki manifest API; publish nothing when clean.";
const WIKI_MANUAL_SCAN_ANCHOR_CONTENT = "Wiki refresh requested. Run the canonical ingest skill against new eligible public source and publish through the Wiki manifest API.";
const WIKI_RESET_AUDIT_CONTENT = "Wiki reset requested. The current manifest and source coverage were removed while the Wiki channel, Agent, conversations, and published revisions were preserved. Automatic maintenance was stopped; initialization was not started.";
const WIKI_DAILY_SCAN_HOUR = 2;
const WIKI_DAILY_SCAN_MINUTE = 30;
const WIKI_WEEKLY_LINT_DAY = "sun";
const WIKI_WEEKLY_LINT_HOUR = 3;
const WIKI_WEEKLY_LINT_MINUTE = 30;
const WIKI_DAILY_SCAN_TZ = "Asia/Shanghai";
const WIKI_DAILY_SCAN_RECURRENCE: Recurrence = {
  version: 1,
  rule: {
    kind: "daily",
    hour: WIKI_DAILY_SCAN_HOUR,
    minute: WIKI_DAILY_SCAN_MINUTE,
    tz: WIKI_DAILY_SCAN_TZ,
  },
};
const WIKI_WEEKLY_LINT_RECURRENCE: Recurrence = {
  version: 1,
  rule: {
    kind: "weekly",
    days: [WIKI_WEEKLY_LINT_DAY],
    hour: WIKI_WEEKLY_LINT_HOUR,
    minute: WIKI_WEEKLY_LINT_MINUTE,
    tz: WIKI_DAILY_SCAN_TZ,
  },
};

function isWikiMaintenanceSchedulePayload(value: unknown): value is WikiMaintenanceSchedulePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<WikiMaintenanceSchedulePayload>;
  return (
    (
      payload.kind === "wiki.incremental_discovery"
      || payload.kind === "wiki.ingest_request"
      || payload.kind === "wiki.lint"
    )
    && payload.version === 1
    && typeof payload.wikiSpaceId === "string"
    && typeof payload.serverId === "string"
  );
}

export function isWikiMaintenanceReminder(reminder: Pick<ReminderRow, "payload">): boolean {
  return isWikiMaintenanceSchedulePayload(reminder.payload);
}

function isWikiDailyScanRecurrence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const recurrence = value as Partial<Recurrence>;
  const rule = recurrence.rule;
  return recurrence.version === WIKI_DAILY_SCAN_RECURRENCE.version
    && !!rule
    && rule.kind === "daily"
    && rule.hour === WIKI_DAILY_SCAN_HOUR
    && rule.minute === WIKI_DAILY_SCAN_MINUTE
    && rule.tz === WIKI_DAILY_SCAN_TZ;
}

function isWikiWeeklyLintRecurrence(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const recurrence = value as Partial<Recurrence>;
  const rule = recurrence.rule;
  return recurrence.version === WIKI_WEEKLY_LINT_RECURRENCE.version
    && !!rule
    && rule.kind === "weekly"
    && Array.isArray(rule.days)
    && rule.days.length === 1
    && rule.days[0] === WIKI_WEEKLY_LINT_DAY
    && rule.hour === WIKI_WEEKLY_LINT_HOUR
    && rule.minute === WIKI_WEEKLY_LINT_MINUTE
    && rule.tz === WIKI_DAILY_SCAN_TZ;
}

function serializeArtifact(artifact: WikiManifestArtifact) {
  return {
    id: artifact.id,
    artifactType: artifact.artifactType,
    slug: artifact.slug,
    title: artifact.title,
    summary: artifact.summary,
    currentUnderstanding: artifact.currentUnderstanding,
    status: artifact.status,
    confidence: artifact.confidence,
    sourcePolicy: artifact.sourcePolicy,
    sourceRefs: artifact.sourceRefs,
    timeRangeStart: null,
    timeRangeEnd: null,
    revision: artifact.revision,
    updatedAt: artifact.updatedAt,
    createdAt: artifact.updatedAt,
  };
}

function serializeSpace(
  space: WikiBindingRow,
  refs: {
    agentName?: string | null;
    agentDeletedAt?: Date | null;
    channelName?: string | null;
  },
  maintenanceReminders: {
    dailyScan: WikiScheduleSummary;
    weeklyLint: WikiScheduleSummary;
  },
  manifest: WikiManifest | null,
  lastIngestRequestedAt: Date | null = null,
) {
  const active = manifest !== null;
  const agentDeleted = refs.agentDeletedAt != null;
  return {
    id: space.id,
    status: agentDeleted
      ? "setup_required" as const
      : active
        ? "active" as const
        : space.status as WikiStatus,
    wikiAgentId: space.wikiAgentId,
    wikiAgentName: agentDeleted ? null : refs.agentName ?? null,
    wikiChannelId: space.wikiChannelId,
    wikiChannelName: refs.channelName ?? null,
    initializedAt: manifest?.publishedAt ?? null,
    lastScannedAt: manifest?.lastIngest.publishedAt ?? null,
    lastIngestReceiptId: manifest?.lastIngest.receiptId ?? null,
    lastIngestRequestedAt: lastIngestRequestedAt?.toISOString() ?? null,
    lastLintAt: manifest?.lastLint?.publishedAt ?? null,
    dailyScanReminderId: maintenanceReminders.dailyScan?.id ?? null,
    dailyScanNextAt: maintenanceReminders.dailyScan?.fireAt ?? null,
    weeklyLintReminderId: maintenanceReminders.weeklyLint?.id ?? null,
    weeklyLintNextAt: maintenanceReminders.weeklyLint?.fireAt ?? null,
    manifestRevision: manifest?.revision ?? null,
    createdAt: space.createdAt,
    updatedAt: manifest?.publishedAt ?? space.updatedAt,
  };
}

function serializeManifestJob(manifest: WikiManifest | null) {
  if (!manifest) return null;
  if (manifest.lastLint?.publishedAt === manifest.publishedAt) {
    return {
      jobType: "lint",
      status: "completed",
      phase: "manifest_repaired",
      progress: {
        percent: 100,
        label: "Wiki integrity repairs published",
      },
      error: null,
      startedAt: null,
      completedAt: manifest.lastLint.publishedAt,
      createdAt: manifest.lastLint.publishedAt,
      updatedAt: manifest.lastLint.publishedAt,
      receipt: manifest.lastLint,
    };
  }
  const ingest = manifest.lastIngest;
  return {
    jobType: manifest.revision === 1 ? "init_discovery" : "incremental_discovery",
    status: "completed",
    phase: ingest.outcome === "no_changes" ? "no_changes" : "manifest_published",
    progress: {
      percent: 100,
      label: ingest.outcome === "no_changes" ? "No notable Wiki changes" : "Wiki manifest published",
    },
    error: null,
    startedAt: null,
    completedAt: ingest.publishedAt,
    createdAt: ingest.publishedAt,
    updatedAt: ingest.publishedAt,
    receipt: ingest,
  };
}

async function getSpaceWithRefs(serverId: string) {
  const [row] = await getDb()
    .select({
      space: wikiBindings,
      agentName: agents.name,
      agentDeletedAt: agents.deletedAt,
      channelName: channels.name,
    })
    .from(wikiBindings)
    .leftJoin(agents, eq(wikiBindings.wikiAgentId, agents.id))
    .leftJoin(channels, eq(wikiBindings.wikiChannelId, channels.id))
    .where(eq(wikiBindings.serverId, serverId))
    .limit(1);
  return row ?? null;
}

async function readCurrentManifest(serverId: string): Promise<WikiManifestSnapshot | null> {
  try {
    return await readWikiManifest(serverId);
  } catch (error) {
    console.error("[wiki] failed to read canonical manifest:", error);
    throw new WikiError("storage_unavailable", "Wiki manifest storage could not be read");
  }
}

export async function isWikiFeatureEnabledForServer(serverId: string): Promise<boolean> {
  const evaluation = await evaluateFeatureFlag({
    key: WIKI_FEATURE_FLAG_KEY,
    serverId,
  });
  return evaluation.enabled;
}

async function isCurrentWikiDailyScanReminder(
  space: Pick<WikiBindingRow, "id" | "serverId" | "wikiAgentId" | "wikiChannelId">,
  reminder: ReminderRow,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  if (
    reminder.id !== space.id
    || reminder.serverId !== space.serverId
    || reminder.ownerAgentId !== space.wikiAgentId
    || reminder.msgId == null
    || !isWikiMaintenanceSchedulePayload(reminder.payload)
    || reminder.payload.kind !== "wiki.incremental_discovery"
    || reminder.payload.wikiSpaceId !== space.id
    || reminder.payload.serverId !== space.serverId
    || !isWikiDailyScanRecurrence(reminder.recurrence)
  ) {
    return false;
  }
  return hasCurrentWikiMaintenanceOwner(space, executor);
}

async function isCurrentWikiWeeklyLintReminder(
  space: Pick<WikiBindingRow, "id" | "serverId" | "wikiAgentId" | "wikiChannelId">,
  reminder: ReminderRow,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  if (
    reminder.serverId !== space.serverId
    || reminder.ownerAgentId !== space.wikiAgentId
    || reminder.msgId == null
    || !isWikiMaintenanceSchedulePayload(reminder.payload)
    || reminder.payload.kind !== "wiki.lint"
    || reminder.payload.wikiSpaceId !== space.id
    || reminder.payload.serverId !== space.serverId
    || !isWikiWeeklyLintRecurrence(reminder.recurrence)
  ) {
    return false;
  }
  return hasCurrentWikiMaintenanceOwner(space, executor);
}

async function hasCurrentWikiMaintenanceOwner(
  space: Pick<WikiBindingRow, "serverId" | "wikiAgentId" | "wikiChannelId">,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  const [agent] = await executor
    .select({ id: agents.id })
    .from(agents)
    .where(and(
      eq(agents.id, space.wikiAgentId),
      eq(agents.serverId, space.serverId),
      isNull(agents.deletedAt),
    ))
    .limit(1);
  if (!agent) return false;
  const [channel] = await executor
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.id, space.wikiChannelId),
      eq(channels.serverId, space.serverId),
      eq(channels.type, "channel"),
      isNull(channels.deletedAt),
      isNull(channels.archivedAt),
    ))
    .limit(1);
  return Boolean(channel);
}

async function canReplaceConfiguredWikiAgent(
  space: Pick<WikiBindingRow, "wikiAgentId">,
  requestedAgentId: string,
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  if (space.wikiAgentId === requestedAgentId) return true;
  const [configuredAgent] = await executor
    .select({ deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, space.wikiAgentId))
    .limit(1);
  return configuredAgent == null || configuredAgent.deletedAt != null;
}

async function getWikiDailyScanReminder(
  space: Pick<WikiBindingRow, "id" | "serverId" | "wikiAgentId" | "wikiChannelId">,
  executor: DatabaseExecutor = getDb(),
): Promise<WikiScheduleSummary> {
  const reminder = await getReminderById(space.id, { executor });
  if (!reminder || reminder.status !== "scheduled") return null;
  if (!await isCurrentWikiDailyScanReminder(space, reminder, executor)) return null;
  return {
    id: reminder.id,
    title: reminder.title,
    fireAt: reminder.fireAt,
    recurrence: reminder.recurrence,
  };
}

async function getWikiWeeklyLintReminder(
  space: Pick<WikiBindingRow, "id" | "serverId" | "wikiAgentId" | "wikiChannelId">,
  executor: DatabaseExecutor = getDb(),
): Promise<WikiScheduleSummary> {
  const scheduled = await listReminders(
    { serverId: space.serverId, status: "scheduled" },
    { executor },
  );
  for (const reminder of scheduled) {
    if (await isCurrentWikiWeeklyLintReminder(space, reminder, executor)) {
      return {
        id: reminder.id,
        title: reminder.title,
        fireAt: reminder.fireAt,
        recurrence: reminder.recurrence,
      };
    }
  }
  return null;
}

async function assertWikiFirstPublicationIsAllowed(
  serverId: string,
  manifestExists: boolean,
): Promise<void> {
  if (manifestExists) return;

  // Read lifecycle state after observing the absent manifest. Reset writes
  // `ready_uninitialized` before deleting the entry point, so a Computer-local
  // scheduled wake that was already due cannot recreate revision 1 while the
  // Computer catches up with the durable cancellation. A later explicit Refresh
  // moves the binding to the existing `initializing` state and re-opens first
  // publication without introducing a second Wiki job or generation system.
  const row = await getSpaceWithRefs(serverId);
  if (row?.space.status === "ready_uninitialized") {
    throw new WikiError(
      "conflict",
      "Initialize Wiki before publishing its first manifest",
    );
  }
}

// The manual ingest request is the only durable trace that an initialization
// was asked for before the first manifest exists. Status reads it so the panel
// can say when the run was requested instead of falling back to the initial
// call to action.
async function getLastWikiIngestRequestedAt(
  space: Pick<WikiBindingRow, "id" | "serverId" | "updatedAt">,
  executor: DatabaseExecutor = getDb(),
): Promise<Date | null> {
  const [row] = await executor
    .select({ createdAt: reminders.createdAt })
    .from(reminders)
    .where(and(
      eq(reminders.serverId, space.serverId),
      sql`${reminders.payload} ->> 'kind' = 'wiki.ingest_request'`,
      sql`${reminders.payload} ->> 'wikiSpaceId' = ${space.id}`,
      gte(reminders.createdAt, space.updatedAt),
    ))
    .orderBy(desc(reminders.createdAt))
    .limit(1);
  return row?.createdAt ?? null;
}

export async function getStatus(serverId: string) {
  const row = await getSpaceWithRefs(serverId);
  if (!row) {
    return {
      space: { status: "setup_required" as const },
      lastJob: null,
    };
  }
  const [dailyScanReminder, weeklyLintReminder, manifest] = await Promise.all([
    getWikiDailyScanReminder(row.space),
    getWikiWeeklyLintReminder(row.space),
    readCurrentManifest(serverId),
  ]);
  // Only the uninitialized panel renders this, so skip the lookup once a
  // manifest exists. Status is polled while work is in flight; the steady
  // state must not pay for a request trace nobody displays.
  const lastIngestRequestedAt = manifest
    ? null
    : await getLastWikiIngestRequestedAt(row.space);
  return {
    space: serializeSpace(
      row.space,
      {
        agentName: row.agentName,
        agentDeletedAt: row.agentDeletedAt,
        channelName: row.channelName,
      },
      {
        dailyScan: dailyScanReminder,
        weeklyLint: weeklyLintReminder,
      },
      manifest?.manifest ?? null,
      lastIngestRequestedAt,
    ),
    lastJob: serializeManifestJob(manifest?.manifest ?? null),
  };
}

export async function validateWikiSetupResources(input: {
  serverId: string;
  agentId: string;
  channelId: string;
}) {
  const db = getDb();
  const [agent] = await db
    .select()
    .from(agents)
    .where(and(
      eq(agents.id, input.agentId),
      eq(agents.serverId, input.serverId),
      isNull(agents.deletedAt),
    ))
    .limit(1);
  if (!agent) throw new WikiError("bad_request", "Wiki Agent not found in this server");

  const [channel] = await db
    .select()
    .from(channels)
    .where(and(
      eq(channels.id, input.channelId),
      eq(channels.serverId, input.serverId),
      isNull(channels.deletedAt),
    ))
    .limit(1);
  if (!channel) throw new WikiError("bad_request", "Wiki Channel not found in this server");
  if (channel.archivedAt) throw new WikiError("conflict", "Wiki Channel is archived");
  if (channel.type !== "channel") throw new WikiError("bad_request", "Wiki Channel must be a public channel");

  const [existingSpace] = await db
    .select({
      wikiAgentId: wikiBindings.wikiAgentId,
      wikiChannelId: wikiBindings.wikiChannelId,
    })
    .from(wikiBindings)
    .where(eq(wikiBindings.serverId, input.serverId))
    .limit(1);
  if (
    existingSpace
    && (
      existingSpace.wikiChannelId !== channel.id
      || !await canReplaceConfiguredWikiAgent(existingSpace, agent.id, db)
    )
  ) {
    throw new WikiError("conflict", "Wiki Agent can be replaced only after the configured Agent is deleted");
  }
  return { agent, channel };
}

async function ensureWikiDailyScanReminder(
  space: Pick<WikiBindingRow, "id" | "serverId" | "wikiAgentId" | "wikiChannelId">,
  userId: string,
  executor: DatabaseExecutor = getDb(),
  changes: WikiScheduleSyncInstruction[] = [],
): Promise<WikiScheduleSummary> {
  const stableReminder = await getReminderById(space.id, { executor });
  if (
    stableReminder?.status === "scheduled"
    && await isCurrentWikiDailyScanReminder(space, stableReminder, executor)
  ) {
    const scheduled = await listReminders(
      { serverId: space.serverId, status: "scheduled" },
      { executor },
    );
    for (const reminder of scheduled) {
      if (reminder.id === stableReminder.id) continue;
      if (
        !isWikiMaintenanceSchedulePayload(reminder.payload)
        || reminder.payload.kind !== "wiki.incremental_discovery"
      ) continue;
      const canceled = await cancelAppReminder(reminder.id, {
        actor: { type: "system", id: null },
        executor,
        expectedVersion: reminder.version,
        allowSystemManaged: true,
      });
      if (!canceled) throw new WikiError("conflict", "Wiki schedule changed while canceling it; retry setup");
      changes.push({
        kind: "cancel",
        ownerAgentId: canceled.ownerAgentId,
        reminderId: canceled.id,
        version: canceled.version,
      });
    }
    return {
      id: stableReminder.id,
      title: stableReminder.title,
      fireAt: stableReminder.fireAt,
      recurrence: stableReminder.recurrence,
    };
  }
  const scheduled = await listReminders(
    { serverId: space.serverId, status: "scheduled" },
    { executor },
  );
  let keeper: ReminderRow | null = null;
  for (const reminder of scheduled.filter((candidate) => {
    return isWikiMaintenanceSchedulePayload(candidate.payload)
      && candidate.payload.kind === "wiki.incremental_discovery";
  })) {
    if (stableReminder && reminder.id === stableReminder.id) continue;
    const isCurrent = await isCurrentWikiDailyScanReminder(space, reminder, executor);
    if (isCurrent && !keeper) {
      keeper = reminder;
      continue;
    }
    const canceled = await cancelAppReminder(reminder.id, {
      actor: { type: "system", id: null },
      executor,
      expectedVersion: reminder.version,
      allowSystemManaged: true,
    });
    if (!canceled) {
      throw new WikiError("conflict", "Wiki schedule changed while canceling it; retry setup");
    }
    changes.push({
      kind: "cancel",
      ownerAgentId: canceled.ownerAgentId,
      reminderId: canceled.id,
      version: canceled.version,
    });
  }
  if (keeper) {
    return {
      id: keeper.id,
      title: keeper.title,
      fireAt: keeper.fireAt,
      recurrence: keeper.recurrence,
    };
  }

  const anchor = await createMessage(
    space.wikiChannelId,
    "agent",
    space.wikiAgentId,
    WIKI_DAILY_SCAN_ANCHOR_CONTENT,
    "system",
    undefined,
    undefined,
    executor,
  );
  const replacement = {
    id: space.id,
    serverId: space.serverId,
    ownerAgentId: space.wikiAgentId,
    msgId: anchor.id,
    title: WIKI_DAILY_SCAN_REMINDER_TITLE,
    fireAt: computeNextFire(WIKI_DAILY_SCAN_RECURRENCE, currentDate()),
    recurrence: WIKI_DAILY_SCAN_RECURRENCE,
    payload: {
      kind: "wiki.incremental_discovery",
      version: 1,
      wikiSpaceId: space.id,
      serverId: space.serverId,
    } satisfies WikiMaintenanceSchedulePayload,
    createdBy: { type: "human", id: userId },
  } as const;
  const row = stableReminder
    ? await replaceAppReminder(space.id, replacement, {
      actor: { type: "human", id: userId },
      executor,
      expectedVersion: stableReminder.version,
      allowSystemManaged: true,
    })
    : await createAppReminder(replacement, { executor });
  if (!row) throw new WikiError("conflict", "Wiki schedule changed while replacing it; retry setup");
  if (stableReminder && stableReminder.ownerAgentId !== row.ownerAgentId) {
    changes.push({
      kind: "cancel",
      ownerAgentId: stableReminder.ownerAgentId,
      reminderId: stableReminder.id,
      version: row.version,
    });
  }
  changes.push({ kind: "upsert", row });
  return {
    id: row.id,
    title: row.title,
    fireAt: row.fireAt,
    recurrence: row.recurrence,
  };
}

async function ensureWikiWeeklyLintReminder(
  space: Pick<WikiBindingRow, "id" | "serverId" | "wikiAgentId" | "wikiChannelId">,
  userId: string,
  executor: DatabaseExecutor = getDb(),
  changes: WikiScheduleSyncInstruction[] = [],
): Promise<WikiScheduleSummary> {
  const scheduled = await listReminders(
    { serverId: space.serverId, status: "scheduled" },
    { executor },
  );
  let keeper: ReminderRow | null = null;
  for (const reminder of scheduled.filter((candidate) => {
    return isWikiMaintenanceSchedulePayload(candidate.payload)
      && candidate.payload.kind === "wiki.lint";
  })) {
    const isCurrent = await isCurrentWikiWeeklyLintReminder(space, reminder, executor);
    if (isCurrent && !keeper) {
      keeper = reminder;
      continue;
    }
    // Rebinding after the configured Agent was soft-deleted must not leave a
    // weekly lifecycle row armed on that Agent's Computer.
    const canceled = await cancelAppReminder(reminder.id, {
      actor: { type: "system", id: null },
      executor,
      expectedVersion: reminder.version,
      allowSystemManaged: true,
    });
    if (!canceled) {
      throw new WikiError("conflict", "Wiki schedule changed while replacing it; retry setup");
    }
    changes.push({
      kind: "cancel",
      ownerAgentId: canceled.ownerAgentId,
      reminderId: canceled.id,
      version: canceled.version,
    });
  }
  if (keeper) {
    return {
      id: keeper.id,
      title: keeper.title,
      fireAt: keeper.fireAt,
      recurrence: keeper.recurrence,
    };
  }

  const anchor = await createMessage(
    space.wikiChannelId,
    "agent",
    space.wikiAgentId,
    WIKI_WEEKLY_LINT_ANCHOR_CONTENT,
    "system",
    undefined,
    undefined,
    executor,
  );
  const row = await createAppReminder({
    id: randomUUID(),
    serverId: space.serverId,
    ownerAgentId: space.wikiAgentId,
    msgId: anchor.id,
    title: WIKI_WEEKLY_LINT_REMINDER_TITLE,
    fireAt: computeNextFire(WIKI_WEEKLY_LINT_RECURRENCE, currentDate()),
    recurrence: WIKI_WEEKLY_LINT_RECURRENCE,
    payload: {
      kind: "wiki.lint",
      version: 1,
      wikiSpaceId: space.id,
      serverId: space.serverId,
    } satisfies WikiMaintenanceSchedulePayload,
    createdBy: { type: "human", id: userId },
  }, { executor });
  changes.push({ kind: "upsert", row });
  return {
    id: row.id,
    title: row.title,
    fireAt: row.fireAt,
    recurrence: row.recurrence,
  };
}

async function cancelWikiSchedules(
  space: Pick<WikiBindingRow, "id" | "serverId">,
  actorId: string,
  executor: DatabaseExecutor = getDb(),
  changes: WikiScheduleSyncInstruction[] = [],
): Promise<number> {
  const canceled = await cancelMatchingSchedules(
    { serverId: space.serverId, status: "scheduled" },
    (candidate) => isWikiMaintenanceSchedulePayload(candidate.payload)
      && candidate.payload.wikiSpaceId === space.id,
    {
      actor: { type: "human", id: actorId },
      executor,
      allowSystemManaged: true,
    },
  );
  if (!canceled) {
    throw new WikiError("conflict", "Wiki maintenance schedules changed while resetting; retry reset");
  }
  for (const row of canceled) {
    changes.push({
      kind: "cancel",
      ownerAgentId: row.ownerAgentId,
      reminderId: row.id,
      version: row.version,
    });
  }
  return canceled.length;
}

export async function setupWikiSpace(input: {
  serverId: string;
  userId: string;
  agentId: string;
  channelId: string;
  syncReminder?: WikiScheduleSync;
}) {
  await validateWikiSetupResources(input);
  const db = getDb();
  const now = currentDate();
  const reminderChanges: WikiScheduleSyncInstruction[] = [];
  const result = await db.transaction(async (tx) => {
    const [server] = await tx
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.id, input.serverId), isNull(servers.deletedAt)))
      .for("update");
    if (!server) throw new WikiError("bad_request", "Server not found");

    const [agent] = await tx
      .select()
      .from(agents)
      .where(and(
        eq(agents.id, input.agentId),
        eq(agents.serverId, input.serverId),
        isNull(agents.deletedAt),
      ))
      .limit(1)
      .for("update");
    if (!agent) throw new WikiError("bad_request", "Wiki Agent not found in this server");

    const [channel] = await tx
      .select()
      .from(channels)
      .where(and(
        eq(channels.id, input.channelId),
        eq(channels.serverId, input.serverId),
        isNull(channels.deletedAt),
      ))
      .limit(1)
      .for("update");
    if (!channel) throw new WikiError("bad_request", "Wiki Channel not found in this server");
    if (channel.archivedAt) throw new WikiError("conflict", "Wiki Channel is archived");
    if (channel.type !== "channel") throw new WikiError("bad_request", "Wiki Channel must be a public channel");

    const [existingSpace] = await tx
      .select()
      .from(wikiBindings)
      .where(eq(wikiBindings.serverId, input.serverId))
      .limit(1)
      .for("update");
    if (
      existingSpace
      && (
        existingSpace.wikiChannelId !== channel.id
        || !await canReplaceConfiguredWikiAgent(existingSpace, agent.id, tx)
      )
    ) {
      throw new WikiError("conflict", "Wiki Agent can be replaced only after the configured Agent is deleted");
    }

    await tx
      .insert(channelAgents)
      .values({ channelId: channel.id, agentId: agent.id })
      .onConflictDoNothing();

    const runtimeConfig = hydrateRuntimeConfig(agent);
    const wikiEnvVars = { ...(runtimeConfig.envVars ?? {}) };
    delete wikiEnvVars[LEGACY_WIKI_AGENT_WORKSPACE_SEED_ENV];
    wikiEnvVars[WIKI_AGENT_WORKSPACE_ENV] = WIKI_AGENT_WORKSPACE_ENABLED;
    const wikiRuntimeConfig = { ...runtimeConfig, envVars: wikiEnvVars };
    const launch = buildLaunchPlan(wikiRuntimeConfig);
    const persistedEnvVars = wikiRuntimeConfig.runtime === "builtin"
      ? wikiRuntimeConfig.envVars
      : launch.envVars;
    await tx
      .update(agents)
      .set({ runtimeConfig: wikiRuntimeConfig, envVars: persistedEnvVars, updatedAt: now })
      .where(eq(agents.id, agent.id));

    let space = existingSpace;
    if (!space) {
      [space] = await tx
        .insert(wikiBindings)
        .values({
          serverId: input.serverId,
          wikiAgentId: agent.id,
          wikiChannelId: channel.id,
          status: "ready_uninitialized",
          createdByUserId: input.userId,
          updatedAt: now,
        })
        .returning();
    } else if (space.wikiAgentId !== agent.id) {
      [space] = await tx
        .update(wikiBindings)
        .set({
          wikiAgentId: agent.id,
          status: "ready_uninitialized",
          updatedAt: now,
        })
        .where(and(
          eq(wikiBindings.id, space.id),
          eq(wikiBindings.serverId, input.serverId),
          eq(wikiBindings.wikiAgentId, space.wikiAgentId),
        ))
        .returning();
    }
    if (!space) throw new WikiError("bad_request", "Failed to set up Wiki space");
    const dailyScanReminder = await ensureWikiDailyScanReminder(
      space,
      input.userId,
      tx,
      reminderChanges,
    );
    const weeklyLintReminder = await ensureWikiWeeklyLintReminder(
      space,
      input.userId,
      tx,
      reminderChanges,
    );
    return { space, agent, channel, dailyScanReminder, weeklyLintReminder };
  });
  await flushWikiScheduleSync(reminderChanges, input.syncReminder);

  const manifest = await readCurrentManifest(input.serverId);
  return {
    space: serializeSpace(
      result.space,
      { agentName: result.agent.name, channelName: result.channel.name },
      {
        dailyScan: result.dailyScanReminder,
        weeklyLint: result.weeklyLintReminder,
      },
      manifest?.manifest ?? null,
    ),
    reviewSummary: {
      wikiAgent: { id: result.agent.id, name: result.agent.name },
      wikiChannel: { id: result.channel.id, name: result.channel.name },
      channelMembers: { includesWikiAgent: true },
      dailyScanReminder: result.dailyScanReminder
        ? {
          id: result.dailyScanReminder.id,
          title: result.dailyScanReminder.title,
          nextFireAt: result.dailyScanReminder.fireAt,
        }
        : null,
      weeklyLintReminder: result.weeklyLintReminder
        ? {
          id: result.weeklyLintReminder.id,
          title: result.weeklyLintReminder.title,
          nextFireAt: result.weeklyLintReminder.fireAt,
        }
        : null,
    },
  };
}

export async function refreshWiki(
  serverId: string,
  actorId: string,
  actorType: "user" | "agent" | "system" = "user",
  _allowInitialize = actorType === "user",
  syncReminder?: WikiScheduleSync,
) {
  const row = await getSpaceWithRefs(serverId);
  if (!row) throw new WikiError("bad_request", "Set up Wiki before refreshing");
  const initialManifest = await readCurrentManifest(serverId);
  if (
    initialManifest
    && !hasUncoveredNewSource(
      initialManifest.manifest.coverage,
      await getEligibleWikiSourceLatestByChannel(row.space),
    )
  ) {
    const [dailyScanReminder, weeklyLintReminder] = await Promise.all([
      getWikiDailyScanReminder(row.space),
      getWikiWeeklyLintReminder(row.space),
    ]);
    const now = currentDate();
    return {
      space: serializeSpace(
        row.space,
        {
          agentName: row.agentName,
          agentDeletedAt: row.agentDeletedAt,
          channelName: row.channelName,
        },
        {
          dailyScan: dailyScanReminder,
          weeklyLint: weeklyLintReminder,
        },
        initialManifest.manifest,
      ),
      job: {
        jobType: "incremental_discovery",
        status: "completed",
        phase: "no_changes",
        progress: { percent: 100, label: "Wiki is already up to date" },
        error: null,
        startedAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      sourceChangesDetected: false,
      upToDate: true,
      round: null,
    };
  }
  const maintenanceReminderChanges: WikiScheduleSyncInstruction[] = [];
  if (!initialManifest) {
    await getDb().transaction(async (tx) => {
      await ensureWikiDailyScanReminder(row.space, actorId, tx, maintenanceReminderChanges);
      await ensureWikiWeeklyLintReminder(row.space, actorId, tx, maintenanceReminderChanges);
    });
  }
  const anchor = await createMessage(
    row.space.wikiChannelId,
    actorType === "user" ? "user" : "agent",
    actorType === "system" ? row.space.wikiAgentId : actorId,
    WIKI_MANUAL_SCAN_ANCHOR_CONTENT,
    "system",
  );
  const now = currentDate();
  const reminder = await createAppReminder({
    id: randomUUID(),
    serverId,
    ownerAgentId: row.space.wikiAgentId,
    msgId: anchor.id,
    title: WIKI_MANUAL_SCAN_REMINDER_TITLE,
    fireAt: new Date(now.getTime() + 1_000),
    recurrence: null,
    payload: {
      kind: "wiki.ingest_request",
      version: 1,
      wikiSpaceId: row.space.id,
      serverId,
      requestedByType: actorType,
      requestedById: actorType === "system" ? null : actorId,
    } satisfies WikiMaintenanceSchedulePayload,
    createdBy: actorType === "user"
      ? { type: "human", id: actorId }
      : actorType === "agent"
        ? { type: "agent", id: actorId }
        : { type: "agent", id: row.space.wikiAgentId },
  });
  if (!initialManifest) {
    await getDb()
      .update(wikiBindings)
      // The request row and lifecycle boundary must share the DB clock because
      // status later filters out requests created before the most recent reset.
      .set({ status: "initializing", updatedAt: reminder.createdAt })
      .where(and(
        eq(wikiBindings.id, row.space.id),
        eq(wikiBindings.serverId, serverId),
        ne(wikiBindings.status, "active"),
      ));
  }
  await flushWikiScheduleSync(
    [...maintenanceReminderChanges, { kind: "upsert", row: reminder }],
    syncReminder,
  );
  const [dailyScanReminder, weeklyLintReminder, manifest] = await Promise.all([
    getWikiDailyScanReminder(row.space),
    getWikiWeeklyLintReminder(row.space),
    readCurrentManifest(serverId),
  ]);
  return {
    space: serializeSpace(
      initialManifest
        ? row.space
        : { ...row.space, status: "initializing", updatedAt: reminder.createdAt },
      {
        agentName: row.agentName,
        agentDeletedAt: row.agentDeletedAt,
        channelName: row.channelName,
      },
      {
        dailyScan: dailyScanReminder,
        weeklyLint: weeklyLintReminder,
      },
      manifest?.manifest ?? null,
      reminder.createdAt,
    ),
    job: {
      id: reminder.id,
      jobType: manifest ? "incremental_discovery" : "init_discovery",
      status: "running",
      phase: "computer_reminder_scheduled",
      progress: { percent: 0, label: "Wiki Agent reminder scheduled on its Computer" },
      error: null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    sourceChangesDetected: null,
    upToDate: false,
    round: null,
  };
}

export async function resetWiki(
  serverId: string,
  actorId: string,
  syncReminder?: WikiScheduleSync,
) {
  const row = await getSpaceWithRefs(serverId);
  if (!row) throw new WikiError("bad_request", "Set up Wiki before resetting");

  const previousStatus = row.space.status;
  // Establish the first-publication fence before deleting the manifest. While
  // the old manifest still exists, its ETag remains the S3 commit boundary;
  // after deletion, `ready_uninitialized` rejects a null-ETag publication
  // until a human explicitly starts Initialize through Refresh.
  const [fence] = await getDb()
    .update(wikiBindings)
    .set({ status: "ready_uninitialized", updatedAt: sql`now()` })
    .where(and(
      eq(wikiBindings.id, row.space.id),
      eq(wikiBindings.serverId, serverId),
    ))
    .returning({ updatedAt: wikiBindings.updatedAt });
  if (!fence) throw new WikiError("conflict", "Wiki changed while resetting; retry reset");
  const resetAt = fence.updatedAt;

  let resetReceipt;
  try {
    resetReceipt = await resetWikiManifest(serverId);
  } catch (error) {
    try {
      await getDb()
        .update(wikiBindings)
        .set({ status: previousStatus, updatedAt: row.space.updatedAt })
        .where(and(
          eq(wikiBindings.id, row.space.id),
          eq(wikiBindings.serverId, serverId),
          eq(wikiBindings.status, "ready_uninitialized"),
          eq(wikiBindings.updatedAt, resetAt),
        ));
    } catch (restoreError) {
      console.error("[wiki] failed to restore binding status after reset delete failure:", restoreError);
    }
    console.info("[wiki] reset", {
      serverId,
      actorId,
      previousEtag: null,
      deleteResult: "failed",
      schedulesCanceled: 0,
    });
    throw new WikiError(
      "storage_unavailable",
      "Wiki could not be reset because its current manifest could not be deleted.",
      { phase: "delete", resetCompleted: false },
    );
  }

  const reminderChanges: WikiScheduleSyncInstruction[] = [];
  let schedulesCanceled = 0;
  try {
    schedulesCanceled = await getDb().transaction((tx) =>
      cancelWikiSchedules(row.space, actorId, tx, reminderChanges)
    );
    await flushWikiScheduleSync(reminderChanges, syncReminder);
  } catch (error) {
    console.info("[wiki] reset", {
      serverId,
      actorId,
      previousEtag: resetReceipt.previousEtag,
      deleteResult: resetReceipt.existed ? "deleted" : "already_absent",
      schedulesCanceled,
      scheduleResult: "failed",
    });
    throw new WikiError(
      "conflict",
      "Wiki was reset, but its automatic maintenance could not all be stopped. Retry reset.",
      { phase: "reminders", resetCompleted: true },
    );
  }

  try {
    await createMessage(
      row.space.wikiChannelId,
      "user",
      actorId,
      WIKI_RESET_AUDIT_CONTENT,
      "system",
    );
  } catch (error) {
    console.error("[wiki] failed to write reset audit message:", error);
  }
  console.info("[wiki] reset", {
    serverId,
    actorId,
    previousEtag: resetReceipt.previousEtag,
    deleteResult: resetReceipt.existed ? "deleted" : "already_absent",
    schedulesCanceled,
  });
  return getStatus(serverId);
}

async function loadWikiParentMessageChannels(
  parentMessageIds: string[],
): Promise<Map<string, string>> {
  const rows = parentMessageIds.length === 0
    ? []
    : await getDb()
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(inArray(messages.id, parentMessageIds));
  return new Map(rows.map((message) => [message.id, message.channelId]));
}

export async function getDirectory(serverId: string) {
  const row = await getSpaceWithRefs(serverId);
  if (!row) throw new WikiError("not_found", "Wiki is not set up");
  const snapshot = await readCurrentManifest(serverId);
  if (!snapshot) {
    return { index: null, log: null, pages: [] };
  }
  return {
    index: serializeArtifact(snapshot.manifest.index),
    log: serializeArtifact(snapshot.manifest.log),
    pages: snapshot.manifest.pages
      .filter((page) => page.status !== "archived")
      .map(serializeArtifact),
  };
}

async function readCurrentArtifact(
  snapshot: WikiManifestSnapshot,
  artifactId: string,
): Promise<{ artifact: WikiManifestArtifact; markdown: string }> {
  try {
    return await readWikiArtifactMarkdown(snapshot.manifest, artifactId);
  } catch (error) {
    if (
      error instanceof WikiManifestValidationError
      && error.message === "Wiki artifact is not in the current manifest"
    ) {
      throw new WikiError("not_found", "Wiki document not found");
    }
    console.error("[wiki] failed to read current artifact:", error);
    throw new WikiError("storage_unavailable", "Wiki document storage could not be read");
  }
}

export async function getArtifact(serverId: string, artifactId: string) {
  const row = await getSpaceWithRefs(serverId);
  if (!row) throw new WikiError("not_found", "Wiki is not set up");
  const snapshot = await readCurrentManifest(serverId);
  if (!snapshot) throw new WikiError("not_found", "Wiki document not found");
  const document = await readCurrentArtifact(snapshot, artifactId);
  return {
    ...serializeArtifact(document.artifact),
    markdown: document.markdown,
  };
}

function manifestSourceRefs(manifest: WikiManifest) {
  return listManifestArtifacts(manifest).flatMap((artifact) => artifact.sourceRefs);
}

async function listEligibleWikiPublicChannelIds(space: WikiBindingRow): Promise<string[]> {
  const rows = await getDb()
    .select({ id: channels.id })
    .from(channels)
    .where(and(
      eq(channels.serverId, space.serverId),
      eq(channels.type, "channel"),
      ne(channels.name, "all"),
      ne(channels.id, space.wikiChannelId),
      isNull(channels.archivedAt),
      isNull(channels.deletedAt),
    ));
  return rows.map((channel) => channel.id);
}

async function listActiveWikiThreadScopes(
  serverId: string,
): Promise<Array<{ id: string; parentMessageId: string }>> {
  const rows = await getDb()
    .select({ id: channels.id, parentMessageId: channels.parentMessageId })
    .from(channels)
    .where(and(
      eq(channels.serverId, serverId),
      eq(channels.type, "thread"),
      isNotNull(channels.parentMessageId),
      isNull(channels.archivedAt),
      isNull(channels.deletedAt),
    ));
  return rows.map((channel) => ({
    id: channel.id,
    parentMessageId: channel.parentMessageId!,
  }));
}

/**
 * The eligible source scope, expressed in both keys that matter.
 *
 * `messages.seq` is server-global and a thread reply is stored under the
 * thread's own channel id, so a parent channel and its threads interleave in
 * one sequence space. Coverage is recorded per parent channel — "a channel
 * stands for its threads" — which only holds if every coverage-facing query
 * folds thread storage ids into their parent. Keying any one of them on the
 * physical channel id makes the parent's range and the parent's own messages
 * disagree, which is how thread content became unpublishable.
 */
type WikiEligibleScope = {
  storageChannelIds: string[];
  coverageIdByStorageId: Map<string, string>;
  storageIdsByCoverageId: Map<string, string[]>;
};

async function getEligibleWikiSourceScope(space: WikiBindingRow): Promise<WikiEligibleScope> {
  // Resolve the eligible local public scope without joining messages through
  // channels.serverId. Joint-channel messages live in canonical storage, so
  // that join shape can silently bypass the local projection boundary. Wiki
  // deliberately excludes joint channels: enumerate local public parents,
  // then attach only local threads whose parent message belongs to that set.
  const [publicChannelIdsList, threadChannels] = await Promise.all([
    listEligibleWikiPublicChannelIds(space),
    listActiveWikiThreadScopes(space.serverId),
  ]);
  const publicChannelIds = new Set(publicChannelIdsList);
  const parentById = await loadWikiParentMessageChannels(
    threadChannels.map((channel) => channel.parentMessageId),
  );
  const coverageIdByStorageId = new Map<string, string>();
  for (const channelId of publicChannelIds) coverageIdByStorageId.set(channelId, channelId);
  for (const channel of threadChannels) {
    const parentChannelId = parentById.get(channel.parentMessageId) ?? "";
    if (!publicChannelIds.has(parentChannelId)) continue;
    coverageIdByStorageId.set(channel.id, parentChannelId);
  }
  const storageIdsByCoverageId = new Map<string, string[]>();
  for (const [storageId, coverageId] of coverageIdByStorageId) {
    const known = storageIdsByCoverageId.get(coverageId);
    if (known) known.push(storageId);
    else storageIdsByCoverageId.set(coverageId, [storageId]);
  }
  return {
    storageChannelIds: [...coverageIdByStorageId.keys()],
    coverageIdByStorageId,
    storageIdsByCoverageId,
  };
}

async function getEligibleWikiSourceChannelIds(space: WikiBindingRow): Promise<string[]> {
  return (await getEligibleWikiSourceScope(space)).storageChannelIds;
}

/**
 * Latest sequence per coverage channel — a parent channel together with every
 * thread hanging off it. A single global MAX cannot answer "which channels are
 * behind"; a per-storage-channel MAX answers it in the wrong key and would
 * report each thread as a channel of its own that coverage never reaches.
 */
function foldLatestByCoverageId(
  scope: WikiEligibleScope,
  rows: Array<{ channelId: string; latestSeq: number }>,
): Map<string, number> {
  const latestByCoverageId = new Map<string, number>();
  for (const row of rows) {
    const coverageId = scope.coverageIdByStorageId.get(row.channelId) ?? row.channelId;
    latestByCoverageId.set(
      coverageId,
      Math.max(latestByCoverageId.get(coverageId) ?? 0, row.latestSeq),
    );
  }
  return latestByCoverageId;
}

async function loadLatestByCoverageId(scope: WikiEligibleScope): Promise<Map<string, number>> {
  if (scope.storageChannelIds.length === 0) return new Map();
  const rows = await getDb()
    .select({
      channelId: messages.channelId,
      latestSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0)::bigint`.mapWith(Number),
    })
    .from(messages)
    .where(inArray(messages.channelId, scope.storageChannelIds))
    .groupBy(messages.channelId);
  return foldLatestByCoverageId(scope, rows);
}

async function getEligibleWikiSourceLatestByChannel(
  space: WikiBindingRow,
): Promise<Map<string, number>> {
  return loadLatestByCoverageId(await getEligibleWikiSourceScope(space));
}

/**
 * Signal A: eligible source exists above what coverage already records. This is
 * deliberately not "coverage has any gap" — with holes allowed, a gap-based
 * predicate would stay true for as long as any history remains unread and would
 * therefore wake the Agent every day without distinguishing new activity from
 * an old backlog.
 */
function hasUncoveredNewSource(
  coverage: WikiCoverage,
  latestByChannel: Map<string, number>,
): boolean {
  for (const [channelId, latestSeq] of latestByChannel) {
    if (latestSeq > coverageHighWater(coverage, channelId)) return true;
  }
  return false;
}

/**
 * The highest sequence that exists anywhere in eligible source. This bounds
 * what coverage may claim; it is not a cursor and says nothing about what has
 * been read.
 */
async function getEligibleWikiSourceUpperSeq(scope: WikiEligibleScope): Promise<number> {
  if (scope.storageChannelIds.length === 0) return 0;
  const [row] = await getDb()
    .select({
      upperSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0)::bigint`.mapWith(Number),
    })
    .from(messages)
    .where(inArray(messages.channelId, scope.storageChannelIds));
  return row?.upperSeq ?? 0;
}

function sourceRefKey(ref: { channelId: string; messageId: string }): string {
  return `${ref.channelId}:${ref.messageId}`;
}

/** Every source reference the currently committed manifest already carries. */
function committedSourceRefKeys(manifest: WikiManifest | null): Set<string> {
  if (!manifest) return new Set();
  return new Set(manifestSourceRefs(manifest).map(sourceRefKey));
}

async function assertManifestSourceRefsEligible(
  space: WikiBindingRow,
  manifest: WikiManifest,
  carriedRefKeys: Set<string>,
): Promise<void> {
  const validationErrors = new Set<string>();
  const scope = await getEligibleWikiSourceScope(space);
  // Only this publication's declared advances are measured against live source.
  //
  // Historical coverage is not re-audited. The eligible set shrinks when a
  // channel is archived, and with it the global upper sequence, so coverage
  // recorded honestly at the time would later sit above the bound and fail
  // every publication from then on. That is the same mistake as re-auditing a
  // carried ingest receipt: a fact about the past checked against the present.
  //
  // Nothing is conceded. Coverage cannot grow without a declared advance — the
  // shared growth assertion closes both the first and the incremental
  // publication — and every declared advance is bounded, eligibility-checked,
  // and counted here.
  const upperSeq = await getEligibleWikiSourceUpperSeq(scope);
  // Every declared advance is counted against the database. Without this the
  // publisher's own claim about what it read would be accepted on assertion,
  // which is how the previous model let coverage run ahead of reality. The
  // count spans the parent channel and its threads together, matching the key
  // coverage is recorded under.
  //
  // Only a current ingest receipt is audited. A lint publication must preserve
  // the previous ingest receipt verbatim, so auditing that carried history
  // against today's eligible source would permanently block lint once any
  // channel it names is archived. Coverage cannot change on a lint publication,
  // so skipping it here concedes nothing.
  for (const advance of isIngestPublication(manifest) ? manifest.lastIngest.added : []) {
    // The bound is the global upper sequence, not the channel's own latest:
    // sequences are server-wide, so a channel whose last message is older than
    // another's still gets read up to the frozen boundary, and the doctrine
    // requires recording that checked-and-empty tail.
    if (advance.to > upperSeq) {
      validationErrors.add(
        `Wiki coverage for channel ${advance.channelId} claims sequence ${advance.to} beyond the latest eligible sequence ${upperSeq}`,
      );
    }
    const storageChannelIds = scope.storageIdsByCoverageId.get(advance.channelId);
    if (!storageChannelIds) {
      validationErrors.add(
        `Wiki coverage advance names channel ${advance.channelId}, which is not an eligible Wiki source channel (thread coverage belongs to its parent channel)`,
      );
      continue;
    }
    const [counted] = await getDb()
      .select({ total: sql<number>`COUNT(*)::int`.mapWith(Number) })
      .from(messages)
      .where(and(
        inArray(messages.channelId, storageChannelIds),
        gte(messages.seq, advance.from),
        lte(messages.seq, advance.to),
      ));
    const actual = counted?.total ?? 0;
    if (actual !== advance.observedCount) {
      validationErrors.add(
        `Wiki coverage for channel ${advance.channelId} reported ${advance.observedCount} messages in ${advance.from}-${advance.to} but the server counted ${actual}`,
      );
    }
  }
  const refs = manifestSourceRefs(manifest);
  if (refs.length === 0) {
    throwWikiSourceValidationErrors(validationErrors);
    return;
  }

  const uniqueMessageIds = [...new Set(refs.map((ref) => ref.messageId))];
  const messageRows = await getDb()
    .select({ id: messages.id, channelId: messages.channelId, seq: messages.seq })
    .from(messages)
    .where(inArray(messages.id, uniqueMessageIds));
  const messageById = new Map(messageRows.map((message) => [message.id, message]));
  const physicalChannelIds = [...new Set(messageRows.map((message) => message.channelId))];
  const channelRows = await getDb()
    .select({
      id: channels.id,
      type: channels.type,
      name: channels.name,
      parentMessageId: channels.parentMessageId,
      archivedAt: channels.archivedAt,
      deletedAt: channels.deletedAt,
      serverId: channels.serverId,
    })
    .from(channels)
    .where(inArray(channels.id, physicalChannelIds));
  const channelById = new Map(channelRows.map((channel) => [channel.id, channel]));

  const parentMessageIds = channelRows
    .filter((channel) => channel.type === "thread" && channel.parentMessageId)
    .map((channel) => channel.parentMessageId!)
  ;
  const parentRows = parentMessageIds.length === 0
    ? []
    : await getDb()
      .select({ id: messages.id, channelId: messages.channelId })
      .from(messages)
      .where(inArray(messages.id, parentMessageIds));
  const parentChannelIds = [...new Set(parentRows.map((message) => message.channelId))];
  const parentChannelRows = parentChannelIds.length === 0
    ? []
    : await getDb()
      .select({
        id: channels.id,
        type: channels.type,
        name: channels.name,
        archivedAt: channels.archivedAt,
        deletedAt: channels.deletedAt,
        serverId: channels.serverId,
      })
      .from(channels)
      .where(inArray(channels.id, parentChannelIds));
  const parentMessageById = new Map(parentRows.map((message) => [message.id, message]));
  const parentChannelById = new Map(parentChannelRows.map((channel) => [channel.id, channel]));

  const isEligiblePublicChannel = (channel: {
    id: string;
    type: string;
    name: string;
    archivedAt: Date | null;
    deletedAt: Date | null;
    serverId: string;
  } | undefined, allowArchived = false) => {
    return Boolean(
      channel
      && channel.serverId === space.serverId
      && channel.type === "channel"
      && channel.name !== "all"
      && channel.id !== space.wikiChannelId
      && (channel.archivedAt === null || allowArchived)
      && channel.deletedAt === null
    );
  };

  for (const ref of refs) {
    const message = messageById.get(ref.messageId);
    if (!message || message.channelId !== ref.channelId || Number(message.seq) !== ref.seq) {
      validationErrors.add(`Wiki source ref ${ref.messageId} does not match a source message`);
      continue;
    }
    // A citation that was legal when it was published survives its channel
    // being archived, but only if the previous manifest already carried it.
    // Otherwise every existing Page would brick ingest and lint the moment its
    // channel is archived, for the same reason historical coverage must not be
    // re-audited. This admits archived channels only: private, joint, and
    // deleted stay out, and no *new* reference to an archived channel is
    // allowed.
    const carriedFromPreviousManifest = carriedRefKeys.has(sourceRefKey(ref));
    const channel = channelById.get(message.channelId);
    if (
      !channel
      || channel.serverId !== space.serverId
      || channel.deletedAt
      || (channel.archivedAt && !carriedFromPreviousManifest)
    ) {
      validationErrors.add(`Wiki source ref ${ref.messageId} is not in an active server channel`);
      continue;
    }
    if (channel.type === "channel") {
      if (!isEligiblePublicChannel(channel, carriedFromPreviousManifest)) {
        validationErrors.add(`Wiki source ref ${ref.messageId} is outside eligible public scope`);
        continue;
      }
      const expectedRef = `#${channel.name}:${ref.messageId.slice(0, 8)}`;
      if (ref.slockRef !== expectedRef) {
        validationErrors.add(`Wiki source ref ${ref.messageId} must use ${expectedRef}`);
      }
      const coverageError = wikiRefCoverageError(manifest.coverage, channel.id, ref);
      if (coverageError) validationErrors.add(coverageError);
      continue;
    }
    if (channel.type !== "thread" || !channel.parentMessageId) {
      validationErrors.add(`Wiki source ref ${ref.messageId} is outside eligible public scope`);
      continue;
    }
    const parentMessage = parentMessageById.get(channel.parentMessageId);
    const parentChannel = parentMessage
      ? parentChannelById.get(parentMessage.channelId)
      : undefined;
    if (!parentMessage || !isEligiblePublicChannel(parentChannel, carriedFromPreviousManifest)) {
      validationErrors.add(`Wiki source ref ${ref.messageId} has no eligible public parent`);
      continue;
    }
    const expectedRef = `#${parentChannel!.name}:${channel.parentMessageId.slice(0, 8)}`;
    if (ref.slockRef !== expectedRef) {
      validationErrors.add(`Wiki source ref ${ref.messageId} must use ${expectedRef}`);
    }
    // A thread has its own channel row, but coverage is recorded against the
    // parent channel — a channel's coverage stands for the channel and all of
    // its threads, which is what keeps the manifest from needing one entry per
    // thread.
    const coverageError = wikiRefCoverageError(manifest.coverage, parentChannel!.id, ref);
    if (coverageError) validationErrors.add(coverageError);
  }
  throwWikiSourceValidationErrors(validationErrors);
}

function throwWikiSourceValidationErrors(errors: Set<string>): void {
  if (errors.size === 0) return;
  const messages = [...errors];
  throw new WikiError(
    "bad_request",
    messages.length === 1
      ? messages[0]!
      : `Wiki publication has ${messages.length} source validation errors:\n- ${messages.join("\n- ")}`,
  );
}

/**
 * Membership, not magnitude: a reference is admissible only when the channel it
 * belongs to is covered at that sequence. A single cursor let coverage of one
 * channel vouch for every other; this cannot.
 */
function wikiRefCoverageError(
  coverage: WikiCoverage,
  coverageChannelId: string,
  ref: { messageId: string; seq: number },
): string | null {
  return coverageIncludesSeq(coverage, coverageChannelId, ref.seq)
    ? null
    : `Wiki source ref ${ref.messageId} is outside the committed coverage for channel ${coverageChannelId}`;
}

export async function getWikiAgentManifest(serverId: string, agentId: string) {
  if (!await isWikiFeatureEnabledForServer(serverId)) {
    throw new WikiError("not_found", "Wiki is not available on this server");
  }
  const row = await getSpaceWithRefs(serverId);
  if (!row || row.space.wikiAgentId !== agentId) {
    throw new WikiError("forbidden", "Only the configured Wiki Agent can access this manifest");
  }
  const snapshot = await readCurrentManifest(serverId);
  return {
    configured: true,
    wikiSpaceId: row.space.id,
    etag: snapshot?.etag ?? null,
    manifest: snapshot?.manifest ?? null,
  };
}

export async function getWikiAgentArtifact(
  serverId: string,
  agentId: string,
  artifactId: string,
) {
  if (!await isWikiFeatureEnabledForServer(serverId)) {
    throw new WikiError("not_found", "Wiki is not available on this server");
  }
  const row = await getSpaceWithRefs(serverId);
  if (!row || row.space.wikiAgentId !== agentId) {
    throw new WikiError("forbidden", "Only the configured Wiki Agent can read Wiki documents");
  }
  const snapshot = await readCurrentManifest(serverId);
  if (!snapshot) throw new WikiError("not_found", "Wiki document not found");
  const document = await readCurrentArtifact(snapshot, artifactId);
  return {
    configured: true as const,
    wikiSpaceId: row.space.id,
    etag: snapshot.etag,
    artifact: serializeArtifact(document.artifact),
    markdown: document.markdown,
  };
}

export async function publishWikiAgentManifest(input: {
  serverId: string;
  agentId: string;
  expectedEtag: string | null;
  manifest: unknown;
  revisionBodies: WikiRevisionBody[];
}) {
  if (!await isWikiFeatureEnabledForServer(input.serverId)) {
    throw new WikiError("not_found", "Wiki is not available on this server");
  }
  const row = await getSpaceWithRefs(input.serverId);
  if (!row || row.space.wikiAgentId !== input.agentId) {
    throw new WikiError("forbidden", "Only the configured Wiki Agent can publish this manifest");
  }
  let manifest: WikiManifest;
  try {
    manifest = parseWikiManifest(input.manifest);
    const committed = await readWikiManifest(input.serverId);
    await assertManifestSourceRefsEligible(
      row.space,
      manifest,
      committedSourceRefKeys(committed?.manifest ?? null),
    );
    await assertWikiFirstPublicationIsAllowed(input.serverId, committed !== null);
    const snapshot = await publishWikiManifest({
      serverId: input.serverId,
      wikiSpaceId: row.space.id,
      agentId: input.agentId,
      expectedEtag: input.expectedEtag,
      manifest: input.manifest,
      revisionBodies: input.revisionBodies,
    });
    try {
      await getDb()
        .update(wikiBindings)
        .set({ status: "active", updatedAt: currentDate() })
        .where(and(
          eq(wikiBindings.id, row.space.id),
          eq(wikiBindings.serverId, input.serverId),
          eq(wikiBindings.wikiAgentId, input.agentId),
        ));
    } catch (error) {
      // The S3 manifest CAS above is the publication commit point. Do not turn
      // a committed publication into an apparent failure that callers would
      // retry with a stale ETag; status reads derive Active from the manifest.
      console.error("[wiki] manifest committed but coarse DB status update failed:", error);
    }
    return {
      configured: true,
      wikiSpaceId: row.space.id,
      etag: snapshot.etag,
      manifest: snapshot.manifest,
    };
  } catch (error) {
    if (error instanceof WikiError) throw error;
    if (error instanceof WikiManifestConflictError) {
      throw new WikiError("conflict", error.message);
    }
    if (error instanceof WikiManifestValidationError) {
      throw new WikiError("bad_request", error.message);
    }
    console.error("[wiki] failed to publish canonical manifest:", error);
    throw new WikiError("storage_unavailable", "Wiki manifest storage could not be published");
  }
}

export function makeWikiSpaceIdForTests(): string {
  return randomUUID();
}
