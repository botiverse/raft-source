/**
 * Device-code authorization grant — task #30 PR-A2 (RFC v0.8 contract v3
 * §3/§5/§9). The SHARED pre-credential login primitive behind the generic
 * `/api/auth/device/*` surface, consumed by BOTH `raft-computer login`
 * AND external-agent `slock-cli login`.
 *
 * Lifecycle is aligned 1:1 with `agentBootstrapTokens` (contract §5 binding,
 * no forked auth/pepper path): HMAC lookup-hash (reuses the SAME pepper via
 * the exported `computeTokenLookupHash`), argon2id secret verifier,
 * single-consume CAS claim, soft state / NEVER deleted (audit), stable
 * fail-closed errors, zero existence enumeration.
 *
 * Three principal phases (contract §3 — device-code is NOT a Slock
 * principal, just a pre-credential grant):
 *   authorize  — unauthenticated public, env/feature gated
 *   describe   — USER-authenticated, read only (the approval page's check;
 *                issues the approval ticket approve needs)
 *   approve    — USER-authenticated
 *   token      — unauthenticated public poll, single-consume
 *
 * IMPORTANT: this grant does NOT mint `sk_computer_*` / `sk_agent_*`. It
 * only establishes an approved user identity, and the token phase issues
 * that identity's device session (in the consume's transaction, while the
 * sign-in that approved it is live). `attach` / external-agent bootstrap
 * later consume that identity under their own principal/surface contract.
 */
import { enforceAgentCredentialMintRate } from "./agentCredentialMintLimits";
import { randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { and, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { deviceAuthorizationRevokeTokens, deviceAuthorizations, deviceLoginGrants, integrationAuditEvents, users, type DeviceLoginGrantKind, type DeviceLoginRevokeReason, type SessionScope, type RequestSessionScope } from "../db/schema";
import type { DeviceLoginGrantRequest } from "./deviceLoginGrantService";
import { attachableServer, keyableAgent } from "./deviceLoginGrantChoices";
import { addTraceEvent } from "../tracing/semanticTrace";
import { sendDeviceLoginEmail } from "./emailService";
import { revokeSocketAccess } from "../socket/accessRevocation";
import { computeTokenLookupHash } from "./agentCredentialService";
import { createSession, DeviceSessionRevokedError, isApprovingSessionLive, lockLiveSessionFamily, revokeSessionFamilyInTransaction } from "./sessionService";
import { proofForDeviceLogin } from "./sessionIssueGate";
import { closeDeviceSessionKeys, deviceSessionKeyReach, revokeKeysOfRevokedDeviceSessions } from "./deviceSessionKeys";
import { approvedGrantReach } from "./approverSessionGrants";
import { runSecurityRevokeCascade } from "./securityRevokeCascade";

// Raw device_code entropy (base64url). user_code is a short human-typed
// code; device_code is the long secret polled by the client.
const DEVICE_CODE_BYTES = 32;
const USER_CODE_BYTES = 5; // → ~8 base32-ish chars, grouped for humans
const DEFAULT_DEVICE_CODE_TTL_MS = 10 * 60_000; // RFC-8628-style ~10min
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** How long an approved one-time grant may be used (device-auth design v2 §3.1). */
export const DEVICE_LOGIN_GRANT_TTL_MS = 10 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Gate — default-on. Operators flip SLOCK_DEVICE_LOGIN_ENABLED to an
// explicit false/0/no/off to kill-switch the surface (emergency only).
// Unset is treated as enabled because raft-computer attach is the
// canonical post-PR-G entry path; defaulting off blocked staging users
// even though every other safety gate (rate limit, anti-enum, code
// expiry, user-confirm page) is intact.
export function isDeviceAuthSurfaceEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env.SLOCK_DEVICE_LOGIN_ENABLED;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  return !(v === "0" || v === "false" || v === "no" || v === "off");
}

function humanUserCode(): string {
  // Crockford-ish base32 (no I/L/O/U), grouped XXXX-XXXX. Not a secret.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(USER_CODE_BYTES * 2);
  let out = "";
  for (let i = 0; i < 8; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

const USER_CODE_INPUT_MAX_LENGTH = 32;

/**
 * A code as a person types it, in its stored form (`XXXX-XXXX`): case, spaces
 * and dashes don't matter, and the letters the alphabet leaves out for being
 * look-alikes read as the digit they resemble (O → 0, I and L → 1). Null when
 * it can't be a code at all.
 */
export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > USER_CODE_INPUT_MAX_LENGTH) return null;
  const chars = raw.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (chars.length !== 8) return null;
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

const CLIENT_NAME_MAX_LENGTH = 64;

/**
 * The client name as the approval page may show it: the requester chooses it,
 * so control characters and bidirectional overrides (which reorder what
 * follows them on screen) are dropped, whitespace collapsed, and the length
 * capped. Null when nothing is left.
 */
export function sanitizeClientName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const kept = Array.from(raw).filter((ch) => {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false;
    if (code === 0x061c || code === 0x200e || code === 0x200f) return false;
    if (code >= 0x202a && code <= 0x202e) return false;
    if (code >= 0x2066 && code <= 0x2069) return false;
    return true;
  }).join("").replace(/\s+/g, " ").trim();
  if (!kept) return null;
  return Array.from(kept).slice(0, CLIENT_NAME_MAX_LENGTH).join("");
}

/**
 * Proof that the person's page checked a code with describe before approving
 * it: an HMAC over the grant and the person, so it can't be reused for another
 * code or account. A page that pre-fills a code from its link and approves in
 * one click (any web bundle from before this check, which a returning
 * visitor's service worker may still serve) never has one.
 */
function approvalTicket(grantId: string, userId: string): string {
  return computeTokenLookupHash(`device-approval-ticket:${grantId}:${userId}`).toString("base64url");
}

function approvalTicketMatches(grantId: string, userId: string, ticket: unknown): boolean {
  if (typeof ticket !== "string" || ticket.length > 100) return false;
  const expected = Buffer.from(approvalTicket(grantId, userId));
  const actual = Buffer.from(ticket);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export interface CreateDeviceAuthorizationResult {
  deviceCode: string; // raw — returned once, client polls with it
  userCode: string; // human enters this at the approve UI
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

/**
 * Who started a login, as the approval page shows it. The IP and location are
 * null unless the visitor's address is trusted (lib/visitorOrigin.ts).
 */
export interface DeviceAuthorizationRequester {
  ip: string | null;
  location: string | null;
}

/** authorize phase — unauthenticated public (caller must gate-check first). */
export async function createDeviceAuthorization(
  input: {
    clientName?: string | null;
    ttlMs?: number;
    requester?: DeviceAuthorizationRequester;
    /** A one-time grant instead of a session (deviceLoginGrantService); absent → a device session, as before. */
    grant?: DeviceLoginGrantRequest | null;
    /** Kept on the grant when there is one, otherwise on the authorization. */
    requesterUserAgent?: string | null;
  } = {},
): Promise<CreateDeviceAuthorizationResult> {
  const db = getDb();
  const deviceCode = `dvc_${randomBytes(DEVICE_CODE_BYTES).toString("base64url")}`;
  const userCode = humanUserCode();
  const ttlMs = input.ttlMs ?? DEFAULT_DEVICE_CODE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  const deviceCodeHash = await argon2.hash(deviceCode);
  const grant = input.grant ?? null;
  const requesterUserAgent = input.requesterUserAgent ? input.requesterUserAgent.slice(0, 512) : null;
  const createdGrantId = await db.transaction(async (tx): Promise<string | null> => {
    const [row] = await tx.insert(deviceAuthorizations).values({
      deviceCodeLookupHash: computeTokenLookupHash(deviceCode),
      deviceCodeHash,
      userCode,
      status: "pending",
      clientName: sanitizeClientName(input.clientName),
      expiresAt,
      pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
      requestedIp: input.requester?.ip ?? null,
      requestedLocation: input.requester?.location ?? null,
      requestedUserAgent: grant ? null : requesterUserAgent,
    }).returning({ id: deviceAuthorizations.id });
    if (!grant) return null;
    const [created] = await tx.insert(deviceLoginGrants).values({
      deviceAuthorizationId: row!.id,
      kind: grant.kind,
      status: "pending",
      machineName: grant.machineName,
      hostname: grant.hostname,
      os: grant.os,
      requestedAgentId: grant.agentId,
      requestedUserAgent: requesterUserAgent,
    }).returning({ id: deviceLoginGrants.id });
    return created!.id;
  });
  if (createdGrantId && grant) addTraceEvent("auth.device.grant.created", { grant_id: createdGrantId, kind: grant.kind });

  return {
    deviceCode,
    userCode,
    expiresInSeconds: Math.floor(ttlMs / 1000),
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

/** A one-time grant request, as describe shows it (choices are listed by the route). */
export interface DescribedDeviceLoginGrant {
  id: string;
  kind: DeviceLoginGrantKind;
  machineName: string | null;
  hostname: string | null;
  os: string | null;
  requestedAgentId: string | null;
}

export type DescribeDeviceAuthorizationResult =
  | {
      ok: true;
      /** Set when the client asked for a one-time grant instead of a session. */
      grant: DescribedDeviceLoginGrant | null;
      /** The stored form of the typed code, for the page to show. */
      userCode: string;
      /** As the client sent it (sanitized): anyone starting a login can set it to anything. */
      clientName: string | null;
      requestedAt: Date;
      requester: DeviceAuthorizationRequester;
      /** What approve needs to approve this code as this person. */
      approvalTicket: string;
    }
  | { ok: false; error: "user_code_invalid" | "already_resolved" | "expired" };

/**
 * The approval page's look at a code before anyone approves it — USER-
 * authenticated like approve, with approve's answers for a code that can't be
 * approved (same states, same uniform user_code_invalid for a miss). Its
 * approval ticket is what approve requires.
 */
export async function describeDeviceAuthorization(input: { userCode: unknown; userId: string }): Promise<DescribeDeviceAuthorizationResult> {
  const userCode = normalizeUserCode(input.userCode);
  if (!userCode) return { ok: false, error: "user_code_invalid" };
  const db = getDb();
  const [row] = await db
    .select({
      id: deviceAuthorizations.id,
      status: deviceAuthorizations.status,
      clientName: deviceAuthorizations.clientName,
      expiresAt: deviceAuthorizations.expiresAt,
      createdAt: deviceAuthorizations.createdAt,
      requestedIp: deviceAuthorizations.requestedIp,
      requestedLocation: deviceAuthorizations.requestedLocation,
      grantId: deviceLoginGrants.id,
      grantKind: deviceLoginGrants.kind,
      machineName: deviceLoginGrants.machineName,
      hostname: deviceLoginGrants.hostname,
      os: deviceLoginGrants.os,
      requestedAgentId: deviceLoginGrants.requestedAgentId,
    })
    .from(deviceAuthorizations)
    .leftJoin(deviceLoginGrants, eq(deviceLoginGrants.deviceAuthorizationId, deviceAuthorizations.id))
    .where(eq(deviceAuthorizations.userCode, userCode));
  if (!row) return { ok: false, error: "user_code_invalid" };
  if (row.status !== "pending") return { ok: false, error: "already_resolved" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, error: "expired" };
  return {
    ok: true,
    grant: row.grantId && row.grantKind
      ? {
          id: row.grantId,
          kind: row.grantKind,
          machineName: row.machineName,
          hostname: row.hostname,
          os: row.os,
          requestedAgentId: row.requestedAgentId,
        }
      : null,
    userCode,
    clientName: row.clientName,
    requestedAt: row.createdAt,
    requester: { ip: row.requestedIp, location: row.requestedLocation },
    approvalTicket: approvalTicket(row.id, input.userId),
  };
}

/** A login just approved, as its notification email describes it. */
export interface ApprovedDeviceLogin {
  id: string;
  clientName: string | null;
  requestedAt: Date;
  requester: Pick<DeviceAuthorizationRequester, "ip" | "location">;
}

export type ApproveDeviceAuthorizationResult =
  | {
      ok: true;
      grant: ApprovedDeviceLogin;
      /** Set when it was a one-time grant: what the person picked. */
      oneTime: { id: string; kind: DeviceLoginGrantKind; serverId: string | null; agentId: string | null } | null;
    }
  | {
      ok: false;
      error:
        | "user_code_invalid"
        | "already_resolved"
        | "expired"
        | "approval_ticket_required"
        // One-time grants: the server (computer_attach, computer_migrate) or
        // agent (agent_key) must be picked explicitly, and be one the person may use.
        | "grant_selection_required"
        | "grant_selection_not_allowed"
        | "grant_kind_unsupported"
        // The approving session was revoked while it approved.
        | "approver_session_revoked";
    };

/**
 * approve phase — USER-authenticated. `userId` is the authenticated
 * principal from the web/JWT session. Approving needs describe's approval
 * ticket for this code and person (denying doesn't). CAS: only a
 * still-pending, unexpired grant transitions (zero enumeration: any miss →
 * uniform user_code_invalid).
 */
export async function approveDeviceAuthorization(input: {
  userCode: unknown;
  userId: string;
  approve: boolean;
  approvalTicket?: unknown;
  /** A one-time grant's explicit pick: never defaulted, even when only one is possible. */
  selection?: { serverId?: unknown; agentId?: unknown };
  /**
   * The approving web session's family, recorded on every approval
   * (device_authorizations.approver_family_id: a code for a device session is
   * polled only while it is live, consumeDeviceAuthorization), and on a
   * one-time grant so a security revoke of that session revokes what the
   * grant issued (approverSessionGrants.ts). Null for a legacy token with no
   * family.
   */
  approverSessionFamilyId?: string | null;
}): Promise<ApproveDeviceAuthorizationResult> {
  const userCode = normalizeUserCode(input.userCode);
  if (!userCode) return { ok: false, error: "user_code_invalid" };
  const db = getDb();
  const [row] = await db
    .select({
      id: deviceAuthorizations.id,
      status: deviceAuthorizations.status,
      expiresAt: deviceAuthorizations.expiresAt,
      grantId: deviceLoginGrants.id,
      grantKind: deviceLoginGrants.kind,
    })
    .from(deviceAuthorizations)
    .leftJoin(deviceLoginGrants, eq(deviceLoginGrants.deviceAuthorizationId, deviceAuthorizations.id))
    .where(eq(deviceAuthorizations.userCode, userCode));
  if (!row) return { ok: false, error: "user_code_invalid" };
  if (input.approve && !approvalTicketMatches(row.id, input.userId, input.approvalTicket)) {
    return { ok: false, error: "approval_ticket_required" };
  }
  if (row.status !== "pending") return { ok: false, error: "already_resolved" };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "expired" };
  }

  // A one-time grant: the person's explicit pick, checked against the same
  // rule as the route it stands in for. Re-checked when it is used (attach
  // and the agent key mint run their own permission fence).
  let pick: { serverId: string | null; agentId: string | null } = { serverId: null, agentId: null };
  if (row.grantId && row.grantKind && input.approve) {
    const selection = input.selection ?? {};
    // computer_migrate picks the server the same way: the servers the person
    // may add a Computer to, the gate adopting one checks too.
    if (row.grantKind === "computer_attach" || row.grantKind === "computer_migrate") {
      if (typeof selection.serverId !== "string" || !UUID_RE.test(selection.serverId)) return { ok: false, error: "grant_selection_required" };
      if (!await attachableServer(input.userId, selection.serverId)) return { ok: false, error: "grant_selection_not_allowed" };
      pick = { serverId: selection.serverId, agentId: null };
    } else if (row.grantKind === "agent_key") {
      if (typeof selection.agentId !== "string" || !UUID_RE.test(selection.agentId)) return { ok: false, error: "grant_selection_required" };
      const agent = await keyableAgent(input.userId, selection.agentId);
      if (!agent) return { ok: false, error: "grant_selection_not_allowed" };
      // Approving is the person's act of issuing the key (minted when the
      // device polls): the same per-person and per-agent budget as a direct
      // mint, refused here (429) while the code can still be approved later.
      await enforceAgentCredentialMintRate({ userId: input.userId, agentId: agent.id });
      pick = { serverId: agent.serverId, agentId: agent.id };
    } else {
      return { ok: false, error: "grant_kind_unsupported" };
    }
  }

  const now = new Date();
  const approverSessionFamilyId = row.grantId && input.approve ? input.approverSessionFamilyId ?? null : null;
  return db.transaction(async (tx): Promise<ApproveDeviceAuthorizationResult> => {
    // A one-time grant records the approving session's family: fence it live,
    // as a device session's writes do, so a security revoke of that session
    // either commits first (nothing is approved) or waits for this commit and
    // its cascade then sees the grant (approverSessionGrants.ts).
    if (approverSessionFamilyId) {
      try {
        await lockLiveSessionFamily(tx, approverSessionFamilyId, input.userId);
      } catch (err) {
        if (err instanceof DeviceSessionRevokedError) return { ok: false, error: "approver_session_revoked" };
        throw err;
      }
    }
    // CAS — only flip if still pending (loses to a concurrent resolve).
    const claimed = await tx
      .update(deviceAuthorizations)
      .set(
        input.approve
          ? {
              status: "approved",
              approvedByUserId: input.userId,
              approvedAt: now,
              // Every approval records the approving session's family (two-step
              // verification reads it later); only a grant fences it live above.
              approverFamilyId: input.approverSessionFamilyId ?? null,
            }
          : { status: "denied", deniedAt: now },
      )
      .where(
        and(
          eq(deviceAuthorizations.id, row.id),
          eq(deviceAuthorizations.status, "pending"),
        ),
      )
      .returning({
        id: deviceAuthorizations.id,
        clientName: deviceAuthorizations.clientName,
        createdAt: deviceAuthorizations.createdAt,
        requestedIp: deviceAuthorizations.requestedIp,
        requestedLocation: deviceAuthorizations.requestedLocation,
      });
    const [grant] = claimed;
    if (!grant) return { ok: false, error: "already_resolved" };
    let oneTime: { id: string; kind: DeviceLoginGrantKind; serverId: string | null; agentId: string | null } | null = null;
    if (row.grantId && row.grantKind) {
      await tx
        .update(deviceLoginGrants)
        .set(input.approve
          ? {
              status: "approved",
              approverUserId: input.userId,
              approverSessionFamilyId,
              serverId: pick.serverId,
              agentId: pick.agentId,
              approvedAt: now,
              expiresAt: new Date(now.getTime() + DEVICE_LOGIN_GRANT_TTL_MS),
            }
          : { status: "denied" })
        .where(and(eq(deviceLoginGrants.id, row.grantId), eq(deviceLoginGrants.status, "pending")));
      oneTime = { id: row.grantId, kind: row.grantKind, ...pick };
    }
    return {
      ok: true,
      oneTime,
      grant: {
        id: grant.id,
        clientName: grant.clientName,
        requestedAt: grant.createdAt,
        requester: { ip: grant.requestedIp, location: grant.requestedLocation },
      },
    };
  });
}

export type ConsumeDeviceAuthorizationError =
  | "device_code_invalid"
  | "authorization_pending"
  | "access_denied"
  | "expired_token"
  | "device_code_consumed";

export type ConsumeDeviceAuthorizationResult =
  | {
      ok: true;
      grantId: string;
      approvedByUserId: string;
      /**
       * The device session issued for a login that asked for one; null for a
       * one-time grant (the route issues what the grant asks for).
       */
      session: { sessionId: string; familyId: string; refreshToken: string } | null;
    }
  | { ok: false; error: ConsumeDeviceAuthorizationError };

type DeviceCodeState = Pick<
  typeof deviceAuthorizations.$inferSelect,
  "status" | "approvedByUserId" | "expiresAt" | "consumedAt" | "revokedAt"
>;

/** What the poll answers for a code it can't consume now; null when it can. */
function unconsumableAnswer(row: DeviceCodeState, now: number): ConsumeDeviceAuthorizationError | null {
  if (row.revokedAt) return "access_denied";
  if (row.consumedAt) return "device_code_consumed";
  if (row.expiresAt.getTime() <= now) return "expired_token";
  if (row.status === "denied") return "access_denied";
  if (row.status !== "approved" || !row.approvedByUserId) return "authorization_pending";
  return null;
}

/**
 * token phase — unauthenticated public poll. HMAC-locate → argon2-verify →
 * distinct status → CAS single-consume. Zero enumeration: unknown/invalid →
 * uniform device_code_invalid. This grant never mints sk_* itself (contract
 * §5).
 *
 * A login that asked for a device session gets it here, in the consume's
 * transaction, and only while the web sign-in that approved the code is live
 * (device_authorizations.approver_family_id, isApprovingSessionLive): past
 * the verifier, the person's `users` row is taken FOR UPDATE (as every
 * family revoker takes it first, and as the session issue does after this),
 * then the code's row is read again, so a revoke of the approver (a logout, a
 * password change or reset, the account's retirement) either commits first
 * and the code is refused, or waits until the session exists (and a revoke
 * of every family then takes it too). Refused as a denied code is
 * (access_denied), so it tells nothing new; a revoke of the family has
 * usually denied it already (denyLoginCodesApprovedBy). A code that names no
 * family is refused: every approval records it (approveDeviceAuthorization),
 * so only an approval from before the column has none.
 *
 * A one-time grant's code is consumed as before, and the route issues what
 * the grant asks for: it was fenced live when approved, and what it issues
 * dies only with a security revoke of that sign-in (approverSessionGrants.ts).
 */
export async function consumeDeviceAuthorization(
  rawDeviceCode: string,
  observe: { ip?: string | null; userAgent?: string | null } = {},
): Promise<ConsumeDeviceAuthorizationResult> {
  if (!rawDeviceCode || typeof rawDeviceCode !== "string") {
    return { ok: false, error: "device_code_invalid" };
  }
  const db = getDb();
  const [row] = await db
    .select({
      id: deviceAuthorizations.id,
      deviceCodeHash: deviceAuthorizations.deviceCodeHash,
      status: deviceAuthorizations.status,
      approvedByUserId: deviceAuthorizations.approvedByUserId,
      expiresAt: deviceAuthorizations.expiresAt,
      consumedAt: deviceAuthorizations.consumedAt,
      revokedAt: deviceAuthorizations.revokedAt,
      oneTimeGrantId: deviceLoginGrants.id,
    })
    .from(deviceAuthorizations)
    .leftJoin(deviceLoginGrants, eq(deviceLoginGrants.deviceAuthorizationId, deviceAuthorizations.id))
    .where(eq(deviceAuthorizations.deviceCodeLookupHash, computeTokenLookupHash(rawDeviceCode)));
  if (!row) return { ok: false, error: "device_code_invalid" };

  let argonOk = false;
  try {
    argonOk = await argon2.verify(row.deviceCodeHash, rawDeviceCode);
  } catch {
    argonOk = false;
  }
  if (!argonOk) return { ok: false, error: "device_code_invalid" };

  const unconsumable = unconsumableAnswer(row, Date.now());
  if (unconsumable || !row.approvedByUserId) return { ok: false, error: unconsumable ?? "authorization_pending" };
  const userId = row.approvedByUserId;
  const consumed = {
    status: "consumed",
    consumedAt: new Date(),
    consumedIp: observe.ip ?? null,
    consumedUserAgent: observe.userAgent ?? null,
  };
  const claim = (executor: DatabaseExecutor) => executor
    .update(deviceAuthorizations)
    .set(consumed)
    .where(and(eq(deviceAuthorizations.id, row.id), eq(deviceAuthorizations.status, "approved")))
    .returning({ id: deviceAuthorizations.id });

  // CAS single-consume — lose the race → device_code_consumed.
  if (row.oneTimeGrantId) {
    if ((await claim(db)).length === 0) return { ok: false, error: "device_code_consumed" };
    return { ok: true, grantId: row.id, approvedByUserId: userId, session: null };
  }
  return db.transaction(async (tx): Promise<ConsumeDeviceAuthorizationResult> => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1).for("update");
    const [current] = await tx
      .select({
        status: deviceAuthorizations.status,
        approvedByUserId: deviceAuthorizations.approvedByUserId,
        approverFamilyId: deviceAuthorizations.approverFamilyId,
        expiresAt: deviceAuthorizations.expiresAt,
        consumedAt: deviceAuthorizations.consumedAt,
        revokedAt: deviceAuthorizations.revokedAt,
      })
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.id, row.id));
    if (!current) return { ok: false, error: "device_code_invalid" };
    const answer = unconsumableAnswer(current, Date.now());
    if (answer) return { ok: false, error: answer };
    if (!(await isApprovingSessionLive(tx, { userId, familyId: current.approverFamilyId }))) {
      return { ok: false, error: "access_denied" };
    }
    if ((await claim(tx)).length === 0) return { ok: false, error: "device_code_consumed" };
    // A device-scoped session: only the routes Raft Computer and the raft CLI
    // call, 7-day refresh window (middleware/auth.ts DEVICE_SESSION_ROUTES).
    // Deliberately never inherits the approver's second factor (see
    // proofForDeviceLogin): a long-lived device session, and the approval
    // check has no time limit. `approverFamilyId` is passed only for its SSO
    // facts (RFC 083 §6.2), which createSession copies with their original time.
    const { sessionId, familyId, refreshToken } = await createSession(await proofForDeviceLogin(userId, current.approverFamilyId), tx, { scope: "device" });
    return { ok: true, grantId: row.id, approvedByUserId: userId, session: { sessionId, familyId, refreshToken } };
  });
}

const REVOKE_LINK_TTL_MS = 24 * 60 * 60 * 1000;
const REVOKE_TOKEN_PREFIX = "dvr_";
const MAX_REVOKE_TOKEN_LENGTH = 100;

export type { DeviceLoginRevokeReason };

/**
 * A one-time "this wasn't me" link for a device login, mailed to the person
 * who approved it. Only the HMAC lookup hash is stored; the raw `dvr_*` token
 * goes into the email once.
 */
export async function issueDeviceLoginRevokeToken(grantId: string, reason: DeviceLoginRevokeReason): Promise<string> {
  const token = `${REVOKE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  await getDb().insert(deviceAuthorizationRevokeTokens).values({
    deviceAuthorizationId: grantId,
    tokenLookupHash: computeTokenLookupHash(token),
    reason,
    expiresAt: new Date(Date.now() + REVOKE_LINK_TTL_MS),
  });
  return token;
}

/**
 * Mails the person a device login acted for: what happened, who asked, and a
 * fresh revoke link. Never throws: the login has already happened, and a
 * failed email must not undo it (the failure is logged).
 */
export async function sendDeviceLoginNotice(input: {
  userId: string;
  grant: ApprovedDeviceLogin;
  event: DeviceLoginRevokeReason;
  target?: { label: string; value: string };
}): Promise<void> {
  try {
    const [user] = await getDb()
      .select({ email: users.email, name: users.name, displayName: users.displayName })
      .from(users)
      .where(eq(users.id, input.userId));
    if (!user?.email) return;
    const token = await issueDeviceLoginRevokeToken(input.grant.id, input.event);
    await sendDeviceLoginEmail(user.email, user.displayName || user.name, input.event, {
      requestedAt: input.grant.requestedAt,
      requester: input.grant.requester,
      ...(input.target ? { target: input.target } : {}),
    }, token);
  } catch (err) {
    console.error(`[device-login] ${input.event} notice email failed:`, err);
  }
}

/**
 * When a device login's session does something that hands out lasting
 * access (mints an agent credential, attaches or adopts a computer), the
 * person it acts for gets the same notice as on approval, with a fresh revoke
 * link. A full session, or a family no device login issued, sends nothing.
 */
/**
 * Never awaited by the routes: the credential or computer key is already
 * minted, and the person must get it even if the mail provider stalls.
 */
export async function notifyDeviceSessionAction(input: {
  userId: string | undefined;
  familyId: string | undefined;
  scope: RequestSessionScope | undefined;
  event: Exclude<DeviceLoginRevokeReason, "approved">;
  /** What it acted on, shown in the email ("Agent: …", "Server: …"). */
  target?: { label: string; value: string };
}): Promise<void> {
  if (input.scope !== "device" || !input.userId || !input.familyId) return;
  try {
    const [grant] = await getDb()
      .select({
        id: deviceAuthorizations.id,
        clientName: deviceAuthorizations.clientName,
        createdAt: deviceAuthorizations.createdAt,
        requestedIp: deviceAuthorizations.requestedIp,
        requestedLocation: deviceAuthorizations.requestedLocation,
      })
      .from(deviceAuthorizations)
      .where(eq(deviceAuthorizations.consumedSessionFamilyId, input.familyId))
      .limit(1);
    if (!grant) return;
    await sendDeviceLoginNotice({
      userId: input.userId,
      event: input.event,
      target: input.target,
      grant: {
        id: grant.id,
        clientName: grant.clientName,
        requestedAt: grant.createdAt,
        requester: { ip: grant.requestedIp, location: grant.requestedLocation },
      },
    });
  } catch (err) {
    console.error(`[device-login] ${input.event} notice failed:`, err);
  }
}

/**
 * The token phase names the session it issued, so a revoke link can sign it
 * out. A link used between the consume and this write already revoked the
 * grant: `revoked` tells the token phase to revoke the new session at once
 * (the row lock orders the two writes, so one of them always sees the other).
 */
export async function recordDeviceLoginSession(
  grantId: string,
  session: { sessionId: string; familyId: string },
): Promise<{ revoked: boolean }> {
  const [row] = await getDb()
    .update(deviceAuthorizations)
    .set({ consumedSessionId: session.sessionId, consumedSessionFamilyId: session.familyId })
    .where(eq(deviceAuthorizations.id, grantId))
    .returning({ revokedAt: deviceAuthorizations.revokedAt });
  return { revoked: Boolean(row?.revokedAt) };
}

/** Signs a device login's session out everywhere: its family, every rotation, open sockets, and what it handed out. */
export async function revokeDeviceLoginSession(userId: string, familyId: string): Promise<void> {
  await getDb().transaction(async (tx) => {
    await revokeSessionFamilyInTransaction(tx, userId, familyId, "device_login_revoked");
  });
  try {
    await revokeSocketAccess({ userId, familyId });
  } finally {
    await revokeKeysOfRevokedDeviceSessions({ familyId });
  }
}

/**
 * "This wasn't me" is a security revoke: what the session approved through
 * one-time grants goes too (approverSessionGrants.ts). A device-scoped session
 * can't approve (approve isn't a device-session route), so today this only
 * reaches a family that was `full` when it approved; it is kept so the link
 * means "everything this session did" whatever its scope. A used link runs it
 * again and closes again, for a first click that failed after the revoke.
 * Likewise what a `full` session issued itself (webSessionIssuedKeys.ts): a
 * device family records nothing there today, so this reaches nothing yet.
 * Logged, not thrown: the revoke has committed, and maintenance repairs it.
 */
async function revokeApprovedByRevokedDeviceLogin(familyId: string, reclose: boolean, now: Date): Promise<void> {
  try {
    await runSecurityRevokeCascade({ familyId }, "device_login_revoked", now);
    if (reclose) await closeDeviceSessionKeys(await approvedGrantReach(familyId));
  } catch (err) {
    console.error("[device-login] revoking what the revoked session approved or issued failed:", err);
  }
}

export type RevokeDeviceLoginResult =
  /**
   * `grant`: not yet exchanged for a session, now never will be. `session`:
   * the session it issued is signed out. `session_unknown`: it was exchanged,
   * but by a server from before sessions were recorded, so there is no session
   * to sign out here (the page sends the person to change their password).
   */
  | { ok: true; revoked: "grant" | "session" | "session_unknown" }
  | { ok: false; error: "revoke_link_invalid" | "revoke_link_used" | "revoke_link_expired" };

/**
 * Socket eviction after a link signed a session out. It can fail (fan-out
 * not ready, timeout) after the revoke has committed: logged, and a second
 * click on the used link evicts again, so a live socket can't outlast it.
 */
async function evictDeviceLoginSockets(userId: string, familyId: string): Promise<void> {
  try {
    await revokeSocketAccess({ userId, familyId });
  } catch (err) {
    console.error("[device-login] revoke link socket eviction failed:", err);
  }
}

/**
 * A revoke link, used. Single use, 24 hours, and it only revokes: before the
 * token phase it cancels the grant (the poll then gets access_denied); after
 * it, it revokes the session family the grant issued, and everything that
 * session handed out: the agent credentials it minted and the Computer keys it
 * holds, with their runners' credentials (deviceSessionKeys.ts).
 */
export async function revokeDeviceLoginByLink(rawToken: unknown, now = new Date()): Promise<RevokeDeviceLoginResult> {
  if (typeof rawToken !== "string" || !rawToken.startsWith(REVOKE_TOKEN_PREFIX) || rawToken.length > MAX_REVOKE_TOKEN_LENGTH) {
    return { ok: false, error: "revoke_link_invalid" };
  }
  const lookupHash = computeTokenLookupHash(rawToken);
  const result = await getDb().transaction(async (tx) => {
    const [link] = await tx
      .update(deviceAuthorizationRevokeTokens)
      .set({ usedAt: now })
      .where(and(
        eq(deviceAuthorizationRevokeTokens.tokenLookupHash, lookupHash),
        isNull(deviceAuthorizationRevokeTokens.usedAt),
        gt(deviceAuthorizationRevokeTokens.expiresAt, now),
      ))
      .returning({ grantId: deviceAuthorizationRevokeTokens.deviceAuthorizationId });
    if (!link) {
      const [existing] = await tx
        .select({
          usedAt: deviceAuthorizationRevokeTokens.usedAt,
          userId: deviceAuthorizations.approvedByUserId,
          familyId: deviceAuthorizations.consumedSessionFamilyId,
          revokedAt: deviceAuthorizations.revokedAt,
        })
        .from(deviceAuthorizationRevokeTokens)
        .innerJoin(deviceAuthorizations, eq(deviceAuthorizations.id, deviceAuthorizationRevokeTokens.deviceAuthorizationId))
        .where(eq(deviceAuthorizationRevokeTokens.tokenLookupHash, lookupHash));
      if (!existing) return { ok: false as const, error: "revoke_link_invalid" as const };
      if (!existing.usedAt) return { ok: false as const, error: "revoke_link_expired" as const };
      // Used already: evict again, for a first click whose eviction failed.
      const evict = existing.revokedAt && existing.userId && existing.familyId
        ? { userId: existing.userId, familyId: existing.familyId }
        : null;
      return { ok: false as const, error: "revoke_link_used" as const, evict };
    }
    const [grant] = await tx
      .update(deviceAuthorizations)
      .set({
        revokedAt: sql`COALESCE(${deviceAuthorizations.revokedAt}, ${now})`,
        revokedReason: sql`COALESCE(${deviceAuthorizations.revokedReason}, 'revoke_link')`,
      })
      .where(eq(deviceAuthorizations.id, link.grantId))
      .returning({
        userId: deviceAuthorizations.approvedByUserId,
        familyId: deviceAuthorizations.consumedSessionFamilyId,
        consumedAt: deviceAuthorizations.consumedAt,
      });
    if (grant?.userId && grant.familyId) {
      await revokeSessionFamilyInTransaction(tx, grant.userId, grant.familyId, "device_login_revoked", now);
      return { ok: true as const, revoked: "session" as const, evict: { userId: grant.userId, familyId: grant.familyId } };
    }
    return { ok: true as const, revoked: grant?.consumedAt ? "session_unknown" as const : "grant" as const, evict: null };
  });
  // Once the family's revoke has committed, what its session handed out goes
  // too (deviceSessionKeys.ts, its own transaction). A used link runs it again:
  // it revokes what is still live, and closes every key the family had, for a
  // first click that failed after the revoke.
  const revoked = result.ok ? result.evict : result.error === "revoke_link_used" ? result.evict : null;
  if (revoked) {
    await evictDeviceLoginSockets(revoked.userId, revoked.familyId);
    await revokeApprovedByRevokedDeviceLogin(revoked.familyId, !result.ok, now);
    await revokeKeysOfRevokedDeviceSessions({ familyId: revoked.familyId }, now);
    if (!result.ok) await closeDeviceSessionKeys(await deviceSessionKeyReach(revoked.familyId));
  }
  return result.ok ? { ok: true, revoked: result.revoked } : { ok: false, error: result.error };
}

const REQUESTER_DETAILS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SCRUB_BATCH_SIZE = 500;
const SCRUB_MAX_BATCHES = 20;

/**
 * Clears who started and who finished each login (IP, location, user agent)
 * 30 days after it was started: kept for security only (hourly maintenance,
 * bounded batches per tick). The grant row itself stays for audit.
 */
export async function scrubDeviceAuthorizationRequesterDetails(opts: {
  now?: Date;
  batchSize?: number;
  maxBatches?: number;
} = {}): Promise<number> {
  const db = getDb();
  const cutoff = new Date((opts.now ?? new Date()).getTime() - REQUESTER_DETAILS_RETENTION_MS);
  const batchSize = opts.batchSize ?? SCRUB_BATCH_SIZE;
  const maxBatches = opts.maxBatches ?? SCRUB_MAX_BATCHES;
  const hasDetails = or(
    isNotNull(deviceAuthorizations.requestedIp),
    isNotNull(deviceAuthorizations.requestedLocation),
    isNotNull(deviceAuthorizations.consumedIp),
    isNotNull(deviceAuthorizations.consumedUserAgent),
    isNotNull(deviceAuthorizations.requestedUserAgent),
  );
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const scrubbed = await db
      .update(deviceAuthorizations)
      .set({
        requestedIp: null,
        requestedLocation: null,
        consumedIp: null,
        consumedUserAgent: null,
        requestedUserAgent: null,
      })
      .where(sql`${deviceAuthorizations.id} IN (
        SELECT ${deviceAuthorizations.id} FROM ${deviceAuthorizations}
        WHERE ${and(lt(deviceAuthorizations.createdAt, cutoff), hasDetails)}
        LIMIT ${batchSize}
      )`)
      .returning({ id: deviceAuthorizations.id });
    total += scrubbed.length;
    if (scrubbed.length < batchSize) break;
  }
  // A Computer retiring its device session recorded the address it asked
  // from in its audit record (computer.device_session_retired): same 30 days;
  // the record itself stays.
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const scrubbed = await db
      .update(integrationAuditEvents)
      .set({ metadata: sql`${integrationAuditEvents.metadata} - 'requestIp'` })
      .where(sql`${integrationAuditEvents.id} IN (
        SELECT ${integrationAuditEvents.id} FROM ${integrationAuditEvents}
        WHERE ${and(
          eq(integrationAuditEvents.eventType, "computer.device_session_retired"),
          lt(integrationAuditEvents.createdAt, cutoff),
          sql`${integrationAuditEvents.metadata} -> 'requestIp' IS NOT NULL`,
        )}
        LIMIT ${batchSize}
      )`)
      .returning({ id: integrationAuditEvents.id });
    total += scrubbed.length;
    if (scrubbed.length < batchSize) break;
  }
  // A one-time grant keeps who asked too (the user agent): same 30 days.
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const scrubbed = await db
      .update(deviceLoginGrants)
      .set({ requestedUserAgent: null })
      .where(sql`${deviceLoginGrants.id} IN (
        SELECT ${deviceLoginGrants.id} FROM ${deviceLoginGrants}
        WHERE ${and(lt(deviceLoginGrants.createdAt, cutoff), isNotNull(deviceLoginGrants.requestedUserAgent))}
        LIMIT ${batchSize}
      )`)
      .returning({ id: deviceLoginGrants.id });
    total += scrubbed.length;
    if (scrubbed.length < batchSize) break;
  }
  return total;
}
