/**
 * Legacy reminders → Reminder App, one server at a time, when that server
 * installs the Reminder App (#raft-antiproton:ad71df22; import contract:
 * reminder-app `docs/legacy-import.md`).
 *
 * Per installation, per run:
 *   1. select the server's recurring legacy reminders, plus its overdue one-time
 *      reminders a Computer was sent but never fired (`oneTimeLate`). Rows whose
 *      payload has a `kind` are server-internal and never move; reminders of a
 *      deleted agent are voided (canceled) instead;
 *   2. give each owner agent the Reminder App's notification grant
 *      (`grant_source = legacy_import`) BEFORE importing, so the first delivery
 *      finds it; an owner a person revoked the app for is skipped entirely;
 *   3. import in batches; `imported` and `duplicate` rows are marked `migrated`
 *      (the arm watchdog then tells the Computer to drop its copy); `conflict`
 *      and `rejected` stay legacy and are reported.
 * A run completes when nothing is left to retry. Completion is what turns the
 * server over to the Reminder App (`reminderAppActiveForServer`); until then the
 * legacy commands keep working.
 */
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../../db/index";
import {
  agents,
  channelAgents,
  channels,
  messages,
  oauthAgentAutoGrantBlocks,
  oauthClientInstalls,
  oauthClients,
  oauthGrants,
  officialAppRegistry,
  reminderAppMigrations,
  reminders,
  servers,
} from "../../db/schema";
import { getJointThreadProjectionByLocalThread, resolveAgentFacingDmRefs } from "../../services/channelService";
import { cancelReminder, markReminderMigrated, type ReminderRow, type TimeProvider } from "./service";
import { recordIntegrationAuditEvent } from "../../services/integrationAuditService";
import { oauthClientHasKey } from "../../services/oauthClientKeys";

export const REMINDER_APP_NOTIFICATION_SCOPE = "agent:notification:write";
const BATCH_SIZE = 200;
/** A reminder due this soon is left for the legacy system to fire first (next run). */
const DUE_SOON_MS = 10 * 60_000;
/** A one-time reminder is "late" once it is this overdue and still armed. */
const LATE_AFTER_MS = 24 * 60 * 60_000;
/**
 * How long a claimed run holds its row before another worker may retry it. A
 * run renews it before every step, so a long run keeps it; a
 * worker that lost it stops at its next step and writes nothing more.
 */
const RUN_LEASE_MS = 10 * 60_000;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export interface ReminderAppMigrationConfig {
  /** The Reminder App's public OAuth client id (`oauth_clients.client_id`). */
  clientId: string;
  /** Needed only to migrate (`live`); a dry run never calls the import. */
  importUrl: string | null;
  token: string | null;
  /** `dry_run` (default): report the plan, write nothing. `live`: migrate. */
  mode: "dry_run" | "live";
  /** `live` was asked for without the import settings: running as a dry run. */
  liveBlockedReason: "import_settings_missing" | null;
  /** Servers the job may touch; `"*"` for all. Unset: none. */
  servers: ReadonlySet<string> | "*";
}

/**
 * Null without `REMINDER_APP_CLIENT_ID`: the migration (and the install-based
 * switch) is off. The client id alone allows a dry run; migrating (`live`) also
 * needs the import URL and token, and asking for `live` without them stays a
 * dry run. Nothing migrates by configuration alone: the mode defaults to
 * `dry_run` and the server allowlist to none.
 */
export function readReminderAppMigrationConfig(env: NodeJS.ProcessEnv = process.env): ReminderAppMigrationConfig | null {
  const clientId = env.REMINDER_APP_CLIENT_ID?.trim();
  if (!clientId) return null;
  const importUrl = env.REMINDER_APP_IMPORT_URL?.trim() || null;
  const token = env.REMINDER_APP_IMPORT_TOKEN?.trim() || null;
  const wantsLive = env.REMINDER_APP_MIGRATION_MODE?.trim() === "live";
  const liveBlockedReason = wantsLive && (!importUrl || !token) ? "import_settings_missing" as const : null;
  const mode = wantsLive && !liveBlockedReason ? "live" : "dry_run";
  const rawServers = env.REMINDER_APP_MIGRATION_SERVERS?.trim() ?? "";
  const servers = rawServers === "*"
    ? "*" as const
    : new Set(rawServers.split(",").map((id) => id.trim()).filter(Boolean));
  return { clientId, importUrl, token, mode, liveBlockedReason, servers };
}

export function reminderAppMigrationAllowsServer(config: ReminderAppMigrationConfig, serverId: string): boolean {
  return config.servers === "*" || config.servers.has(serverId);
}

export interface ReminderAppInstall {
  installId: string;
  serverId: string;
  /** Internal `oauth_clients.id`. */
  clientUuid: string;
  clientCreatedByUserId: string;
  approvedScopes: string[];
}

/** The server's active Reminder App installation, if any. */
export async function findActiveReminderAppInstall(
  serverId: string,
  clientId: string,
  db: DatabaseExecutor = getDb(),
): Promise<ReminderAppInstall | null> {
  const [row] = await db.select({
    installId: oauthClientInstalls.id,
    serverId: oauthClientInstalls.serverId,
    clientUuid: oauthClients.id,
    clientCreatedByUserId: oauthClients.createdByUserId,
    approvedScopes: oauthClientInstalls.approvedScopes,
  })
    .from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .where(and(
      eq(oauthClientInstalls.serverId, serverId),
      eq(oauthClientInstalls.status, "active"),
      oauthClientHasKey(clientId),
      eq(oauthClients.enabled, true),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Whether this server's reminders have moved to the Reminder App by
 * installation: the app is installed and that installation's migration
 * completed. (The `reminder_app` flag is the other way; see
 * `reminderAppActiveForServer`.)
 */
export async function reminderAppMigratedForServer(
  serverId: string,
  config: ReminderAppMigrationConfig | null = readReminderAppMigrationConfig(),
  db: DatabaseExecutor = getDb(),
): Promise<boolean> {
  if (!config) return false;
  const install = await findActiveReminderAppInstall(serverId, config.clientId, db);
  if (!install) return false;
  const [run] = await db.select({ state: reminderAppMigrations.state }).from(reminderAppMigrations)
    .where(and(eq(reminderAppMigrations.serverId, serverId), eq(reminderAppMigrations.installId, install.installId)))
    .limit(1);
  return run?.state === "completed";
}

/** Installations with no completed run whose (re)try is due. */
export async function listDueReminderAppInstalls(
  config: ReminderAppMigrationConfig,
  opts: { now: Date; limit: number; db?: DatabaseExecutor },
): Promise<ReminderAppInstall[]> {
  const db = opts.db ?? getDb();
  // The server allowlist filters in SQL, before the LIMIT: filtering after it
  // could leave allowlisted servers behind a page of other due installations.
  if (config.servers !== "*" && config.servers.size === 0) return [];
  const rows = await db.select({
    installId: oauthClientInstalls.id,
    serverId: oauthClientInstalls.serverId,
    clientUuid: oauthClients.id,
    clientCreatedByUserId: oauthClients.createdByUserId,
    approvedScopes: oauthClientInstalls.approvedScopes,
  })
    .from(oauthClientInstalls)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthClientInstalls.clientId))
    .leftJoin(reminderAppMigrations, and(
      eq(reminderAppMigrations.serverId, oauthClientInstalls.serverId),
      eq(reminderAppMigrations.installId, oauthClientInstalls.id),
    ))
    .where(and(
      eq(oauthClientInstalls.status, "active"),
      oauthClientHasKey(config.clientId),
      eq(oauthClients.enabled, true),
      config.servers === "*" ? undefined : inArray(oauthClientInstalls.serverId, [...config.servers]),
      or(
        isNull(reminderAppMigrations.id),
        and(
          sql`${reminderAppMigrations.state} <> 'completed'`,
          or(isNull(reminderAppMigrations.nextAttemptAt), lte(reminderAppMigrations.nextAttemptAt, opts.now)),
        ),
      ),
    ))
    .orderBy(asc(oauthClientInstalls.createdAt))
    .limit(opts.limit);
  return rows;
}

/** Claim one installation's run (insert or take over a due retry). Null: someone else holds it. */
async function claimRun(install: ReminderAppInstall, now: Date, db: DatabaseExecutor) {
  const leaseUntil = new Date(now.getTime() + RUN_LEASE_MS);
  const [claimed] = await db.insert(reminderAppMigrations).values({
    serverId: install.serverId,
    installId: install.installId,
    state: "running",
    attempts: 1,
    nextAttemptAt: leaseUntil,
    startedAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: [reminderAppMigrations.serverId, reminderAppMigrations.installId],
    set: {
      state: "running",
      attempts: sql`${reminderAppMigrations.attempts} + 1`,
      nextAttemptAt: leaseUntil,
      updatedAt: now,
    },
    setWhere: and(
      sql`${reminderAppMigrations.state} <> 'completed'`,
      or(isNull(reminderAppMigrations.nextAttemptAt), lte(reminderAppMigrations.nextAttemptAt, now)),
    ),
  }).returning();
  return claimed ?? null;
}

export type ReminderAppMigrationCounts = Record<string, number>;

export interface ReminderAppMigrationOutcome {
  state: "completed" | "failed" | "running";
  counts: ReminderAppMigrationCounts;
  errorCode: string | null;
}

export interface ReminderAppImportItem {
  legacyId: string;
  kind: "recurring" | "oneTimeLate";
  owner: { agentId: string; agentName: string; displayName?: string };
  createdBy: { type: "agent" | "human"; id: string };
  title: string;
  payload: unknown;
  anchor: null | {
    targetChannelId?: string;
    msgId?: string;
    resolved: null | { channelType: "channel" | "dm"; channelName: string; messageId?: string; threadId?: string };
  };
  fireAt: string;
  recurrence?: unknown;
}

export interface ReminderAppImportItemResult {
  legacyId: string;
  status: "imported" | "duplicate" | "conflict" | "rejected";
  reminderId?: string;
  code?: string;
}

export type ReminderAppImportResponse =
  | { kind: "ok"; items: ReminderAppImportItemResult[] }
  /** Final for this server (no retry until something changes): reported. */
  | { kind: "refused"; status: number; code: string }
  /** Network / 5xx / unexpected: retry later with backoff. */
  | { kind: "retry"; code: string };

export type ReminderAppImportFn = (input: {
  config: ReminderAppMigrationConfig;
  body: { batchId: string; serverId: string; serverSlug: string; items: ReminderAppImportItem[] };
}) => Promise<ReminderAppImportResponse>;

/** POST one batch to the Reminder App's platform import endpoint. */
export const postReminderAppImport: ReminderAppImportFn = async ({ config, body }) => {
  if (!config.importUrl || !config.token) return { kind: "refused", status: 0, code: "import_settings_missing" };
  let res: Response;
  try {
    res = await fetch(config.importUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    return { kind: "retry", code: error instanceof Error && error.name === "TimeoutError" ? "import_timeout" : "import_network_error" };
  }
  const parsed = await res.json().catch(() => null) as
    | { ok?: boolean; result?: { items?: ReminderAppImportItemResult[] }; error?: { code?: string } }
    | null;
  if (res.status === 200 && parsed?.ok === true && Array.isArray(parsed.result?.items)) {
    return { kind: "ok", items: parsed.result.items };
  }
  if (res.status >= 500 || res.status === 429) return { kind: "retry", code: `import_http_${res.status}` };
  // 404: the endpoint is off (no credential set there); 401/403/409/413: refused.
  return { kind: "refused", status: res.status, code: parsed?.error?.code ?? `import_http_${res.status}` };
};

interface Candidate {
  row: ReminderRow;
  kind: "recurring" | "oneTimeLate";
  agentName: string;
  agentDisplayName: string | null;
  agentDeleted: boolean;
}

/** The server's reminders that move: recurring ones, and one-time ones a Computer never fired. */
async function selectCandidates(serverId: string, now: Date, db: DatabaseExecutor): Promise<Candidate[]> {
  const notServerInternal = sql`(${reminders.payload} IS NULL OR json_typeof(${reminders.payload}) <> 'object' OR (${reminders.payload}::jsonb ->> 'kind') IS NULL)`;
  const lateBefore = new Date(now.getTime() - LATE_AFTER_MS);
  const rows = await db.select({
    row: reminders,
    agentName: agents.name,
    agentDisplayName: agents.displayName,
    agentDeletedAt: agents.deletedAt,
  })
    .from(reminders)
    .innerJoin(agents, eq(agents.id, reminders.ownerAgentId))
    .where(and(
      eq(reminders.serverId, serverId),
      eq(reminders.status, "scheduled"),
      notServerInternal,
      or(
        isNotNull(reminders.recurrence),
        and(
          isNull(reminders.recurrence),
          lte(reminders.fireAt, lateBefore),
          eq(reminders.armState, "armed"),
          sql`${reminders.armedVersion} = ${reminders.version}`,
        ),
      ),
    ))
    .orderBy(asc(reminders.createdAt));
  return rows.map((r) => ({
    row: r.row as ReminderRow,
    kind: r.row.recurrence ? "recurring" : "oneTimeLate",
    agentName: r.agentName,
    agentDisplayName: r.agentDisplayName,
    agentDeleted: r.agentDeletedAt !== null,
  }));
}

type ResolvedAnchor = NonNullable<ReminderAppImportItem["anchor"]>["resolved"];

/**
 * Each reminder's anchor in the Reminder App's shape, as the owner agent sees
 * it with `raft`: a channel name, or a DM peer (`name`, `name~agent|human` when
 * a human and an agent share it), a thread's parent short id, a message short
 * id. Null when the agent can no longer reach it (deleted, not a member).
 */
async function resolveImportAnchors(serverId: string, candidates: Candidate[], db: DatabaseExecutor) {
  const out = new Map<string, ResolvedAnchor>();
  const msgIds = [...new Set(candidates.map((c) => c.row.msgId).filter((x): x is string => !!x))];
  const msgChannel = new Map<string, string>();
  if (msgIds.length > 0) {
    const found = await db.select({ id: messages.id, channelId: messages.channelId }).from(messages).where(inArray(messages.id, msgIds));
    for (const m of found) msgChannel.set(m.id, m.channelId);
  }
  const surfaceOf = (c: Candidate) => c.row.targetChannelId ?? (c.row.msgId ? msgChannel.get(c.row.msgId) ?? null : null);
  const channelIds = [...new Set(candidates.map(surfaceOf).filter((x): x is string => !!x))];
  if (channelIds.length === 0) {
    for (const c of candidates) out.set(c.row.id, null);
    return out;
  }
  const chans = await db.select({
    id: channels.id,
    type: channels.type,
    name: channels.name,
    deletedAt: channels.deletedAt,
    parentMessageId: channels.parentMessageId,
    parentChannelId: channels.parentChannelId,
  }).from(channels).where(inArray(channels.id, channelIds));
  // A thread's parent channel: `parent_channel_id` (derived by a trigger from
  // `parent_message_id`). A joint (cross-server) thread's local projection has
  // neither, by design: its parent is the projection's local parent channel.
  // If only the derived column is missing, the parent message's channel is it.
  for (const c of chans) {
    if (c.type !== "thread" || c.parentChannelId) continue;
    if (c.parentMessageId) {
      const [parentMsg] = await db.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, c.parentMessageId)).limit(1);
      c.parentChannelId = parentMsg?.channelId ?? null;
    } else {
      const projection = await getJointThreadProjectionByLocalThread(c.id, serverId, db);
      c.parentChannelId = projection?.localParentChannelId ?? null;
    }
  }
  const byId = new Map(chans.map((c) => [c.id, c]));
  const parentIds = [...new Set(chans.map((c) => c.parentChannelId).filter((x): x is string => !!x))];
  const parents = parentIds.length > 0
    ? await db.select({ id: channels.id, type: channels.type, name: channels.name, deletedAt: channels.deletedAt })
      .from(channels).where(inArray(channels.id, parentIds))
    : [];
  const parentById = new Map(parents.map((p) => [p.id, p]));
  // Membership of the surface (or the thread's parent) per owner.
  const membershipChannelIds = [...new Set([...channelIds, ...parentIds])];
  const members = await db.select({ channelId: channelAgents.channelId, agentId: channelAgents.agentId })
    .from(channelAgents).where(inArray(channelAgents.channelId, membershipChannelIds));
  const memberKeys = new Set(members.map((m) => `${m.channelId}:${m.agentId}`));
  // DM faces are per owner: one batched lookup per owner.
  const dmFaces = new Map<string, Map<string, string>>();
  for (const owner of new Set(candidates.map((c) => c.row.ownerAgentId))) {
    const dmIds = new Set<string>();
    for (const c of candidates) {
      if (c.row.ownerAgentId !== owner) continue;
      const ch = byId.get(surfaceOf(c) ?? "");
      if (!ch) continue;
      if (ch.type === "dm") dmIds.add(ch.id);
      const parent = ch.parentChannelId ? parentById.get(ch.parentChannelId) : undefined;
      if (ch.type === "thread" && parent?.type === "dm") dmIds.add(parent.id);
    }
    if (dmIds.size > 0) dmFaces.set(owner, await resolveAgentFacingDmRefs(serverId, owner, [...dmIds]));
  }
  const face = (owner: string, ch: { id: string; type: string; name: string }): { channelType: "channel" | "dm"; channelName: string } | null => {
    if (ch.type === "dm") {
      const ref = dmFaces.get(owner)?.get(ch.id);
      return ref ? { channelType: "dm", channelName: ref.replace(/^dm:@/, "") } : null;
    }
    if (ch.type === "channel" || ch.type === "private" || ch.type === "joint") return { channelType: "channel", channelName: ch.name };
    return null;
  };
  for (const c of candidates) {
    const owner = c.row.ownerAgentId;
    const ch = byId.get(surfaceOf(c) ?? "");
    let resolved: ResolvedAnchor = null;
    if (ch && !ch.deletedAt) {
      const messageId = c.row.msgId && msgChannel.get(c.row.msgId) === ch.id ? c.row.msgId.slice(0, 8) : undefined;
      if (ch.type === "thread") {
        const parent = ch.parentChannelId ? parentById.get(ch.parentChannelId) : undefined;
        // The short id agents address the thread by on this server (`#parent:<id>`):
        // the thread channel's own name, as the agent-facing target formatter uses.
        const threadId = ch.name.startsWith("thread-") ? ch.name.slice("thread-".length) : ch.parentMessageId?.slice(0, 8);
        if (parent && !parent.deletedAt && threadId && memberKeys.has(`${parent.id}:${owner}`)) {
          const f = face(owner, parent);
          if (f) resolved = { ...f, threadId, ...(messageId ? { messageId } : {}) };
        }
      } else if (memberKeys.has(`${ch.id}:${owner}`)) {
        const f = face(owner, ch);
        if (f) resolved = { ...f, ...(messageId ? { messageId } : {}) };
      }
    }
    out.set(c.row.id, resolved);
  }
  return out;
}

/** Which owners still need the notification grant, and which a person revoked the app for (skipped). */
async function grantNeeds(
  install: ReminderAppInstall,
  ownerIds: string[],
  db: DatabaseExecutor,
): Promise<{ blocked: Set<string>; missing: string[] }> {
  const blocked = new Set<string>();
  if (ownerIds.length === 0) return { blocked, missing: [] };
  const blocks = await db.select({ agentId: oauthAgentAutoGrantBlocks.agentId }).from(oauthAgentAutoGrantBlocks)
    .where(and(eq(oauthAgentAutoGrantBlocks.clientId, install.clientUuid), inArray(oauthAgentAutoGrantBlocks.agentId, ownerIds)));
  for (const b of blocks) blocked.add(b.agentId);
  const live = await db.select({ agentId: oauthGrants.agentId, scopes: oauthGrants.scopes }).from(oauthGrants)
    .where(and(
      eq(oauthGrants.serverId, install.serverId),
      eq(oauthGrants.clientId, install.clientUuid),
      inArray(oauthGrants.agentId, ownerIds),
      isNull(oauthGrants.revokedAt),
    ));
  const covered = new Set(live.filter((g) => g.scopes.includes(REMINDER_APP_NOTIFICATION_SCOPE)).map((g) => g.agentId));
  return { blocked, missing: ownerIds.filter((id) => !blocked.has(id) && !covered.has(id)) };
}

/** The Reminder App's notification grant, recorded as coming from this import. */
async function createLegacyImportGrants(install: ReminderAppInstall, ownerIds: string[], now: Date, db: DatabaseExecutor): Promise<number> {
  if (ownerIds.length === 0) return 0;
  const created = await db.insert(oauthGrants).values(ownerIds.map((agentId) => ({
    serverId: install.serverId,
    agentId,
    clientId: install.clientUuid,
    scopes: [REMINDER_APP_NOTIFICATION_SCOPE],
    // As the app's own automatic grant does (`grantedByUserId: client.createdByUserId`).
    grantedByUserId: install.clientCreatedByUserId,
    grantSource: "legacy_import" as const,
    createdAt: now,
    updatedAt: now,
  }))).returning({ id: oauthGrants.id });
  // Audit item 3: the grants are made by the system on the installer's
  // approval, so record them like any other change to what an app may do.
  await recordIntegrationAuditEvent({
    serverId: install.serverId,
    clientId: install.clientUuid,
    eventType: "installation.legacy_import_grants_created",
    outcome: "success",
    source: "system",
    actor: { type: "system" },
    subject: { type: "app", id: install.clientUuid },
    target: { type: "installation", id: install.installId },
    metadata: { installationId: install.installId, grantCount: created.length, scopes: [REMINDER_APP_NOTIFICATION_SCOPE] },
  }, db as Parameters<typeof recordIntegrationAuditEvent>[1]);
  return created.length;
}

function bump(counts: ReminderAppMigrationCounts, key: string, by = 1) {
  counts[key] = (counts[key] ?? 0) + by;
}

interface ReminderAppMigrationPlan {
  serverSlug: string;
  candidates: Candidate[];
  /** Reminders of a deleted agent: voided, not moved. */
  voids: Candidate[];
  /** Recurring reminders due within DUE_SOON_MS: the legacy system fires them first. */
  dueSoon: Candidate[];
  /** Owners a person revoked the app for: all their reminders are skipped. */
  blockedOwners: Set<string>;
  /** Owners still needing the notification grant. */
  ownersToGrant: string[];
  toImport: Candidate[];
  anchors: Map<string, ResolvedAnchor>;
}

/** Everything the run would do, read-only (the dry run reports exactly this). */
async function planReminderAppMigration(
  install: ReminderAppInstall,
  serverSlug: string,
  now: Date,
  db: DatabaseExecutor,
): Promise<ReminderAppMigrationPlan> {
  const candidates = await selectCandidates(install.serverId, now, db);
  const voids = candidates.filter((c) => c.agentDeleted);
  const live = candidates.filter((c) => !c.agentDeleted);
  const dueSoonCutoff = now.getTime() + DUE_SOON_MS;
  const dueSoon = live.filter((c) => c.kind === "recurring" && c.row.fireAt.getTime() >= now.getTime() && c.row.fireAt.getTime() < dueSoonCutoff);
  const movable = live.filter((c) => !dueSoon.includes(c));
  const owners = [...new Set(movable.map((c) => c.row.ownerAgentId))];
  const { blocked, missing } = await grantNeeds(install, owners, db);
  const toImport = movable.filter((c) => !blocked.has(c.row.ownerAgentId));
  const anchors = await resolveImportAnchors(install.serverId, toImport, db);
  return { serverSlug, candidates, voids, dueSoon, blockedOwners: blocked, ownersToGrant: missing, toImport, anchors };
}

function planCounts(plan: ReminderAppMigrationPlan): ReminderAppMigrationCounts {
  const counts: ReminderAppMigrationCounts = {};
  bump(counts, "candidates", plan.candidates.length);
  bump(counts, "recurring", plan.toImport.filter((c) => c.kind === "recurring").length);
  bump(counts, "one_time_late", plan.toImport.filter((c) => c.kind === "oneTimeLate").length);
  bump(counts, "to_import", plan.toImport.length);
  bump(counts, "grants_to_create", plan.ownersToGrant.length);
  bump(counts, "voided_owner_deleted", plan.voids.length);
  bump(counts, "deferred_due_soon", plan.dueSoon.length);
  bump(counts, "skipped_grant_revoked", plan.candidates.filter((c) => !c.agentDeleted && plan.blockedOwners.has(c.row.ownerAgentId) && !plan.dueSoon.includes(c)).length);
  bump(counts, "anchor_unresolved", plan.toImport.filter((c) => (c.row.targetChannelId || c.row.msgId) && !plan.anchors.get(c.row.id)).length);
  return counts;
}

/**
 * Audit item 4: the Reminder App is recognized by its `client_id` alone. Until
 * it is an approved official app (the registry is empty today), report that
 * on every run so it shows in the dry run; it does not block the migration.
 */
async function reminderAppIsApprovedOfficial(install: ReminderAppInstall, db: DatabaseExecutor): Promise<boolean> {
  const [row] = await db.select({ status: officialAppRegistry.status }).from(officialAppRegistry)
    .where(eq(officialAppRegistry.oauthClientId, install.clientUuid)).limit(1);
  return row?.status === "approved";
}

/** The dry run: the plan's counts, nothing written. */
export async function planReminderAppMigrationReport(
  install: ReminderAppInstall,
  input: { clock: TimeProvider; db?: DatabaseExecutor },
): Promise<{ counts: ReminderAppMigrationCounts; errorCode: string | null }> {
  const db = input.db ?? getDb();
  if (!install.approvedScopes.includes(REMINDER_APP_NOTIFICATION_SCOPE)) return { counts: {}, errorCode: "notification_scope_not_approved" };
  const [server] = await db.select({ slug: servers.slug }).from(servers).where(eq(servers.id, install.serverId));
  if (!server) return { counts: {}, errorCode: "server_missing" };
  const plan = await planReminderAppMigration(install, server.slug, input.clock.now(), db);
  const counts = planCounts(plan);
  if (!await reminderAppIsApprovedOfficial(install, db)) bump(counts, "reminder_app_not_official");
  return { counts, errorCode: null };
}

/** Migrate one installation's server (live). Never throws for expected outcomes; the run row records them. */
export async function runReminderAppMigration(
  install: ReminderAppInstall,
  input: { config: ReminderAppMigrationConfig; clock: TimeProvider; importFn?: ReminderAppImportFn; db?: DatabaseExecutor },
): Promise<ReminderAppMigrationOutcome | null> {
  const db = input.db ?? getDb();
  const importFn = input.importFn ?? postReminderAppImport;
  const now = input.clock.now();
  const run = await claimRun(install, now, db);
  if (!run) return null;

  // This run owns the row only while it is still `running` at the
  // `attempts` it claimed (every claim increments it). Each renewal and the
  // final write are conditional on that, so after a lost lease a slow worker
  // cannot overwrite the run that took over.
  const ownsRun = and(
    eq(reminderAppMigrations.id, run.id),
    eq(reminderAppMigrations.attempts, run.attempts),
    eq(reminderAppMigrations.state, "running"),
  );
  const renewLease = async (): Promise<boolean> => {
    const renewedAt = input.clock.now();
    const renewed = await db.update(reminderAppMigrations)
      .set({ nextAttemptAt: new Date(renewedAt.getTime() + RUN_LEASE_MS), updatedAt: renewedAt })
      .where(ownsRun)
      .returning({ id: reminderAppMigrations.id });
    return renewed.length > 0;
  };

  let counts: ReminderAppMigrationCounts = {};
  const finish = async (state: ReminderAppMigrationOutcome["state"], errorCode: string | null): Promise<ReminderAppMigrationOutcome | null> => {
    const finishedAt = input.clock.now();
    const backoff = RETRY_BACKOFF_MS[Math.min(run.attempts - 1, RETRY_BACKOFF_MS.length - 1)];
    const written = await db.update(reminderAppMigrations).set({
      state,
      counts,
      lastErrorCode: errorCode,
      nextAttemptAt: state === "completed" ? null
        : state === "running" ? new Date(finishedAt.getTime() + DUE_SOON_MS + 60_000)
          : new Date(finishedAt.getTime() + backoff),
      completedAt: state === "completed" ? finishedAt : null,
      updatedAt: finishedAt,
    }).where(ownsRun).returning({ id: reminderAppMigrations.id });
    // Lost the lease: the run that took over owns the outcome.
    return written.length > 0 ? { state, counts, errorCode } : null;
  };

  if (!install.approvedScopes.includes(REMINDER_APP_NOTIFICATION_SCOPE)) {
    // The installer never approved notifications for this app: nothing it imports could reach an agent.
    return finish("failed", "notification_scope_not_approved");
  }
  const [server] = await db.select({ slug: servers.slug }).from(servers).where(eq(servers.id, install.serverId));
  if (!server) return finish("failed", "server_missing");

  const plan = await planReminderAppMigration(install, server.slug, now, db);
  counts = planCounts(plan);
  counts.voided_owner_deleted = 0;
  if (!await reminderAppIsApprovedOfficial(install, db)) bump(counts, "reminder_app_not_official");

  if (!await renewLease()) return null;
  for (const c of plan.voids) {
    const voided = await cancelReminder(c.row.id, {
      expectedVersion: c.row.version,
      actor: { type: "system", id: null },
      clock: input.clock,
      executor: db,
    });
    bump(counts, voided ? "voided_owner_deleted" : "changed_during_run");
  }
  // The grant exists before the import, so the first delivery (a late one fires at once) finds it.
  // Renewed right before, so two workers never both create grants (oauth_grants has no unique key).
  if (!await renewLease()) return null;
  bump(counts, "grants_created", await createLegacyImportGrants(install, plan.ownersToGrant, now, db));

  let retryCode: string | null = null;
  for (let i = 0; i < plan.toImport.length; i += BATCH_SIZE) {
    const batch = plan.toImport.slice(i, i + BATCH_SIZE);
    const batchId = `raft_${run.id.slice(0, 8)}_${run.attempts}_${i / BATCH_SIZE}`;
    const byLegacyId = new Map(batch.map((c) => [c.row.id, c]));
    if (!await renewLease()) return null;
    const response = await importFn({
      config: input.config,
      body: {
        batchId,
        serverId: install.serverId,
        serverSlug: plan.serverSlug,
        items: batch.map((c) => toImportItem(c, plan.anchors.get(c.row.id) ?? null)),
      },
    });
    if (response.kind === "retry") {
      retryCode = response.code;
      break;
    }
    if (response.kind === "refused") {
      bump(counts, `refused_${response.code}`);
      return finish("failed", response.code);
    }
    for (const item of response.items) {
      const candidate = byLegacyId.get(item.legacyId);
      if (!candidate) continue;
      bump(counts, item.status);
      if (item.status === "conflict" || item.status === "rejected") {
        if (item.code) bump(counts, `${item.status}_${item.code}`);
        continue;
      }
      // imported or duplicate: the app holds it (a duplicate means an earlier run imported it).
      const marked = await markReminderMigrated(candidate.row.id, { appReminderId: item.reminderId ?? "", batchId }, {
        expectedVersion: candidate.row.version,
        actor: { type: "system", id: null },
        clock: input.clock,
        executor: db,
      });
      bump(counts, marked ? "marked_migrated" : "changed_during_run");
    }
  }
  if (retryCode) return finish("failed", retryCode);
  // Deferred rows (and rows that changed under us) need another pass before the switch.
  if ((counts.deferred_due_soon ?? 0) > 0 || (counts.changed_during_run ?? 0) > 0) return finish("running", null);
  return finish("completed", null);
}

function toImportItem(c: Candidate, resolved: ResolvedAnchor): ReminderAppImportItem {
  return {
    legacyId: c.row.id,
    kind: c.kind,
    owner: { agentId: c.row.ownerAgentId, agentName: c.agentName, ...(c.agentDisplayName ? { displayName: c.agentDisplayName } : {}) },
    createdBy: { type: c.row.createdByType, id: c.row.createdById },
    title: c.row.title,
    payload: c.row.payload ?? null,
    anchor: c.row.targetChannelId || c.row.msgId
      ? {
        ...(c.row.targetChannelId ? { targetChannelId: c.row.targetChannelId } : {}),
        ...(c.row.msgId ? { msgId: c.row.msgId } : {}),
        resolved,
      }
      : null,
    fireAt: c.row.fireAt.toISOString(),
    ...(c.kind === "recurring" ? { recurrence: c.row.recurrence } : {}),
  };
}

