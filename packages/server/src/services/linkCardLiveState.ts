import { and, eq, isNull, sql } from "drizzle-orm";
import { appLinkReadUrls, matchesAppPreview, UNREVIEWED_APP_CAPABILITY, type LinkCardCapability } from "@botiverse/raft-shared/src/appLinkPreview";
import { getDb, type DatabaseExecutor } from "../db";
import { appHosts } from "../platform/links";
import { linkCardOperations, linkCardViews, oauthAppLinkPreviews, oauthClientInstalls, oauthClients, oauthLinkPreviewDeclines, oauthUserConsents, serverMembers } from "../db/schema";
import { lockLinkPreviewChoice } from "./appLinkPreviewConsentService";
import { LINK_PREVIEW_PROOF_HARD_TTL_MS, LINK_PREVIEW_SCOPES, previewable, provenWithin, registeredApps, type RegisteredApp } from "./appLinkPreviewService";
import { LINK_CARD_READ_MAX_URLS } from "./linkCardReadService";
import { linkCardActionEndpointSha256, linkCardMessageContentSha256, linkCardUrlSha256, type LinkCardHandleClaims } from "./linkCardTokens";
import { isApprovedOfficialAppClient } from "./officialAppAutoInstallService";
import { ownServerActionsInForce } from "./linkCardExecuteEligibility";
import { oauthClientHasKey } from "./oauthClientKeys";

// Interactive link cards: the ONE place an action compares a handle with live
// state (RFC 076 §3.4, §5.1; protocol v3.2.3 §3.4; Tenny, PR B review). Prepare
// and execute both call verifyLinkCardActionAgainstLiveState before anything
// reaches an App; execute's transaction re-checks eligibility under FOR SHARE
// with lockLinkCardActionEligibility and the viewer's side after its lock
// waits with recheckLinkCardViewerInTransaction, claims a view with
// linkCardViewMatches, and the dispatch re-checks where it sends with
// linkCardDispatchTargetInForce. After the send (C2c), reading a receipt asks
// linkCardReceiptAccess, a forwarded status asks linkCardStatusTargetInForce
// where it may go, and the by-URL operation lookup asks
// matchLinkCardUrlIdentity which identity domain the link belongs to now.
// No endpoint compares bindings on its own: the API tests guard that the
// action, receipt and update services and the routes never reach for the
// comparison tools.
//
// Raft compares the live-state bindings only. It never compares the action
// descriptor with a live card (it has none at click time): the descriptor
// digest is bound, recorded and forwarded, and the App refuses anything stale
// under its current policy (rule 4).

/** The message as the viewer may read it now (routes/messages.ts readPreviewableMessage), or null. */
export type LinkCardMessageReader = (messageId: string) => Promise<{ content: string } | null>;

export type LinkCardLiveState = {
  /** The message's link the handle names, re-extracted from the current content (WHATWG href). */
  url: string;
  /** The provider matched server-side now: App, installation, registration (in force) and the viewer's role. */
  entry: RegisteredApp;
  /** The approved action endpoint in force, and its SHA-256: where this action may be sent. */
  actionEndpoint: string;
  actionEndpointSha256: string;
  /**
   * Why this App may act here: an approved official App (§4), or its own-Server
   * confirmation on this Server (RFC 076 §17), which also needs the handle to
   * carry unreviewed_app.v1 and spends the per-App execute budget.
   */
  basis: "official" | "own_server";
};

/** Why a handle no longer matches; all of them are 410 to the client. */
export type LinkCardLiveStateFailure =
  | "identity" | "capabilities" | "message" | "url" | "provider" | "installation" | "revision" | "eligibility" | "consent" | "decline";

/** Which comparison ran: the live check of prepare or execute, or execute's in-transaction re-check of the viewer's side. */
type ObservedCheck = "prepare" | "execute" | "execute_transaction";
let observeForTests: ((check: ObservedCheck) => void) | null = null;
export function __observeLinkCardLiveStateForTests(observer: typeof observeForTests) {
  if (process.env.NODE_ENV !== "test") throw new Error("Link card live-state hooks are test-only");
  observeForTests = observer;
}

/** The capabilities an action needs (addendum 1 §2): buttons at all, then its kind. */
export function linkCardActionCapabilities(requiresPrepare: boolean): LinkCardCapability[] {
  return ["card.v2", "button.v1", requiresPrepare ? "confirm.v1" : "undo.v1"];
}

/**
 * Compares every bound field of a verified handle (MAC and expiry already
 * checked) with live state, then the pre-call checks every action-endpoint
 * call needs: an approved official App with an approved
 * action endpoint in force, or an App with its own-Server actions in force on
 * this Server (RFC 076 §17), its registration not suspended and proven within
 * HARD_TTL. Writes nothing and calls no App.
 * - viewer and Server: the authenticated context (the handle's plain text only selects);
 * - provider and installation: the provider Raft matches for the URL now,
 *   exactly as the read does (enabled, actively installed, consented and not
 *   declined, proven, one match);
 * - registration revision: the one in force;
 * - message and content digest: the viewer can read it now and it is unchanged;
 * - URL: still one of the message's preview links;
 * - capabilities: include what this action needs.
 */
export async function verifyLinkCardActionAgainstLiveState(input: {
  phase: "prepare" | "execute"; viewerId: string; serverId: string; claims: LinkCardHandleClaims; readMessage: LinkCardMessageReader; now: Date;
}): Promise<{ ok: true; live: LinkCardLiveState } | { ok: false; reason: LinkCardLiveStateFailure }> {
  observeForTests?.(input.phase);
  const { binding } = input.claims;
  if (binding.viewerId !== input.viewerId || binding.serverId !== input.serverId) return { ok: false, reason: "identity" };
  // Native providers are not registered yet (RFC 076 §7): nothing native matches.
  if (binding.providerKind !== "app") return { ok: false, reason: "provider" };
  if (!linkCardActionCapabilities(input.claims.requiresPrepare).every((capability) => binding.capabilities.includes(capability))) return { ok: false, reason: "capabilities" };
  const message = await input.readMessage(binding.messageId);
  if (!message || linkCardMessageContentSha256(message.content) !== input.claims.messageContentSha256) return { ok: false, reason: "message" };
  const url = appLinkReadUrls(message.content, appHosts(), LINK_CARD_READ_MAX_URLS).find((link) => linkCardUrlSha256(link) === binding.urlSha256);
  if (!url) return { ok: false, reason: "url" };
  const apps = await registeredApps(input.serverId, input.viewerId, [new URL(url).origin]);
  const matched = apps.filter((row) => previewable(row) && provenWithin(row.config.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, input.now) && matchesAppPreview(url, row.config));
  const entry = matched.length === 1 ? matched[0]! : null;
  if (!entry || entry.app.key !== binding.providerKey) return { ok: false, reason: "provider" };
  if (entry.installationId !== binding.installationKey) return { ok: false, reason: "installation" };
  if (entry.config.revision !== binding.registrationRevision) return { ok: false, reason: "revision" };
  // Before any action-endpoint call: not suspended, proven within HARD_TTL
  // (both also gate the match above; restated here as the pre-call rule),
  // an action endpoint in force, and either the App's own-Server actions in
  // force on this Server (RFC 076 §17) or an approved official App.
  const actionEndpoint = entry.config.actionEndpoint;
  if (actionEndpoint === null || entry.config.suspendedAt !== null || !provenWithin(entry.config.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, input.now)) return { ok: false, reason: "eligibility" };
  const basis: LinkCardLiveState["basis"] | null = await isApprovedOfficialAppClient(entry.app.id) ? "official"
    : ownServerActionsInForce(entry, input.serverId) ? "own_server" : null;
  if (basis === null) return { ok: false, reason: "eligibility" };
  // RFC 076 §17: only a client that shows Raft's not-reviewed confirmation
  // before every acting button may act for such an App; the read gave other
  // clients navigate buttons, and a handle without it is refused here.
  if (basis === "own_server" && !binding.capabilities.includes(UNREVIEWED_APP_CAPABILITY)) return { ok: false, reason: "capabilities" };
  return { ok: true, live: { url, entry, actionEndpoint, actionEndpointSha256: linkCardActionEndpointSha256(actionEndpoint), basis } };
}

const HARD_TTL_SECONDS = LINK_PREVIEW_PROOF_HARD_TTL_MS / 1000;

/**
 * Execute's eligibility, decided at commit (RFC 076 §3.3; protocol §5.3.2 (a)):
 * FOR SHARE on the official registry row, the install row and the link-preview
 * registration row, so a revocation, an uninstall, a suspension or a
 * re-registration (each takes FOR UPDATE on its row) is ordered with this
 * execute. Then the registration must still be the one the handle names, not
 * suspended, proven within HARD_TTL by the database clock, and hold the same
 * approved action endpoint the live check saw; and the App must be an
 * approved official one, or have its own-Server actions in force on this
 * Server as the locked registration row has them (RFC 076 §17: withdrawing
 * the confirmation takes FOR UPDATE on that row).
 */
export async function lockLinkCardActionEligibility(tx: DatabaseExecutor, input: { live: LinkCardLiveState; claims: LinkCardHandleClaims; serverId: string }): Promise<boolean> {
  const { entry } = input.live;
  // FOR SHARE on the registry row when there is one; an App that is not
  // official passes only on its own-Server confirmation, read below under the
  // registration row's lock (a withdrawal takes FOR UPDATE on that row).
  const official = await isApprovedOfficialAppClient(entry.app.id, tx, { forShare: true });
  // The App's distribution is read in this statement too (RFC 076 §17: a
  // publish ends own-Server actions), not taken from the earlier live check.
  const [install] = await tx.select({ id: oauthClientInstalls.id, appType: oauthClients.appType }).from(oauthClientInstalls)
    .innerJoin(oauthClients, and(eq(oauthClients.id, oauthClientInstalls.clientId), eq(oauthClients.enabled, true)))
    .where(and(eq(oauthClientInstalls.id, input.claims.binding.installationKey), eq(oauthClientInstalls.clientId, entry.app.id),
      eq(oauthClientInstalls.serverId, input.serverId), eq(oauthClientInstalls.status, "active")))
    .for("share", { of: oauthClientInstalls });
  if (!install) return false;
  const [registration] = await tx.select({
    revision: oauthAppLinkPreviews.revision, origin: oauthAppLinkPreviews.origin, actionEndpoint: oauthAppLinkPreviews.actionEndpoint,
    suspendedAt: oauthAppLinkPreviews.suspendedAt, ownServerActionEndpoint: oauthAppLinkPreviews.ownServerActionEndpoint,
    proven: sql<boolean>`${oauthAppLinkPreviews.verifiedAt} > clock_timestamp() - make_interval(secs => ${HARD_TTL_SECONDS})`,
  }).from(oauthAppLinkPreviews).where(eq(oauthAppLinkPreviews.clientId, entry.app.id)).for("share");
  return !!registration && registration.revision === input.claims.binding.registrationRevision && registration.suspendedAt === null && registration.proven === true
    && registration.origin === entry.config.origin && registration.actionEndpoint !== null
    && linkCardActionEndpointSha256(registration.actionEndpoint) === input.live.actionEndpointSha256
    && (official || ownServerActionsInForce({ app: { serverId: entry.app.serverId, appType: install.appType }, config: registration }, input.serverId));
}

/**
 * The viewer's side of live state again, inside execute's admission
 * transaction after its lock waits (eligibility FOR SHARE and the advisory
 * locks, each up to lock_timeout), so a change made while execute waited is
 * not missed (Tenny, #10971 review). The check before the transaction stays the
 * first pass; this one is decided at commit, as eligibility is (RFC 076 §3.3):
 * - consent: the row the live match used, still active and covering the
 *   preview scopes, FOR SHARE. Every revocation and re-grant updates that one
 *   row (the viewer leaving the Server, an uninstall, an offline review, a new
 *   login), so one that committed first fails the re-read and one that starts
 *   later waits for this commit.
 * - decline: a missing row can't be locked, so the viewer's choice lock is
 *   taken shared (declining takes it exclusively, appLinkPreviewConsentService)
 *   and the decline is read again after it.
 * - message: read again through the same reader, which runs inside this
 *   transaction (the ambient transaction: its connection, a fresh snapshot per
 *   statement): still readable by the viewer (removal from a private channel
 *   or the Server fails it) and with the content digest the handle signed (an
 *   edit or a retraction changes it; a deletion leaves nothing to read).
 * Returns why the handle no longer matches (410: the transaction rolls back and
 * no App is called), or null.
 */
export async function recheckLinkCardViewerInTransaction(tx: DatabaseExecutor, input: {
  viewerId: string; serverId: string; claims: LinkCardHandleClaims; live: LinkCardLiveState; readMessage: LinkCardMessageReader;
}): Promise<LinkCardLiveStateFailure | null> {
  observeForTests?.("execute_transaction");
  const { entry } = input.live;
  const choice = { userId: input.viewerId, serverId: input.serverId, clientId: entry.app.id };
  if (entry.consentId === null) return "consent";
  const [consent] = await tx.select({ id: oauthUserConsents.id }).from(oauthUserConsents)
    .where(and(eq(oauthUserConsents.id, entry.consentId), eq(oauthUserConsents.userId, choice.userId), eq(oauthUserConsents.serverId, choice.serverId),
      eq(oauthUserConsents.clientId, choice.clientId), isNull(oauthUserConsents.revokedAt),
      sql`${oauthUserConsents.scopes}::jsonb @> ${JSON.stringify(LINK_PREVIEW_SCOPES)}::jsonb`))
    .for("share");
  if (!consent) return "consent";
  await lockLinkPreviewChoice(tx, choice, "shared");
  const [decline] = await tx.select({ id: oauthLinkPreviewDeclines.id }).from(oauthLinkPreviewDeclines)
    .where(and(eq(oauthLinkPreviewDeclines.userId, choice.userId), eq(oauthLinkPreviewDeclines.serverId, choice.serverId),
      eq(oauthLinkPreviewDeclines.clientId, choice.clientId)))
    .limit(1);
  if (decline) return "decline";
  const message = await input.readMessage(input.claims.binding.messageId);
  if (!message || linkCardMessageContentSha256(message.content) !== input.claims.messageContentSha256) return "message";
  return null;
}

/** A view row (claimed or rebuilt) belongs to this handle's view: same instance, viewer, identity domain, message and link (protocol §5.3.2 (g)). */
export function linkCardViewMatches(row: Pick<typeof linkCardViews.$inferSelect, "viewInstanceId" | "viewerId" | "serverId" | "providerKind" | "providerKey" | "installationKey" | "messageId" | "urlSha256">, claims: LinkCardHandleClaims): boolean {
  const b = claims.binding;
  return row.viewInstanceId === claims.viewInstanceId && row.viewerId === b.viewerId && row.serverId === b.serverId && row.providerKind === b.providerKind
    && row.providerKey === b.providerKey && row.installationKey === b.installationKey && row.messageId === b.messageId && row.urlSha256 === b.urlSha256;
}

/**
 * Immediately before execute is sent (the dispatch transaction): the
 * registration the operation was admitted under still has the endpoint and
 * origin it recorded, approved and in force, is not suspended and is proven
 * within HARD_TTL (checked before every action-endpoint call). Otherwise
 * nothing is sent: credentials never go to a changed, pending or deleted
 * endpoint (rule 8). Official eligibility is not re-checked here: it was
 * decided at commit (rule 3).
 */
export async function linkCardDispatchTargetInForce(tx: DatabaseExecutor, op: { providerKey: string; actionOrigin: string; actionEndpointSha256: string }): Promise<boolean> {
  return (await actionTargetInForce(tx, op)) !== null;
}

/**
 * Where a forwarded status may go (RFC 076 rule 8; protocol §5.4; T2): the
 * endpoint the operation's execute went to, and only while the registration of
 * the operation's OWN App, approved and in force, still has that origin and an
 * action endpoint with that SHA-256, is not suspended and is proven within
 * HARD_TTL (checked before every action-endpoint call). The registration
 * is looked up by the operation's client, never by origin, so an origin taken
 * over by another App (its row replaces the old owner's) is never asked about
 * the old owner's operations. A change to paths alone, or a repeat
 * registration, keeps the target; a pending, deleted, suspended or different
 * endpoint does not. Returns the endpoint to call, or null (do not forward).
 * Takes FOR SHARE on that registration row, so a re-registration is ordered
 * with the decision. The revision is not compared.
 * The answer's `audienceKey` is the id the App last proved (RFC 084 §4), for the assertion.
 */
export async function linkCardStatusTargetInForce(tx: DatabaseExecutor, op: { providerKind: string; providerKey: string; actionOrigin: string | null; actionEndpointSha256: string | null }): Promise<LinkCardActionTarget | null> {
  // Native providers are not registered yet; an app operation always recorded both.
  if (op.providerKind !== "app" || op.actionOrigin === null || op.actionEndpointSha256 === null) return null;
  return actionTargetInForce(tx, { providerKey: op.providerKey, actionOrigin: op.actionOrigin, actionEndpointSha256: op.actionEndpointSha256 });
}

/** Where an action-endpoint call may go, and the id its assertion names. */
export type LinkCardActionTarget = { endpoint: string; audienceKey: string };

async function actionTargetInForce(tx: DatabaseExecutor, op: { providerKey: string; actionOrigin: string; actionEndpointSha256: string }): Promise<LinkCardActionTarget | null> {
  const [registration] = await tx.select({
    origin: oauthAppLinkPreviews.origin, actionEndpoint: oauthAppLinkPreviews.actionEndpoint, suspendedAt: oauthAppLinkPreviews.suspendedAt,
    provedClientKey: oauthAppLinkPreviews.provedClientKey, clientKey: oauthClients.clientId,
    proven: sql<boolean>`${oauthAppLinkPreviews.verifiedAt} > clock_timestamp() - make_interval(secs => ${HARD_TTL_SECONDS})`,
  }).from(oauthAppLinkPreviews)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthAppLinkPreviews.clientId))
    .where(oauthClientHasKey(op.providerKey))
    .for("share", { of: oauthAppLinkPreviews });
  const inForce = !!registration && registration.suspendedAt === null && registration.proven === true && registration.origin === op.actionOrigin
    && registration.actionEndpoint !== null && linkCardActionEndpointSha256(registration.actionEndpoint) === op.actionEndpointSha256;
  return inForce ? { endpoint: registration.actionEndpoint!, audienceKey: registration.provedClientKey ?? registration.clientKey } : null;
}

/**
 * Whether the viewer may read an operation's receipt now (protocol §5.4, §8.2
 * (2)): the operation is theirs on this Server (the caller looked it up by the
 * authenticated identity), the App is still enabled with the original
 * installation active, their consent is still valid (not revoked, not
 * declined), and they can still read the message (a joint message too: RFC
 * 076 §16). Not the handle, eligibility, card
 * freshness or the current revision.
 */
export async function linkCardReceiptReadable(op: LinkCardReceiptSubject, readMessage: LinkCardMessageReader): Promise<boolean> {
  return (await linkCardReceiptAccess(op, readMessage)) !== null;
}

type LinkCardReceiptSubject = Pick<typeof linkCardOperations.$inferSelect, "viewerId" | "serverId" | "providerKind" | "providerKey" | "installationKey" | "messageId">;

/**
 * linkCardReceiptReadable, also returning the viewer's role on the Server now
 * (a forwarded status signs it as this request's `server_role`), or null when
 * the receipt is not readable. The viewer must still be a member (or guest).
 */
export async function linkCardReceiptAccess(op: LinkCardReceiptSubject, readMessage: LinkCardMessageReader): Promise<{ serverRole: RegisteredApp["serverRole"] } | null> {
  // Native providers are not registered yet: nothing native is readable.
  if (op.providerKind !== "app") return null;
  const [row] = await getDb().select({ clientId: oauthClients.id, declineId: oauthLinkPreviewDeclines.id, serverRole: serverMembers.role }).from(oauthClients)
    .innerJoin(oauthClientInstalls, and(eq(oauthClientInstalls.id, op.installationKey), eq(oauthClientInstalls.clientId, oauthClients.id),
      eq(oauthClientInstalls.serverId, op.serverId), eq(oauthClientInstalls.status, "active")))
    .innerJoin(oauthUserConsents, and(eq(oauthUserConsents.userId, op.viewerId), eq(oauthUserConsents.serverId, op.serverId), eq(oauthUserConsents.clientId, oauthClients.id),
      isNull(oauthUserConsents.revokedAt), sql`${oauthUserConsents.scopes}::jsonb @> ${JSON.stringify(LINK_PREVIEW_SCOPES)}::jsonb`))
    .innerJoin(serverMembers, and(eq(serverMembers.serverId, op.serverId), eq(serverMembers.userId, op.viewerId)))
    .leftJoin(oauthLinkPreviewDeclines, and(eq(oauthLinkPreviewDeclines.userId, op.viewerId), eq(oauthLinkPreviewDeclines.serverId, op.serverId),
      eq(oauthLinkPreviewDeclines.clientId, oauthClients.id)))
    .where(and(oauthClientHasKey(op.providerKey), eq(oauthClients.enabled, true)))
    .limit(1);
  if (!row || row.declineId !== null) return null;
  return (await readMessage(op.messageId)) !== null ? { serverRole: row.serverRole } : null;
}

/** An operation's identity domain (RFC 076 §5.2). */
export type LinkCardIdentityDomain = { providerKind: "app" | "native"; providerKey: string; installationKey: string };

/**
 * The identity domain a link of a message belongs to now, for the by-URL
 * operation lookup (RFC 076 §6.4; protocol §5.4, §7.4): the viewer can read the
 * message now, `urlSha256` names one of its preview links (re-extracted from the
 * current content), and Raft matches that link's provider server-side exactly as
 * the read does (enabled, actively installed, consented and not declined, not
 * suspended, proven within HARD_TTL, exactly one match). The client's digest is
 * only an identifier. Null when any of that fails: the lookup then returns
 * nothing, and an operation whose link now matches another App, or nothing,
 * stays reachable only by its own id. Not eligibility or the revision. Writes nothing and calls no App.
 */
export async function matchLinkCardUrlIdentity(input: {
  viewerId: string; serverId: string; messageId: string; urlSha256: string; readMessage: LinkCardMessageReader; now: Date;
}): Promise<LinkCardIdentityDomain | null> {
  const message = await input.readMessage(input.messageId);
  if (!message) return null;
  const url = appLinkReadUrls(message.content, appHosts(), LINK_CARD_READ_MAX_URLS).find((link) => linkCardUrlSha256(link) === input.urlSha256);
  if (!url) return null;
  const apps = await registeredApps(input.serverId, input.viewerId, [new URL(url).origin]);
  const matched = apps.filter((row) => previewable(row) && provenWithin(row.config.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, input.now) && matchesAppPreview(url, row.config));
  const entry = matched.length === 1 ? matched[0]! : null;
  return entry ? { providerKind: "app", providerKey: entry.app.key, installationKey: entry.installationId } : null;
}
