/**
 * SSO sign-ins in flight (rfcs/083-server-sso.md §5.1, §5.2): the state of one
 * sign-in leg, from its start to the IdP callback to the client's completion.
 * `state` and the completion code are kept as hashes; both are single use.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt, lte, ne, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { ssoAuthTransactions } from "../../db/schema";
import { newOidcChecks } from "./ssoOidc";
import type { SsoProfile } from "./ssoSignIn";

export type SsoAuthTransaction = typeof ssoAuthTransactions.$inferSelect;

export const SSO_TRANSACTION_TTL_MS = 10 * 60 * 1000;
/** Completion attempts per code (asking for legal acceptance, then completing, leaves room for retries). */
const MAX_COMPLETION_ATTEMPTS = 5;

function hash(value: string): string {
  return createHash("sha256").update(`raft-sso:${value}`).digest("hex");
}

export async function createSsoTransaction(input: {
  connectionId: string;
  kind: SsoAuthTransaction["kind"];
  usesDraft?: boolean;
  returnTo?: string | null;
  appReturnUri?: string | null;
  appCodeChallenge?: string | null;
  testUserId?: string | null;
}, now: Date = currentDate()) {
  const checks = await newOidcChecks();
  const [row] = await getDb().insert(ssoAuthTransactions).values({
    connectionId: input.connectionId,
    kind: input.kind,
    usesDraft: input.usesDraft ?? false,
    stateHash: hash(checks.state),
    nonce: checks.nonce,
    codeVerifier: checks.codeVerifier,
    returnTo: input.returnTo ?? null,
    appReturnUri: input.appReturnUri ?? null,
    appCodeChallenge: input.appCodeChallenge ?? null,
    testUserId: input.testUserId ?? null,
    expiresAt: new Date(now.getTime() + SSO_TRANSACTION_TTL_MS),
  }).returning();
  return { row: row!, state: checks.state, codeChallenge: checks.codeChallenge };
}

/**
 * Claims the leg a callback's `state` belongs to: only a leg still waiting
 * for its IdP answer and not expired, and only once (a replayed callback
 * finds nothing). The IdP is then asked outside any transaction.
 */
export async function claimSsoTransactionForCallback(state: string, now: Date = currentDate()) {
  const [row] = await getDb().update(ssoAuthTransactions).set({ status: "exchanging" })
    .where(and(eq(ssoAuthTransactions.stateHash, hash(state)), eq(ssoAuthTransactions.status, "started"), gt(ssoAuthTransactions.expiresAt, now)))
    .returning();
  return row ?? null;
}

/** Whether `state` names a leg Raft started (in any status, expired or not); reads only. */
export async function ssoTransactionExists(state: string): Promise<boolean> {
  const [row] = await getDb().select({ id: ssoAuthTransactions.id }).from(ssoAuthTransactions)
    .where(eq(ssoAuthTransactions.stateHash, hash(state))).limit(1);
  return !!row;
}

/** Records the IdP-verified profile and returns the one-time completion code for the client. */
export async function storeSsoProfile(id: string, profile: SsoProfile, executor: DatabaseExecutor = getDb()): Promise<string> {
  const code = randomBytes(32).toString("base64url");
  await executor.update(ssoAuthTransactions).set({
    status: "profile_ready",
    profile: { subject: profile.subject, email: profile.email, emailVerified: profile.emailVerified, displayName: profile.displayName, linkByEmail: profile.linkByEmail },
    completionCodeHash: hash(code),
    // The leg's secrets are spent.
    codeVerifier: "",
    nonce: "",
  }).where(eq(ssoAuthTransactions.id, id));
  return code;
}

function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export type SsoCompletion =
  | { ok: true; row: SsoAuthTransaction & { profile: NonNullable<SsoAuthTransaction["profile"]> } }
  | { ok: false; reason: "invalid_code" | "verifier_mismatch" | "browser_mismatch" };

/**
 * Claims the completion code: one atomic UPDATE from profile_ready to
 * completing, so two requests racing with the same code cannot both complete
 * (the loser finds nothing). An app's leg also needs the PKCE verifier its
 * start was bound to; a web leg, the cookie its callback left in that browser
 * (`browserBound`, services/completionBrowserBinding.ts), so a code opened in
 * another browser signs no one in there (login CSRF). Only a sign-in refused for missing legal acceptance
 * hands the code back (releaseSsoCompletion), for the same browser to retry.
 */
export async function takeSsoCompletion(
  code: string,
  proof: { codeVerifier: string | null; browserBound: boolean },
  now: Date = currentDate(),
): Promise<SsoCompletion> {
  const [row] = await getDb().update(ssoAuthTransactions)
    .set({ status: "completing", attempts: sql`${ssoAuthTransactions.attempts} + 1` })
    .where(and(
      eq(ssoAuthTransactions.completionCodeHash, hash(code)),
      eq(ssoAuthTransactions.status, "profile_ready"),
      gt(ssoAuthTransactions.expiresAt, now),
      lt(ssoAuthTransactions.attempts, MAX_COMPLETION_ATTEMPTS),
      ne(ssoAuthTransactions.kind, "test"),
    ))
    .returning();
  if (!row || !row.profile) return { ok: false, reason: "invalid_code" };
  if (row.appCodeChallenge && (!proof.codeVerifier || pkceS256(proof.codeVerifier) !== row.appCodeChallenge)) {
    // A wrong verifier spends the code.
    await finishSsoTransaction(row.id);
    return { ok: false, reason: "verifier_mismatch" };
  }
  if (row.kind === "web" && !proof.browserBound) {
    // So does another browser.
    await finishSsoTransaction(row.id);
    return { ok: false, reason: "browser_mismatch" };
  }
  return { ok: true, row: { ...row, profile: row.profile } };
}

/** Hands a claimed code back (only after `legal_acceptance_required`). */
export async function releaseSsoCompletion(id: string): Promise<void> {
  await getDb().update(ssoAuthTransactions).set({ status: "profile_ready" })
    .where(and(eq(ssoAuthTransactions.id, id), eq(ssoAuthTransactions.status, "completing")));
}

/** Ends a leg: its code never works again. */
export async function finishSsoTransaction(id: string, executor: DatabaseExecutor = getDb()): Promise<void> {
  await executor.delete(ssoAuthTransactions).where(eq(ssoAuthTransactions.id, id));
}

/** A SAML leg's AuthnRequest ID, which its response must answer (taken once by ssoSaml's cache). */
export async function setSsoTransactionSamlRequest(id: string, requestId: string): Promise<void> {
  await getDb().update(ssoAuthTransactions).set({ samlRequestId: requestId }).where(eq(ssoAuthTransactions.id, id));
}

/** Hourly maintenance: legs past their expiry. */
export async function sweepExpiredSsoTransactions(now: Date = currentDate()): Promise<number> {
  const removed = await getDb().delete(ssoAuthTransactions).where(lte(ssoAuthTransactions.expiresAt, now)).returning({ id: ssoAuthTransactions.id });
  return removed.length;
}
