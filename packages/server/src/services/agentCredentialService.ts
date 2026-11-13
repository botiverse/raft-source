// Agent credential service — manages `sk_agent_*` runtime principals per
// `rfcs/034-slock-credential-rfc.zh.html#section-credential-model`.
//
// One row in `agent_credentials` per credential, bound to exactly one
// `agentId` for life. NEVER reassigned to a different agent — a fresh
// credential is issued instead. Rows are NEVER deleted; revoked rows stay
// for audit.
//
// Hot-path auth lookup: prefix-indexed (O(1) by `idx_agent_credentials_prefix_active`,
// the partial index that excludes revoked rows). Verify follows: a
// constant-time HMAC compare when the row has `api_key_hmac`; otherwise, or
// when that compare fails, argon2id (legacy rows, `AGENT_API_KEY_HMAC_SECRET`
// unset, or an HMAC from an older secret), and an argon2 success stores the
// current HMAC.
//
// This module owns:
//   - findAgentCredentialByApiKey(apiKey)   — middleware-side lookup
//   - recordAgentCredentialUse({...})       — best-effort observability triple
//   - mintAgentCredential(...) / revokeAgentCredential(...) live in step 3
//     when the mint endpoints land.
//
// Key isolation invariant (base RFC §1.4 runner key isolation): this module
// returns the raw key exactly once at mint time; subsequent reads return the
// row WITHOUT the raw key.

import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import { eq, and, isNull, isNotNull, desc, inArray, like, lt, max, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { currentDate, isExternalAgentRuntime, makeIsMember } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { recordIntegrationAuditEvent, recordRunnerCredentialRenewed } from "./integrationAuditService";
import { agentCredentials, agentBootstrapTokens, agents, servers, raftbenchServiceAgents, agentRuntimeProvisions, type AgentCredentialIssuedVia } from "../db/schema";
import { hasExactRaftbenchServiceScopes } from "../raftbench/credentialScopes";
import { assertAgentHumanCredentialCapacity } from "./agentCredentialMintLimits";
import { addTraceEvent } from "../tracing/semanticTrace";
import { apiKeyPrefixHashAttrs } from "../tracing/traceIdentity";
import { agentCredentialVerifyTotal } from "../metrics";

const API_KEY_PREFIX_LENGTH = 16;
const RAW_KEY_BYTES = 32;
const BOOTSTRAP_TOKEN_BYTES = 24;       // 24 random bytes → 32-char base64url body
const BOOTSTRAP_TOKEN_PREFIX_LENGTH = 12;
const DEFAULT_BOOTSTRAP_TTL_MS = 30 * 60 * 1000;  // 30 minutes (§7 default)

// Allowed scope values for `sk_agent_*` credentials (v0 active enum).
// Route allowlist in `routeAuthPolicy` is the actual enforcement; this
// list bounds what the mint endpoints will accept onto a credential row.
export const ALLOWED_AGENT_CAPABILITIES = [
  "send",
  "read",
  "mentions",
  "tasks",
  "reactions",
  "server",
  "channels",
  "knowledge",
  "mcp",
  "raftbench",
] as const;
export type AgentCapability = (typeof ALLOWED_AGENT_CAPABILITIES)[number];
const isAgentCapability = makeIsMember(ALLOWED_AGENT_CAPABILITIES);

/**
 * Least-privilege default for an external agent's `sk_agent_*` when the
 * minter does not name scopes: everything a normal member agent needs to
 * message, read, react, work its inbox / mentions / tasks, use channels and
 * threads, attach files, read knowledge and edit its own profile/avatar
 * (`send`). Excluded (must be requested explicitly by an authorized minter):
 *   - `server` — acting on the server: PATCH /server, POST /server/avatar,
 *     labs, and migrations (moving a managed agent between computers);
 *   - `mcp`    — calling managed MCP tools with server-held provider
 *     credentials.
 * A managed agent's runner credential (daemon `RUNNER_CREDENTIAL_SCOPES`)
 * carries this set plus `server` and `mcp`.
 */
export const DEFAULT_EXTERNAL_AGENT_CAPABILITIES: readonly AgentCapability[] = [
  "channels",
  "knowledge",
  "mentions",
  "reactions",
  "read",
  "send",
  "tasks",
];

/**
 * A hosted runtime's credential (Antiproton) carries what a managed agent's
 * runner credential carries: whatever an internal agent can do, a hosted one
 * can too (tygg, #raft-antiproton:9a4fe245). Role checks still run live on
 * every call, so `server` lets an admin agent edit the server, not a member.
 */
/**
 * Capability set for a managed app bot (`agents.managed_by_app_install_id
 * IS NOT NULL`). Narrower than `DEFAULT_EXTERNAL_AGENT_CAPABILITIES`: yezizp's
 * Phase-1 ask is DM people/agents, channelable, send/receive. Tasks, manual,
 * reactions, server/channel-management, knowledge, mcp are all withheld until
 * the product asks for them.
 */
export const MANAGED_APP_BOT_CAPABILITIES: readonly AgentCapability[] = [
  "send",
  "read",
  "mentions",
  "channels",
];

export const HOSTED_RUNTIME_AGENT_CAPABILITIES: readonly AgentCapability[] = [
  ...DEFAULT_EXTERNAL_AGENT_CAPABILITIES,
  "server",
  "mcp",
];

/**
 * A personal assistant's hosted credential (RFC 075 v4): only the scopes its
 * route allowlist (assistantRouteAllowlist.ts) needs. No `mcp` or `server`:
 * the runtime keys optional calls off these scopes, and every such call would
 * be refused.
 */
export const ASSISTANT_AGENT_CAPABILITIES: readonly AgentCapability[] = ["read", "send", "reactions"];

export type RequestedAgentCapabilities =
  | { ok: true; scopes: AgentCapability[] }
  | { ok: false; code: "scopes_invalid" | "scopes_empty"; error: string };

/**
 * Parse the optional `scopes` field of a mint/issue request body. Omitted →
 * `defaults`; otherwise a non-empty subset of `ALLOWED_AGENT_CAPABILITIES`.
 */
export function resolveRequestedAgentCapabilities(
  raw: unknown,
  defaults: readonly AgentCapability[],
): RequestedAgentCapabilities {
  if (raw === undefined) return { ok: true, scopes: [...defaults] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: "scopes_invalid", error: "scopes must be an array of capability literals" };
  }
  let scopes: AgentCapability[];
  try {
    scopes = normalizeAgentCapabilities(raw as readonly string[]);
  } catch {
    return {
      ok: false,
      code: "scopes_invalid",
      error: `scopes must each be one of: ${ALLOWED_AGENT_CAPABILITIES.join(", ")}`,
    };
  }
  if (scopes.length === 0) {
    return { ok: false, code: "scopes_empty", error: "scopes must include at least one capability" };
  }
  return { ok: true, scopes };
}

// Exported so the device-code grant (task #30 PR-A2, deviceAuthService.ts)
// reuses the EXACT same pepper + lookup-hash, not a parallel one — per
// v0.8 contract v3 §5 "device-code lifecycle aligned with the existing
// bootstrap-token model" (no forked auth/pepper path).
export function getBootstrapTokenPepper(): Buffer {
  const raw = process.env.AGENT_BOOTSTRAP_TOKEN_PEPPER || process.env.JWT_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error(
      "AGENT_BOOTSTRAP_TOKEN_PEPPER or JWT_SECRET environment variable is required (>= 32 chars)",
    );
  }
  return Buffer.from(raw, "utf8");
}

export function computeTokenLookupHash(rawToken: string): Buffer {
  return createHmac("sha256", getBootstrapTokenPepper()).update(rawToken, "utf8").digest();
}

// Secret for `agent_credentials.api_key_hmac`. Deliberately separate from the
// bootstrap pepper and with no JWT_SECRET fallback: rotating it invalidates
// every stored HMAC, so it gets its own rotation boundary. Optional — when it
// is unset (or too short) mint stores no HMAC and verify stays on argon2.
export const AGENT_API_KEY_HMAC_SECRET_ENV = "AGENT_API_KEY_HMAC_SECRET";
let warnedMissingApiKeyHmacSecret = false;

function getAgentApiKeyHmacSecret(): Buffer | null {
  const raw = process.env[AGENT_API_KEY_HMAC_SECRET_ENV];
  if (!raw || raw.length < 32) {
    if (!warnedMissingApiKeyHmacSecret) {
      warnedMissingApiKeyHmacSecret = true;
      console.warn(
        `[AgentCredential] ${AGENT_API_KEY_HMAC_SECRET_ENV} unset or shorter than 32 chars — sk_agent_* keys verify with argon2 only`,
      );
    }
    return null;
  }
  return Buffer.from(raw, "utf8");
}

/** HMAC-SHA-256 of a raw `sk_agent_*` key, or null when the secret is unset. */
export function computeAgentApiKeyHmac(apiKey: string): Buffer | null {
  const secret = getAgentApiKeyHmacSecret();
  return secret ? createHmac("sha256", secret).update(apiKey, "utf8").digest() : null;
}

export function extractApiKeyPrefix(apiKey: string): string {
  return apiKey.slice(0, API_KEY_PREFIX_LENGTH);
}

export function isAgentApiKey(token: string): boolean {
  return token.startsWith("sk_agent_");
}

export interface AgentCredentialLookupResult {
  credentialId: string;
  agentId: string;
  serverId: string;
  scopes: readonly string[];
  /** Who minted it; `app` only for a managed App Bot's key (appBotIdentityService). */
  issuedVia: AgentCredentialIssuedVia | null;
}

export interface LatestActiveAgentCredentialSummary {
  credentialId: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function getLatestActiveAgentCredential(
  agentId: string,
): Promise<LatestActiveAgentCredentialSummary | null> {
  const db = getDb();
  const [row] = await db
    .select({
      credentialId: agentCredentials.id,
      createdAt: agentCredentials.createdAt,
      lastUsedAt: agentCredentials.lastUsedAt,
    })
    .from(agentCredentials)
    .where(and(eq(agentCredentials.agentId, agentId), isNull(agentCredentials.revokedAt)))
    .orderBy(desc(agentCredentials.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Look up an agent credential by raw API key.
 *
 * Hot path: prefix lookup served by `idx_agent_credentials_prefix_active`
 * (partial index `WHERE revoked_at IS NULL`) → verify against matching rows:
 * constant-time HMAC compare when the row has `apiKeyHmac` and the secret is
 * configured; otherwise, or when the compare fails, argon2id, whose success
 * stores the current HMAC (best-effort).
 * Revoked rows are excluded by the query on every request — the middleware
 * never verifies against a revoked credential.
 *
 * Returns `null` for: unknown key, revoked credential, soft-deleted agent,
 * a runner credential whose agent is no longer on the Machine that minted it,
 * an expired credential (`authenticateAgentApiKey` tells that one apart).
 * The agent join ensures the credential's bound agent still exists.
 *
 * No in-memory caching in v0 — keep the current behavior and trace the
 * phase costs first so optimization can target the measured bottleneck.
 */
export async function findAgentCredentialByApiKey(
  apiKey: string,
): Promise<AgentCredentialLookupResult | null> {
  const outcome = await authenticateAgentApiKey(apiKey);
  return outcome.ok ? outcome.credential : null;
}

/** 401 code of a key that verified but whose `expires_at` has passed (#wg-rbac:#27). */
export const AGENT_CREDENTIAL_EXPIRED_CODE = "agent_credential_expired";

export type AgentApiKeyAuthOutcome =
  | { ok: true; credential: AgentCredentialLookupResult }
  /**
   * `expired`: the key verified, it is not revoked and would otherwise
   * authenticate, but its `expires_at` has passed. Every other refusal
   * (unknown, wrong, revoked, deleted agent, off its Machine) is `invalid`.
   */
  | { ok: false; reason: "invalid" | "expired" };

/** Whether a credential's `expires_at` has passed at `now` (NULL never expires). */
export function isAgentCredentialExpired(expiresAt: Date | null, now: Date = currentDate()): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}

/**
 * `findAgentCredentialByApiKey` that also says why a key was refused, so the
 * agent-api middleware can answer an expired key with its own code: the
 * daemon renews on `agent_credential_expired` and never on anything else.
 * Expiry is checked only once the key has verified (by HMAC or argon2) and
 * every other condition holds, so the code reveals nothing about a key the
 * caller doesn't hold and never turns a terminal refusal into "renew me".
 * There is no auth cache: every request reads the row, so a key is refused
 * from the first request after its `expires_at`.
 */
export async function authenticateAgentApiKey(apiKey: string): Promise<AgentApiKeyAuthOutcome> {
  const invalid = { ok: false, reason: "invalid" } as const;
  if (!isAgentApiKey(apiKey)) return invalid;
  const db = getDb();
  const prefix = extractApiKeyPrefix(apiKey);

  // Partial index `idx_agent_credentials_prefix_active` requires the WHERE
  // clause to include `revoked_at IS NULL` for the planner to pick it up.
  const lookupStart = Date.now();
  const candidates = await db
    .select({
      id: agentCredentials.id,
      agentId: agentCredentials.agentId,
      apiKeyHash: agentCredentials.apiKeyHash,
      apiKeyHmac: agentCredentials.apiKeyHmac,
      scopes: agentCredentials.scopes,
      issuedVia: agentCredentials.issuedVia,
      issuedByMachineId: agentCredentials.issuedByMachineId,
      expiresAt: agentCredentials.expiresAt,
    })
    .from(agentCredentials)
    .where(
      and(
        eq(agentCredentials.apiKeyPrefix, prefix),
        isNull(agentCredentials.revokedAt),
      ),
    );
  addTraceEvent("agent_credential_auth.credential_lookup.finished", {
    duration_ms: Date.now() - lookupStart,
    candidate_count: candidates.length,
    // A key nothing matches has no agent to name, and a caller without x-agent-id
    // claims none: this is all that tells one such caller from another.
    ...(candidates.length === 0 ? apiKeyPrefixHashAttrs(prefix) : {}),
  });

  const verifyStart = Date.now();
  const presentedHmac = candidates.length > 0 ? computeAgentApiKeyHmac(apiKey) : null;
  let verifiedCredential: typeof candidates[number] | null = null;
  let usedArgon2 = false;
  // The verified row carried an HMAC that did not match, but argon2 accepted
  // the key: that HMAC came from a different secret and is rewritten below.
  let staleHmac = false;
  for (const cred of candidates) {
    if (presentedHmac && cred.apiKeyHmac) {
      if (cred.apiKeyHmac.length === presentedHmac.length && timingSafeEqual(cred.apiKeyHmac, presentedHmac)) {
        verifiedCredential = cred;
        break;
      }
      // No match: a wrong key, or an HMAC stored under a secret that has since
      // changed. argon2 tells them apart, so a changed or re-created secret
      // degrades to argon2 and heals itself instead of 401ing every key.
    }
    usedArgon2 = true;
    try {
      if (!(await argon2.verify(cred.apiKeyHash, apiKey))) continue;
      verifiedCredential = cred;
      staleHmac = Boolean(presentedHmac && cred.apiKeyHmac);
      break;
    } catch {
      continue;
    }
  }
  // "none": no candidate had this prefix, so nothing was verified.
  // "argon2_rehmac": a stored HMAC was stale (secret changed); a burst of these
  // after a secret change is the signal that load went back to argon2.
  const verifyPath = candidates.length === 0
    ? "none"
    : staleHmac ? "argon2_rehmac" : usedArgon2 ? "argon2" : "hmac";
  const verifyOutcome = verifiedCredential ? "matched" : "not_matched";
  // Event name predates the HMAC path; kept for trace-query continuity.
  addTraceEvent("agent_credential_auth.argon2_verify.finished", {
    duration_ms: Date.now() - verifyStart,
    candidate_count: candidates.length,
    outcome: verifyOutcome,
    verify_path: verifyPath,
  });
  if (candidates.length > 0) agentCredentialVerifyTotal.inc({ path: verifyPath, outcome: verifyOutcome });
  if (!verifiedCredential) return invalid;

  if (presentedHmac && (!verifiedCredential.apiKeyHmac || staleHmac)) {
    await storeAgentApiKeyHmac(verifiedCredential.id, verifiedCredential.apiKeyHash, presentedHmac);
  }

  // Resolve serverId via the bound agent. The credential row itself does
  // not carry serverId — it's derived from `agents.serverId` (FK chain).
  // Filtering on `agents.deletedAt IS NULL` keeps the contract that a
  // soft-deleted agent's credential is unusable.
  const agentLookupStart = Date.now();
  const [agentRow] = await db
    .select({ id: agents.id, serverId: agents.serverId, machineId: agents.machineId })
    .from(agents)
    .where(and(eq(agents.id, verifiedCredential.agentId), isNull(agents.deletedAt)));
  addTraceEvent("agent_credential_auth.agent_lookup.finished", {
    duration_ms: Date.now() - agentLookupStart,
    outcome: agentRow ? "found" : "missing",
  });
  if (!agentRow) return invalid;
  // A runner credential authenticates only while its agent is on the Machine
  // that minted it. Refused like an unknown key (the caller answers the same
  // 401); the event tells a leftover runner after a move apart in traces.
  if (isRunnerCredentialOffMachine(verifiedCredential, agentRow.machineId)) {
    addTraceEvent("agent_credential_auth.refused", {
      reason: RUNNER_CREDENTIAL_WRONG_MACHINE,
      credential_id: verifiedCredential.id,
      agent_id: verifiedCredential.agentId,
    });
    return invalid;
  }
  if (isAgentCredentialExpired(verifiedCredential.expiresAt)) {
    addTraceEvent("agent_credential_auth.refused", {
      reason: AGENT_CREDENTIAL_EXPIRED_CODE,
      credential_id: verifiedCredential.id,
      agent_id: verifiedCredential.agentId,
    });
    return { ok: false, reason: "expired" };
  }

  const result = {
    credentialId: verifiedCredential.id,
    agentId: verifiedCredential.agentId,
    serverId: agentRow.serverId,
    scopes: verifiedCredential.scopes,
    issuedVia: verifiedCredential.issuedVia,
  } satisfies AgentCredentialLookupResult;
  return { ok: true, credential: result };
}

/** Trace label of a runner credential refused because its agent is on another Machine (or none). */
export const RUNNER_CREDENTIAL_WRONG_MACHINE = "runner_credential_wrong_machine";

/**
 * A Computer's runner credential (`issued_via = 'computer'`) is bound to the
 * Machine that minted it: once its agent is on another Machine, or on none, it
 * no longer authenticates. A computer row with no recorded Machine (minted
 * before the column, or not attributable by the backfill) is not bound.
 * Credentials of every other origin (human, provision, app) are never bound.
 *
 * Assumes a Machine uses a runner key only while it holds the agent. The mint
 * route (POST /internal/computer/runners/:agentId/credentials) answers 404
 * unless `agents.machine_id` is the caller, and a migration's target starts
 * the agent only after the flip (start-transfer, stage/commit the workspace,
 * flip-machine, arrived, start), so it mints and uses its key after
 * `agents.machine_id` moved. If a target ever minted or ran the agent before
 * the flip, this rule would refuse that key until the flip.
 */
function isRunnerCredentialOffMachine(
  credential: { issuedVia: AgentCredentialIssuedVia | null; issuedByMachineId: string | null },
  agentMachineId: string | null,
): boolean {
  return credential.issuedVia === "computer"
    && credential.issuedByMachineId !== null
    && credential.issuedByMachineId !== agentMachineId;
}

// Row verified by argon2: store its HMAC (filling a missing one, or replacing
// one from an older secret) so later requests take the fast path. Conditional
// on the hash just verified. Best-effort: auth already passed.
async function storeAgentApiKeyHmac(credentialId: string, apiKeyHash: string, apiKeyHmac: Buffer): Promise<void> {
  try {
    await getDb()
      .update(agentCredentials)
      .set({ apiKeyHmac })
      .where(and(eq(agentCredentials.id, credentialId), eq(agentCredentials.apiKeyHash, apiKeyHash)));
  } catch (err) {
    console.warn("[AgentCredential] api_key_hmac store failed", {
      credentialId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Minimum interval between two `last_used_at` writes for the same credential
 * in this process. `last_used_at` doubles as the external-agent presence
 * signal ("seen in the last 120 s" → online), so the window must stay well
 * under 120 s: 60 s (half of it) means a wake-hints stream ticking every 25 s
 * is written every 2-3 ticks, at most ~85 s apart, instead of every other
 * tick. The map is per process: with N replicas a credential is written at
 * most N times per window, which is fine. Cutting writes further needs
 * presence split from last_used_at (#proj-o11y task #6), not a longer window.
 */
export const AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS = 60_000;
const MAX_TRACKED_CREDENTIAL_WRITES = 10_000;
const lastCredentialUseWriteMs = new Map<string, number>();
let credentialUseWriteThrottleMs = AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS;

function claimCredentialUseWrite(credentialId: string, nowMs: number): boolean {
  const last = lastCredentialUseWriteMs.get(credentialId);
  if (last !== undefined && nowMs - last < credentialUseWriteThrottleMs) return false;
  if (last === undefined && lastCredentialUseWriteMs.size >= MAX_TRACKED_CREDENTIAL_WRITES) {
    // Bound memory: drop entries whose window already expired (they would
    // write on their next request anyway).
    for (const [id, at] of lastCredentialUseWriteMs) {
      if (nowMs - at >= credentialUseWriteThrottleMs) lastCredentialUseWriteMs.delete(id);
    }
  }
  lastCredentialUseWriteMs.set(credentialId, nowMs);
  return true;
}

/**
 * Test seam: override the throttle window (`null` restores the default) and
 * forget per-credential throttle state.
 */
export function __setAgentCredentialUseThrottleMsForTests(ms: number | null): void {
  credentialUseWriteThrottleMs = ms ?? AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS;
  lastCredentialUseWriteMs.clear();
}

/** How long the best-effort last-used write waits for its row before skipping. */
export const AGENT_CREDENTIAL_USE_LOCK_TIMEOUT = "100ms";

function isLockNotAvailable(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth += 1) {
    if (typeof current === "object" && (current as { code?: unknown }).code === "55P03") return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * Record observability triple (last_used_at, last_used_ip, last_used_user_agent)
 * for a successful credential auth. Best-effort: failure does not affect the
 * request path. Always called via `void recordAgentCredentialUse(...)` after
 * `next()` resolves on the middleware.
 *
 * Throttled per credential (see `AGENT_CREDENTIAL_USE_WRITE_THROTTLE_MS`):
 * resolves `null` when the write was skipped (or failed), otherwise the
 * `last_used_at` value that was written.
 */
export async function recordAgentCredentialUse(input: {
  credentialId: string;
  ip: string | null;
  userAgent: string | null;
}): Promise<Date | null> {
  const now = new Date();
  if (!claimCredentialUseWrite(input.credentialId, now.getTime())) {
    addTraceEvent("agent_credential_auth.last_used.finished", {
      duration_ms: 0,
      outcome: "throttled",
    });
    return null;
  }
  const writeStart = Date.now();
  try {
    // A revoked credential is never "seen": an already-open stream or an
    // in-flight request must not refresh its presence after revocation.
    // A short lock_timeout: while something else holds the row (a revoke, a
    // bulk revocation, an account deletion's transaction), skip this window
    // rather than hold a pooled connection waiting (#proj-o11y:058cb07b,
    // 11 s behind a rolled-back deletion on 2026-11-05).
    const updated = await getDb().transaction(async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${AGENT_CREDENTIAL_USE_LOCK_TIMEOUT}'`));
      return tx
        .update(agentCredentials)
        .set({
          lastUsedAt: now,
          lastUsedIp: input.ip,
          lastUsedUserAgent: input.userAgent,
        })
        .where(and(eq(agentCredentials.id, input.credentialId), isNull(agentCredentials.revokedAt)))
        .returning({ id: agentCredentials.id });
    });
    const outcome = updated.length > 0 ? "updated" : "revoked";
    addTraceEvent("agent_credential_auth.last_used.finished", {
      duration_ms: Date.now() - writeStart,
      outcome,
    });
    return outcome === "updated" ? now : null;
  } catch (error) {
    if (isLockNotAvailable(error)) {
      // The row is busy: this window is skipped (the throttle stays claimed),
      // the next one writes.
      addTraceEvent("agent_credential_auth.last_used.finished", {
        duration_ms: Date.now() - writeStart,
        outcome: "lock_busy",
      });
      return null;
    }
    // Let the next request retry instead of waiting out the window.
    lastCredentialUseWriteMs.delete(input.credentialId);
    addTraceEvent("agent_credential_auth.last_used.finished", {
      duration_ms: Date.now() - writeStart,
      outcome: "error",
    });
    // Swallow — observability writes must not impact auth latency / success.
    return null;
  }
}

/**
 * Re-validation for long-lived connections that authenticated once at open
 * (the wake-hint stream), keyed by credential id: `active` while the
 * credential is unrevoked and unexpired, its agent and server still exist, and
 * a runner credential's agent is still on the Machine that minted it (the
 * conditions of `authenticateAgentApiKey` plus the middleware's
 * server-liveness check). Otherwise `expired` when only its `expires_at` has
 * passed (its holder renews), `invalid` for everything else.
 */
export async function agentCredentialStreamState(credentialId: string): Promise<"active" | "expired" | "invalid"> {
  const [row] = await getDb()
    .select({
      id: agentCredentials.id,
      issuedVia: agentCredentials.issuedVia,
      issuedByMachineId: agentCredentials.issuedByMachineId,
      expiresAt: agentCredentials.expiresAt,
      agentMachineId: agents.machineId,
    })
    .from(agentCredentials)
    .innerJoin(agents, and(eq(agents.id, agentCredentials.agentId), isNull(agents.deletedAt)))
    .innerJoin(servers, and(eq(servers.id, agents.serverId), isNull(servers.deletedAt)))
    .where(and(eq(agentCredentials.id, credentialId), isNull(agentCredentials.revokedAt)))
    .limit(1);
  if (!row || isRunnerCredentialOffMachine(row, row.agentMachineId)) return "invalid";
  return isAgentCredentialExpired(row.expiresAt) ? "expired" : "active";
}

/**
 * Presence read for `GET /agents`: max(last_used_at) over each agent's
 * non-revoked credentials, one query for the whole page.
 */
export async function getAgentsLastSeenAt(agentIds: readonly string[]): Promise<Map<string, Date>> {
  const result = new Map<string, Date>();
  if (agentIds.length === 0) return result;
  const db = getDb();
  const rows = await db
    .select({
      agentId: agentCredentials.agentId,
      lastSeenAt: max(agentCredentials.lastUsedAt),
    })
    .from(agentCredentials)
    .where(and(inArray(agentCredentials.agentId, [...agentIds]), isNull(agentCredentials.revokedAt)))
    .groupBy(agentCredentials.agentId);
  for (const row of rows) {
    if (!row.lastSeenAt) continue;
    const at = row.lastSeenAt instanceof Date ? row.lastSeenAt : new Date(row.lastSeenAt);
    if (!Number.isNaN(at.getTime())) result.set(row.agentId, at);
  }
  return result;
}

/**
 * Helper for the step-3 mint endpoints. Generates a raw `sk_agent_*` key
 * + its argon2id hash + its HMAC (null when the secret is unset) + the prefix
 * used for indexed lookup. Returns the raw key ONLY to the caller; never
 * persists it in raw form.
 */
export async function generateAgentApiKeyMaterial(): Promise<{
  apiKey: string;
  apiKeyHash: string;
  apiKeyHmac: Buffer | null;
  apiKeyPrefix: string;
}> {
  const apiKey = `sk_agent_${randomBytes(RAW_KEY_BYTES).toString("hex")}`;
  const apiKeyHash = await argon2.hash(apiKey);
  return {
    apiKey,
    apiKeyHash,
    apiKeyHmac: computeAgentApiKeyHmac(apiKey),
    apiKeyPrefix: extractApiKeyPrefix(apiKey),
  };
}

// ============================================================================
// Mint primitives — write paths. Used by:
//   - POST /api/agent/login                       (bootstrap exchange, gated)
//   - POST /api/agents/:id/bootstrap-tokens       (web session mint, gated)
//   - POST /internal/computer/runners/:agentId/credentials  (sk_computer mint)
// ============================================================================

export const AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV = "SLOCK_SELF_HOSTED_RUNNER_BOOTSTRAP_ENABLED";

export function isAgentBootstrapSurfaceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[AGENT_BOOTSTRAP_SURFACE_ENABLED_ENV] ?? "").trim().toLowerCase() === "true";
}

/**
 * Validate a scopes array submitted by a caller. Returns the canonical list
 * (deduplicated, sorted) or throws if any value is outside the v0 enum.
 */
export function normalizeAgentCapabilities(input: readonly string[]): AgentCapability[] {
  const seen = new Set<AgentCapability>();
  for (const raw of input) {
    if (!isAgentCapability(raw)) {
      throw new Error(`unsupported agent capability: ${raw}`);
    }
    seen.add(raw);
  }
  return Array.from(seen).sort();
}

/** The origins a live write path can record; `unknown` is only for backfilled rows. */
export type LiveAgentCredentialIssuedVia = Exclude<AgentCredentialIssuedVia, "unknown">;

/**
 * Where the credential comes from (`agent_credentials.issued_via`). Only a
 * person's mint (directly, or by exchanging a bootstrap token they issued)
 * names an issuer; a cloud runtime's provider-held key, a Computer's runner
 * key and an App Bot's key have none.
 */
export type AgentCredentialIssuance =
  | {
      issuedVia: "human";
      createdByUserId: string;
      issuedByMachineId?: never;
      /** A device login's session family when that session mints (revoking the session revokes the credential). */
      issuedBySessionFamilyId?: string | null;
      /**
       * The person's web (full) session family when that session mints, or
       * issued the bootstrap token exchanged for it (a security revoke of the
       * session revokes the credential, webSessionIssuedKeys.ts).
       */
      issuedByWebSessionFamilyId?: string | null;
    }
  | {
      issuedVia: "computer";
      createdByUserId: null;
      issuedByMachineId?: string | null;
      /** The device login's family holding the minting Computer's key, if any (revoking that session revokes the credential). */
      issuedBySessionFamilyId?: string | null;
    }
  | { issuedVia: "provision" | "app"; createdByUserId: null; issuedByMachineId?: never };

export type MintAgentCredentialInput = AgentCredentialIssuance & {
  agentId: string;
  scopes: readonly AgentCapability[];
  name?: string | null;
  /**
   * Refuse (`agent_not_external`) unless the agent's runtime is external.
   * Set by every human-facing mint path (web session, bootstrap exchange):
   * a managed agent's credentials come only from its Computer
   * (`/internal/computer/runners/:agentId/credentials`), because a key for a
   * managed agent could drain and ack the daemon's delivery buffer.
   */
  requireExternalRuntime?: boolean;
  /**
   * Rotation: revoke this credential of the same agent in the same write
   * (the login flow passes the credential its local profile held). Throws
   * `replaces_credential_invalid` when it does not belong to the agent.
   * Callers that need atomicity pass a transaction executor.
   */
  replacesCredentialId?: string | null;
  /**
   * When the credential stops authenticating (`agent_credentials.expires_at`);
   * omitted or null never expires. Set only for a runner credential minted
   * for a daemon that renews (runnerCredentialExpiry).
   */
  expiresAt?: Date | null;
};

/**
 * Mint a fresh `sk_agent_*` credential bound to `agentId`. Returns the raw
 * API key exactly once — callers MUST return it to the user in the same
 * response and then forget it. The argon2 hash and HMAC are what persist.
 *
 * One row per credential. Other credentials for the same agent are NOT
 * revoked (each device/profile holds its own); only `replacesCredentialId`,
 * when given, is revoked in the same write.
 */
let mintBeforeLockHookForTests: ((agentId: string) => Promise<void>) | null = null;
/** Tests only: runs after the key is hashed, before the agent row is locked. */
export function __setMintBeforeLockHookForTests(hook: ((agentId: string) => Promise<void>) | null): void {
  mintBeforeLockHookForTests = hook;
}

export async function mintAgentCredential(
  input: MintAgentCredentialInput,
  options: { executor?: DatabaseExecutor } = {},
): Promise<{
  credentialId: string;
  apiKey: string;
  scopes: AgentCapability[];
  agentId: string;
  serverId: string;
  agentName: string;
  replacedCredentialId: string | null;
  issuedVia: LiveAgentCredentialIssuedVia;
  expiresAt: Date | null;
}> {
  const db = options.executor ?? getDb();

  // Resolve agent + soft-delete check + server liveness in one go.
  const [agentRow] = await db
    .select({
      id: agents.id,
      name: agents.name,
      serverId: agents.serverId,
      runtime: agents.runtime,
    })
    .from(agents)
    .innerJoin(servers, and(eq(servers.id, agents.serverId), isNull(servers.deletedAt)))
    .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)));
  if (!agentRow) {
    throw new Error("agent_missing");
  }
  if (input.requireExternalRuntime && !isExternalAgentRuntime(agentRow.runtime)) {
    throw new Error("agent_not_external");
  }

  const scopes = normalizeAgentCapabilities(input.scopes);
  const [raftbenchService] = await db.select({ agentId: raftbenchServiceAgents.agentId })
    .from(raftbenchServiceAgents).where(eq(raftbenchServiceAgents.agentId, input.agentId));
  if (raftbenchService && !hasExactRaftbenchServiceScopes(scopes)) {
    throw new Error("raftbench_service_credential_scope_invalid");
  }

  // Hashing is slow (argon2): before the lock, never under it.
  const material = await generateAgentApiKeyMaterial();
  await mintBeforeLockHookForTests?.(input.agentId);

  // The agent row, FOR SHARE, decides against a concurrent deleteAgent
  // (#wg-rbac:#27): either this sees the deletion and refuses, or the deletion
  // waits for this commit and then revokes the new key with the rest. Checking
  // without the lock left a window across the hash: a Computer minted a runner
  // key 3 s after its agent was deleted (production 2026-11-05).
  const { replacedCredentialId, row } = await db.transaction(async (tx) => {
    const [live] = await tx.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
      .for("share", { of: agents });
    if (!live) throw new Error("agent_missing");
    let replacedCredentialId: string | null = null;
    if (input.replacesCredentialId) {
      const [replaced] = await tx
        .select({ id: agentCredentials.id, revokedAt: agentCredentials.revokedAt })
        .from(agentCredentials)
        .where(and(eq(agentCredentials.id, input.replacesCredentialId), eq(agentCredentials.agentId, input.agentId)));
      if (!replaced) throw new Error("replaces_credential_invalid");
      if (!replaced.revokedAt) {
        await tx
          .update(agentCredentials)
          .set({
            revokedAt: new Date(),
            revokedReason: "rotated",
            ...(input.createdByUserId ? { revokedByUserId: input.createdByUserId } : {}),
          })
          .where(and(eq(agentCredentials.id, replaced.id), isNull(agentCredentials.revokedAt)));
        replacedCredentialId = replaced.id;
      }
    }

    // A person's keys are capped per agent (agentCredentialMintLimits.ts),
    // counted after a `replacesCredentialId` rotation's revoke above, so that rotation works at the cap. A device-grant re-login (`raft agent login`) mints without it and is refused at the cap; the existing key keeps working.
    if (input.issuedVia === "human") await assertAgentHumanCredentialCapacity(tx, input.agentId);

    const [row] = await tx
      .insert(agentCredentials)
      .values({
        agentId: input.agentId,
        apiKeyHash: material.apiKeyHash,
        apiKeyHmac: material.apiKeyHmac,
        apiKeyPrefix: material.apiKeyPrefix,
        name: input.name ?? null,
        scopes,
        createdByUserId: input.issuedVia === "human" ? input.createdByUserId : null,
        issuedVia: input.issuedVia,
        issuedByMachineId: input.issuedVia === "computer" ? input.issuedByMachineId ?? null : null,
        issuedBySessionFamilyId: input.issuedVia === "human" || input.issuedVia === "computer" ? input.issuedBySessionFamilyId ?? null : null,
        issuedByWebSessionFamilyId: input.issuedVia === "human" ? input.issuedByWebSessionFamilyId ?? null : null,
        expiresAt: input.expiresAt ?? null,
      })
      .returning({ id: agentCredentials.id });
    return { replacedCredentialId, row };
  });

  return {
    credentialId: row.id,
    apiKey: material.apiKey,
    scopes,
    agentId: agentRow.id,
    serverId: agentRow.serverId,
    agentName: agentRow.name,
    replacedCredentialId,
    issuedVia: input.issuedVia,
    expiresAt: input.expiresAt ?? null,
  };
}

/** Public management metadata only; never return key material or usage IPs. */
export async function listAgentCredentials(agentId: string) {
  const rows = await getDb().select({
    id: agentCredentials.id,
    apiKeyPrefix: agentCredentials.apiKeyPrefix,
    name: agentCredentials.name,
    scopes: agentCredentials.scopes,
    createdAt: agentCredentials.createdAt,
    lastUsedAt: agentCredentials.lastUsedAt,
    revokedAt: agentCredentials.revokedAt,
  }).from(agentCredentials).where(eq(agentCredentials.agentId, agentId))
    .orderBy(desc(agentCredentials.createdAt), desc(agentCredentials.id));
  // Existing rows retain only a lookup prefix, not a recoverable secret/tail.
  return rows.map(({ apiKeyPrefix, ...metadata }) => ({
    ...metadata,
    maskedToken: `${apiKeyPrefix.slice(0, 14)}***`,
  }));
}

export interface RevokeAgentCredentialInput {
  credentialId: string;
  agentId?: string;
  serverId?: string;
  reason: string;
  revokedByUserId?: string;
  /**
   * A Computer revokes only what it issued: set to the calling Machine, a
   * credential not minted by it (`issued_via = 'computer'` and
   * `issued_by_machine_id` = this Machine) is refused with
   * `not_issued_by_machine` and stays valid.
   */
  issuedByMachineId?: string;
  /**
   * The holder revokes its own key (`self_revoked`): a credential that is not
   * self-revocable (isSelfRevocableAgentCredential) is refused with
   * `not_self_revocable` and stays valid.
   */
  selfRevocableOnly?: boolean;
}

/** `revoked_reason` of a credential its holder revoked with the key itself. */
export const SELF_REVOKED_REASON = "self_revoked";

/**
 * Whether the holder of a key may revoke it with the key alone
 * (POST /internal/agent-api/credentials/self/revoke): only one a person
 * minted (`issued_via = 'human'`: `raft agent login`, the web, a bootstrap
 * exchange). A runner key (`computer`) belongs to its daemon, a cloud
 * runtime's (`provision`) to its provider and an App Bot's (`app`) to its App:
 * each is minted, renewed and revoked by the system that holds it, so killing
 * it from inside would only break that system. Unclassified rows (NULL,
 * `unknown`) could be any of those, so they are refused too.
 */
export function isSelfRevocableAgentCredential(issuedVia: AgentCredentialIssuedVia | null): boolean {
  return issuedVia === "human";
}

export async function revokeAgentCredential(
  input: RevokeAgentCredentialInput,
  options: { executor?: DatabaseExecutor } = {},
): Promise<boolean> {
  const outcome = await revokeAgentCredentialWithOutcome(input, options);
  return outcome === "revoked" || outcome === "already_revoked";
}

/**
 * `revoked` when this call revoked it, `already_revoked` for an idempotent
 * repeat (or a concurrent revoke that got there first), `not_issued_by_machine`
 * when `issuedByMachineId` is set and the credential is not that Machine's,
 * `not_self_revocable` when `selfRevocableOnly` is set and it is not, null when
 * not found.
 */
export async function revokeAgentCredentialWithOutcome(
  input: RevokeAgentCredentialInput,
  options: { executor?: DatabaseExecutor } = {},
): Promise<"revoked" | "already_revoked" | "not_issued_by_machine" | "not_self_revocable" | null> {
  const db = options.executor ?? getDb();
  const [row] = await db
    .select({
      id: agentCredentials.id,
      agentId: agentCredentials.agentId,
      revokedAt: agentCredentials.revokedAt,
      issuedVia: agentCredentials.issuedVia,
      issuedByMachineId: agentCredentials.issuedByMachineId,
      serverId: agents.serverId,
    })
    .from(agentCredentials)
    .innerJoin(agents, eq(agents.id, agentCredentials.agentId))
    .where(eq(agentCredentials.id, input.credentialId));
  if (!row) return null;
  if (input.agentId && row.agentId !== input.agentId) return null;
  if (input.serverId && row.serverId !== input.serverId) return null;
  if (
    input.issuedByMachineId
    && (row.issuedVia !== "computer" || row.issuedByMachineId !== input.issuedByMachineId)
  ) {
    return "not_issued_by_machine";
  }
  if (input.selfRevocableOnly && !isSelfRevocableAgentCredential(row.issuedVia)) return "not_self_revocable";
  if (row.revokedAt) return "already_revoked";

  // Conditional on still being live: of two concurrent revokes only one
  // reports `revoked` (and so records the audit event).
  const updated = await db
    .update(agentCredentials)
    .set({
      revokedAt: new Date(),
      revokedReason: input.reason,
      ...(input.revokedByUserId ? { revokedByUserId: input.revokedByUserId } : {}),
    })
    .where(and(eq(agentCredentials.id, input.credentialId), isNull(agentCredentials.revokedAt)))
    .returning({ id: agentCredentials.id });
  return updated.length > 0 ? "revoked" : "already_revoked";
}

export const RUNNER_MACHINE_CHANGED_REVOKE_REASON = "runner_machine_changed";

/**
 * An agent moved to `machineId` (null: to no Machine, e.g. unbound or hosted):
 * revoke its runner credentials minted by any other Machine, which no longer
 * authenticate anyway (isRunnerCredentialOffMachine) and which the old Machine
 * can no longer revoke itself (its DELETE needs the agent on it). Keys the new
 * Machine minted stay (it can mint only while it holds the agent, so after the
 * move; excluding them costs nothing), as do human, provision and app
 * credentials and computer rows with no recorded Machine. Run in the transaction that writes `agents.machine_id`;
 * open streams of a revoked credential close at their next re-validation, or
 * sooner where the caller broadcasts the revocation after commit.
 */
export async function revokeRunnerCredentialsOffMachine(
  executor: DatabaseExecutor,
  input: { agentIds: readonly string[]; machineId: string | null; now: Date },
): Promise<void> {
  if (input.agentIds.length === 0) return;
  await executor
    .update(agentCredentials)
    .set({ revokedAt: input.now, revokedReason: RUNNER_MACHINE_CHANGED_REVOKE_REASON })
    .where(and(
      inArray(agentCredentials.agentId, [...input.agentIds]),
      eq(agentCredentials.issuedVia, "computer"),
      isNotNull(agentCredentials.issuedByMachineId),
      input.machineId ? ne(agentCredentials.issuedByMachineId, input.machineId) : undefined,
      isNull(agentCredentials.revokedAt),
    ));
}

// ============================================================================
// Runner credential expiry and renewal (#wg-rbac:#27). A daemon that declares
// `runner-credential-renew:v1` gets runner credentials that expire
// RUNNER_CREDENTIAL_TTL_MS after they are issued, and renews them with its
// Machine's own key (POST /internal/computer/runners/:agentId/credentials/renew)
// before then, or after a 401 `agent_credential_expired`.
// ============================================================================

/** How long a runner credential minted or renewed for a renewing daemon lives. */
export const RUNNER_CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60_000;
/**
 * After a renewal the old key keeps working at most this long (its
 * `expires_at` is pulled in, never pushed out): in-flight requests and a
 * second process sharing the key finish instead of failing at once.
 */
export const RUNNER_CREDENTIAL_RENEW_OVERLAP_MS = 5 * 60_000;
/** An expired runner credential may still be renewed this long after it expired; later, the daemon mints afresh. */
export const RUNNER_CREDENTIAL_RENEW_AFTER_EXPIRY_MS = 7 * 24 * 60 * 60_000;

/** `expires_at` for a runner credential issued at `now`: 7 days out for a renewing daemon, never otherwise. */
export function runnerCredentialExpiresAt(daemonRenews: boolean, now: Date = currentDate()): Date | null {
  return daemonRenews ? new Date(now.getTime() + RUNNER_CREDENTIAL_TTL_MS) : null;
}

export type RunnerCredentialRenewRefusal =
  /** The agent is gone, on another server, or not on the calling Machine. */
  | "agent_missing"
  /** No such credential of this agent. */
  | "credential_missing"
  /** Not a Computer's runner credential (`issued_via = 'computer'`, name `runner:*`). */
  | "credential_not_runner"
  /** A runner credential another Machine (or none on record) minted. */
  | "credential_not_issued_by_this_computer"
  /** Revoked: never renewed. */
  | "credential_revoked"
  /** Expired more than RUNNER_CREDENTIAL_RENEW_AFTER_EXPIRY_MS ago. */
  | "renew_window_passed"
  /** Already renewed once; nothing new is issued. */
  | "already_renewed";

export type RunnerCredentialRenewal =
  | {
      ok: true;
      credentialId: string;
      apiKey: string;
      expiresAt: Date;
      scopes: AgentCapability[];
      replacedCredentialId: string;
      /** The old key's `expires_at` after the renewal. */
      replacedExpiresAt: Date;
    }
  | { ok: false; refusal: RunnerCredentialRenewRefusal };

const RUNNER_CREDENTIAL_NAME_PREFIX = "runner:";

function runnerCredentialRenewRefusal(
  row: {
    agentId: string;
    issuedVia: AgentCredentialIssuedVia | null;
    name: string | null;
    createdByUserId: string | null;
    issuedByMachineId: string | null;
    revokedAt: Date | null;
    expiresAt: Date | null;
    replacedByCredentialId: string | null;
  } | undefined,
  input: { agentId: string; machineId: string },
  now: Date,
): RunnerCredentialRenewRefusal | null {
  if (!row || row.agentId !== input.agentId) return "credential_missing";
  if (row.issuedVia !== "computer" || !row.name?.startsWith(RUNNER_CREDENTIAL_NAME_PREFIX) || row.createdByUserId !== null) {
    return "credential_not_runner";
  }
  if (row.issuedByMachineId !== input.machineId) return "credential_not_issued_by_this_computer";
  if (row.revokedAt) return "credential_revoked";
  if (row.replacedByCredentialId) return "already_renewed";
  if (row.expiresAt && row.expiresAt.getTime() <= now.getTime() - RUNNER_CREDENTIAL_RENEW_AFTER_EXPIRY_MS) {
    return "renew_window_passed";
  }
  return null;
}

const runnerCredentialRenewColumns = {
  id: agentCredentials.id,
  agentId: agentCredentials.agentId,
  name: agentCredentials.name,
  scopes: agentCredentials.scopes,
  issuedVia: agentCredentials.issuedVia,
  createdByUserId: agentCredentials.createdByUserId,
  issuedByMachineId: agentCredentials.issuedByMachineId,
  revokedAt: agentCredentials.revokedAt,
  expiresAt: agentCredentials.expiresAt,
  replacedByCredentialId: agentCredentials.replacedByCredentialId,
};

let renewBeforeLockHookForTests: (() => Promise<void>) | null = null;
/** Tests only: runs after the new key is hashed, before the rows are locked. */
export function __setRenewBeforeLockHookForTests(hook: (() => Promise<void>) | null): void {
  renewBeforeLockHookForTests = hook;
}

/**
 * Renew a Computer's runner credential: issue a new one in its place (same
 * agent, Machine, name and scopes, a fresh RUNNER_CREDENTIAL_TTL_MS, HMAC from
 * the start) and pull the old key's `expires_at` in to at most
 * RUNNER_CREDENTIAL_RENEW_OVERLAP_MS out. The old key is not revoked: it keeps
 * working through the overlap. One transaction: the agent row FOR SHARE (as
 * mintAgentCredential: a concurrent delete either sees the new key or waits
 * and revokes it), the old credential FOR UPDATE (two renewals of it
 * serialize; the second sees `replaced_by_credential_id` and is refused
 * `already_renewed` without issuing anything), the insert, the old row's
 * update and the audit event.
 *
 * The caller has authenticated `machineId` (the Machine's own key, never the
 * old agent key) and checked that its daemon declared
 * `runner-credential-renew:v1`. `issuedBySessionFamilyId`: the device login's
 * family holding the Computer's key now, as for a mint.
 */
export async function renewRunnerCredential(
  input: {
    agentId: string;
    serverId: string;
    machineId: string;
    credentialId: string;
    issuedBySessionFamilyId?: string | null;
  },
  options: { executor?: DatabaseExecutor } = {},
): Promise<RunnerCredentialRenewal> {
  if (!CREDENTIAL_ID_PATTERN.test(input.credentialId)) return { ok: false, refusal: "credential_missing" };
  const db = options.executor ?? getDb();

  // Refuse what can be refused before paying for argon2; re-checked under the locks.
  const [unlocked] = await db.select(runnerCredentialRenewColumns).from(agentCredentials)
    .where(eq(agentCredentials.id, input.credentialId));
  const early = runnerCredentialRenewRefusal(unlocked, input, currentDate());
  if (early) return { ok: false, refusal: early };

  const material = await generateAgentApiKeyMaterial();
  await renewBeforeLockHookForTests?.();

  return db.transaction(async (tx): Promise<RunnerCredentialRenewal> => {
    const [agent] = await tx.select({ id: agents.id, serverId: agents.serverId, machineId: agents.machineId })
      .from(agents)
      .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
      .for("share", { of: agents });
    if (!agent || agent.serverId !== input.serverId || agent.machineId !== input.machineId) {
      return { ok: false, refusal: "agent_missing" };
    }
    const [old] = await tx.select(runnerCredentialRenewColumns).from(agentCredentials)
      .where(eq(agentCredentials.id, input.credentialId))
      .for("update");
    const now = currentDate();
    const refusal = runnerCredentialRenewRefusal(old, input, now);
    if (refusal || !old) return { ok: false, refusal: refusal ?? "credential_missing" };

    const expiresAt = new Date(now.getTime() + RUNNER_CREDENTIAL_TTL_MS);
    const overlapEnd = new Date(now.getTime() + RUNNER_CREDENTIAL_RENEW_OVERLAP_MS);
    const replacedExpiresAt = old.expiresAt && old.expiresAt.getTime() < overlapEnd.getTime() ? old.expiresAt : overlapEnd;
    const scopes = normalizeAgentCapabilities(old.scopes);
    const [row] = await tx.insert(agentCredentials).values({
      agentId: input.agentId,
      apiKeyHash: material.apiKeyHash,
      apiKeyHmac: material.apiKeyHmac,
      apiKeyPrefix: material.apiKeyPrefix,
      name: old.name,
      scopes,
      createdByUserId: null,
      issuedVia: "computer",
      issuedByMachineId: input.machineId,
      issuedBySessionFamilyId: input.issuedBySessionFamilyId ?? null,
      expiresAt,
    }).returning({ id: agentCredentials.id });
    await tx.update(agentCredentials)
      .set({ expiresAt: replacedExpiresAt, replacedByCredentialId: row!.id })
      .where(eq(agentCredentials.id, old.id));
    await recordRunnerCredentialRenewed({
      serverId: agent.serverId,
      agentId: input.agentId,
      credentialId: row!.id,
      replacedCredentialId: old.id,
      machineId: input.machineId,
      scopes,
      expiresAt,
    }, tx);
    return {
      ok: true,
      credentialId: row!.id,
      apiKey: material.apiKey,
      expiresAt,
      scopes,
      replacedCredentialId: old.id,
      replacedExpiresAt,
    };
  });
}

export const RUNNER_NOT_HELD_REVOKE_REASON = "runner_not_held";
/** A mint issued this long before a `ready` may still be on its way to the daemon. */
export const RUNNER_CREDENTIAL_RECONCILE_GRACE_MS = 5 * 60_000;
/** More held ids than this is not a believable claim (one per launch): reconcile nothing. */
export const RUNNER_CREDENTIAL_RECONCILE_MAX_HELD = 4096;
/**
 * A key used this recently is spared whatever the list says: `last_used_at` is
 * written at most once a minute while a key is used, so a process calling the
 * server keeps its key even if a second daemon on the same Machine key (task
 * #374 duplicates) sent this list, or the list missed it.
 */
export const RUNNER_CREDENTIAL_RECONCILE_RECENT_USE_MS = 15 * 60_000;
/** Revoked per `ready` at most; a machine's older backlog goes on its next connection. */
export const RUNNER_CREDENTIAL_RECONCILE_BATCH = 200;
const CREDENTIAL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #wg-rbac:#27 reconcile: the daemon on `machineId` says (first `ready` of a
 * connection, `runner-credential-reconcile:v1`) it holds `heldIds` and no
 * other runner credential. Revoke this Machine's live runner credentials
 * (issued_via 'computer', name `runner:*`, no person, not a cloud runtime's)
 * that are not listed, were issued before `issuedBefore` (the ready's
 * arrival minus RUNNER_CREDENTIAL_RECONCILE_GRACE_MS: a mint whose response
 * had not reached the daemon when it built the frame is never listed), and
 * were not used in the last RUNNER_CREDENTIAL_RECONCILE_RECENT_USE_MS. Ids
 * the daemon lists that are not this Machine's, or not ids at all, change
 * nothing. No broadcast: no process holds these keys. Returns how many were
 * revoked, or null when the claim was refused as too large.
 */
export async function revokeRunnerCredentialsNotHeld(
  input: { machineId: string; heldIds: readonly string[]; issuedBefore: Date; now: Date; limit?: number },
  executor: DatabaseExecutor = getDb(),
): Promise<number | null> {
  const notHeldWhere = runnerCredentialsNotHeldWhere(input, executor);
  if (!notHeldWhere) return null;
  const notHeld = executor
    .select({ id: agentCredentials.id })
    .from(agentCredentials)
    .where(notHeldWhere)
    .limit(input.limit ?? RUNNER_CREDENTIAL_RECONCILE_BATCH);
  const revoked = await executor
    .update(agentCredentials)
    .set({ revokedAt: input.now, revokedReason: RUNNER_NOT_HELD_REVOKE_REASON })
    .where(and(inArray(agentCredentials.id, notHeld), isNull(agentCredentials.revokedAt)))
    .returning({ id: agentCredentials.id });
  return revoked.length;
}

/**
 * Count-only twin of revokeRunnerCredentialsNotHeld (run while
 * runner_credential_reconcile is off): what it would revoke, uncapped,
 * and how many of those were used in the last 24 hours (a live but idle
 * process, or a second daemon on the Machine key: the ones a real revoke
 * could break). Writes nothing. Null when the claim is refused as too large.
 */
export async function countRunnerCredentialsNotHeld(
  input: { machineId: string; heldIds: readonly string[]; issuedBefore: Date; now: Date },
  executor: DatabaseExecutor = getDb(),
): Promise<{ wouldRevoke: number; usedLast24h: number } | null> {
  const notHeldWhere = runnerCredentialsNotHeldWhere(input, executor);
  if (!notHeldWhere) return null;
  const dayAgo = new Date(input.now.getTime() - 24 * 60 * 60_000);
  const [row] = await executor
    .select({
      wouldRevoke: sql<number>`count(*)::int`,
      usedLast24h: sql<number>`(count(*) filter (where ${agentCredentials.lastUsedAt} >= ${dayAgo}))::int`,
    })
    .from(agentCredentials)
    .where(notHeldWhere);
  return { wouldRevoke: Number(row?.wouldRevoke ?? 0), usedLast24h: Number(row?.usedLast24h ?? 0) };
}

function runnerCredentialsNotHeldWhere(
  input: { machineId: string; heldIds: readonly string[]; issuedBefore: Date; now: Date },
  executor: DatabaseExecutor,
): SQL | undefined {
  if (input.heldIds.length > RUNNER_CREDENTIAL_RECONCILE_MAX_HELD) return undefined;
  const held = input.heldIds.filter((id) => CREDENTIAL_ID_PATTERN.test(id));
  const providerHeld = executor
    .select({ id: agentRuntimeProvisions.credentialId })
    .from(agentRuntimeProvisions)
    .where(isNotNull(agentRuntimeProvisions.credentialId));
  return and(
    eq(agentCredentials.issuedByMachineId, input.machineId),
    eq(agentCredentials.issuedVia, "computer"),
    like(agentCredentials.name, "runner:%"),
    isNull(agentCredentials.createdByUserId),
    isNull(agentCredentials.revokedAt),
    lt(agentCredentials.createdAt, input.issuedBefore),
    or(
      isNull(agentCredentials.lastUsedAt),
      lt(agentCredentials.lastUsedAt, new Date(input.now.getTime() - RUNNER_CREDENTIAL_RECONCILE_RECENT_USE_MS)),
    ),
    held.length > 0 ? notInArray(agentCredentials.id, held) : undefined,
    notInArray(agentCredentials.id, providerHeld),
  );
}

export const ISSUER_LEFT_SERVER_REVOKE_REASON = "issuer_left_server";

/**
 * A person's departure from a server takes back the Agent credentials they
 * issued there (#wg-rbac B12): those whose issuer (`created_by_user_id`) they
 * are and those exchanged from a bootstrap token they issued (rows exchanged
 * before the exchange recorded the token's issuer carry none). Their
 * unconsumed bootstrap tokens are revoked too. Left alone: credentials a
 * Computer minted for its runner (no human issuer; the Machine's own
 * revocation path) and a cloud runtime's credential held by its provider (no
 * person ever saw that key) -- including one an older server build minted
 * during rollout, which the insert trigger classed as 'human' with an issuer.
 *
 * Deliberately not keyed on `issued_via` yet: until the backfill
 * (scripts/backfill-agent-credential-issued-via.ts) has run and the contract
 * migration has set NOT NULL, existing rows may be NULL or misclassified. The
 * contract PR simplifies this to
 * `issued_via = 'human' AND created_by_user_id = <leaver>`.
 *
 * Runs on the caller's executor so it commits with the membership delete.
 * Returns the revoked credentials; the caller audits them and broadcasts the
 * revocation per agent after commit so open streams close.
 */
export async function revokeAgentCredentialsIssuedBy(input: {
  serverId: string;
  userId: string;
  revokedAt: Date;
}, executor: DatabaseExecutor): Promise<Array<{ credentialId: string; agentId: string }>> {
  const viaToken = executor
    .select({ id: agentBootstrapTokens.consumedCredentialId })
    .from(agentBootstrapTokens)
    .where(and(
      eq(agentBootstrapTokens.serverId, input.serverId),
      eq(agentBootstrapTokens.issuedByUserId, input.userId),
      isNotNull(agentBootstrapTokens.consumedCredentialId),
    ));
  const serverAgents = executor
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.serverId, input.serverId));
  // A cloud runtime's credential is minted under its creator's authority but
  // handed, encrypted, to the provider: no person ever saw the key, so a
  // departure takes nothing back by revoking it and would only stop the agent.
  const providerHeld = executor
    .select({ id: agentRuntimeProvisions.credentialId })
    .from(agentRuntimeProvisions)
    .where(and(
      eq(agentRuntimeProvisions.serverId, input.serverId),
      isNotNull(agentRuntimeProvisions.credentialId),
    ));
  // Two statements, not one with `issuer OR via token`: under that OR the
  // planner gave up both the agent index and the primary key and scanned all of
  // agent_credentials, which timed out a large server's removal (#wg-rbac:#18).
  // Same transaction, so the revoke still commits or rolls back with the
  // membership delete. A row both statements match is revoked by the first and
  // skipped by the second's `revoked_at IS NULL`, so none is returned twice.
  const revokeWhere = (issuedBy: SQL) => executor
    .update(agentCredentials)
    .set({ revokedAt: input.revokedAt, revokedReason: ISSUER_LEFT_SERVER_REVOKE_REASON })
    .where(and(
      isNull(agentCredentials.revokedAt),
      inArray(agentCredentials.agentId, serverAgents),
      issuedBy,
      notInArray(agentCredentials.id, providerHeld),
    ))
    .returning({ credentialId: agentCredentials.id, agentId: agentCredentials.agentId });
  const revoked = [
    ...await revokeWhere(eq(agentCredentials.createdByUserId, input.userId)),
    ...await revokeWhere(inArray(agentCredentials.id, viaToken)),
  ];

  await executor
    .update(agentBootstrapTokens)
    .set({ revokedAt: input.revokedAt })
    .where(and(
      eq(agentBootstrapTokens.serverId, input.serverId),
      eq(agentBootstrapTokens.issuedByUserId, input.userId),
      isNull(agentBootstrapTokens.consumedAt),
      isNull(agentBootstrapTokens.revokedAt),
    ));

  return revoked;
}

// ----------------------------------------------------------------------------
// Bootstrap token mint + exchange (RFC v0.8 invariants).
// ----------------------------------------------------------------------------

export interface IssueAgentBootstrapTokenInput {
  agentId: string;
  serverId: string;
  issuedByUserId: string;
  /** The issuer's web (full) session family: copied onto the credential at exchange (webSessionIssuedKeys.ts). */
  issuedByWebSessionFamilyId?: string | null;
  scopes: readonly AgentCapability[];
  ttlMs?: number;
}

export async function issueAgentBootstrapToken(
  input: IssueAgentBootstrapTokenInput,
  options: { executor?: DatabaseExecutor } = {},
): Promise<{
  tokenId: string;
  rawToken: string;
  tokenPrefix: string;
  ttlExpiresAt: Date;
  scopes: AgentCapability[];
}> {
  const db = options.executor ?? getDb();

  // Resolve agent + check it belongs to the issuer's server (callers MUST
  // pre-verify this; we re-check here for defense-in-depth).
  const [agentRow] = await db
    .select({ id: agents.id, serverId: agents.serverId, runtime: agents.runtime })
    .from(agents)
    .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)));
  if (!agentRow) {
    throw new Error("agent_missing");
  }
  if (agentRow.serverId !== input.serverId) {
    throw new Error("agent_server_mismatch");
  }
  // The token exchanges for an `sk_agent_*`; same external-only rule as
  // `mintAgentCredential({ requireExternalRuntime: true })`.
  if (!isExternalAgentRuntime(agentRow.runtime)) {
    throw new Error("agent_not_external");
  }

  const scopes = normalizeAgentCapabilities(input.scopes);

  // Generate the raw token. The "abtk_" prefix is human-recognizable so
  // accidental paste into other contexts is identifiable as an agent
  // bootstrap token.
  const rawToken = `abtk_${randomBytes(BOOTSTRAP_TOKEN_BYTES).toString("base64url")}`;
  const tokenLookupHash = computeTokenLookupHash(rawToken);
  const tokenHash = await argon2.hash(rawToken);
  const tokenPrefix = rawToken.slice(0, BOOTSTRAP_TOKEN_PREFIX_LENGTH);
  const ttlMs = input.ttlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
  const ttlExpiresAt = new Date(Date.now() + ttlMs);

  // Same lock as mintAgentCredential: no token for an agent being deleted.
  const row = await db.transaction(async (tx) => {
    const [live] = await tx.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.id, input.agentId), isNull(agents.deletedAt)))
      .for("share", { of: agents });
    if (!live) throw new Error("agent_missing");
    const [inserted] = await tx
      .insert(agentBootstrapTokens)
      .values({
        tokenLookupHash,
        tokenHash,
        tokenPrefix,
        targetAgentId: input.agentId,
        serverId: input.serverId,
        issuedByUserId: input.issuedByUserId,
        issuedByWebSessionFamilyId: input.issuedByWebSessionFamilyId ?? null,
        scopes,
        ttlExpiresAt,
      })
      .returning({ id: agentBootstrapTokens.id });
    return inserted;
  });

  return {
    tokenId: row.id,
    rawToken,
    tokenPrefix,
    ttlExpiresAt,
    scopes,
  };
}

export type ConsumeAgentBootstrapTokenError =
  | "token_invalid"
  | "token_consumed"
  | "token_revoked"
  | "token_expired"
  | "agent_missing"
  | "agent_not_external"
  | "server_missing";

export type ConsumeAgentBootstrapTokenResult =
  | {
      ok: true;
      apiKey: string;
      credentialId: string;
      agentId: string;
      agentName: string;
      serverId: string;
      scopes: AgentCapability[];
    }
  | { ok: false; error: ConsumeAgentBootstrapTokenError };

/**
 * Single-use exchange of a raw bootstrap token for a fresh `sk_agent_*`
 * credential. Concurrent racers contract (RFC §7): exactly one caller gets
 * 200 + apiKey; all others get 410 token_consumed. Implementation:
 *
 *   1. SELECT by HMAC lookup hash (filters revoked / consumed / expired)
 *   2. argon2id verify the raw token against token_hash
 *   3. mint the credential
 *   4. CAS-style UPDATE setting consumed_at + consumed_credential_id
 *      WHERE id = ? AND consumed_at IS NULL — if 0 rows updated, another
 *      racer won; revoke the just-minted credential and return token_consumed.
 *
 * NOTE: step 4 is the actual race-defense. The partial index in step 1 is a
 * fast-path filter, not a serialization point.
 */
export async function consumeAgentBootstrapToken(
  rawToken: string,
  observe: { ip?: string | null; userAgent?: string | null } = {},
): Promise<ConsumeAgentBootstrapTokenResult> {
  if (!rawToken || typeof rawToken !== "string") {
    return { ok: false, error: "token_invalid" };
  }
  const db = getDb();
  const tokenLookupHash = computeTokenLookupHash(rawToken);

  // Step 1 — locate the row. Don't filter on consumed/revoked/expired here:
  // we want distinct error codes so the CLI can render the right message.
  const [row] = await db
    .select({
      id: agentBootstrapTokens.id,
      tokenHash: agentBootstrapTokens.tokenHash,
      targetAgentId: agentBootstrapTokens.targetAgentId,
      serverId: agentBootstrapTokens.serverId,
      scopes: agentBootstrapTokens.scopes,
      ttlExpiresAt: agentBootstrapTokens.ttlExpiresAt,
      consumedAt: agentBootstrapTokens.consumedAt,
      revokedAt: agentBootstrapTokens.revokedAt,
      issuedByUserId: agentBootstrapTokens.issuedByUserId,
      issuedByWebSessionFamilyId: agentBootstrapTokens.issuedByWebSessionFamilyId,
    })
    .from(agentBootstrapTokens)
    .where(eq(agentBootstrapTokens.tokenLookupHash, tokenLookupHash));
  if (!row) {
    return { ok: false, error: "token_invalid" };
  }

  // Constant-time verify against argon2 hash. A row with a matching lookup
  // hash but failing argon2 verify means a (near-impossible) HMAC collision
  // — treat as token_invalid, not 500.
  let argonOk = false;
  try {
    argonOk = await argon2.verify(row.tokenHash, rawToken);
  } catch {
    argonOk = false;
  }
  if (!argonOk) {
    return { ok: false, error: "token_invalid" };
  }

  if (row.revokedAt) return { ok: false, error: "token_revoked" };
  if (row.consumedAt) return { ok: false, error: "token_consumed" };
  if (row.ttlExpiresAt.getTime() <= Date.now()) {
    return { ok: false, error: "token_expired" };
  }

  // Steps 2–4 run in one transaction: mint, claim, and the audit event of the
  // credential commit together (or the race-lost revoke commits instead).
  // Step 2 — mint a fresh credential carrying the token's scopes. If the
  // bound agent has been soft-deleted between issue and exchange,
  // mintAgentCredential throws agent_missing and we map back to the public
  // error code.
  type Exchange =
    | { ok: true; minted: Awaited<ReturnType<typeof mintAgentCredential>> }
    | { ok: false; error: "agent_missing" | "agent_not_external" | "token_consumed" | "token_revoked" };
  const exchange = await db.transaction(async (tx): Promise<Exchange> => {
    let minted: Awaited<ReturnType<typeof mintAgentCredential>>;
    try {
      minted = await mintAgentCredential({
        agentId: row.targetAgentId,
        scopes: row.scopes as AgentCapability[],
        // A person's mint: the token's issuer is the credential's issuer.
        issuedVia: "human",
        createdByUserId: row.issuedByUserId,
        // The web session that issued the token: a security revoke of it
        // revokes this credential (webSessionIssuedKeys.ts).
        issuedByWebSessionFamilyId: row.issuedByWebSessionFamilyId,
        name: null,
        requireExternalRuntime: true,
      }, { executor: tx });
    } catch (err) {
      if (err instanceof Error && err.message === "agent_missing") {
        return { ok: false, error: "agent_missing" };
      }
      if (err instanceof Error && err.message === "agent_not_external") {
        return { ok: false, error: "agent_not_external" };
      }
      throw err;
    }

    // Step 3 — CAS-style claim. If another racer beat us, this returns 0
    // rows; revoke the just-minted credential (otherwise we'd leak it) and
    // surface token_consumed to the caller. A revoke that landed since the
    // read above wins too (token_revoked): a security revoke of the issuing
    // web session revokes the token first and then the credentials minted
    // from it, so an exchange either commits first (its credential is then
    // found) or finds the token revoked here (webSessionIssuedKeys.ts).
    const claimResult = await tx
      .update(agentBootstrapTokens)
      .set({
        consumedAt: new Date(),
        consumedCredentialId: minted.credentialId,
        consumedIp: observe.ip ?? null,
        consumedUserAgent: observe.userAgent ?? null,
      })
      .where(
        and(
          eq(agentBootstrapTokens.id, row.id),
          isNull(agentBootstrapTokens.consumedAt),
          isNull(agentBootstrapTokens.revokedAt),
        ),
      )
      .returning({ id: agentBootstrapTokens.id });

    if (claimResult.length === 0) {
      // Race lost. Revoke the just-minted credential so it can't be used.
      await tx
        .update(agentCredentials)
        .set({
          revokedAt: new Date(),
          revokedReason: "bootstrap_exchange_race_lost",
        })
        .where(eq(agentCredentials.id, minted.credentialId));
      const [lost] = await tx
        .select({ revokedAt: agentBootstrapTokens.revokedAt, consumedAt: agentBootstrapTokens.consumedAt })
        .from(agentBootstrapTokens)
        .where(eq(agentBootstrapTokens.id, row.id));
      return { ok: false, error: lost?.revokedAt && !lost.consumedAt ? "token_revoked" : "token_consumed" };
    }

    // Step 4 — the credential's audit event, in the claim's commit. The person
    // who issued the token authorized it; ids and scopes only, never the key.
    await recordIntegrationAuditEvent({
      serverId: minted.serverId,
      eventType: "agent_credential.issued",
      outcome: "success",
      source: "system",
      actor: { type: "system" },
      requester: { type: "human", id: row.issuedByUserId },
      subject: { type: "agent", id: minted.agentId },
      target: { type: "agent_credential", id: minted.credentialId },
      metadata: {
        agentId: minted.agentId,
        credentialId: minted.credentialId,
        scopes: minted.scopes,
        issuedVia: minted.issuedVia,
        viaBootstrapToken: true,
        bootstrapTokenId: row.id,
      },
    }, tx);
    return { ok: true, minted };
  });
  if (!exchange.ok) return { ok: false, error: exchange.error };
  const { minted } = exchange;

  return {
    ok: true,
    apiKey: minted.apiKey,
    credentialId: minted.credentialId,
    agentId: minted.agentId,
    agentName: minted.agentName,
    serverId: minted.serverId,
    scopes: minted.scopes,
  };
}

/**
 * Where an external agent's setup stands (#wg-external-agent-ux:#2), from its
 * credentials and login tokens, in this order:
 * - `connected`: any credential not revoked has been used;
 * - `credential_minted`: one not revoked exists but none has been used yet;
 * - `disconnected`: none left, and one that was revoked had been used;
 * - `login_token_expired`: never connected, and its newest login token expired unused;
 * - `waiting_for_login`: nothing yet (or a login token still waiting to be used).
 * `credentialLastUsedAt` is the newest use of a credential not revoked.
 */
export type ExternalAgentSetupState = "waiting_for_login" | "credential_minted" | "login_token_expired" | "connected" | "disconnected";

export async function externalAgentSetupState(agentId: string, now: Date = new Date()): Promise<{ setupState: ExternalAgentSetupState; credentialLastUsedAt: Date | null }> {
  const db = getDb();
  const [credentials, [latestToken]] = await Promise.all([
    db.select({ lastUsedAt: agentCredentials.lastUsedAt, revokedAt: agentCredentials.revokedAt })
      .from(agentCredentials)
      .where(eq(agentCredentials.agentId, agentId)),
    db.select({ ttlExpiresAt: agentBootstrapTokens.ttlExpiresAt, consumedAt: agentBootstrapTokens.consumedAt, revokedAt: agentBootstrapTokens.revokedAt })
      .from(agentBootstrapTokens)
      .where(eq(agentBootstrapTokens.targetAgentId, agentId))
      .orderBy(desc(agentBootstrapTokens.createdAt))
      .limit(1),
  ]);
  const active = credentials.filter((credential) => credential.revokedAt === null);
  const usedTimes = active.flatMap((credential) => (credential.lastUsedAt ? [credential.lastUsedAt.getTime()] : []));
  const credentialLastUsedAt = usedTimes.length > 0 ? new Date(Math.max(...usedTimes)) : null;
  if (credentialLastUsedAt) return { setupState: "connected", credentialLastUsedAt };
  if (active.length > 0) return { setupState: "credential_minted", credentialLastUsedAt: null };
  if (credentials.some((credential) => credential.lastUsedAt !== null)) return { setupState: "disconnected", credentialLastUsedAt: null };
  if (latestToken && !latestToken.consumedAt && !latestToken.revokedAt && latestToken.ttlExpiresAt.getTime() <= now.getTime()) {
    return { setupState: "login_token_expired", credentialLastUsedAt: null };
  }
  return { setupState: "waiting_for_login", credentialLastUsedAt: null };
}
