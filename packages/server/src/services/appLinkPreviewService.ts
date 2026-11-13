import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db";
import { integrationAuditEvents, oauthClients, oauthClientInstalls, oauthAppLinkPreviews, oauthLinkPreviewDeclines, oauthUserConsents, servers, serverMembers, users, type AppLinkPreviewSuspendReason } from "../db/schema";
import { appHosts } from "../platform/links";
import { appLinkPreviewRegistrationSchema, appLinkPreviewResponseSchema, appLinkReadUrls, matchesAppPreview, DEFAULT_APP_LINK_PREVIEW_VERSIONS, type AppLinkPreview, type AppLinkPreviewPrompt, type AppLinkPreviewRevision, type AppLinkPreviewVersion } from "@botiverse/raft-shared/src/appLinkPreview";
import { previewHttp, type PreviewHttp } from "./appLinkPreviewHttp";
import { validateOAuthScopesForClient } from "./oauthService";
import { marketplaceReviewApplies, nextActionEndpointState } from "./appActionEndpointPolicy";
import { oidcIssuer, signAppLinkPreviewAssertion } from "./oidcService";
import { currentDate } from "@botiverse/raft-shared";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import { recordTraceEvent } from "../tracing/semanticTrace";
import { listOAuthClientKeys } from "./oauthClientKeys";
import { UUID_RE } from "../lib/messageId";

let http: PreviewHttp = previewHttp;
export function __setPreviewHttpForTests(value: PreviewHttp | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("Preview transport hooks are test-only");
  http = value ?? previewHttp;
}
/** The preview transport (previewHttp, or the test substitute). */
export const previewTransport = (): PreviewHttp => http;
export class AppLinkPreviewConfigError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export type RegisteredAppLinkPreview = typeof oauthAppLinkPreviews.$inferSelect;

type RegisteringClient = Pick<typeof oauthClients.$inferSelect, "id" | "clientId" | "serverId">;

export { nextActionEndpointState };

// Domain proof freshness. A registration whose proof is older than
// SOFT_TTL is rechecked in the background when it is used, and by the sweep
// worker; past HARD_TTL without a successful proof it gets no assertions.
// RETRY spaces proof fetches for one registration across all instances.
export const LINK_PREVIEW_PROOF_SOFT_TTL_MS = 24 * 3600_000;
export const LINK_PREVIEW_PROOF_HARD_TTL_MS = 72 * 3600_000;
export const LINK_PREVIEW_PROOF_RETRY_MS = 10 * 60_000;
export type { AppLinkPreviewSuspendReason };

/** A registration took an App that had declared version 2 back to `[1]`. Only the App, never its URLs. */
export const LINK_PREVIEW_VERSION_2_DROPPED_EVENT = "server.link_preview.version_2_dropped";

export type OriginProof = "match" | "mismatch" | "unavailable";
/** What the domain file answered and, on a match, which of the App's ids it named. */
type ProvenOrigin = { proof: "match"; provedClientKey: string } | { proof: "mismatch" | "unavailable" };
/**
 * Fetches `${origin}/.well-known/raft-link-preview.json`. "mismatch": a JSON
 * reply that does not name this App (another client_id, or none). "unavailable":
 * no usable reply (DNS, TLS, status, content type, size, timeout, invalid JSON).
 * The file may name the App's current id or any alias (RFC 084 §4).
 */
export async function proveOrigin(origin: string, client: { id: string; clientId: string }): Promise<ProvenOrigin> {
  let proof: unknown;
  try { proof = await http(`${origin}/.well-known/raft-link-preview.json`); } catch { return { proof: "unavailable" }; }
  if (!proof || typeof proof !== "object" || !("client_id" in proof) || typeof proof.client_id !== "string") return { proof: "mismatch" };
  const named = proof.client_id;
  return (await listOAuthClientKeys(client)).includes(named) ? { proof: "match", provedClientKey: named } : { proof: "mismatch" };
}

/**
 * The client id a Raft-started link-preview or card-action request names: the
 * one the App last proved in its domain file (RFC 084 §4), so a rename changes
 * nothing for the App until it updates that file.
 */
export function linkPreviewAudienceKey(entry: { config: { provedClientKey: string | null }; app: { key: string } }): string {
  return entry.config.provedClientKey ?? entry.app.key;
}

export async function registerAppLinkPreview(client: RegisteringClient, raw: unknown): Promise<RegisteredAppLinkPreview> {
  const parsed = appLinkPreviewRegistrationSchema.safeParse(raw);
  if (!parsed.success) throw new AppLinkPreviewConfigError("Invalid link preview registration");
  // Both URLs are compared and stored in their WHATWG form, so
  // `https://a.example:443/cb` and `https://a.example/cb` are one registration.
  // The declared preview versions are stored sorted. They apply at once, also
  // for a published App: unlike action_endpoint they never wait for
  // marketplace review (Tenny, #proj-apps), so they stay in `config` and never
  // go through nextActionEndpointState.
  const { action_endpoint: rawActionEndpoint = null, preview_versions: previewVersions = DEFAULT_APP_LINK_PREVIEW_VERSIONS, ...rawConfig } = parsed.data;
  const config = { ...rawConfig, endpoint: canonicalUrl(rawConfig.endpoint), previewVersions: [...previewVersions].sort((a, b) => a - b) };
  const requestedActionEndpoint = rawActionEndpoint === null ? null : canonicalUrl(rawActionEndpoint);
  if (config.endpoint.length > 2000 || (requestedActionEndpoint?.length ?? 0) > 2000) throw new AppLinkPreviewConfigError("Invalid link preview registration");
  // An App cannot claim arbitrary URLs merely by changing its metadata.
  const proven = await proveOrigin(config.origin, client);
  if (proven.proof !== "match") throw new AppLinkPreviewConfigError(proven.proof === "mismatch" ? "Domain ownership proof did not match this App" : "Domain ownership proof could not be fetched");
  for (let attempt = 0; ; attempt++) {
    try {
      return await saveRegistration(client, config, requestedActionEndpoint, proven.provedClientKey);
    } catch (error) {
      const code = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
      // Another registration of this origin committed while this one ran
      // (23505), or two Apps moving onto each other's origins deadlocked
      // (40P01): one fresh attempt sees the committed row and replaces it.
      if ((code === "23505" || code === "40P01") && attempt === 0) continue;
      // Never name the holder.
      if (code === "23505") throw new AppLinkPreviewConfigError("This origin is already registered", 409);
      throw error;
    }
  }
}

type RegistrationConfig = Pick<RegisteredAppLinkPreview, "origin" | "endpoint" | "paths" | "previewVersions">;

async function saveRegistration(client: RegisteringClient, config: RegistrationConfig, requestedActionEndpoint: string | null, provedClientKey: string): Promise<RegisteredAppLinkPreview> {
  return getDb().transaction(async (tx) => {
    // The App's own row is locked FOR NO KEY UPDATE, which does two things.
    // Publish status is read here, not from the request's earlier read: a
    // publish approval (which locks this row FOR UPDATE) can land during the
    // proof fetch, and its review must then apply. And registrations from the
    // same App serialize, so two concurrent first registrations cannot both
    // insert and fail on the origin unique index. Foreign-key checks (KEY
    // SHARE) on the row are not blocked.
    const [app] = await tx.select({ appType: oauthClients.appType, publishStatus: oauthClients.publishStatus })
      .from(oauthClients).where(eq(oauthClients.id, client.id)).for("no key update");
    if (!app) throw new AppLinkPreviewConfigError("App not found", 404);
    let [existing] = await tx.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)).for("update");
    const now = currentDate();
    // This request just proved the origin.
    const proven = { verifiedAt: now, lastCheckedAt: now, provedClientKey };
    const takeover = await takeOverOrigin(tx, client, config.origin);
    if (!existing) {
      // First registration. The lock above already serializes this App's
      // registrations; as a fallback, if a row for it appears anyway, the
      // insert waits for it and does nothing, and that row is then locked and
      // compared below like any repeat registration.
      const [inserted] = await tx.insert(oauthAppLinkPreviews)
        .values({ clientId: client.id, ...config, ...firstActionColumns(requestedActionEndpoint, config.origin, marketplaceReviewApplies(app)), ...proven })
        .onConflictDoNothing({ target: oauthAppLinkPreviews.clientId }).returning();
      if (inserted) {
        await auditRegistration(tx, client, inserted.pendingActionEndpoint !== null, { takeover });
        return inserted;
      }
      [existing] = await tx.select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id)).for("update");
      if (!existing) throw new AppLinkPreviewConfigError("Link preview registration changed concurrently", 409);
    }
    const action = nextActionEndpointState({
      origin: config.origin,
      requested: requestedActionEndpoint,
      live: canonicalUrl(existing.actionEndpoint),
      pending: canonicalUrl(existing.pendingActionEndpoint),
      reviewed: marketplaceReviewApplies(app),
    });
    const actionColumns = {
      actionEndpoint: action.live,
      pendingActionEndpoint: action.pending,
      pendingActionEndpointRequestedAt: action.pending
        ? (action.requestedReview ? now : existing.pendingActionEndpointRequestedAt ?? now)
        : null,
      actionEndpointRejectReason: action.requestedReview ? null : existing.actionEndpointRejectReason,
    };
    // The revision voids every outstanding card handle, so only a change in
    // force moves it (Tenny 2108c37c): a repeat registration, from a deploy
    // script say, must be harmless. A pending endpoint is not in force.
    // Stored URLs are compared in canonical form too; one stored before
    // canonicalization is rewritten below without moving the revision.
    // Lifting a suspension is a change in force.
    // The declared preview versions are deliberately not in force (Tenny,
    // #proj-apps): they change which request version a read sends, not what
    // an outstanding handle can execute, so a change is stored and audited
    // under the same revision. To have it move the revision, add
    // `&& samePreviewVersions(existing.previewVersions, config.previewVersions)`
    // to sameInForce.
    const suspended = existing.suspendedAt !== null;
    const sameInForce = !suspended && existing.origin === config.origin && canonicalUrl(existing.endpoint) === config.endpoint
      && samePaths(existing.paths, config.paths) && canonicalUrl(existing.actionEndpoint) === actionColumns.actionEndpoint;
    if (sameInForce && samePreviewVersions(existing.previewVersions, config.previewVersions)
      && existing.endpoint === config.endpoint && existing.actionEndpoint === actionColumns.actionEndpoint
      && existing.pendingActionEndpoint === actionColumns.pendingActionEndpoint
      && existing.pendingActionEndpointRequestedAt?.getTime() === actionColumns.pendingActionEndpointRequestedAt?.getTime()
      && existing.actionEndpointRejectReason === actionColumns.actionEndpointRejectReason) {
      // Only the proof time is refreshed: no revision move, no audit.
      const [refreshed] = await tx.update(oauthAppLinkPreviews).set(proven).where(eq(oauthAppLinkPreviews.clientId, client.id)).returning();
      return refreshed!;
    }
    const [saved] = await tx.update(oauthAppLinkPreviews).set({
      ...config, ...actionColumns, ...proven, suspendedAt: null, suspendedReason: null,
      revision: sameInForce ? existing.revision : randomUUID() as AppLinkPreviewRevision, updatedAt: now,
    }).where(eq(oauthAppLinkPreviews.clientId, client.id)).returning();
    await auditRegistration(tx, client, action.requestedReview, { takeover, resumed: suspended });
    // A PUT replaces the registration, so one that leaves preview_versions out
    // takes the App off version 2 without any error: later reads are read-only
    // version 1 cards, with no buttons or block placement (Tenny, #proj-apps:#47
    // 8e0fa8d8).
    if (existing.previewVersions.includes(2) && !config.previewVersions.includes(2)) recordTraceEvent(LINK_PREVIEW_VERSION_2_DROPPED_EVENT, { app_id: client.id });
    return saved!;
  });
}

/**
 * The origin is held by another App, but this request's proof names this App:
 * the well-known file holds one client_id, so the holder cannot prove it now.
 * Its registration is deleted (that voids its card handles; no revision move is
 * needed) and audited. The two audit events share a correlation id; neither
 * names the other App. Returns that id, or null when nothing was taken over.
 */
async function takeOverOrigin(tx: DatabaseExecutor, client: RegisteringClient, origin: string): Promise<string | null> {
  const [holder] = await tx.select({ clientId: oauthAppLinkPreviews.clientId, serverId: oauthClients.serverId, clientKey: oauthClients.clientId })
    .from(oauthAppLinkPreviews)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthAppLinkPreviews.clientId))
    .where(and(eq(oauthAppLinkPreviews.origin, origin), ne(oauthAppLinkPreviews.clientId, client.id)))
    .for("update", { of: oauthAppLinkPreviews });
  if (!holder) return null;
  const correlationId = randomUUID();
  await tx.delete(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, holder.clientId));
  await recordIntegrationAuditEvent({ serverId: holder.serverId, clientId: holder.clientId, eventType: "app.updated", outcome: "success", source: "api",
    actor: { type: "system" }, target: { type: "app", id: holder.clientId }, correlationId,
    metadata: { changedFields: ["linkPreview"], clientKey: holder.clientKey, linkPreview: "taken_over" } }, tx);
  return correlationId;
}

/** The WHATWG serialization (`new URL(x).href`): default port dropped, host lowercased. */
function canonicalUrl(url: string): string;
function canonicalUrl(url: string | null): string | null;
function canonicalUrl(url: string | null): string | null {
  return url === null ? null : new URL(url).href;
}

/** Both lists are stored sorted and without duplicates. */
function samePreviewVersions(a: readonly AppLinkPreviewVersion[], b: readonly AppLinkPreviewVersion[]): boolean {
  return a.length === b.length && a.every((version, i) => version === b[i]);
}

/** Path lists compare as sets: matching does not depend on their order. */
function samePaths(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((path, i) => path === right[i]);
}

function firstActionColumns(requested: string | null, origin: string, reviewed: boolean) {
  const action = nextActionEndpointState({ origin, requested, live: null, pending: null, reviewed });
  return {
    actionEndpoint: action.live,
    pendingActionEndpoint: action.pending,
    pendingActionEndpointRequestedAt: action.pending ? currentDate() : null,
    actionEndpointRejectReason: null,
  };
}

async function auditRegistration(tx: DatabaseExecutor, client: RegisteringClient, requestedReview: boolean, change: { takeover?: string | null; resumed?: boolean } = {}) {
  await recordIntegrationAuditEvent({ serverId: client.serverId, clientId: client.id, eventType: "app.updated", outcome: "success", source: "api",
    actor: { type: "system" }, requester: { type: "app", id: client.id }, target: { type: "app", id: client.id }, correlationId: change.takeover ?? null,
    metadata: { changedFields: ["linkPreview"], clientKey: client.clientId, ...(change.takeover ? { takeover: true } : {}), ...(change.resumed ? { linkPreview: "resumed" } : {}) } }, tx);
  if (requestedReview) {
    await recordIntegrationAuditEvent({ serverId: client.serverId, clientId: client.id, eventType: "app.action_endpoint_requested", outcome: "success", source: "api",
      actor: { type: "system" }, requester: { type: "app", id: client.id }, subject: { type: "app", id: client.id }, target: { type: "app", id: client.id },
      metadata: { clientKey: client.clientId } }, tx);
  }
}

export async function deleteAppLinkPreview(client: Pick<typeof oauthClients.$inferSelect, "id" | "clientId" | "serverId">) {
  await getDb().transaction(async (tx) => {
    await tx.delete(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, client.id));
    await recordIntegrationAuditEvent({ serverId: client.serverId, clientId: client.id, eventType: "app.updated", outcome: "success", source: "api",
      actor: { type: "system" }, requester: { type: "app", id: client.id }, target: { type: "app", id: client.id }, metadata: { changedFields: ["linkPreview"], clientKey: client.clientId } }, tx);
  });
}

/**
 * The App's action endpoint review state, as its own Server's admins read it.
 * The review itself is decided in App Admin, through the database function
 * public.app_admin_decide_action_endpoint_review (#proj-apps task #19).
 */
export async function getActionEndpointReviewState(clientId: string) {
  if (!UUID_RE.test(clientId)) return null;
  const [row] = await getDb().select({ preview: oauthAppLinkPreviews, serverId: oauthClients.serverId, appType: oauthClients.appType })
    .from(oauthAppLinkPreviews)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthAppLinkPreviews.clientId))
    .where(eq(oauthAppLinkPreviews.clientId, clientId));
  if (!row) return null;
  return {
    serverId: row.serverId,
    appType: row.appType,
    origin: row.preview.origin,
    live: row.preview.actionEndpoint,
    pending: row.preview.pendingActionEndpoint,
    requestedAt: row.preview.pendingActionEndpointRequestedAt,
    rejectReason: row.preview.actionEndpointRejectReason,
    ownServerActionEndpoint: row.preview.ownServerActionEndpoint,
    ownServerActionsConfirmedAt: row.preview.ownServerActionsConfirmedAt,
    ownServerActionsConfirmedBy: row.preview.ownServerActionEndpoint === null ? null : await ownServerActionsConfirmer(clientId),
    suspended: row.preview.suspendedAt !== null,
  };
}

/**
 * Who allowed the confirmation in force (RFC 076 §17): the person on the
 * latest `app.link_card_actions_confirmed` event (a confirmation is written
 * only with one, and confirming the same endpoint again writes neither). No
 * column: the audit is the record. Null when the person's account is gone.
 */
async function ownServerActionsConfirmer(clientId: string): Promise<{ id: string; name: string } | null> {
  const [event] = await getDb().select({ actorId: integrationAuditEvents.actorId }).from(integrationAuditEvents)
    .where(and(eq(integrationAuditEvents.clientId, clientId), eq(integrationAuditEvents.eventType, "app.link_card_actions_confirmed")))
    .orderBy(desc(integrationAuditEvents.createdAt))
    .limit(1);
  if (!event?.actorId) return null;
  const [person] = await getDb().select({ id: users.id, name: users.name, displayName: users.displayName }).from(users)
    .where(eq(users.id, event.actorId)).limit(1);
  return person ? { id: person.id, name: person.displayName || person.name } : null;
}

export type OwnServerLinkCardActionsResult =
  | { kind: "confirmed"; actionEndpoint: string; confirmedAt: Date }
  | { kind: "withdrawn" }
  | { kind: "not_found" }
  | { kind: "not_server_local" }
  | { kind: "no_action_endpoint" }
  | { kind: "endpoint_changed"; actionEndpoint: string | null };

/**
 * RFC 076 §17: a person with manageIntegrations on a server_local App's own
 * Server lets its card buttons call `actionEndpoint` there, sending the
 * endpoint exactly as they were shown it: anything other than the one in force
 * now is `endpoint_changed` (nothing written), so what is confirmed is what
 * was seen. The caller checks the person (routes/integrations.ts); this checks
 * the App is on `serverId`. One transaction: the registration row FOR UPDATE
 * (execute holds it FOR SHARE while it decides), the confirmation, the audit.
 * Confirming the endpoint already confirmed writes nothing and returns it.
 */
export async function confirmOwnServerLinkCardActions(input: { clientId: string; serverId: string; userId: string; actionEndpoint: string }): Promise<OwnServerLinkCardActionsResult> {
  return getDb().transaction(async (tx) => {
    const row = await lockOwnServerRegistration(tx, input.clientId, input.serverId);
    if (!row) return { kind: "not_found" } as const;
    if (row.appType !== "server_local") return { kind: "not_server_local" } as const;
    const live = row.preview.actionEndpoint;
    if (live === null) return { kind: "no_action_endpoint" } as const;
    if (live !== input.actionEndpoint) return { kind: "endpoint_changed", actionEndpoint: live } as const;
    if (row.preview.ownServerActionEndpoint === live && row.preview.ownServerActionsConfirmedAt) {
      return { kind: "confirmed", actionEndpoint: live, confirmedAt: row.preview.ownServerActionsConfirmedAt } as const;
    }
    const [updated] = await tx.update(oauthAppLinkPreviews)
      .set({ ownServerActionEndpoint: live, ownServerActionsConfirmedAt: sql`clock_timestamp()` })
      .where(eq(oauthAppLinkPreviews.clientId, row.preview.clientId))
      .returning({ confirmedAt: oauthAppLinkPreviews.ownServerActionsConfirmedAt });
    await recordOwnServerActionsAudit(tx, row, input.userId, "app.link_card_actions_confirmed", live);
    return { kind: "confirmed", actionEndpoint: live, confirmedAt: updated!.confirmedAt! } as const;
  });
}

/**
 * Withdraws that confirmation (same caller rules, same lock, audited): the
 * App's buttons on its own Server only navigate again, on cards already shown
 * too. Nothing confirmed: writes nothing and still answers `withdrawn`.
 */
export async function withdrawOwnServerLinkCardActions(input: { clientId: string; serverId: string; userId: string }): Promise<OwnServerLinkCardActionsResult> {
  return getDb().transaction(async (tx) => {
    const row = await lockOwnServerRegistration(tx, input.clientId, input.serverId);
    if (!row) return { kind: "not_found" } as const;
    const confirmed = row.preview.ownServerActionEndpoint;
    if (confirmed === null) return { kind: "withdrawn" } as const;
    await tx.update(oauthAppLinkPreviews)
      .set({ ownServerActionEndpoint: null, ownServerActionsConfirmedAt: null })
      .where(eq(oauthAppLinkPreviews.clientId, row.preview.clientId));
    await recordOwnServerActionsAudit(tx, row, input.userId, "app.link_card_actions_withdrawn", confirmed);
    return { kind: "withdrawn" } as const;
  });
}

async function lockOwnServerRegistration(tx: DatabaseExecutor, clientId: string, serverId: string) {
  if (!UUID_RE.test(clientId)) return null;
  const [row] = await tx.select({ preview: oauthAppLinkPreviews, appType: oauthClients.appType, clientKey: oauthClients.clientId, serverId: oauthClients.serverId })
    .from(oauthAppLinkPreviews)
    .innerJoin(oauthClients, and(eq(oauthClients.id, oauthAppLinkPreviews.clientId), eq(oauthClients.serverId, serverId)))
    .where(eq(oauthAppLinkPreviews.clientId, clientId))
    .for("update", { of: oauthAppLinkPreviews });
  return row ?? null;
}

async function recordOwnServerActionsAudit(
  tx: DatabaseExecutor,
  row: { preview: { clientId: string }; clientKey: string; serverId: string },
  userId: string,
  eventType: "app.link_card_actions_confirmed" | "app.link_card_actions_withdrawn",
  actionEndpoint: string,
) {
  await recordIntegrationAuditEvent({
    serverId: row.serverId, clientId: row.preview.clientId, eventType, outcome: "success", source: "web",
    actor: { type: "human", id: userId }, target: { type: "app", id: row.preview.clientId },
    metadata: { clientKey: row.clientKey, actionEndpoint },
  }, tx);
}

/**
 * Stops a registration's callbacks until its origin proves again. In one
 * transaction: lock the row, mark it suspended, move the revision (which voids
 * outstanding card handles and pending action status) and audit. Consent and
 * grants are untouched. Already suspended: writes nothing and returns false.
 * `provenBefore`: the proof time the failed check saw; a newer successful
 * proof (a re-registration, say) wins over it.
 */
export async function suspendAppLinkPreview(clientId: string, reason: AppLinkPreviewSuspendReason, options: { provenBefore?: Date } = {}): Promise<boolean> {
  return changeSuspension(clientId, reason, options.provenBefore);
}

/** Lifts a suspension the same way (new revision, audit). Not suspended: writes nothing and returns false. */
export async function resumeAppLinkPreview(clientId: string): Promise<boolean> {
  return changeSuspension(clientId, null);
}

async function changeSuspension(clientId: string, reason: AppLinkPreviewSuspendReason | null, provenBefore?: Date): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select({
      suspendedAt: oauthAppLinkPreviews.suspendedAt, suspendedReason: oauthAppLinkPreviews.suspendedReason, verifiedAt: oauthAppLinkPreviews.verifiedAt,
      serverId: oauthClients.serverId, clientKey: oauthClients.clientId,
    }).from(oauthAppLinkPreviews)
      .innerJoin(oauthClients, eq(oauthClients.id, oauthAppLinkPreviews.clientId))
      .where(eq(oauthAppLinkPreviews.clientId, clientId))
      .for("update", { of: oauthAppLinkPreviews });
    if (!row || (row.suspendedAt !== null) === (reason !== null)) return false;
    if (reason && provenBefore && row.verifiedAt.getTime() > provenBefore.getTime()) return false;
    await tx.update(oauthAppLinkPreviews).set({
      suspendedAt: reason ? currentDate() : null, suspendedReason: reason, revision: randomUUID() as AppLinkPreviewRevision, updatedAt: currentDate(),
    }).where(eq(oauthAppLinkPreviews.clientId, clientId));
    await recordIntegrationAuditEvent({ serverId: row.serverId, clientId, eventType: "app.updated", outcome: "success", source: "system",
      actor: { type: "system" }, target: { type: "app", id: clientId },
      metadata: { changedFields: ["linkPreview"], clientKey: row.clientKey, linkPreview: reason ? "suspended" : "resumed", reason: reason ?? row.suspendedReason } }, tx);
    return true;
  });
}

export type AppLinkPreviewRecheck = { proof: OriginProof; suspensionChanged: boolean };

/**
 * Rechecks one registration's domain proof. Only the caller that claims the
 * row (advances last_checked_at, at most once per RETRY across instances)
 * fetches; others get null. match: refresh verified_at and lift a suspension.
 * mismatch: suspend now. unavailable: keep serving until HARD_TTL, then suspend.
 */
export async function recheckAppLinkPreview(clientId: string): Promise<AppLinkPreviewRecheck | null> {
  const now = currentDate();
  const [claimed] = await getDb().update(oauthAppLinkPreviews).set({ lastCheckedAt: now })
    .where(and(eq(oauthAppLinkPreviews.clientId, clientId), or(isNull(oauthAppLinkPreviews.lastCheckedAt),
      lt(oauthAppLinkPreviews.lastCheckedAt, new Date(now.getTime() - LINK_PREVIEW_PROOF_RETRY_MS)))))
    .returning({ origin: oauthAppLinkPreviews.origin, verifiedAt: oauthAppLinkPreviews.verifiedAt });
  if (!claimed) return null;
  const [app] = await getDb().select({ id: oauthClients.id, clientId: oauthClients.clientId }).from(oauthClients).where(eq(oauthClients.id, clientId));
  if (!app) return null;
  const result = await proveOrigin(claimed.origin, app);
  const proof = result.proof;
  if (result.proof === "match") {
    // Only the origin that was fetched counts as proven.
    const [proven] = await getDb().update(oauthAppLinkPreviews).set({ verifiedAt: currentDate(), provedClientKey: result.provedClientKey })
      .where(and(eq(oauthAppLinkPreviews.clientId, clientId), eq(oauthAppLinkPreviews.origin, claimed.origin)))
      .returning({ suspendedAt: oauthAppLinkPreviews.suspendedAt });
    return { proof, suspensionChanged: proven?.suspendedAt ? await resumeAppLinkPreview(clientId) : false };
  }
  if (proof === "mismatch") return { proof, suspensionChanged: await suspendAppLinkPreview(clientId, "proof_mismatch", { provenBefore: claimed.verifiedAt }) };
  if (!provenWithin(claimed.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, now)) {
    return { proof, suspensionChanged: await suspendAppLinkPreview(clientId, "proof_unavailable", { provenBefore: claimed.verifiedAt }) };
  }
  return { proof, suspensionChanged: false };
}

/**
 * Registrations the sweep should recheck, oldest attempt first: suspended
 * ones (so they resume once the origin proves again) and active ones past
 * SOFT_TTL, not attempted within RETRY. A hint: the claim decides.
 */
export async function listDueAppLinkPreviewRechecks(limit: number): Promise<string[]> {
  const now = currentDate().getTime();
  const rows = await getDb().select({ clientId: oauthAppLinkPreviews.clientId }).from(oauthAppLinkPreviews)
    .where(and(
      or(isNotNull(oauthAppLinkPreviews.suspendedAt), lt(oauthAppLinkPreviews.verifiedAt, new Date(now - LINK_PREVIEW_PROOF_SOFT_TTL_MS))),
      or(isNull(oauthAppLinkPreviews.lastCheckedAt), lt(oauthAppLinkPreviews.lastCheckedAt, new Date(now - LINK_PREVIEW_PROOF_RETRY_MS))),
    ))
    .orderBy(sql`${oauthAppLinkPreviews.lastCheckedAt} ASC NULLS FIRST`, asc(oauthAppLinkPreviews.clientId))
    .limit(limit);
  return rows.map((row) => row.clientId);
}

export function provenWithin(verifiedAt: Date, ttlMs: number, now: Date): boolean {
  return now.getTime() - verifiedAt.getTime() < ttlMs;
}

// Read-path rechecks run in the background, so a viewer never waits on a
// proof fetch. Only the v1 resolve path starts them: the v2 read path must not
// write (RFC 076) and relies on the sweep, so keep this out of candidates(). One attempt per registration per RETRY from this process; the
// row claim keeps it to one fetch across instances.
const lastRecheckStarted = new Map<string, number>();
const pendingRechecks = new Set<Promise<unknown>>();
function startRecheck(clientId: string, now: Date) {
  const last = lastRecheckStarted.get(clientId);
  if (last !== undefined && now.getTime() - last < LINK_PREVIEW_PROOF_RETRY_MS) return;
  if (lastRecheckStarted.size >= 10_000) {
    for (const [id, at] of lastRecheckStarted) if (now.getTime() - at >= LINK_PREVIEW_PROOF_RETRY_MS) lastRecheckStarted.delete(id);
  }
  lastRecheckStarted.set(clientId, now.getTime());
  // Errors are swallowed and never logged: they can carry the origin.
  const run = recheckAppLinkPreview(clientId).catch(() => null).finally(() => { pendingRechecks.delete(run); });
  pendingRechecks.add(run);
}
export async function __settleAppLinkPreviewRechecksForTests() {
  if (process.env.NODE_ENV !== "test") throw new Error("Preview recheck hooks are test-only");
  while (pendingRechecks.size) await Promise.allSettled([...pendingRechecks]);
  lastRecheckStarted.clear();
}

/** This Server's Apps registered for link previews without version 2: their previews stay read-only version 1 cards. */
export async function appsOnLinkPreviewVersion1(serverId: string): Promise<Set<string>> {
  const rows = await getDb().select({ id: oauthClients.id }).from(oauthAppLinkPreviews)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthAppLinkPreviews.clientId))
    .where(and(eq(oauthClients.serverId, serverId), sql`NOT (2 = ANY(${oauthAppLinkPreviews.previewVersions}))`));
  return new Set(rows.map((row) => row.id));
}

export async function readAppLinkPreview(clientId: string): Promise<RegisteredAppLinkPreview | null> {
  const [value] = await getDb().select().from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, clientId));
  return value ?? null;
}

/** What a link preview tells an App about its viewer, and so what the viewer's consent must cover. */
export const LINK_PREVIEW_SCOPES = ["openid", "profile"] as const;

/**
 * The link-preview Apps for these origins that the viewer could see on this
 * Server: enabled, actively installed there, the viewer a member, the App
 * still allowed to ask for the preview scopes. Each row says whether the
 * viewer consented (an active consent covering the preview scopes) and
 * whether they declined.
 */
export type RegisteredApp = {
  config: RegisteredAppLinkPreview;
  /** `serverId` and `appType`: the App's own Server and distribution (RFC 076 §17), not the viewer's. */
  app: {
    id: OAuthClientRow["id"]; name: OAuthClientRow["name"]; key: OAuthClientRow["clientId"]; icon: OAuthClientRow["logoUrl"]; allowedScopes: OAuthClientRow["allowedScopes"];
    serverId: OAuthClientRow["serverId"]; appType: OAuthClientRow["appType"];
  };
  installationId: (typeof oauthClientInstalls.$inferSelect)["id"];
  serverSlug: (typeof servers.$inferSelect)["slug"];
  serverRole: (typeof serverMembers.$inferSelect)["role"];
  consentId: (typeof oauthUserConsents.$inferSelect)["id"] | null;
  declineId: (typeof oauthLinkPreviewDeclines.$inferSelect)["id"] | null;
};
type OAuthClientRow = typeof oauthClients.$inferSelect;

export async function registeredApps(serverId: string, userId: string, origins: string[]): Promise<RegisteredApp[]> {
  const rows = await getDb().select({
    config: oauthAppLinkPreviews,
    app: { id: oauthClients.id, name: oauthClients.name, key: oauthClients.clientId, icon: oauthClients.logoUrl, allowedScopes: oauthClients.allowedScopes,
      serverId: oauthClients.serverId, appType: oauthClients.appType },
    installationId: oauthClientInstalls.id, serverSlug: servers.slug, serverRole: serverMembers.role,
    consentId: oauthUserConsents.id, declineId: oauthLinkPreviewDeclines.id,
  }).from(oauthAppLinkPreviews)
    .innerJoin(oauthClients, and(eq(oauthClients.id, oauthAppLinkPreviews.clientId), eq(oauthClients.enabled, true)))
    .innerJoin(oauthClientInstalls, and(eq(oauthClientInstalls.clientId, oauthClients.id), eq(oauthClientInstalls.serverId, serverId), eq(oauthClientInstalls.status, "active")))
    .innerJoin(servers, and(eq(servers.id, serverId), isNull(servers.deletedAt)))
    .innerJoin(serverMembers, and(eq(serverMembers.serverId, serverId), eq(serverMembers.userId, userId)))
    .leftJoin(oauthUserConsents, and(eq(oauthUserConsents.userId, userId), eq(oauthUserConsents.serverId, serverId), eq(oauthUserConsents.clientId, oauthClients.id),
      isNull(oauthUserConsents.revokedAt), sql`${oauthUserConsents.scopes}::jsonb @> ${JSON.stringify(LINK_PREVIEW_SCOPES)}::jsonb`))
    .leftJoin(oauthLinkPreviewDeclines, and(eq(oauthLinkPreviewDeclines.userId, userId), eq(oauthLinkPreviewDeclines.serverId, serverId),
      eq(oauthLinkPreviewDeclines.clientId, oauthClients.id)))
    .where(and(inArray(oauthAppLinkPreviews.origin, origins), isNull(oauthAppLinkPreviews.suspendedAt)));
  return rows.filter((row) => validateOAuthScopesForClient(LINK_PREVIEW_SCOPES, { clientId: row.app.key, allowedScopes: row.app.allowedScopes }).allowed);
}

// The human must have consented to this App on this Server (Login with Raft or
// the preview prompt), not since revoked, and not declined previews from it.
// Token expiry does not matter: human tokens live an hour. Viewing a message
// never creates consent or sends identity to an unconnected App.
export const previewable = (row: RegisteredApp) => row.consentId !== null && row.declineId === null;
// A decline hides the prompt as well as the preview.
const promptable = (row: RegisteredApp) => row.consentId === null && row.declineId === null;

export async function candidates(serverId: string, userId: string, origins: string[]): Promise<RegisteredApp[]> {
  return (await registeredApps(serverId, userId, origins)).filter(previewable);
}

/**
 * First-view prompts: one per App the viewer has neither consented to nor
 * declined, on its first matching link, only for a registration proven within
 * HARD_TTL. Raft data only; never calls the App. Shared by the v1 GET and the
 * batched link-card read, so both answer the same prompts.
 */
export function linkPreviewPrompts(urls: readonly string[], apps: readonly RegisteredApp[], now: Date): AppLinkPreviewPrompt[] {
  const prompts: AppLinkPreviewPrompt[] = [];
  for (const url of urls) {
    const entry = apps.find((row) => promptable(row) && provenWithin(row.config.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, now) && matchesAppPreview(url, row.config));
    if (entry && !prompts.some((prompt) => prompt.app.id === entry.app.id)) prompts.push({ url, app: { id: entry.app.id, name: entry.app.name, icon: entry.app.icon } });
  }
  return prompts;
}
// Each callback can hold an outbound socket for up to 3 seconds. Bound how
// many one viewer holds at once (per process, like the route limiter); an
// over-budget URL keeps its plain-link fallback.
export const MAX_IN_FLIGHT_CALLBACKS_PER_USER = 6;
const inFlightCallbacks = new Map<string, number>();
/** Runs `run` in one of the viewer's callback slots; null (not run) when all are taken. */
export async function withCallbackSlot<T>(userId: string, run: () => Promise<T>): Promise<T | null> {
  const held = inFlightCallbacks.get(userId) ?? 0;
  if (held >= MAX_IN_FLIGHT_CALLBACKS_PER_USER) return null;
  inFlightCallbacks.set(userId, held + 1);
  try { return await run(); } finally {
    const left = (inFlightCallbacks.get(userId) ?? 1) - 1;
    if (left > 0) inFlightCallbacks.set(userId, left); else inFlightCallbacks.delete(userId);
  }
}
/**
 * The previews for a message's links, and a first-view prompt for each App
 * the viewer has neither consented to nor declined: one per App, on its first
 * matching link. A prompt never calls the App.
 *
 * `appIcons` maps each preview's `url` to the icon Raft stores for the App
 * that rendered it (its `logoUrl`, as in the App listings), or null. Never an
 * image the App sends in the preview. It is a top-level field, not one on each
 * preview, because deployed clients parse each preview strictly and would drop
 * them all over an unknown field.
 */
export async function resolveAppLinkPreviews(input: { serverId: string; userId: string; content: string; stillVisible: () => Promise<boolean> }): Promise<{ previews: AppLinkPreview[]; prompts: AppLinkPreviewPrompt[]; appIcons: Record<string, string | null> }> {
  // Raft's own objects' links (an Artifact's) are not counted toward the three.
  const urls = appLinkReadUrls(input.content, appHosts());
  if (!urls.length) return { previews: [], prompts: [], appIcons: {} };
  const now = currentDate();
  const apps = await registeredApps(input.serverId, input.userId, [...new Set(urls.map((url) => new URL(url).origin))]);
  const found = apps.filter(previewable);
  for (const entry of found) {
    if (!provenWithin(entry.config.verifiedAt, LINK_PREVIEW_PROOF_SOFT_TTL_MS, now)) startRecheck(entry.config.clientId, now);
  }
  // Past HARD_TTL a registration is unverified even before the recheck has
  // written the suspension. It gets no prompt either; only a consented
  // viewer's read starts a recheck, so a prompt never contacts the App.
  const proven = (entry: RegisteredApp) => provenWithin(entry.config.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, now);
  const available = found.filter(proven);
  const prompts = linkPreviewPrompts(urls, apps, now);
  // fanout-ok: appLinkReadUrls caps this list at three URLs; each has one callback and bounded authority reads.
  const results = await Promise.all(urls.map(async (url): Promise<{ preview: AppLinkPreview; icon: string | null } | null> => {
    const matched = available.filter((entry) => matchesAppPreview(url, entry.config));
    if (matched.length !== 1) return null;
    const entry = matched[0];
    try {
      const requestId = randomUUID();
      const assertion = signAppLinkPreviewAssertion({ issuer: oidcIssuer(undefined, entry.serverSlug), clientKey: linkPreviewAudienceKey(entry),
        userId: input.userId, serverId: input.serverId, serverRole: entry.serverRole, installationId: entry.installationId, url, requestId, now: currentDate() });
      const result = await withCallbackSlot(input.userId, () => http(entry.config.endpoint, JSON.stringify({ version: 1, url, request_id: requestId }), assertion, { response: "preview" }));
      const parsed = appLinkPreviewResponseSchema.safeParse(result);
      if (!parsed.success) return null;
      // A slow callback must not revive disabled/uninstalled/revoked/declined
      // authority or return an old message's preview after an edit/delete/access change.
      const current = await candidates(input.serverId, input.userId, [entry.config.origin]);
      if (!current.some((v) => v.app.id === entry.app.id && v.installationId === entry.installationId && v.config.revision === entry.config.revision
        && provenWithin(v.config.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, currentDate()))
        || !await input.stillVisible()) return null;
      return { preview: { ...parsed.data, url, appName: entry.app.name }, icon: entry.app.icon };
    } catch { return null; } // Never log callback URL, assertion, body or private response.
  }));
  const rendered = results.filter((value) => value !== null);
  return {
    previews: rendered.map((value) => value.preview),
    prompts,
    appIcons: Object.fromEntries(rendered.map((value) => [value.preview.url, value.icon])),
  };
}
