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
 *   approve    — USER-authenticated (only authenticated phase)
 *   token      — unauthenticated public poll, single-consume
 *
 * IMPORTANT: this grant does NOT mint `sk_computer_*` / `sk_agent_*`. It
 * only establishes an approved user identity; the route layer issues the
 * user session. `attach` / external-agent bootstrap later consume that
 * identity under their own principal/surface contract.
 */
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { and, eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { deviceAuthorizations } from "../db/schema.js";
import { computeTokenLookupHash } from "./agentCredentialService.js";

// Raw device_code entropy (base64url). user_code is a short human-typed
// code; device_code is the long secret polled by the client.
const DEVICE_CODE_BYTES = 32;
const USER_CODE_BYTES = 5; // → ~8 base32-ish chars, grouped for humans
const DEFAULT_DEVICE_CODE_TTL_MS = 10 * 60_000; // RFC-8628-style ~10min
const DEFAULT_POLL_INTERVAL_SECONDS = 5;

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

export interface CreateDeviceAuthorizationResult {
  deviceCode: string; // raw — returned once, client polls with it
  userCode: string; // human enters this at the approve UI
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

/** authorize phase — unauthenticated public (caller must gate-check first). */
export async function createDeviceAuthorization(
  input: { clientName?: string | null; ttlMs?: number } = {},
): Promise<CreateDeviceAuthorizationResult> {
  const db = getDb();
  const deviceCode = `dvc_${randomBytes(DEVICE_CODE_BYTES).toString("base64url")}`;
  const userCode = humanUserCode();
  const ttlMs = input.ttlMs ?? DEFAULT_DEVICE_CODE_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  await db.insert(deviceAuthorizations).values({
    deviceCodeLookupHash: computeTokenLookupHash(deviceCode),
    deviceCodeHash: await argon2.hash(deviceCode),
    userCode,
    status: "pending",
    clientName: input.clientName ?? null,
    expiresAt,
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  });

  return {
    deviceCode,
    userCode,
    expiresInSeconds: Math.floor(ttlMs / 1000),
    pollIntervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
  };
}

export type ApproveDeviceAuthorizationResult =
  | { ok: true }
  | { ok: false; error: "user_code_invalid" | "already_resolved" | "expired" };

/**
 * approve phase — USER-authenticated. `userId` is the authenticated
 * principal from the web/JWT session. CAS: only a still-pending,
 * unexpired grant transitions to approved (zero enumeration: any
 * miss → uniform user_code_invalid).
 */
export async function approveDeviceAuthorization(input: {
  userCode: string;
  userId: string;
  approve: boolean;
}): Promise<ApproveDeviceAuthorizationResult> {
  if (!input.userCode || typeof input.userCode !== "string") {
    return { ok: false, error: "user_code_invalid" };
  }
  const db = getDb();
  const [row] = await db
    .select({
      id: deviceAuthorizations.id,
      status: deviceAuthorizations.status,
      expiresAt: deviceAuthorizations.expiresAt,
    })
    .from(deviceAuthorizations)
    .where(eq(deviceAuthorizations.userCode, input.userCode.trim().toUpperCase()));
  if (!row) return { ok: false, error: "user_code_invalid" };
  if (row.status !== "pending") return { ok: false, error: "already_resolved" };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "expired" };
  }

  // CAS — only flip if still pending (loses to a concurrent resolve).
  const claimed = await db
    .update(deviceAuthorizations)
    .set(
      input.approve
        ? { status: "approved", approvedByUserId: input.userId, approvedAt: new Date() }
        : { status: "denied", deniedAt: new Date() },
    )
    .where(
      and(
        eq(deviceAuthorizations.id, row.id),
        eq(deviceAuthorizations.status, "pending"),
      ),
    )
    .returning({ id: deviceAuthorizations.id });
  if (claimed.length === 0) return { ok: false, error: "already_resolved" };
  return { ok: true };
}

export type ConsumeDeviceAuthorizationResult =
  | { ok: true; approvedByUserId: string }
  | {
      ok: false;
      error:
        | "device_code_invalid"
        | "authorization_pending"
        | "access_denied"
        | "expired_token"
        | "device_code_consumed";
    };

/**
 * token phase — unauthenticated public poll. HMAC-locate → argon2-verify →
 * distinct status → CAS single-consume. On success returns the approved
 * user id; the ROUTE issues the actual user session (this grant never
 * mints sk_* itself, contract §5). Zero enumeration: unknown/invalid →
 * uniform device_code_invalid.
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
    })
    .from(deviceAuthorizations)
    .where(eq(deviceAuthorizations.deviceCodeLookupHash, computeTokenLookupHash(rawDeviceCode)));
  if (!row) return { ok: false, error: "device_code_invalid" };

  let argonOk = false;
  try {
    argonOk = await argon2.verify(row.deviceCodeHash, rawDeviceCode);
  } catch {
    argonOk = false;
  }
  if (!argonOk) return { ok: false, error: "device_code_invalid" };

  if (row.revokedAt) return { ok: false, error: "access_denied" };
  if (row.consumedAt) return { ok: false, error: "device_code_consumed" };
  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "expired_token" };
  }
  if (row.status === "denied") return { ok: false, error: "access_denied" };
  if (row.status !== "approved" || !row.approvedByUserId) {
    return { ok: false, error: "authorization_pending" };
  }

  // CAS single-consume — lose the race → device_code_consumed.
  const claimed = await db
    .update(deviceAuthorizations)
    .set({
      status: "consumed",
      consumedAt: new Date(),
      consumedIp: observe.ip ?? null,
      consumedUserAgent: observe.userAgent ?? null,
    })
    .where(
      and(
        eq(deviceAuthorizations.id, row.id),
        eq(deviceAuthorizations.status, "approved"),
      ),
    )
    .returning({ id: deviceAuthorizations.id });
  if (claimed.length === 0) return { ok: false, error: "device_code_consumed" };

  return { ok: true, approvedByUserId: row.approvedByUserId };
}
