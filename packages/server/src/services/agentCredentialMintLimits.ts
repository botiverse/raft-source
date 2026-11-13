import { and, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "../db/index";
import { agentCredentials } from "../db/schema";
import { RefusalError } from "../lib/refusal";
import { createFixedWindowCounter } from "./fixedWindowRateLimit";

// Bounds on a person issuing agent keys (`issued_via = 'human'`): every mint
// runs an argon2 hash and adds a row that authenticates until it is revoked.
// One place for every path a person issues one by, so the limits can't drift:
//   - POST /api/agents/:id/credentials (routes/agentCredentials.ts),
//   - POST /api/agents/:id/bootstrap-tokens (routes/agents.ts; the token is
//     exchanged for a key at POST /api/agent/login),
//   - a device login's agent_key grant (approved at /api/auth/device/approve,
//     the key minted at /api/auth/device/token).
// The rate is spent where the person acts (the mint, the token issue, the
// approval); the live cap is checked where the row is written
// (mintAgentCredential), so it holds for all three.
// A Computer's runner keys (`issued_via = 'computer'`), a cloud runtime's
// (`provision`) and an App Bot's (`app`) are neither limited nor counted here:
// they have their own lifecycle (renewal, revoke when not held).

/** Agent keys and bootstrap tokens one person may issue in a window, across all their agents. */
export const AGENT_CREDENTIAL_MINT_PER_USER = 30;
/** Agent keys and bootstrap tokens all people together may issue for one agent in a window. */
export const AGENT_CREDENTIAL_MINT_PER_AGENT = 20;
/** The rate window: 10 minutes. */
export const AGENT_CREDENTIAL_MINT_WINDOW_SECONDS = 10 * 60;
/**
 * Live (not revoked, not expired) person-issued keys one agent may hold. Each
 * device or profile holds its own key (only a `replacesCredentialId` mint
 * rotates one in place), so an agent used from many places can legitimately
 * hold a few dozen; 50 leaves room for
 * that while bounding the rows each agent's keys add.
 */
export const AGENT_LIVE_HUMAN_CREDENTIALS_MAX = 50;

export const AGENT_CREDENTIAL_MINT_RATE_LIMITED_CODE = "agent_credential_mint_rate_limited";
export const AGENT_CREDENTIAL_LIMIT_REACHED_CODE = "agent_credential_limit_reached";

const counter = createFixedWindowCounter();
let limitsForTests: { perUser: number; perAgent: number } | null = null;

// The pglite harness (Playwright shards share one server and one seeded
// owner) skips the rate unless a test sets it, as app.ts's limiters do.
function rateLimits(): { perUser: number; perAgent: number } | null {
  if (limitsForTests) return limitsForTests;
  if (process.env.DATABASE_URL?.startsWith("pglite")) return null;
  return { perUser: AGENT_CREDENTIAL_MINT_PER_USER, perAgent: AGENT_CREDENTIAL_MINT_PER_AGENT };
}

/**
 * Spend one unit of the person's and the agent's mint budget; past either,
 * throw a 429 refusal (Retry-After: when that window ends). Call after the
 * caller is authorized for the agent and the request is valid, before the hash.
 */
export async function enforceAgentCredentialMintRate(input: { userId: string; agentId: string }, nowMs = Date.now()): Promise<void> {
  const limits = rateLimits();
  if (!limits) return;
  const window = AGENT_CREDENTIAL_MINT_WINDOW_SECONDS;
  const byUser = await counter.admit(`slock:agent-credential-mint:user:${input.userId}`, limits.perUser, window, nowMs);
  const admission = byUser.admitted
    ? await counter.admit(`slock:agent-credential-mint:agent:${input.agentId}`, limits.perAgent, window, nowMs)
    : byUser;
  if (admission.admitted) return;
  throw new RefusalError(429, {
    code: AGENT_CREDENTIAL_MINT_RATE_LIMITED_CODE,
    error: byUser.admitted
      ? "Too many keys were issued for this agent in the last 10 minutes: wait, then issue the key again."
      : "You issued too many agent keys in the last 10 minutes: wait, then issue the key again.",
    retryAfterSeconds: admission.retryAfterSeconds,
  });
}

/**
 * Inside the mint's transaction, after the agent row is locked: refuse (409)
 * when the agent already holds AGENT_LIVE_HUMAN_CREDENTIALS_MAX live
 * person-issued keys. A transaction-scoped advisory lock per agent makes the
 * count and the insert one step: concurrent mints for the agent take turns
 * here (the agent row lock is FOR SHARE, which they all hold together).
 */
export async function assertAgentHumanCredentialCapacity(tx: DatabaseExecutor, agentId: string, now: Date = new Date()): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-human-credential-cap:${agentId}`}, 0))`);
  const [row] = await tx
    .select({ live: count() })
    .from(agentCredentials)
    .where(and(
      eq(agentCredentials.agentId, agentId),
      eq(agentCredentials.issuedVia, "human"),
      isNull(agentCredentials.revokedAt),
      or(isNull(agentCredentials.expiresAt), gt(agentCredentials.expiresAt, now)),
    ));
  if (Number(row?.live ?? 0) < AGENT_LIVE_HUMAN_CREDENTIALS_MAX) return;
  throw new RefusalError(409, {
    code: AGENT_CREDENTIAL_LIMIT_REACHED_CODE,
    error: `This agent already has ${AGENT_LIVE_HUMAN_CREDENTIALS_MAX} active keys, the most it can hold: revoke an unused key in the agent's settings or with DELETE /api/agents/${agentId}/credentials/<credentialId>, then issue the key again.`,
  });
}

/** Tests only: enforce the rate at these limits (also in the pglite harness); null restores the defaults. Forgets the counts. */
export function __setAgentCredentialMintRateLimitsForTests(limits: { perUser: number; perAgent: number } | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Agent credential mint limit hooks are test-only");
  limitsForTests = limits;
  counter.clear();
}
