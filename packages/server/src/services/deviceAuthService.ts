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
import { and, eq, gt, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { deviceAuthorizationRevokeTokens, deviceAuthorizations, deviceLoginGrants, integrationAuditEvents, users, type DeviceAuthorizationMode, type DeviceLoginGrantKind, type DeviceLoginRevokeReason, type SessionScope, type RequestSessionScope } from "../db/schema";
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
import { hashOneTimeCode, isLoopbackReturnUri, isPkceChallenge, loopbackCallbackUrl, pkceVerifierMatches } from "./loopbackRedirect";

// Raw device_code entropy (base64url). user_code is a short human-typed
// code; device_code is the long secret polled by the client.
const DEVICE_CODE_BYTES = 32;
const USER_CODE_BYTES = 5; // → ~8 base32-ish chars, grouped for humans
const DEFAULT_DEVICE_CODE_TTL_MS = 10 * 60_000; // RFC-8628-style ~10min
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
/** How long an approved one-time grant may be used (device-auth design v2 §3.1). */
export const DEVICE_LOGIN_GRANT_TTL_MS = 10 * 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Loopback: the approval link's request id (32 random bytes, base64url, 43
// chars) and how long the one-time code approve puts in the redirect stays
// redeemable (as app login's, appLoginService.ts).
const LOOPBACK_REQUEST_ID_BYTES = 32;
const LOOPBACK_REQUEST_ID_RE = /^[A-Za-z0-9_-]{43}$/;
export const LOOPBACK_CALLBACK_CODE_TTL_MS = 2 * 60_000;
const LOOPBACK_CALLBACK_CODE_BYTES = 32;
const LOOPBACK_CALLBACK_CODE_MAX_LENGTH = 256;

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
  /** The row's id (never shown to the client): what a computer pairing links. */
  authorizationId: string;
  /** The one-time grant it asks for, or null for a device session. */
  grant: { id: string; kind: DeviceLoginGrantKind } | null;
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

/** A loopback request (RFC 8252): where approve sends the browser, and the PKCE S256 challenge. */
export interface DeviceLoopbackRequest {
  returnUri: string;
  codeChallenge: string;
}

/**
 * The client's `state`, carried in the return URI's own query and echoed back
 * untouched: `?state=` with 16–128 base64url characters, nothing else.
 */
const LOOPBACK_STATE_QUERY = /^state=[A-Za-z0-9_-]{16,128}$/;

/**
 * A loopback device login's return URI: app login's loopback rule
 * (`http://127.0.0.1|[::1]:<port>/callback`, loopbackRedirect.ts) for
 * everything before the query, and at most a `state` in the query.
 */
export function isDeviceLoopbackReturnUri(uri: string): boolean {
  const queryAt = uri.indexOf("?");
  if (queryAt === -1) return isLoopbackReturnUri(uri);
  if (!isLoopbackReturnUri(uri.slice(0, queryAt)) || !LOOPBACK_STATE_QUERY.test(uri.slice(queryAt + 1))) return false;
  try {
    return new URL(uri).href === uri;
  } catch {
    return false;
  }
}

export type ParseDeviceLoopbackResult =
  | { ok: true; loopback: DeviceLoopbackRequest }
  | { ok: false; code: "loopback_invalid" | "return_uri_not_allowed" | "code_challenge_invalid" | "code_challenge_method_unsupported"; error: string };

/** authorize's optional `loopback` object: `{returnUri, codeChallenge, codeChallengeMethod: "S256"}`. */
export function parseDeviceLoopbackRequest(raw: unknown): ParseDeviceLoopbackResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, code: "loopback_invalid", error: "The loopback field must be an object with returnUri, codeChallenge and codeChallengeMethod." };
  }
  const { returnUri, codeChallenge, codeChallengeMethod } = raw as Record<string, unknown>;
  if (typeof returnUri !== "string" || returnUri.length > 512 || !isDeviceLoopbackReturnUri(returnUri)) {
    return { ok: false, code: "return_uri_not_allowed", error: "The loopback returnUri must be http://127.0.0.1:<port>/callback or http://[::1]:<port>/callback, optionally with a state." };
  }
  if (codeChallengeMethod !== "S256") {
    return { ok: false, code: "code_challenge_method_unsupported", error: "The loopback codeChallengeMethod must be S256." };
  }
  if (!isPkceChallenge(codeChallenge)) {
    return { ok: false, code: "code_challenge_invalid", error: "The loopback codeChallenge must be a base64url S256 challenge." };
  }
  return { ok: true, loopback: { returnUri, codeChallenge } };
}

type CreateDeviceAuthorizationInput = {
  clientName?: string | null;
  ttlMs?: number;
  requester?: DeviceAuthorizationRequester;
  /** A one-time grant instead of a session (deviceLoginGrantService); absent → a device session, as before. */
  grant?: DeviceLoginGrantRequest | null;
  /** Kept on the grant when there is one, otherwise on the authorization. */
  requesterUserAgent?: string | null;
  /** Why the client fell back from loopback to this device code (parseLoginFallbackReason); audit only. */
  loginFallbackReason?: string | null;
};

const LOGIN_FALLBACK_REASON = /^[a-z_]{1,64}$/;

/**
 * The authorize body's optional `loginFallbackReason` (a Computer's
 * LoginModeFallbackReason), or null for anything that does not look like one.
 * Never a reason to refuse the login: an older or newer client must not be
 * locked out by an audit field.
 */
export function parseLoginFallbackReason(raw: unknown): string | null {
  return typeof raw === "string" && LOGIN_FALLBACK_REASON.test(raw) ? raw : null;
}

/**
 * The authorization row and its grant, in one transaction: what device and
 * loopback mode share (only how the row is found and completed differs).
 */
async function insertDeviceAuthorization(
  input: CreateDeviceAuthorizationInput,
  completion:
    | { mode: "device"; deviceCodeLookupHash: Buffer; deviceCodeHash: string; userCode: string }
    | { mode: "loopback"; requestId: string; returnUri: string; codeChallenge: string },
  expiresAt: Date,
): Promise<{ authorizationId: string; grant: { id: string; kind: DeviceLoginGrantKind } | null }> {
  const grant = input.grant ?? null;
  const requesterUserAgent = input.requesterUserAgent ? input.requesterUserAgent.slice(0, 512) : null;
  const created = await getDb().transaction(async (tx): Promise<{ authorizationId: string; grantId: string | null }> => {
    const [row] = await tx.insert(deviceAuthorizations).values({
      ...(completion.mode === "device"
        ? {
            deviceCodeLookupHash: completion.deviceCodeLookupHash,
            deviceCodeHash: completion.deviceCodeHash,
            userCode: completion.userCode,
          }
        : {
            mode: "loopback" as const,
            requestId: completion.requestId,
            returnUri: completion.returnUri,
            codeChallenge: completion.codeChallenge,
          }),
      status: "pending",
      clientName: sanitizeClientName(input.clientName),
      loginFallbackReason: input.loginFallbackReason ?? null,
      expiresAt,
      pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
      requestedIp: input.requester?.ip ?? null,
      requestedLocation: input.requester?.location ?? null,
      requestedUserAgent: grant ? null : requesterUserAgent,
    }).returning({ id: deviceAuthorizations.id });
    if (!grant) return { authorizationId: row!.id, grantId: null };
    const [inserted] = await tx.insert(deviceLoginGrants).values({
      deviceAuthorizationId: row!.id,
      kind: grant.kind,
      status: "pending",
      machineName: grant.machineName,
      hostname: grant.hostname,
      os: grant.os,
      requestedAgentId: grant.agentId,
      requestedUserAgent: requesterUserAgent,
    }).returning({ id: deviceLoginGrants.id });
    return { authorizationId: row!.id, grantId: inserted!.id };
  });
  if (created.grantId && grant) {
    addTraceEvent("auth.device.grant.created", { grant_id: created.grantId, kind: grant.kind, mode: completion.mode });
    return { authorizationId: created.authorizationId, grant: { id: created.grantId, kind: grant.kind } };
  }
  return { authorizationId: created.authorizationId, grant: null };
}

/** authorize phase — unauthenticated public (caller must gate-check first). */
export async function createDeviceAuthorization(
  input: CreateDeviceAuthorizationInput = {},
): Promise<CreateDeviceAuthorizationResult> {
  const deviceCode = `dvc_${randomBytes(DEVICE_CODE_BYTES).toString("base64url")}`;
  const userCode = humanUserCode();
  const ttlMs = input.ttlMs ?? DEFAULT_DEVICE_CODE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  const created = await insertDeviceAuthorization(input, {
    mode: "device",
    deviceCodeLookupHash: computeTokenLookupHash(deviceCode),
    deviceCodeHash: await argon2.hash(deviceCode),
    userCode,
  }, expiresAt);

  return {
    ...created,
    deviceCode,
    userCode,
    expiresInSeconds: Math.floor(ttlMs / 1000),
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

export interface CreateLoopbackDeviceAuthorizationResult {
  /** The approval link's id; describe/approve find the request by it. */
  requestId: string;
  expiresInSeconds: number;
}

/**
 * authorize phase, loopback mode: no device code and no user code (nothing to
 * poll, nothing to type). The approval page finds the request by its id;
 * approve sends the browser to the return URI with a one-time code, which the
 * token phase redeems with the PKCE verifier (consumeLoopbackDeviceAuthorization).
 */
export async function createLoopbackDeviceAuthorization(
  input: CreateDeviceAuthorizationInput & { loopback: DeviceLoopbackRequest },
): Promise<CreateLoopbackDeviceAuthorizationResult> {
  const requestId = randomBytes(LOOPBACK_REQUEST_ID_BYTES).toString("base64url");
  const ttlMs = input.ttlMs ?? DEFAULT_DEVICE_CODE_TTL_MS;
  await insertDeviceAuthorization(input, {
    mode: "loopback",
    requestId,
    returnUri: input.loopback.returnUri,
    codeChallenge: input.loopback.codeChallenge,
  }, new Date(Date.now() + ttlMs));
  return { requestId, expiresInSeconds: Math.floor(ttlMs / 1000) };
}

/**
 * How describe and approve find a request: the code the person typed (device
 * mode), the request id in the approval link (loopback mode), or the row id a
 * computer pairing linked itself (computerPairingService.ts; never an id a
 * client sends). A miss of either kind answers the same way
 * (user_code_invalid / request_invalid).
 */
export type DeviceAuthorizationLocator = { userCode: unknown } | { requestId: unknown } | { linkedAuthorizationId: string };

type LocatorMiss = "user_code_invalid" | "request_invalid";

function locate(locator: DeviceAuthorizationLocator):
  | { ok: true; where: SQL }
  | { ok: false; error: LocatorMiss } {
  if ("linkedAuthorizationId" in locator) {
    return { ok: true, where: and(eq(deviceAuthorizations.id, locator.linkedAuthorizationId), eq(deviceAuthorizations.mode, "device"))! };
  }
  if ("requestId" in locator) {
    const { requestId } = locator;
    if (typeof requestId !== "string" || !LOOPBACK_REQUEST_ID_RE.test(requestId)) return { ok: false, error: "request_invalid" };
    return { ok: true, where: and(eq(deviceAuthorizations.requestId, requestId), eq(deviceAuthorizations.mode, "loopback"))! };
  }
  const userCode = normalizeUserCode(locator.userCode);
  if (!userCode) return { ok: false, error: "user_code_invalid" };
  return { ok: true, where: and(eq(deviceAuthorizations.userCode, userCode), eq(deviceAuthorizations.mode, "device"))! };
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
      mode: DeviceAuthorizationMode;
      /** Set when the client asked for a one-time grant instead of a session. */
      grant: DescribedDeviceLoginGrant | null;
      /** The stored form of the typed code, for the page to show; null in loopback mode (there is none). */
      userCode: string | null;
      /** Loopback mode: the approval link's id (null in device mode). */
      requestId: string | null;
      /** As the client sent it (sanitized): anyone starting a login can set it to anything. */
      clientName: string | null;
      requestedAt: Date;
      requester: DeviceAuthorizationRequester;
      /** What approve needs to approve this code as this person. */
      approvalTicket: string;
    }
  | { ok: false; error: LocatorMiss | "already_resolved" | "expired" };

/**
 * The approval page's look at a code before anyone approves it — USER-
 * authenticated like approve, with approve's answers for a code that can't be
 * approved (same states, same uniform user_code_invalid for a miss). Its
 * approval ticket is what approve requires.
 */
export async function describeDeviceAuthorization(input: DeviceAuthorizationLocator & { userId: string }): Promise<DescribeDeviceAuthorizationResult> {
  const located = locate(input);
  if (!located.ok) return { ok: false, error: located.error };
  const db = getDb();
  const [row] = await db
    .select({
      id: deviceAuthorizations.id,
      mode: deviceAuthorizations.mode,
      requestId: deviceAuthorizations.requestId,
      userCode: deviceAuthorizations.userCode,
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
    .where(located.where);
  if (!row) return { ok: false, error: "userCode" in input ? "user_code_invalid" : "request_invalid" };
  if (row.status !== "pending") return { ok: false, error: "already_resolved" };
  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, error: "expired" };
  return {
    ok: true,
    mode: row.mode,
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
    userCode: row.userCode,
    requestId: row.requestId,
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
      mode: DeviceAuthorizationMode;
      grant: ApprovedDeviceLogin;
      /** Set when it was a one-time grant: what the person picked. */
      oneTime: { id: string; kind: DeviceLoginGrantKind; serverId: string | null; agentId: string | null } | null;
      /**
       * Loopback mode: where the page sends the browser next, the return URI
       * with the one-time `code` (approved) or `error=access_denied` (denied).
       */
      redirectUrl: string | null;
    }
  | {
      ok: false;
      error:
        | LocatorMiss
        | "already_resolved"
        | "expired"
        | "approval_ticket_required"
        // One-time grants: the server (computer_attach, computer_migrate) or
        // agent (agent_key) must be picked explicitly, and be one the person may use.
        | "grant_selection_required"
        | "grant_selection_not_allowed"
        | "grant_kind_unsupported"
        // The approving session was revoked while it approved.
        | "approver_session_revoked"
        // Approving through a computer pairing: the pairing stopped being
        // approvable (a second request, cancelled, signed out, expired) before
        // the approval committed.
        | "pairing_unavailable";
    };

/**
 * approve phase — USER-authenticated. `userId` is the authenticated
 * principal from the web/JWT session. Approving needs describe's approval
 * ticket for this code and person (denying doesn't). CAS: only a
 * still-pending, unexpired grant transitions (zero enumeration: any miss →
 * uniform user_code_invalid).
 */
export async function approveDeviceAuthorization(input: DeviceAuthorizationLocator & {
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
  /**
   * Run in the approval's transaction before the authorization's own CAS; false
   * refuses with `pairing_unavailable` and nothing is written. A computer
   * pairing claims itself here (computerPairingService.ts), so a second request
   * voiding it and this approval serialize on its row: one of them wins.
   */
  claim?: (tx: DatabaseExecutor) => Promise<boolean>;
}): Promise<ApproveDeviceAuthorizationResult> {
  const located = locate(input);
  if (!located.ok) return { ok: false, error: located.error };
  const db = getDb();
  const [row] = await db
    .select({
      id: deviceAuthorizations.id,
      mode: deviceAuthorizations.mode,
      returnUri: deviceAuthorizations.returnUri,
      status: deviceAuthorizations.status,
      expiresAt: deviceAuthorizations.expiresAt,
      grantId: deviceLoginGrants.id,
      grantKind: deviceLoginGrants.kind,
    })
    .from(deviceAuthorizations)
    .leftJoin(deviceLoginGrants, eq(deviceLoginGrants.deviceAuthorizationId, deviceAuthorizations.id))
    .where(located.where);
  if (!row) return { ok: false, error: "userCode" in input ? "user_code_invalid" : "request_invalid" };
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
  // Loopback: the one-time code the redirect carries (only its hash is kept),
  // redeemable for 2 minutes and never past the request's own expiry.
  const loopbackReturnUri = row.mode === "loopback" ? row.returnUri : null;
  if (row.mode === "loopback" && !loopbackReturnUri) return { ok: false, error: "request_invalid" };
  const callbackCode = loopbackReturnUri && input.approve ? randomBytes(LOOPBACK_CALLBACK_CODE_BYTES).toString("base64url") : null;
  const callbackCodeColumns = callbackCode
    ? {
        callbackCodeHash: hashOneTimeCode(callbackCode),
        callbackCodeExpiresAt: new Date(Math.min(now.getTime() + LOOPBACK_CALLBACK_CODE_TTL_MS, row.expiresAt.getTime())),
      }
    : {};
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
    if (input.claim && !await input.claim(tx)) return { ok: false, error: "pairing_unavailable" };
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
              ...callbackCodeColumns,
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
      mode: row.mode,
      oneTime,
      redirectUrl: loopbackReturnUri
        ? loopbackCallbackUrl(loopbackReturnUri, callbackCode ? { code: callbackCode } : { error: "access_denied" })
        : null,
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
  | "device_code_consumed"
  // Loopback redeem only: no such request, no code issued, or not its code
  // (uniform); and the right code with the wrong PKCE verifier (not burned).
  | "code_invalid"
  | "pkce_mismatch";

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
      mode: deviceAuthorizations.mode,
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
  // A loopback row has no device code: it is never pollable.
  if (!row || row.mode !== "device" || !row.deviceCodeHash) return { ok: false, error: "device_code_invalid" };

  let argonOk = false;
  try {
    argonOk = await argon2.verify(row.deviceCodeHash, rawDeviceCode);
  } catch {
    argonOk = false;
  }
  if (!argonOk) return { ok: false, error: "device_code_invalid" };
  return consumeVerifiedDeviceAuthorization(row, observe);
}

/**
 * token phase, loopback mode: `{requestId, code, codeVerifier}` instead of a
 * device code. The code is the one approve put in the redirect (2 minutes,
 * stored as a sha256 hash), and the verifier must match the S256 challenge
 * from authorize. A wrong verifier does not burn the code (as in app login:
 * only the program holding the verifier can use it). Past those checks it is
 * the device code's consume, unchanged: the same CAS single-consume, the same
 * grant (or session) and the same answers.
 */
export async function consumeLoopbackDeviceAuthorization(
  input: { requestId: unknown; code: unknown; codeVerifier: unknown },
  observe: { ip?: string | null; userAgent?: string | null } = {},
): Promise<ConsumeDeviceAuthorizationResult> {
  const { requestId, code } = input;
  if (typeof requestId !== "string" || !LOOPBACK_REQUEST_ID_RE.test(requestId)) return { ok: false, error: "code_invalid" };
  if (typeof code !== "string" || !code || code.length > LOOPBACK_CALLBACK_CODE_MAX_LENGTH) return { ok: false, error: "code_invalid" };
  const [row] = await getDb()
    .select({
      id: deviceAuthorizations.id,
      codeChallenge: deviceAuthorizations.codeChallenge,
      callbackCodeHash: deviceAuthorizations.callbackCodeHash,
      callbackCodeExpiresAt: deviceAuthorizations.callbackCodeExpiresAt,
      status: deviceAuthorizations.status,
      approvedByUserId: deviceAuthorizations.approvedByUserId,
      expiresAt: deviceAuthorizations.expiresAt,
      consumedAt: deviceAuthorizations.consumedAt,
      revokedAt: deviceAuthorizations.revokedAt,
      oneTimeGrantId: deviceLoginGrants.id,
    })
    .from(deviceAuthorizations)
    .leftJoin(deviceLoginGrants, eq(deviceLoginGrants.deviceAuthorizationId, deviceAuthorizations.id))
    .where(and(eq(deviceAuthorizations.requestId, requestId), eq(deviceAuthorizations.mode, "loopback")));
  if (!row || !row.callbackCodeHash || !row.codeChallenge) return { ok: false, error: "code_invalid" };
  const expected = Buffer.from(row.callbackCodeHash);
  const actual = Buffer.from(hashOneTimeCode(code));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, error: "code_invalid" };
  if (row.consumedAt) return { ok: false, error: "device_code_consumed" };
  if (!row.callbackCodeExpiresAt || row.callbackCodeExpiresAt.getTime() <= Date.now()) return { ok: false, error: "expired_token" };
  if (!pkceVerifierMatches(input.codeVerifier, row.codeChallenge)) return { ok: false, error: "pkce_mismatch" };
  return consumeVerifiedDeviceAuthorization(row, observe);
}

/**
 * The consume both modes share once the client has proved it holds the
 * request (the device code, or the loopback code + PKCE verifier).
 */
async function consumeVerifiedDeviceAuthorization(
  row: DeviceCodeState & { id: string; oneTimeGrantId: string | null },
  observe: { ip?: string | null; userAgent?: string | null },
): Promise<ConsumeDeviceAuthorizationResult> {
  const db = getDb();
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
