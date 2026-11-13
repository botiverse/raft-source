import argon2 from "argon2";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index";
import { users, type SecondFactorMethod } from "../../db/schema";
import { signAccessToken } from "../../middleware/auth";
import { consumeAuthChallenge, createAuthChallenge } from "../../services/secondFactor/authChallenges";
import { proofForPasswordLogin, proofForSecondFactorVerified } from "../../services/sessionIssueGate";
import { createSession } from "../../services/sessionService";

const passwordHashes = new Map<string, Promise<string>>();

/** Reuse immutable fixture hashes; password/authentication tests use argon2 directly. */
export function fixturePasswordHash(password: string): Promise<string> {
  let hash = passwordHashes.get(password);
  if (!hash) {
    hash = argon2.hash(password);
    passwordHashes.set(password, hash);
    void hash.catch(() => passwordHashes.delete(password));
  }
  return hash;
}

/**
 * A real web sign-in for an existing human: a `full` session family through
 * the password login's gate (as if they had just signed in; refused for a
 * person with two-step verification enforced), and an access token in it.
 * Every access token needs a live family (middleware/auth.ts).
 */
export async function signInForTest(userId: string) {
  const gate = await proofForPasswordLogin(userId);
  if (gate.secondFactorRequired) throw new Error(`signInForTest: ${userId} has two-step verification on; sign in through the second step`);
  process.env.JWT_SECRET ||= "test-jwt-secret";
  const session = await createSession(gate.proof);
  return { ...session, token: signAccessToken(userId, session.familyId) };
}

/**
 * A real web sign-in for a person with two-step verification on, as the
 * password login and its second step leave it: the password gate must ask
 * for the second step (refused otherwise: use signInForTest), then a
 * second_factor_login challenge is created and consumed as a right answer
 * would consume it, and the session comes from proofForSecondFactorVerified
 * (verified now, by `method`). Checking the answer itself is the second-step
 * route's own tests' job; this only stands in for "they answered it".
 */
export async function signInThroughSecondStepForTest(userId: string, method: SecondFactorMethod = "totp") {
  const gate = await proofForPasswordLogin(userId);
  if (!gate.secondFactorRequired) throw new Error(`signInThroughSecondStepForTest: ${userId} has two-step verification off; use signInForTest`);
  const now = new Date();
  const { challenge } = await createAuthChallenge({ kind: "second_factor_login", userId, flow: "password_login", ttlMs: 5 * 60_000, now });
  const consumed = await consumeAuthChallenge(getDb(), challenge, "second_factor_login", now);
  if (!consumed) throw new Error("signInThroughSecondStepForTest: the challenge was not consumed");
  process.env.JWT_SECRET ||= "test-jwt-secret";
  const session = await createSession(proofForSecondFactorVerified(consumed, method));
  return { ...session, token: signAccessToken(userId, session.familyId) };
}

/** signInForTest's access token alone. */
export async function accessTokenForTest(userId: string): Promise<string> {
  return (await signInForTest(userId)).token;
}

/** A real token for an existing human; every request still passes production auth. */
export async function tokenForHuman(email: string): Promise<string> {
  const [human] = await getDb().select({ id: users.id }).from(users).where(eq(users.email, email));
  if (!human) throw new Error(`Cannot issue fixture credentials for missing human: ${email}`);
  return accessTokenForTest(human.id);
}
