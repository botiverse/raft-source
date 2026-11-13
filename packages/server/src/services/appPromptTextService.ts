// App prompt text consent (task #4, #proj-apps). An app's name, description
// and whenToUse go into the system prompt of every agent on a Server that
// installed it. Each edit becomes an immutable oauth_app_text_revisions row:
//
// - A published marketplace app's edit waits for Raft's marketplace review;
//   until it is approved, oauth_clients keeps the previous text, so every
//   reader (marketplace, cards, search) still shows what was approved.
// - Every other edit takes effect at once as the new current revision.
// - Each installing Server's admin then confirms the current revision. Agents
//   read the revision their Server confirmed, never the live text, so an
//   unconfirmed edit leaves the previous confirmed text in place.
//
// The app_prompt_text_consent flag is per Server. While it is off for a
// Server, that Server behaves as before: every change counts as confirmed
// there (advanceConfirmationsWhereConsentOff) and its agents read the app's
// current text.
import { currentDate } from "@botiverse/raft-shared";
import { and, eq, inArray, isNotNull, isNull, sql, type AnyColumn } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { oauthAppTextRevisions, oauthClientInstalls, oauthClients } from "../db/schema";
import { APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, evaluateFeatureFlag } from "./featureFlagService";
import * as integrationAuditService from "./integrationAuditService";
import { announcePermissionUpdatesChanged, announcePermissionUpdatesForApp } from "./listChangedRealtime";

type Db = ReturnType<typeof getDb>;
/** A transaction or the database: every helper below runs inside its caller's transaction. */
type Tx = DatabaseExecutor;

export type AppPromptText = {
  name: string;
  description: string | null;
  whenToUse: string | null;
};

export type AppTextRevision = typeof oauthAppTextRevisions.$inferSelect;

export type PromptTextActor = { type: "human" | "agent" | "system"; id: string | null };

export const PROMPT_TEXT_REVIEW_STALE = "PROMPT_TEXT_REVIEW_STALE";

let consentEvaluatorForTests: ((serverId: string) => Promise<boolean>) | null = null;

/** Tests make the flag evaluation throw to prove the write paths fail closed. */
export function __setPromptTextConsentEvaluatorForTests(evaluator: ((serverId: string) => Promise<boolean>) | null) {
  consentEvaluatorForTests = evaluator;
}

async function evaluateConsent(serverId: string, executor?: DatabaseExecutor): Promise<boolean> {
  if (consentEvaluatorForTests) return consentEvaluatorForTests(serverId);
  return (await evaluateFeatureFlag({ key: APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY, serverId }, executor)).enabled === true;
}

/**
 * Read paths (what agents and screens see): off when the evaluation fails.
 * That is transient and shows what the Server showed before task #4.
 */
export async function promptTextConsentEnabled(serverId: string, executor?: DatabaseExecutor): Promise<boolean> {
  try {
    return await evaluateConsent(serverId, executor);
  } catch (error) {
    console.warn(`[appPromptText] ${APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY} evaluation failed; reading as off`, error);
    return false;
  }
}

/**
 * Write paths (review gating, counting a change as confirmed, an install
 * without the shown revision): ON when the evaluation fails. A failed read
 * must never skip review or record a confirmation nobody gave, and what it
 * writes is permanent.
 */
export async function promptTextConsentForWrite(serverId: string, executor?: DatabaseExecutor): Promise<boolean> {
  try {
    return await evaluateConsent(serverId, executor);
  } catch (error) {
    console.warn(`[appPromptText] ${APP_PROMPT_TEXT_CONSENT_FEATURE_FLAG_KEY} evaluation failed; treating it as on for this write`, error);
    return true;
  }
}

/** Marketplace review applies to an app in the public marketplace lifecycle. */
export function promptTextReviewApplies(client: { appType: string; publishStatus: string }): boolean {
  return client.appType === "third_party_global"
    && (client.publishStatus === "published" || client.publishStatus === "unpublish_requested");
}

export function promptTextOf(row: { name: string; description: string | null; whenToUse: string | null }): AppPromptText {
  return { name: row.name, description: row.description ?? null, whenToUse: row.whenToUse ?? null };
}

function samePromptText(left: AppPromptText, right: AppPromptText): boolean {
  return left.name === right.name && left.description === right.description && left.whenToUse === right.whenToUse;
}

async function lockClientText(tx: Tx, clientId: string) {
  const [client] = await tx.select({
    id: oauthClients.id,
    serverId: oauthClients.serverId,
    appType: oauthClients.appType,
    publishStatus: oauthClients.publishStatus,
    name: oauthClients.name,
    description: oauthClients.description,
    whenToUse: oauthClients.whenToUse,
    textRevision: oauthClients.textRevision,
    textCurrentRevisionId: oauthClients.textCurrentRevisionId,
    textPendingRevisionId: oauthClients.textPendingRevisionId,
    localConfirmedTextRevisionId: oauthClients.localConfirmedTextRevisionId,
  }).from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1).for("update");
  return client ?? null;
}

/**
 * The app's current revision id. An app the previous release created after
 * migration 0382 ran has none yet: it gets revision 1 from its live text, and
 * its source Server counts as having confirmed it, as the backfill does.
 */
export async function ensureCurrentTextRevision(tx: Tx, clientId: string): Promise<{ revisionId: string; text: AppPromptText }> {
  const [existing] = await tx.select({
    textCurrentRevisionId: oauthClients.textCurrentRevisionId,
    name: oauthClients.name,
    description: oauthClients.description,
    whenToUse: oauthClients.whenToUse,
  }).from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  if (existing?.textCurrentRevisionId) return { revisionId: existing.textCurrentRevisionId, text: promptTextOf(existing) };
  const client = await lockClientText(tx, clientId);
  if (!client) throw new Error(`OAuth client ${clientId} not found`);
  const text = promptTextOf(client);
  if (client.textCurrentRevisionId) return { revisionId: client.textCurrentRevisionId, text };
  const revision = client.textRevision + 1;
  const [row] = await tx.insert(oauthAppTextRevisions).values({
    clientId,
    revision,
    ...text,
    state: "active",
    createdByType: "system",
  }).returning({ id: oauthAppTextRevisions.id });
  await tx.update(oauthClients).set({
    textRevision: revision,
    textCurrentRevisionId: row!.id,
    localConfirmedTextRevisionId: client.localConfirmedTextRevisionId ?? row!.id,
  }).where(eq(oauthClients.id, clientId));
  return { revisionId: row!.id, text };
}

/**
 * Install-row fields for an installation the platform or the app's own
 * Server creates without an admin reading a confirmation screen (official
 * auto-install, the publisher's source installation): it counts as having
 * confirmed the current text, like every installation that existed at deploy.
 */
export async function currentTextConfirmation(tx: Tx, clientId: string, userId: string | null = null) {
  const { revisionId } = await ensureCurrentTextRevision(tx, clientId);
  return { confirmedTextRevisionId: revisionId, textConfirmedByUserId: userId, textConfirmedAt: currentDate() };
}

/**
 * Servers whose flag is off keep today's behavior: whatever the app's text
 * becomes counts as confirmed there, so turning the flag on later never
 * rewinds their agents to older text.
 */
async function advanceConfirmationsWhereConsentOff(tx: Tx, input: {
  clientId: string;
  sourceServerId: string;
  revisionId: string;
}) {
  const installs = await tx.select({ id: oauthClientInstalls.id, serverId: oauthClientInstalls.serverId })
    .from(oauthClientInstalls)
    .where(eq(oauthClientInstalls.clientId, input.clientId));
  const serverIds = [...new Set([input.sourceServerId, ...installs.map((install) => install.serverId)])];
  const offServerIds = new Set<string>();
  for (const serverId of serverIds) {
    if (!await promptTextConsentForWrite(serverId, tx)) offServerIds.add(serverId);
  }
  const offInstallIds = installs.filter((install) => offServerIds.has(install.serverId)).map((install) => install.id);
  const now = currentDate();
  if (offInstallIds.length > 0) {
    await tx.update(oauthClientInstalls).set({
      confirmedTextRevisionId: input.revisionId,
      textConfirmedByUserId: null,
      textConfirmedAt: now,
      updatedAt: now,
    }).where(inArray(oauthClientInstalls.id, offInstallIds));
  }
  if (offServerIds.has(input.sourceServerId)) {
    await tx.update(oauthClients).set({ localConfirmedTextRevisionId: input.revisionId })
      .where(eq(oauthClients.id, input.clientId));
  }
}

/**
 * An App with no When to use stays out of the agent prompt, but agents still
 * read the confirmed name and description from their integration list. So an
 * edit gives an admin nothing to confirm when it shows agents nothing new:
 * When to use is empty before and after, and the description is the one
 * confirmed (with nothing confirmed, agents get no description, so the new one
 * must be empty too). Then the confirmation moves along. Otherwise it stays.
 */
async function advanceConfirmationsOfUnchangedAgentText(tx: Tx, input: {
  clientId: string;
  revisionId: string;
  text: AppPromptText;
}) {
  if (input.text.whenToUse?.trim()) return;
  const description = input.text.description?.trim() ?? "";
  const showsNothingNew = (confirmed: AnyColumn) => sql`(
    (${confirmed} IS NULL AND ${description} = '')
    OR EXISTS (
      SELECT 1 FROM ${oauthAppTextRevisions}
       WHERE ${oauthAppTextRevisions.id} = ${confirmed}
         AND coalesce(btrim(${oauthAppTextRevisions.whenToUse}), '') = ''
         AND coalesce(btrim(${oauthAppTextRevisions.description}), '') = ${description}
    )
  )`;
  const now = currentDate();
  await tx.update(oauthClientInstalls).set({
    confirmedTextRevisionId: input.revisionId,
    textConfirmedByUserId: null,
    textConfirmedAt: now,
    updatedAt: now,
  }).where(and(
    eq(oauthClientInstalls.clientId, input.clientId),
    sql`${oauthClientInstalls.confirmedTextRevisionId} IS DISTINCT FROM ${input.revisionId}::uuid`,
    showsNothingNew(oauthClientInstalls.confirmedTextRevisionId),
  ));
  await tx.update(oauthClients).set({ localConfirmedTextRevisionId: input.revisionId }).where(and(
    eq(oauthClients.id, input.clientId),
    sql`${oauthClients.localConfirmedTextRevisionId} IS DISTINCT FROM ${input.revisionId}::uuid`,
    showsNothingNew(oauthClients.localConfirmedTextRevisionId),
  ));
}

/** The source Server confirms: its server_local slot and its own installation row, if any. */
async function confirmForSourceServer(tx: Tx, input: {
  clientId: string;
  sourceServerId: string;
  revisionId: string;
  userId: string | null;
}) {
  const now = currentDate();
  await tx.update(oauthClients).set({ localConfirmedTextRevisionId: input.revisionId })
    .where(eq(oauthClients.id, input.clientId));
  await tx.update(oauthClientInstalls).set({
    confirmedTextRevisionId: input.revisionId,
    textConfirmedByUserId: input.userId,
    textConfirmedAt: now,
    updatedAt: now,
  }).where(and(
    eq(oauthClientInstalls.clientId, input.clientId),
    eq(oauthClientInstalls.serverId, input.sourceServerId),
  ));
  announcePermissionUpdatesChanged([input.sourceServerId]);
}

export type PromptTextEditResult =
  | { kind: "unchanged" }
  | { kind: "applied"; revisionId: string }
  | { kind: "pending_review"; revisionId: string };

/**
 * Both app edit paths call this inside their transaction, with the
 * normalized `updates` they are about to write to oauth_clients. For an edit
 * that waits for review it REMOVES name/description/whenToUse from `updates`
 * (they stay as approved) and records the pending revision; otherwise it
 * records the new current revision. Either way it adds the revision pointers
 * to `updates`.
 *
 * `confirmsForSource`: a human admin saving on the app's own Server has read
 * what they wrote, so it counts as that Server's confirmation. An agent's
 * edit never does: a person on the Server confirms it.
 */
export async function recordPromptTextEdit(tx: Tx, input: {
  clientId: string;
  updates: Record<string, unknown>;
  actor: PromptTextActor;
  confirmsForSource: boolean;
}): Promise<PromptTextEditResult> {
  const before = await lockClientText(tx, input.clientId);
  if (!before) return { kind: "unchanged" };
  const has = (key: string) => Object.prototype.hasOwnProperty.call(input.updates, key) && input.updates[key] !== undefined;
  const next: AppPromptText = {
    name: has("name") ? input.updates.name as string : before.name,
    description: has("description") ? (input.updates.description as string | null) : before.description,
    whenToUse: has("whenToUse") ? (input.updates.whenToUse as string | null) : before.whenToUse,
  };
  if (samePromptText(next, promptTextOf(before))) return { kind: "unchanged" };

  const current = await ensureCurrentTextRevision(tx, before.id);
  const [counter] = await tx.select({ textRevision: oauthClients.textRevision })
    .from(oauthClients).where(eq(oauthClients.id, before.id)).limit(1);
  const revision = counter!.textRevision + 1;
  if (before.textPendingRevisionId) {
    await tx.update(oauthAppTextRevisions).set({ state: "superseded" }).where(and(
      eq(oauthAppTextRevisions.id, before.textPendingRevisionId),
      eq(oauthAppTextRevisions.state, "pending_review"),
    ));
  }

  const reviewed = promptTextReviewApplies(before) && await promptTextConsentForWrite(before.serverId, tx);
  const [row] = await tx.insert(oauthAppTextRevisions).values({
    clientId: before.id,
    revision,
    ...next,
    state: reviewed ? "pending_review" : "active",
    createdByType: input.actor.type,
    createdById: input.actor.id,
  }).returning({ id: oauthAppTextRevisions.id });
  const revisionId = row!.id;
  input.updates.textRevision = revision;

  if (reviewed) {
    delete input.updates.name;
    delete input.updates.description;
    delete input.updates.whenToUse;
    input.updates.textPendingRevisionId = revisionId;
    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: before.serverId,
      clientId: before.id,
      eventType: "app.prompt_text_requested",
      outcome: "success",
      source: "api",
      actor: { type: input.actor.type, id: input.actor.id },
      subject: { type: "app", id: before.id },
      target: { type: "app", id: before.id },
      metadata: { revision },
    }, tx);
    return { kind: "pending_review", revisionId };
  }

  await tx.update(oauthAppTextRevisions).set({ state: "superseded" })
    .where(eq(oauthAppTextRevisions.id, current.revisionId));
  input.updates.textCurrentRevisionId = revisionId;
  input.updates.textPendingRevisionId = null;
  if (input.confirmsForSource) {
    await confirmForSourceServer(tx, {
      clientId: before.id,
      sourceServerId: before.serverId,
      revisionId,
      userId: input.actor.type === "human" ? input.actor.id : null,
    });
  }
  await advanceConfirmationsWhereConsentOff(tx, { clientId: before.id, sourceServerId: before.serverId, revisionId });
  await advanceConfirmationsOfUnchangedAgentText(tx, { clientId: before.id, revisionId, text: next });
  // New current text: each installing Server's admins may have it to confirm.
  await announcePermissionUpdatesForApp(tx, before.id);
  return { kind: "applied", revisionId };
}

export type PromptTextReviewResult =
  | { kind: "not_found" }
  | { kind: "stale"; pendingRevisionId: string | null }
  | { kind: "approved"; revisionId: string }
  | { kind: "rejected"; revisionId: string };

/** A marketplace reviewer approves or rejects the pending edit they were shown. */
export async function reviewPendingPromptText(input: {
  clientId: string;
  reviewerUserId: string;
  decision: "approve" | "reject";
  expectedRevisionId: string;
  reason?: string | null;
}, db: Db = getDb()): Promise<PromptTextReviewResult> {
  return db.transaction(async (tx) => {
    const client = await lockClientText(tx, input.clientId);
    if (!client || !client.textPendingRevisionId) return { kind: "not_found" } as const;
    if (client.textPendingRevisionId !== input.expectedRevisionId) {
      return { kind: "stale", pendingRevisionId: client.textPendingRevisionId } as const;
    }
    const [pending] = await tx.select().from(oauthAppTextRevisions)
      .where(eq(oauthAppTextRevisions.id, client.textPendingRevisionId)).limit(1);
    if (!pending) return { kind: "not_found" } as const;
    const now = currentDate();
    const reviewed = { reviewedByUserId: input.reviewerUserId, reviewedAt: now };

    if (input.decision === "reject") {
      await tx.update(oauthAppTextRevisions).set({
        ...reviewed,
        state: "rejected",
        rejectReason: input.reason?.trim() || null,
      }).where(eq(oauthAppTextRevisions.id, pending.id));
      await tx.update(oauthClients).set({ textPendingRevisionId: null, updatedAt: now })
        .where(eq(oauthClients.id, client.id));
    } else {
      if (client.textCurrentRevisionId) {
        await tx.update(oauthAppTextRevisions).set({ state: "superseded" })
          .where(eq(oauthAppTextRevisions.id, client.textCurrentRevisionId));
      }
      await tx.update(oauthAppTextRevisions).set({ ...reviewed, state: "active" })
        .where(eq(oauthAppTextRevisions.id, pending.id));
      await tx.update(oauthClients).set({
        ...promptTextOf(pending),
        textCurrentRevisionId: pending.id,
        textPendingRevisionId: null,
        updatedAt: now,
      }).where(eq(oauthClients.id, client.id));
      // The source admin who wrote it through the web has read it; an agent's
      // edit still waits for a person on the source Server.
      if (pending.createdByType === "human") {
        await confirmForSourceServer(tx, {
          clientId: client.id,
          sourceServerId: client.serverId,
          revisionId: pending.id,
          userId: pending.createdById,
        });
      }
      await advanceConfirmationsWhereConsentOff(tx, { clientId: client.id, sourceServerId: client.serverId, revisionId: pending.id });
      await advanceConfirmationsOfUnchangedAgentText(tx, { clientId: client.id, revisionId: pending.id, text: promptTextOf(pending) });
      await announcePermissionUpdatesForApp(tx, client.id);
    }

    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: client.serverId,
      clientId: client.id,
      eventType: "app.prompt_text_reviewed",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.reviewerUserId },
      subject: { type: "app", id: client.id },
      target: { type: "app", id: client.id },
      metadata: { revision: pending.revision, decision: input.decision },
    }, tx);
    return input.decision === "reject"
      ? { kind: "rejected", revisionId: pending.id } as const
      : { kind: "approved", revisionId: pending.id } as const;
  });
}

export type SourcePromptTextConfirmResult =
  | { kind: "not_found" }
  | { kind: "changed"; current: { revisionId: string; text: AppPromptText } }
  | { kind: "confirmed"; revisionId: string };

/** The app's own Server confirms the current text (server_local apps, and the source install of a shared app). */
export async function confirmPromptTextForSource(input: {
  serverId: string;
  clientId: string;
  userId: string;
  expectedRevisionId: string;
}, db: Db = getDb()): Promise<SourcePromptTextConfirmResult> {
  return db.transaction(async (tx) => {
    const client = await lockClientText(tx, input.clientId);
    if (!client || client.serverId !== input.serverId) return { kind: "not_found" } as const;
    const current = await ensureCurrentTextRevision(tx, client.id);
    if (current.revisionId !== input.expectedRevisionId) return { kind: "changed", current } as const;
    await confirmForSourceServer(tx, {
      clientId: client.id,
      sourceServerId: client.serverId,
      revisionId: current.revisionId,
      userId: input.userId,
    });
    await integrationAuditService.recordIntegrationAuditEvent({
      serverId: client.serverId,
      clientId: client.id,
      eventType: "app.prompt_text_confirmed",
      outcome: "success",
      source: "api",
      actor: { type: "human", id: input.userId },
      subject: { type: "app", id: client.id },
      target: { type: "server", id: client.serverId },
      metadata: {},
    }, tx);
    return { kind: "confirmed", revisionId: current.revisionId } as const;
  });
}

export type PromptTextRevisionView = {
  id: string;
  revision: number;
  state: AppTextRevision["state"];
  name: string;
  description: string | null;
  when_to_use: string | null;
  created_at: string;
  reviewed_at: string | null;
  reject_reason: string | null;
};

export function promptTextRevisionView(row: AppTextRevision): PromptTextRevisionView {
  return {
    id: row.id,
    revision: row.revision,
    state: row.state,
    name: row.name,
    description: row.description,
    when_to_use: row.whenToUse,
    created_at: row.createdAt.toISOString(),
    reviewed_at: row.reviewedAt?.toISOString() ?? null,
    reject_reason: row.rejectReason,
  };
}

export async function getTextRevisions(ids: readonly (string | null | undefined)[], executor: DatabaseExecutor = getDb()) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map<string, AppTextRevision>();
  const rows = await executor.select().from(oauthAppTextRevisions).where(inArray(oauthAppTextRevisions.id, unique));
  return new Map(rows.map((row) => [row.id, row]));
}

/** Developer / reviewer view: current, pending and the latest rejection newer than current. */
export async function getAppPromptTextState(clientId: string, executor: DatabaseExecutor = getDb()) {
  const [client] = await executor.select({
    id: oauthClients.id,
    serverId: oauthClients.serverId,
    textCurrentRevisionId: oauthClients.textCurrentRevisionId,
    textPendingRevisionId: oauthClients.textPendingRevisionId,
    localConfirmedTextRevisionId: oauthClients.localConfirmedTextRevisionId,
  }).from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1);
  if (!client) return null;
  const revisions = await getTextRevisions([client.textCurrentRevisionId, client.textPendingRevisionId], executor);
  const current = client.textCurrentRevisionId ? revisions.get(client.textCurrentRevisionId) ?? null : null;
  const rejectedRows = await executor.select().from(oauthAppTextRevisions).where(and(
    eq(oauthAppTextRevisions.clientId, clientId),
    eq(oauthAppTextRevisions.state, "rejected"),
  ));
  // Only a rejection newer than what is live is news to the developer.
  const rejected = rejectedRows
    .filter((row) => !current || row.revision > current.revision)
    .sort((a, b) => b.revision - a.revision)[0] ?? null;
  return {
    serverId: client.serverId,
    current,
    pending: client.textPendingRevisionId ? revisions.get(client.textPendingRevisionId) ?? null : null,
    rejected,
    localConfirmedRevisionId: client.localConfirmedTextRevisionId,
  };
}

/**
 * The text a Server's agents read for each app: the revision that Server
 * confirmed while its flag is on, the app's current text while it is off.
 * An app with no confirmed revision gets null text (it stays out of the
 * prompt). `confirmedRevisionId` is the install's for a third-party app and
 * the app's source slot for a server_local one.
 */
export async function resolveAgentFacingPromptText<T extends AppPromptText & { id: string }>(
  serverId: string,
  clients: readonly (T & { confirmedTextRevisionId: string | null })[],
  executor: DatabaseExecutor = getDb(),
): Promise<Array<T & { promptText: AppPromptText | null }>> {
  if (!await promptTextConsentEnabled(serverId)) {
    return clients.map((client) => ({ ...client, promptText: promptTextOf(client) }));
  }
  const revisions = await getTextRevisions(clients.map((client) => client.confirmedTextRevisionId), executor);
  return clients.map((client) => {
    const revision = client.confirmedTextRevisionId ? revisions.get(client.confirmedTextRevisionId) : undefined;
    return { ...client, promptText: revision && revision.clientId === client.id ? promptTextOf(revision) : null };
  });
}

/**
 * Heals rows the previous release wrote between migration 0382 and this
 * code: apps with no revision get revision 1 from their live text, and
 * installs with no confirmation confirm the current revision, exactly as the
 * migration's backfill did for everything that existed. Idempotent; a
 * dry run only counts. Must be run (and return zeros) before
 * app_prompt_text_consent is turned on for any Server.
 */
export async function backfillAppPromptTextRevisions(db: Db, apply: boolean) {
  const unrevisioned = await db.select({ id: oauthClients.id }).from(oauthClients)
    .where(isNull(oauthClients.textCurrentRevisionId));
  const unconfirmedBefore = await db.select({ id: oauthClientInstalls.id }).from(oauthClientInstalls)
    .where(and(isNull(oauthClientInstalls.confirmedTextRevisionId), isNull(oauthClientInstalls.textConfirmedAt)));
  if (!apply) return { appsWithoutRevision: unrevisioned.length, installsWithoutConfirmation: unconfirmedBefore.length };
  return db.transaction(async (tx) => {
    for (const client of unrevisioned) await ensureCurrentTextRevision(tx, client.id);
    const confirmed = await tx.update(oauthClientInstalls).set({
      confirmedTextRevisionId: sql`(select ${oauthClients.textCurrentRevisionId} from ${oauthClients} where ${oauthClients.id} = ${oauthClientInstalls.clientId})`,
      textConfirmedAt: currentDate(),
    }).where(and(
      isNull(oauthClientInstalls.confirmedTextRevisionId),
      isNull(oauthClientInstalls.textConfirmedAt),
      isNotNull(sql`(select ${oauthClients.textCurrentRevisionId} from ${oauthClients} where ${oauthClients.id} = ${oauthClientInstalls.clientId})`),
    )).returning({ id: oauthClientInstalls.id });
    return { appsWithoutRevision: unrevisioned.length, installsWithoutConfirmation: unconfirmedBefore.length, confirmedInstalls: confirmed.length };
  });
}

