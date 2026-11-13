/**
 * One-time device-login grants (device-auth design v2 §3.1, §3.4): a device
 * login that asks for one thing instead of a session.
 *
 *   authorize  — the client sends `grant: { kind, machineName?, hostname?, os?, agentId? }`;
 *                deviceAuthService writes the grant row with the device authorization.
 *   describe   — the approval page gets the kind and what the person may pick
 *                (deviceLoginGrantChoices).
 *   approve    — the person picks a server / agent explicitly (never defaulted);
 *                the grant is approved for 10 minutes.
 *   token      — computer_attach: a single-use `dvat_*` attach token for that
 *                server (only its HMAC lookup hash is stored), returned once;
 *                computer_migrate: a `dvmt_*` migrate token for that server,
 *                the same way; agent_key: the `sk_agent_*` itself, minted and
 *                returned once. No session either way.
 *   attach     — POST /api/computer/attach with `Authorization: Bearer dvat_*`
 *                runs the existing attach as the approver and consumes the
 *                grant in the same transaction (computerCredentialService).
 *   migrate    — `Authorization: Bearer dvmt_*` reaches two routes only, as the
 *                approver and for the server they picked: the approver's own
 *                legacy-machine roster (GET /api/computer/legacy-machines, any
 *                number of times until the grant expires) and adopting one
 *                old daemon: their own, or by its id another member's while
 *                they hold registerMachines; never a machine whose Computer
 *                someone else attached (POST /api/computer/adopt-legacy,
 *                which consumes the grant in the adoption's transaction,
 *                computerAdoptionService). `raft-computer setup`'s legacy-daemon
 *                migration uses it instead of a user session.
 *
 * The grant row is the audit record: who asked (IP, location, user agent),
 * who approved, for which server or agent, and what it issued.
 */
import { randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { DEFAULT_EXTERNAL_AGENT_CAPABILITIES, computeTokenLookupHash, mintAgentCredential } from "./agentCredentialService";
import { getDb } from "../db/index";
import { agents, deviceAuthorizations, deviceLoginGrants, servers, users, type DeviceLoginGrantKind } from "../db/schema";
import { sanitizeClientName } from "./deviceAuthService";
import { sendDeviceGrantEmail, type DeviceGrantEmailEvent } from "./emailService";
import { issueComputerRevokeToken } from "./computerKeyRevocation";
import { FencedAuthorizationDeniedError, ServerMembershipRevokedError, withActorMembershipFence } from "../lib/actorMembershipFence";
import { userCanActOnAgentResource } from "../lib/actorPermissions";
import { recordIntegrationAuditEvent, serverAuditContextMetadata } from "./integrationAuditService";
import { addTraceEvent } from "../tracing/semanticTrace";

export const ATTACH_TOKEN_PREFIX = "dvat_";
export const MIGRATE_TOKEN_PREFIX = "dvmt_";
const ATTACH_TOKEN_BYTES = 32;
const MAX_ATTACH_TOKEN_LENGTH = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What a client asks for at authorize, validated and sanitized. */
export interface DeviceLoginGrantRequest {
  kind: DeviceLoginGrantKind;
  machineName: string | null;
  hostname: string | null;
  os: string | null;
  /** agent_key: the agent the client has in mind. A hint for the page, never the pick. */
  agentId: string | null;
}

export type ParseDeviceLoginGrantResult =
  | { ok: true; grant: DeviceLoginGrantRequest }
  | { ok: false; code: "grant_invalid" | "grant_kind_unsupported"; error: string };

function optionalLabel(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.length > 200) return { ok: false };
  return { ok: true, value: sanitizeClientName(raw) };
}

/** authorize's `grant` field. Absent/null is not a grant (the caller keeps the legacy device session). */
export function parseDeviceLoginGrantRequest(raw: unknown): ParseDeviceLoginGrantResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, code: "grant_invalid", error: "grant must be an object" };
  }
  const body = raw as Record<string, unknown>;
  if (typeof body.kind !== "string") {
    return { ok: false, code: "grant_invalid", error: "grant.kind must be computer_attach, computer_migrate or agent_key" };
  }
  // A kind this server does not know: a client newer than the server. It is in
  // REFUSAL_CODES so the client can fall back to what this server supports.
  if (body.kind !== "computer_attach" && body.kind !== "computer_migrate" && body.kind !== "agent_key") {
    return { ok: false, code: "grant_kind_unsupported", error: "This server does not support that grant kind; grant.kind must be computer_attach, computer_migrate or agent_key" };
  }
  const machineName = optionalLabel(body.machineName);
  const hostname = optionalLabel(body.hostname);
  const os = optionalLabel(body.os);
  if (!machineName.ok || !hostname.ok || !os.ok) {
    return { ok: false, code: "grant_invalid", error: "grant.machineName, grant.hostname and grant.os must be strings up to 200 chars" };
  }
  let agentId: string | null = null;
  if (body.agentId !== undefined && body.agentId !== null) {
    if (body.kind !== "agent_key" || typeof body.agentId !== "string" || !UUID_RE.test(body.agentId)) {
      return { ok: false, code: "grant_invalid", error: "grant.agentId must be an agent id, for an agent_key grant" };
    }
    agentId = body.agentId.toLowerCase();
  }
  return { ok: true, grant: { kind: body.kind, machineName: machineName.value, hostname: hostname.value, os: os.value, agentId } };
}

export interface OneTimeGrant {
  id: string;
  kind: DeviceLoginGrantKind;
  status: string;
  approverUserId: string | null;
  serverId: string | null;
  agentId: string | null;
  expiresAt: Date | null;
  machineName: string | null;
  hostname: string | null;
}

/** The one-time grant a device authorization was started for, or null (a legacy device-session login). */
export async function oneTimeGrantOf(deviceAuthorizationId: string): Promise<OneTimeGrant | null> {
  const [row] = await getDb()
    .select({
      id: deviceLoginGrants.id,
      kind: deviceLoginGrants.kind,
      status: deviceLoginGrants.status,
      approverUserId: deviceLoginGrants.approverUserId,
      serverId: deviceLoginGrants.serverId,
      agentId: deviceLoginGrants.agentId,
      expiresAt: deviceLoginGrants.expiresAt,
      machineName: deviceLoginGrants.machineName,
      hostname: deviceLoginGrants.hostname,
    })
    .from(deviceLoginGrants)
    .where(eq(deviceLoginGrants.deviceAuthorizationId, deviceAuthorizationId));
  return row ?? null;
}

async function markExpired(grantId: string): Promise<void> {
  await getDb()
    .update(deviceLoginGrants)
    .set({ status: "expired" })
    .where(and(eq(deviceLoginGrants.id, grantId), eq(deviceLoginGrants.status, "approved")));
}

function usable(grant: OneTimeGrant, now: Date): boolean {
  return grant.status === "approved" && Boolean(grant.approverUserId) && Boolean(grant.expiresAt && grant.expiresAt > now);
}

export type IssueAttachTokenResult =
  | { ok: true; attachToken: string; expiresAt: Date; server: { id: string; slug: string; name: string } }
  | { ok: false; error: "expired_token" | "access_denied" };

/** The server-scoped token a grant kind hands out at the token phase. */
function serverTokenPrefix(kind: DeviceLoginGrantKind): string | null {
  if (kind === "computer_attach") return ATTACH_TOKEN_PREFIX;
  if (kind === "computer_migrate") return MIGRATE_TOKEN_PREFIX;
  return null;
}

/**
 * Token phase, computer_attach (a `dvat_*` attach token) or computer_migrate
 * (a `dvmt_*` migrate token): the token, once. The device code was already
 * single-consumed, and the conditional write (no token yet, still approved,
 * unexpired) makes a second issue impossible either way.
 */
export async function issueAttachToken(grant: OneTimeGrant, now = new Date()): Promise<IssueAttachTokenResult> {
  const prefix = serverTokenPrefix(grant.kind);
  if (!prefix || !grant.serverId) return { ok: false, error: "access_denied" };
  if (!usable(grant, now)) {
    await markExpired(grant.id);
    return { ok: false, error: "expired_token" };
  }
  const [server] = await getDb()
    .select({ id: servers.id, slug: servers.slug, name: servers.name })
    .from(servers)
    .where(and(eq(servers.id, grant.serverId), isNull(servers.deletedAt)));
  if (!server) return { ok: false, error: "access_denied" };
  const attachToken = `${prefix}${randomBytes(ATTACH_TOKEN_BYTES).toString("base64url")}`;
  const [issued] = await getDb()
    .update(deviceLoginGrants)
    .set({ attachTokenLookupHash: computeTokenLookupHash(attachToken), attachTokenIssuedAt: now })
    .where(and(
      eq(deviceLoginGrants.id, grant.id),
      eq(deviceLoginGrants.status, "approved"),
      isNull(deviceLoginGrants.attachTokenLookupHash),
      gt(deviceLoginGrants.expiresAt, now),
    ))
    .returning({ id: deviceLoginGrants.id });
  if (!issued) return { ok: false, error: "expired_token" };
  addTraceEvent("auth.device.grant.token_issued", { grant_id: grant.id, kind: grant.kind, server_id: server.id, user_id: grant.approverUserId! });
  return { ok: true, attachToken, expiresAt: grant.expiresAt!, server };
}

export type MintGrantAgentKeyResult =
  | {
      ok: true;
      credential: { credentialId: string; apiKey: string; scopes: string[]; agentId: string; agentName: string; serverId: string };
    }
  | { ok: false; error: "expired_token" | "access_denied" };

/**
 * Token phase, agent_key: mints the key for the agent the person picked, as
 * them, under the same fence as POST /api/agents/:id/credentials (membership
 * row lock, agent row lock, the same authority rule), and consumes the grant in
 * that transaction. The raw key is returned once; the device code is already
 * consumed, so a second poll gets device_code_consumed. Like a refused
 * permission, an agent already at its live-key cap (mintAgentCredential,
 * agentCredentialMintLimits.ts) rolls the grant back and ends this login: the
 * RefusalError (409 agent_credential_limit_reached) is thrown to the route.
 */
export async function mintGrantAgentKey(grant: OneTimeGrant, now = new Date()): Promise<MintGrantAgentKeyResult> {
  if (grant.kind !== "agent_key" || !grant.agentId || !grant.serverId) return { ok: false, error: "access_denied" };
  if (!usable(grant, now)) {
    await markExpired(grant.id);
    return { ok: false, error: "expired_token" };
  }
  const userId = grant.approverUserId!;
  const agentId = grant.agentId;
  try {
    const credential = await withActorMembershipFence(grant.serverId, userId, async (tx, lockedRole) => {
      const [locked] = await tx
        .select({
          id: agents.id,
          serverId: agents.serverId,
          creatorType: agents.creatorType,
          creatorId: agents.creatorId,
          assistantOwnerUserId: agents.assistantOwnerUserId,
        })
        .from(agents)
        .where(and(eq(agents.id, agentId), isNull(agents.deletedAt)))
        .for("share");
      if (!locked || locked.serverId !== grant.serverId) throw new FencedAuthorizationDeniedError("not_found");
      if (!userCanActOnAgentResource(lockedRole, userId, locked, "issueAgentCredentials")) throw new FencedAuthorizationDeniedError("forbidden");
      const [claimed] = await tx
        .update(deviceLoginGrants)
        .set({ status: "consumed", consumedAt: now })
        .where(and(eq(deviceLoginGrants.id, grant.id), eq(deviceLoginGrants.status, "approved"), gt(deviceLoginGrants.expiresAt, now)))
        .returning({ id: deviceLoginGrants.id });
      if (!claimed) throw new FencedAuthorizationDeniedError("forbidden");
      const minted = await mintAgentCredential({
        agentId,
        scopes: DEFAULT_EXTERNAL_AGENT_CAPABILITIES,
        issuedVia: "human",
        createdByUserId: userId,
        requireExternalRuntime: true,
        ...(grant.machineName ? { name: grant.machineName } : {}),
      }, { executor: tx });
      await tx.update(deviceLoginGrants).set({ consumedAgentCredentialId: minted.credentialId }).where(eq(deviceLoginGrants.id, grant.id));
      await recordIntegrationAuditEvent({
        serverId: minted.serverId,
        eventType: "agent_credential.issued",
        outcome: "success",
        source: "cli",
        actor: { type: "human", id: userId },
        subject: { type: "agent", id: minted.agentId },
        target: { type: "agent_credential", id: minted.credentialId },
        metadata: {
          agentId: minted.agentId,
          credentialId: minted.credentialId,
          scopes: minted.scopes,
          issuedVia: minted.issuedVia,
          replacedCredentialId: null,
          ...serverAuditContextMetadata({ actorRole: lockedRole }),
        },
      }, tx);
      return minted;
    });
    addTraceEvent("auth.device.grant.consumed", {
      grant_id: grant.id,
      kind: grant.kind,
      server_id: credential.serverId,
      agent_id: credential.agentId,
      credential_id: credential.credentialId,
      user_id: userId,
    });
    return {
      ok: true,
      credential: {
        credentialId: credential.credentialId,
        apiKey: credential.apiKey,
        scopes: [...credential.scopes],
        agentId: credential.agentId,
        agentName: credential.agentName,
        serverId: credential.serverId,
      },
    };
  } catch (err) {
    if (err instanceof ServerMembershipRevokedError || err instanceof FencedAuthorizationDeniedError) return { ok: false, error: "access_denied" };
    if (err instanceof Error && (err.message === "agent_missing" || err.message === "agent_not_external")) return { ok: false, error: "access_denied" };
    throw err;
  }
}

export function looksLikeAttachToken(raw: string): boolean {
  return raw.startsWith(ATTACH_TOKEN_PREFIX);
}

export function looksLikeMigrateToken(raw: string): boolean {
  return raw.startsWith(MIGRATE_TOKEN_PREFIX);
}

/** The grant a server-scoped token was issued for: who approved it, for which server. */
export interface ServerTokenGrant {
  id: string;
  approverUserId: string;
  serverId: string;
  serverSlug: string;
  machineName: string | null;
  tokenLookupHash: Buffer;
}

export type FindAttachTokenGrantResult =
  | { ok: true; grant: ServerTokenGrant }
  | { ok: false; error: "attach_token_invalid" | "attach_token_expired" | "attach_token_consumed" };

export type FindMigrateTokenGrantResult =
  | { ok: true; grant: ServerTokenGrant }
  | { ok: false; error: "migrate_token_invalid" | "migrate_token_expired" | "migrate_token_consumed" };

async function findServerTokenGrant(
  rawToken: string,
  kind: "computer_attach" | "computer_migrate",
  now: Date,
): Promise<{ ok: true; grant: ServerTokenGrant } | { ok: false; error: "invalid" | "expired" | "consumed" }> {
  const prefix = serverTokenPrefix(kind)!;
  if (!rawToken.startsWith(prefix) || rawToken.length > MAX_ATTACH_TOKEN_LENGTH) return { ok: false, error: "invalid" };
  const tokenLookupHash = computeTokenLookupHash(rawToken);
  const [row] = await getDb()
    .select({
      id: deviceLoginGrants.id,
      kind: deviceLoginGrants.kind,
      status: deviceLoginGrants.status,
      approverUserId: deviceLoginGrants.approverUserId,
      serverId: deviceLoginGrants.serverId,
      expiresAt: deviceLoginGrants.expiresAt,
      machineName: deviceLoginGrants.machineName,
      serverSlug: servers.slug,
    })
    .from(deviceLoginGrants)
    .leftJoin(servers, and(eq(servers.id, deviceLoginGrants.serverId), isNull(servers.deletedAt)))
    .where(eq(deviceLoginGrants.attachTokenLookupHash, tokenLookupHash));
  if (!row || row.kind !== kind) return { ok: false, error: "invalid" };
  if (row.status === "consumed") return { ok: false, error: "consumed" };
  if (row.status !== "approved" || !row.expiresAt || row.expiresAt <= now) {
    if (row.status === "approved") await markExpired(row.id);
    return { ok: false, error: "expired" };
  }
  if (!row.approverUserId || !row.serverId || !row.serverSlug) return { ok: false, error: "invalid" };
  return {
    ok: true,
    grant: {
      id: row.id,
      approverUserId: row.approverUserId,
      serverId: row.serverId,
      serverSlug: row.serverSlug,
      machineName: row.machineName,
      tokenLookupHash,
    },
  };
}

/**
 * The grant an attach token was issued for, before the attach. Only a first
 * read: the attach's transaction locks the grant and checks it again
 * (computerCredentialService lockRedeemableAttachGrant).
 */
export async function findAttachTokenGrant(rawToken: string, now = new Date()): Promise<FindAttachTokenGrantResult> {
  const found = await findServerTokenGrant(rawToken, "computer_attach", now);
  return found.ok ? found : { ok: false, error: `attach_token_${found.error}` };
}

/**
 * The grant a migrate token was issued for. Enough for reading the roster;
 * the adoption's transaction locks the grant and checks it again before
 * consuming it (computerAdoptionService).
 */
export async function findMigrateTokenGrant(rawToken: string, now = new Date()): Promise<FindMigrateTokenGrantResult> {
  const found = await findServerTokenGrant(rawToken, "computer_migrate", now);
  return found.ok ? found : { ok: false, error: `migrate_token_${found.error}` };
}

/**
 * Mails the approver what a one-time grant just did: "You added machine X to
 * server Y" / "You gave agent Z a key". Never throws, never awaited by the
 * routes: the key is already issued.
 *
 * TODO(device-auth PR 2): a per-computer / per-key revoke link. Until then the
 * mail points at the server's Computers page and the agent's credentials.
 */
export async function sendDeviceGrantNotice(input: {
  grantId: string;
  event: DeviceGrantEmailEvent;
  machineName: string | null;
  serverId: string;
  agentName?: string | null;
  /** computer_attach: the Computer it added, for its one-time revoke link. */
  computerId?: string | null;
}): Promise<void> {
  try {
    const db = getDb();
    const [row] = await db
      .select({
        approverUserId: deviceLoginGrants.approverUserId,
        requestedAt: deviceAuthorizations.createdAt,
        requestedIp: deviceAuthorizations.requestedIp,
        requestedLocation: deviceAuthorizations.requestedLocation,
      })
      .from(deviceLoginGrants)
      .innerJoin(deviceAuthorizations, eq(deviceAuthorizations.id, deviceLoginGrants.deviceAuthorizationId))
      .where(eq(deviceLoginGrants.id, input.grantId));
    if (!row?.approverUserId) return;
    const [user] = await db
      .select({ email: users.email, name: users.name, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, row.approverUserId));
    const [server] = await db.select({ name: servers.name, slug: servers.slug }).from(servers).where(eq(servers.id, input.serverId));
    if (!user?.email || !server) return;
    // A link that couldn't be issued still leaves the email, pointing at the Computers page.
    const computerRevokeToken = input.event === "computer_attach" && input.computerId
      ? await issueComputerRevokeToken({ computerId: input.computerId, grantId: input.grantId }).catch((err: unknown) => {
        console.error("[device-login] computer revoke link failed:", err);
        return null;
      })
      : null;
    await sendDeviceGrantEmail(user.email, user.displayName || user.name, input.event, {
      computerRevokeToken,
      // Requester-chosen: no control or bidi characters in a mail from Raft.
      machineName: sanitizeClientName(input.machineName),
      serverName: server.name,
      serverSlug: server.slug,
      agentName: input.agentName ?? null,
      requestedAt: row.requestedAt,
      requester: { ip: row.requestedIp, location: row.requestedLocation },
    });
  } catch (err) {
    console.error(`[device-login] ${input.event} grant notice email failed:`, err);
  }
}
