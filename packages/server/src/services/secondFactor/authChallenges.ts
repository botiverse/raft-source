/**
 * Short-lived, single-use auth challenges (`auth_challenges`): WebAuthn
 * registration and assertion challenges, and the second-factor step of a
 * sign-in. The plaintext is returned once, at creation; only its SHA-256 hash
 * is stored. Consuming is a compare-and-set (unconsumed, unexpired, of the
 * expected kind), so a challenge is used at most once. Every answer to it is
 * claimed first, before it is checked (claimAuthChallengeAttempt), so the
 * attempt limit holds however many answers arrive at once; at the limit the
 * challenge is dead.
 *
 * Second-factor sign-in challenges are served by signIn.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";

import { getDb, type DatabaseExecutor } from "../../db/index";
import { authChallenges, type AuthChallengeKind, type AuthChallengePayload } from "../../db/schema";

/**
 * A challenge's plaintext, as handed to the client and sent back: minted only
 * by createAuthChallenge and parseAuthChallengeToken (this file).
 */
export type AuthChallengeToken = string & { readonly __authChallengeToken: unique symbol };

/** Answers a challenge takes (right or wrong) before it is dead. */
export const AUTH_CHALLENGE_MAX_ATTEMPTS = 5;
const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** A challenge as sent back by a client; null when it cannot be one. */
export function parseAuthChallengeToken(raw: unknown): AuthChallengeToken | null {
  return typeof raw === "string" && TOKEN_RE.test(raw) ? raw as AuthChallengeToken : null;
}

function hashChallenge(token: AuthChallengeToken): string {
  return createHash("sha256").update(token).digest("hex");
}

export type AuthChallengeRow = {
  id: string;
  userId: string | null;
  kind: AuthChallengeKind;
  flow: string | null;
  payload: AuthChallengePayload | null;
  attempts: number;
  expiresAt: Date;
};

const rowColumns = {
  id: authChallenges.id,
  userId: authChallenges.userId,
  kind: authChallenges.kind,
  flow: authChallenges.flow,
  payload: authChallenges.payload,
  attempts: authChallenges.attempts,
  expiresAt: authChallenges.expiresAt,
};

export async function createAuthChallenge(input: {
  kind: AuthChallengeKind;
  userId: string | null;
  flow?: string | null;
  payload?: AuthChallengePayload | null;
  ttlMs: number;
  now?: Date;
}): Promise<{ id: string; challenge: AuthChallengeToken; expiresAt: Date }> {
  const now = input.now ?? currentDate();
  const challenge = randomBytes(TOKEN_BYTES).toString("base64url") as AuthChallengeToken;
  const expiresAt = new Date(now.getTime() + input.ttlMs);
  const [row] = await getDb().insert(authChallenges).values({
    kind: input.kind,
    userId: input.userId,
    flow: input.flow ?? null,
    payload: input.payload ?? null,
    challengeHash: hashChallenge(challenge),
    expiresAt,
    createdAt: now,
  }).returning({ id: authChallenges.id });
  return { id: row!.id, challenge, expiresAt };
}

function liveConditions(token: AuthChallengeToken, kind: AuthChallengeKind, now: Date) {
  return and(
    eq(authChallenges.challengeHash, hashChallenge(token)),
    eq(authChallenges.kind, kind),
    isNull(authChallenges.consumedAt),
    gt(authChallenges.expiresAt, now),
  );
}

/**
 * Read a live (unconsumed, unexpired) challenge of `kind` without taking an
 * attempt: to learn whose it is, and whether its attempts are used up,
 * before claiming anything. Null when there is none.
 */
export async function findLiveAuthChallenge(
  executor: DatabaseExecutor,
  token: AuthChallengeToken,
  kind: AuthChallengeKind,
  now: Date,
): Promise<AuthChallengeRow | null> {
  const [row] = await executor.select(rowColumns).from(authChallenges).where(liveConditions(token, kind, now)).limit(1);
  return row ?? null;
}

/**
 * Take one attempt at a challenge before checking an answer to it: a single
 * conditional increment, so of any number of concurrent calls at most
 * AUTH_CHALLENGE_MAX_ATTEMPTS get the row back. Only a caller that gets the
 * row may verify the answer (against the row's bound context); null (used,
 * expired, out of attempts, another kind) means refuse without verifying. A
 * right answer does not refund the attempt. Commit the claim whatever the
 * answer turns out to be (claim on its own, before the transaction that uses
 * the challenge): a claim rolled back with a wrong answer does not count.
 */
export async function claimAuthChallengeAttempt(
  executor: DatabaseExecutor,
  token: AuthChallengeToken,
  kind: AuthChallengeKind,
  now: Date,
): Promise<AuthChallengeRow | null> {
  const [row] = await executor
    .update(authChallenges)
    .set({ attempts: sql`${authChallenges.attempts} + 1` })
    .where(and(liveConditions(token, kind, now), lt(authChallenges.attempts, AUTH_CHALLENGE_MAX_ATTEMPTS)))
    .returning(rowColumns);
  return row ?? null;
}

/**
 * Take the only answer a challenge of `kind` and `flow` will ever get: the
 * one call that finds it live and unanswered takes every attempt at once and
 * gets its row; any other gets null. For a challenge whose answer is not
 * guessable (a passkey assertion) and that must be single use whatever the
 * outcome, while being consumed (consumeAuthChallenge) only in the
 * transaction that acts on a right answer. Commit the claim on its own,
 * before checking the answer.
 */
export async function claimOnlyAuthChallengeAnswer(
  executor: DatabaseExecutor,
  token: AuthChallengeToken,
  kind: AuthChallengeKind,
  flow: string,
  now: Date,
): Promise<AuthChallengeRow | null> {
  const [row] = await executor
    .update(authChallenges)
    .set({ attempts: AUTH_CHALLENGE_MAX_ATTEMPTS })
    .where(and(liveConditions(token, kind, now), eq(authChallenges.flow, flow), eq(authChallenges.attempts, 0)))
    .returning(rowColumns);
  return row ?? null;
}

/**
 * Use a challenge: the one call that finds it unconsumed and unexpired marks
 * it consumed and gets its row; any other (used, expired, another kind, a
 * lost race) gets null. A challenge answered with a guessable code (the
 * second-factor step) is claimed first (claimAuthChallengeAttempt) and
 * consumed only after a right answer; the attempt that answered it may be the
 * last one, so consuming does not look at the attempt count.
 */
export async function consumeAuthChallenge(
  executor: DatabaseExecutor,
  token: AuthChallengeToken,
  kind: AuthChallengeKind,
  now: Date,
): Promise<AuthChallengeRow | null> {
  const [row] = await executor
    .update(authChallenges)
    .set({ consumedAt: now })
    .where(liveConditions(token, kind, now))
    .returning(rowColumns);
  return row ?? null;
}
