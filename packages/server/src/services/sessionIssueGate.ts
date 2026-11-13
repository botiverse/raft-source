/**
 * The one place that decides whether a sign-in may become a user session.
 * sessionService.createSession takes only a SessionIssueProof, and the proof
 * is minted only here, one gate per sign-in flow: a new way of issuing a
 * session has to add one (sessionIssueGate.contract.test.ts lists every
 * caller).
 *
 * Two-step verification (design v8 §2, §3) is enforced here for every person
 * whose `users.second_factor_required_at` is set. Everyone else gets
 * `not_required` from every gate (design §0). The `auth_second_factor_v1` flag
 * that once also had to be on is retired (#raft-architecture:#32): a leftover
 * flag row, even off, changes nothing.
 *
 *   - First-factor gates (password, web social, mobile social) return either
 *     a proof or "second factor required" (no proof: the caller starts the
 *     challenge in services/secondFactor/signIn.ts instead of a session).
 *   - proofForSecondFactorVerified mints the proof for the second step, from
 *     the challenge it consumed.
 *   - proofForPasskeyLogin (design §2, D3): a passkey assertion with user
 *     verification is both factors at once, so it never asks for a second
 *     step; it admits only a person passkey sign-in is open to (not retired),
 *     from the passkey_login challenge
 *     it consumed.
 *   - Signup, app login and device login always admit: a new account has
 *     nothing enrolled, and the two handoffs are vouched for by the approving
 *     session, which approverSecondFactorCheck gates at approval.
 *   - proofForAppLogin also carries the approver's second factor over: when
 *     the approving family is the person's own live `full` sign-in that passed
 *     it, the app's new session is verified as of the approver's time (never
 *     later), so the step-up window is not extended. Device login never does
 *     (see proofForDeviceLogin).
 */
import { and, eq, isNull } from "drizzle-orm";

import { getDb, type DatabaseExecutor } from "../db/index";
import { sessionFamilies, users, type SecondFactorMethod } from "../db/schema";
import type { AuthChallengeRow } from "./secondFactor/authChallenges";

export type SessionIssueFlow =
  | "password_login"
  | "signup"
  | "social_login"
  | "mobile_social_login"
  | "app_login"
  | "device_login"
  | "passkey_login"
  | "sso_login";

/** The flows whose first factor alone may not be enough. */
export type FirstFactorFlow = "password_login" | "social_login" | "mobile_social_login" | "sso_login";

const FIRST_FACTOR_FLOWS: ReadonlySet<string> = new Set<FirstFactorFlow>(["password_login", "social_login", "mobile_social_login", "sso_login"]);

export function isFirstFactorFlow(value: string | null): value is FirstFactorFlow {
  return value !== null && FIRST_FACTOR_FLOWS.has(value);
}

/** What the gate found about the second factor. */
export type SessionIssueSecondFactor =
  | { readonly secondFactor: "not_required" }
  | {
      readonly secondFactor: "verified";
      readonly method: SecondFactorMethod;
      /** The second_factor_login challenge this proof consumed. */
      readonly challengeId: string;
    };

declare const sessionIssueProofBrand: unique symbol;

/** Minted only by the gates below; not persisted, but a verified one marks the new family. */
export type SessionIssueProof = {
  readonly [sessionIssueProofBrand]: true;
  readonly userId: string;
} & (
  | ({ readonly flow: Exclude<FirstFactorFlow, "sso_login"> } & SessionIssueSecondFactor)
  | ({
      readonly flow: "sso_login";
      /** The Server SSO connection whose IdP answered (rfcs/083-server-sso.md §5.4); written on the new family. */
      readonly ssoConnectionId: string;
    } & SessionIssueSecondFactor)
  | { readonly flow: "signup"; readonly secondFactor: "not_required" }
  | {
      readonly flow: "passkey_login";
      readonly secondFactor: "verified";
      readonly method: "passkey";
      /** The passkey_login assertion challenge this proof consumed. */
      readonly challengeId: string;
      readonly passkeyId: string;
    }
  | ({
      readonly flow: "app_login";
      /**
       * The family of the signed-in session that approved this login on
       * another screen (app_login_requests.approver_family_id): its second
       * factor is what vouches for this one.
       */
      readonly approverFamilyId: string | null;
    } & (
      | { readonly secondFactor: "not_required" }
      | {
          /** Inherited from the approver's family (proofForAppLogin). */
          readonly secondFactor: "verified";
          readonly method: SecondFactorMethod;
          /** The approver family's `second_factor_verified_at`: the new family's, unchanged. */
          readonly verifiedAt: Date;
        }
    ))
  | {
      readonly flow: "device_login";
      readonly secondFactor: "not_required";
      /** The family of the signed-in session that approved this login, when recorded. */
      readonly approverFamilyId: string | null;
    }
);

/** A first-factor gate's answer: a proof, or no session until a second step. */
export type FirstFactorGateResult =
  | { readonly secondFactorRequired: false; readonly proof: SessionIssueProof }
  | { readonly secondFactorRequired: true; readonly userId: string; readonly flow: FirstFactorFlow };

/**
 * Whether sign-in asks this person for a second step. Reads the person's row
 * FOR UPDATE through `executor` (a no-op lock outside a transaction): inside
 * the transaction that issues the session, turning two-step verification on
 * (which takes the same lock) cannot slip between this answer and the
 * session.
 */
export async function isSecondFactorEnforced(userId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [user] = await executor.select({ requiredAt: users.secondFactorRequiredAt })
    .from(users).where(eq(users.id, userId)).limit(1).for("update");
  return Boolean(user?.requiredAt);
}

async function firstFactorGate(flow: FirstFactorFlow, userId: string, executor?: DatabaseExecutor): Promise<FirstFactorGateResult> {
  if (await isSecondFactorEnforced(userId, executor)) return { secondFactorRequired: true, userId, flow };
  return { secondFactorRequired: false, proof: { flow, userId, secondFactor: "not_required" } as SessionIssueProof };
}

/** Pass the transaction that will issue the session (see isSecondFactorEnforced). */
export async function proofForPasswordLogin(userId: string, executor?: DatabaseExecutor): Promise<FirstFactorGateResult> {
  return firstFactorGate("password_login", userId, executor);
}

/** Web OAuth sign-in, including the account it creates on first sign-in. */
export async function proofForSocialLogin(userId: string, executor?: DatabaseExecutor): Promise<FirstFactorGateResult> {
  return firstFactorGate("social_login", userId, executor);
}

/** The mobile OAuth handoff, including the account it creates on first sign-in. */
export async function proofForMobileSocialLogin(userId: string, executor?: DatabaseExecutor): Promise<FirstFactorGateResult> {
  return firstFactorGate("mobile_social_login", userId, executor);
}

/**
 * SSO sign-in (rfcs/083-server-sso.md §5.4): the IdP of the Server SSO
 * connection `ssoConnectionId` vouched for this person (services/sso). A
 * first factor like any other: a person who turned two-step verification on
 * still takes the second step, and the connection id travels on the
 * challenge so the proof rebuilt after it keeps it.
 */
export async function proofForSsoLogin(userId: string, ssoConnectionId: string, executor?: DatabaseExecutor): Promise<FirstFactorGateResult> {
  if (await isSecondFactorEnforced(userId, executor)) return { secondFactorRequired: true, userId, flow: "sso_login" };
  return {
    secondFactorRequired: false,
    proof: { flow: "sso_login", userId, ssoConnectionId, secondFactor: "not_required" } as SessionIssueProof,
  };
}

/** The SSO connection a second-factor sign-in challenge of flow sso_login carries. */
function ssoConnectionOf(consumed: AuthChallengeRow): { ssoConnectionId: string } | Record<string, never> {
  if (consumed.flow !== "sso_login") return {};
  const id = consumed.payload?.ssoConnectionId;
  if (typeof id !== "string" || !id) throw new Error("second-factor sso_login challenge without its SSO connection");
  return { ssoConnectionId: id };
}

/**
 * The second step of a first-factor sign-in passed: `consumed` is the
 * second_factor_login challenge the caller just consumed (in the transaction
 * that issues the session), `method` what answered it.
 */
export function proofForSecondFactorVerified(consumed: AuthChallengeRow, method: SecondFactorMethod): SessionIssueProof {
  if (consumed.kind !== "second_factor_login" || !consumed.userId || !isFirstFactorFlow(consumed.flow)) {
    throw new Error("proofForSecondFactorVerified: not a second-factor sign-in challenge");
  }
  return {
    flow: consumed.flow,
    userId: consumed.userId,
    ...ssoConnectionOf(consumed),
    secondFactor: "verified",
    method,
    challengeId: consumed.id,
  } as SessionIssueProof;
}

/**
 * The second step of a first-factor sign-in was answered by finishing an
 * email recovery of two-step verification (services/secondFactor/recovery.ts):
 * `consumed` is the second_factor_login challenge consumed in the transaction
 * that also removed every factor and cleared `second_factor_required_at`, so
 * from then on the person has no second factor to verify (`not_required`).
 */
export function proofForSecondFactorRecovered(consumed: AuthChallengeRow): SessionIssueProof {
  if (consumed.kind !== "second_factor_login" || !consumed.userId || !isFirstFactorFlow(consumed.flow)) {
    throw new Error("proofForSecondFactorRecovered: not a second-factor sign-in challenge");
  }
  return { flow: consumed.flow, userId: consumed.userId, ...ssoConnectionOf(consumed), secondFactor: "not_required" } as SessionIssueProof;
}

/** The challenge flow passkey sign-in options are created with (`auth_challenges.flow`). */
export const PASSKEY_LOGIN_FLOW = "passkey_login" satisfies SessionIssueFlow;

/**
 * Whether passkey sign-in is open to this person: the account exists and is
 * not retired. Reads the person's row FOR UPDATE through `executor` (see
 * isSecondFactorEnforced).
 */
export async function isPasskeySignInOpen(userId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  const [user] = await executor.select({ retiredAt: users.retiredAt })
    .from(users).where(eq(users.id, userId)).limit(1).for("update");
  return Boolean(user && !user.retiredAt);
}

/**
 * Passkey sign-in (design §2, D3): `consumed` is the passkey_login assertion
 * challenge the caller just consumed, in the transaction that issues the
 * session (pass it as `executor`), and `passkey` the person's passkey whose
 * assertion (user verification required) answered it. Both factors at once:
 * a verified proof for anyone passkey sign-in is open to
 * (isPasskeySignInOpen), whether or not they turned two-step verification on;
 * null for anyone else.
 */
export async function proofForPasskeyLogin(
  consumed: AuthChallengeRow,
  passkey: { userId: string; passkeyId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<SessionIssueProof | null> {
  if (consumed.kind !== "webauthn_assertion" || consumed.flow !== PASSKEY_LOGIN_FLOW || consumed.userId !== null) {
    throw new Error("proofForPasskeyLogin: not a passkey sign-in challenge");
  }
  if (!(await isPasskeySignInOpen(passkey.userId, executor))) return null;
  return {
    flow: PASSKEY_LOGIN_FLOW,
    userId: passkey.userId,
    secondFactor: "verified",
    method: "passkey",
    challengeId: consumed.id,
    passkeyId: passkey.passkeyId,
  } as SessionIssueProof;
}

/** A new account: nothing is enrolled yet. */
export async function proofForSignup(userId: string): Promise<SessionIssueProof> {
  return { flow: "signup", userId, secondFactor: "not_required" } as SessionIssueProof;
}

/**
 * The app login handoff's exchange (routes/appLogin.ts POST /complete):
 * `approverFamilyId` is the family that approved the request. The new session
 * inherits the approver's second factor only when that family is this
 * person's own `full` sign-in, neither revoked nor retired, that passed it;
 * then the proof carries the approver's method and verification time (not
 * now: a step-up window measured from it is not extended by the handoff).
 * Anything else is `not_required`, as before.
 *
 * Pass the transaction that issues the session as `executor`: the person's
 * `users` row is taken FOR UPDATE first (every family revoker takes it first,
 * and createSession takes it again), then the approver family is read FOR
 * SHARE, so a revoke of the approver cannot slip between this read and the
 * new session.
 */
export async function proofForAppLogin(
  userId: string,
  approverFamilyId: string | null,
  executor: DatabaseExecutor = getDb(),
): Promise<SessionIssueProof> {
  const notRequired = { flow: "app_login", userId, approverFamilyId, secondFactor: "not_required" } as SessionIssueProof;
  if (!approverFamilyId) return notRequired;
  await executor.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1).for("update");
  const [approver] = await executor.select({
    verifiedAt: sessionFamilies.secondFactorVerifiedAt,
    method: sessionFamilies.secondFactorMethod,
  }).from(sessionFamilies)
    .where(and(
      eq(sessionFamilies.id, approverFamilyId),
      eq(sessionFamilies.userId, userId),
      eq(sessionFamilies.scope, "full"),
      isNull(sessionFamilies.revokedAt),
      isNull(sessionFamilies.retiredAt),
    ))
    .limit(1)
    .for("share");
  if (!approver?.verifiedAt || !approver.method) return notRequired;
  return {
    flow: "app_login",
    userId,
    approverFamilyId,
    secondFactor: "verified",
    method: approver.method,
    verifiedAt: approver.verifiedAt,
  } as SessionIssueProof;
}

/**
 * The device login's poll (routes/deviceAuth.ts POST /token). Never inherits
 * the approver's second factor, unlike proofForAppLogin: the session it
 * issues is a long-lived `device` session (Raft Computer, the raft CLI) that
 * refreshes for days, and approverSecondFactorCheck at approval has no time
 * limit, so a verification inherited here would vouch for far longer than
 * the step-up it came from. What a device session may do is decided by its
 * scope (middleware/auth.ts DEVICE_SESSION_ROUTES), not by a second factor.
 */
export async function proofForDeviceLogin(userId: string, approverFamilyId: string | null): Promise<SessionIssueProof> {
  return { flow: "device_login", userId, approverFamilyId, secondFactor: "not_required" } as SessionIssueProof;
}

/**
 * The session lookup both second-factor gates share: approving a login
 * elsewhere (approverSecondFactorCheck) and a sensitive action
 * (stepUpGate.recentSecondFactorCheck). They differ only in what they accept:
 * any pass, or a pass within the step-up window.
 *
 * "not_enforced" for anyone without two-step verification enforced; they are
 * never refused. Otherwise when `familyId`, the person's own live `full`
 * sign-in, last passed its second factor, or null: never passed, no family,
 * someone else's, a device login's, revoked or retired.
 */
export async function enforcedSecondFactorVerifiedAt(
  userId: string,
  familyId: string | null,
): Promise<"not_enforced" | Date | null> {
  if (!(await isSecondFactorEnforced(userId))) return "not_enforced";
  if (!familyId) return null;
  const [family] = await getDb().select({ verifiedAt: sessionFamilies.secondFactorVerifiedAt })
    .from(sessionFamilies)
    .where(and(
      eq(sessionFamilies.id, familyId),
      eq(sessionFamilies.userId, userId),
      eq(sessionFamilies.scope, "full"),
      isNull(sessionFamilies.revokedAt),
      isNull(sessionFamilies.retiredAt),
    ));
  return family?.verifiedAt ?? null;
}

/**
 * Approving a device or app login on another screen (design §3 step 4): for
 * a person with two-step verification enforced, only from a `full` family
 * that passed its second factor (at sign-in, or by step-up on this session).
 * Anyone else approves exactly as before. A device-scope family never
 * reaches here (requireAuth refuses it on both approve routes).
 */
export async function approverSecondFactorCheck(
  userId: string,
  familyId: string | null,
): Promise<"ok" | "step_up_required"> {
  const verifiedAt = await enforcedSecondFactorVerifiedAt(userId, familyId);
  return verifiedAt === "not_enforced" || verifiedAt ? "ok" : "step_up_required";
}
