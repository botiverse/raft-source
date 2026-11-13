/**
 * Turning an identity provider's answer into a Raft session
 * (rfcs/083-server-sso.md §5.3, §5.4, §6.1). The protocol layer (OIDC, SAML)
 * has already verified the answer and hands over an SsoProfile; this decides
 * who the person is, links or creates the account, and issues the session
 * through the sso_login gate. Nothing here talks to an IdP.
 *
 * Who the person is (§5.3):
 * - an identity (connection, subject) already linked: that account;
 * - else the asserted email must be verified by the IdP and on a domain the
 *   connection's Server has verified now; then the account with that email
 *   is linked if it verified its email, or a new account is created. An
 *   account that never verified its email is refused
 *   (`account_email_unverified`): whoever registered it may not be the person
 *   the IdP vouches for, and the one way to claim it is a password reset by
 *   email, which signs everything out and marks the email verified
 *   (review in #raft-architecture:102593c2: one claim path, not two cleanup
 *   lists that drift apart).
 * - How far the email is trusted is the protocol's `linkByEmail`: OIDC links
 *   an existing account and moves a link to a new subject (the IdP
 *   re-provisioned the person); SAML links an existing account only when the
 *   owner attested that only IdP administrators can change the email
 *   (`email_link_not_attested` otherwise), and never moves a link
 *   (`identity_subject_changed`): a SAML email attribute is often
 *   self-editable, and moving a link by it hands one person's account to
 *   another (review in #raft-architecture:102593c2).
 */
import { and, eq, isNotNull } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { serverSsoConnections, serverSsoDomains, ssoIdentities, users } from "../../db/schema";
import { findPendingAccountDeletion } from "../accountDeletion/requests";
import { evaluateFeatureFlag, SERVER_SSO_FEATURE_FLAG_KEY } from "../featureFlagService";
import { normalizeEmail } from "../emailNormalization";
import { sendSsoIdentityLinkedEmail } from "../emailService";
import { admitBySso, type SsoAdmission } from "../inviteService";
import { recordIntegrationAuditEvent, recordIntegrationAuditEventBestEffort } from "../integrationAuditService";
import type { LegalAcceptanceInput, LegalAcceptanceMetadata } from "../legalAcceptanceService";
import { assertRegistrationEnabled } from "../registrationPolicy";
import { proofForSsoLogin, type SessionIssueProof } from "../sessionIssueGate";
import { createSession } from "../sessionService";
import { createSsoUserInTransaction } from "../userService";
import { normalizeSsoDomain } from "./ssoDomains";
import { assertEnterpriseSsoAllowed } from "./ssoEdition";

/** What the protocol layer verified: the IdP's immutable subject and the email it asserts. */
export type SsoProfile = {
  readonly subject: string;
  readonly email: string;
  /** OIDC `email_verified`; a SAML assertion from the IdP counts as verified. */
  readonly emailVerified: boolean;
  readonly displayName: string | null;
  /**
   * What an email match may do when no link for this subject exists:
   * "link_and_move" links an existing account and moves this connection's
   * link from an old subject; "link" only links an account not yet linked;
   * "none" links nothing (a new account may still be created).
   */
  readonly linkByEmail: "link_and_move" | "link" | "none";
};

export type SsoSignInRefusal =
  | "connection_inactive"
  | "email_unverified"
  | "email_not_canonical"
  | "domain_not_verified"
  | "account_email_unverified"
  | "email_link_not_attested"
  | "identity_subject_changed"
  | "account_unavailable"
  | "registration_closed"
  | "legal_acceptance_required";

export type SsoSession = Awaited<ReturnType<typeof createSession>>;

export type SsoSignInResult =
  | { kind: "refused"; reason: SsoSignInRefusal }
  /** The person turned two-step verification on: the caller starts the second step (flow sso_login). */
  | { kind: "second_factor_required"; userId: string; connectionId: string }
  | { kind: "signed_in"; userId: string; connectionId: string; session: SsoSession; createdAccount: boolean; linked: boolean };

class RefusedError extends Error {
  constructor(readonly reason: SsoSignInRefusal) {
    super(reason);
  }
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  return at > 0 ? normalizeSsoDomain(email.slice(at + 1)) : null;
}

/** Whether the Server has `domain` verified right now (a lapsed domain is not). */
async function isDomainVerifiedFor(tx: DatabaseExecutor, serverId: string, domain: string): Promise<boolean> {
  const [row] = await tx.select({ id: serverSsoDomains.id }).from(serverSsoDomains)
    .where(and(eq(serverSsoDomains.serverId, serverId), eq(serverSsoDomains.domain, domain), isNotNull(serverSsoDomains.verifiedAt)))
    .limit(1);
  return !!row;
}

/** The account may sign in at all: not retired, no deletion pending (RFC 083 §5.3). Locks the users row first. */
async function lockSignInableUser(tx: DatabaseExecutor, userId: string): Promise<void> {
  const [user] = await tx.select({ retiredAt: users.retiredAt }).from(users).where(eq(users.id, userId)).for("update");
  if (!user || user.retiredAt) throw new RefusedError("account_unavailable");
  if (await findPendingAccountDeletion(tx, userId)) throw new RefusedError("account_unavailable");
}

/** `server_sso_v1` for the connection's Server (RFC 083 §8), read again at every sign-in step: turning it off stops legs in flight. */
async function isSsoFlagOn(tx: DatabaseExecutor, serverId: string): Promise<boolean> {
  try {
    return (await evaluateFeatureFlag({ key: SERVER_SSO_FEATURE_FLAG_KEY, serverId }, tx)).enabled;
  } catch {
    return false;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "23505"
    || (err as { cause?: { code?: unknown } } | null)?.cause?.code === "23505";
}

type Resolved = {
  userId: string;
  serverId: string;
  connectionName: string;
  createdAccount: boolean;
  /** Linked an existing account to this connection (it gets the "linked" email). */
  linkedExisting: boolean;
  linked: boolean;
  second: { kind: "second_factor_required" } | { kind: "signed_in"; session: SsoSession };
};

async function signInOnce(input: {
  connectionId: string;
  profile: SsoProfile;
  legalAcceptance?: LegalAcceptanceInput | null;
  legalMetadata?: LegalAcceptanceMetadata;
}, now: Date, serverIdOut: { value: string | null }): Promise<Resolved> {
  return getDb().transaction(async (tx) => {
    const [connection] = await tx.select().from(serverSsoConnections)
      .where(eq(serverSsoConnections.id, input.connectionId)).for("share");
    if (!connection || connection.status !== "active") throw new RefusedError("connection_inactive");
    serverIdOut.value = connection.serverId;
    if (!(await isSsoFlagOn(tx, connection.serverId))) throw new RefusedError("connection_inactive");

    let userId: string;
    let createdAccount = false;
    let linkedExisting = false;
    let linked = false;
    const [identity] = await tx.select({ id: ssoIdentities.id, userId: ssoIdentities.userId }).from(ssoIdentities)
      .where(and(eq(ssoIdentities.connectionId, connection.id), eq(ssoIdentities.subject, input.profile.subject)));
    if (identity) {
      userId = identity.userId;
      await lockSignInableUser(tx, userId);
    } else {
      if (!input.profile.emailVerified) throw new RefusedError("email_unverified");
      const email = normalizeEmail(input.profile.email);
      const domain = emailDomain(email);
      // The account is looked up and created by this exact email, so its domain must already be the
      // normalized one: `alice@ａｃｍｅ.com` would pass the domain check yet create a look-alike account.
      if (domain && email.slice(email.lastIndexOf("@") + 1) !== domain) throw new RefusedError("email_not_canonical");
      if (!domain || !(await isDomainVerifiedFor(tx, connection.serverId, domain))) throw new RefusedError("domain_not_verified");
      const [existing] = await tx.select({ id: users.id, emailVerified: users.emailVerified })
        .from(users).where(eq(users.email, email));
      if (existing) {
        if (!existing.emailVerified) throw new RefusedError("account_email_unverified");
        if (input.profile.linkByEmail === "none") throw new RefusedError("email_link_not_attested");
        userId = existing.id;
        await lockSignInableUser(tx, userId);
        linkedExisting = true;
      } else {
        if (!input.legalAcceptance) throw new RefusedError("legal_acceptance_required");
        try {
          assertRegistrationEnabled();
        } catch {
          throw new RefusedError("registration_closed");
        }
        userId = (await createSsoUserInTransaction(tx, {
          email,
          displayName: input.profile.displayName,
          legalAcceptance: input.legalAcceptance,
          legalMetadata: input.legalMetadata,
          joiningServerId: connection.serverId,
        })).id;
        createdAccount = true;
      }
      // The IdP re-provisioned the person (a new subject, the same verified
      // email on a verified domain): the link moves to the new subject.
      const [previous] = await tx.select({ id: ssoIdentities.id }).from(ssoIdentities)
        .where(and(eq(ssoIdentities.connectionId, connection.id), eq(ssoIdentities.userId, userId)));
      if (previous && input.profile.linkByEmail !== "link_and_move") throw new RefusedError("identity_subject_changed");
      if (previous) {
        await tx.update(ssoIdentities).set({ subject: input.profile.subject, emailAtLink: email }).where(eq(ssoIdentities.id, previous.id));
      } else {
        await tx.insert(ssoIdentities).values({ connectionId: connection.id, subject: input.profile.subject, userId, emailAtLink: email });
      }
      linked = true;
      await recordIntegrationAuditEvent({
        serverId: connection.serverId,
        eventType: "sso.identity_linked",
        outcome: "success",
        source: "web",
        actor: { type: "human", id: userId },
        target: { type: "sso_connection", id: connection.id },
        metadata: { connectionId: connection.id, relinked: !!previous },
      }, tx);
    }
    await tx.update(ssoIdentities).set({ lastLoginAt: now })
      .where(and(eq(ssoIdentities.connectionId, connection.id), eq(ssoIdentities.userId, userId)));

    const base = { userId, serverId: connection.serverId, connectionName: connection.displayName, createdAccount, linkedExisting, linked };
    const gate = await proofForSsoLogin(userId, connection.id, tx);
    if (gate.secondFactorRequired) return { ...base, second: { kind: "second_factor_required" } };
    const session = await createSession(gate.proof, tx);
    await recordIntegrationAuditEvent({
      serverId: connection.serverId,
      eventType: "sso.signed_in",
      outcome: "success",
      source: "web",
      actor: { type: "human", id: userId },
      target: { type: "sso_connection", id: connection.id },
      metadata: { connectionId: connection.id, sessionFamilyId: session.familyId },
    }, tx);
    return { ...base, second: { kind: "signed_in", session } };
  });
}

/**
 * Signs the person in after the IdP of `connectionId` answered with
 * `profile`. `legalAcceptance` is needed only when this creates the account;
 * without it such a sign-in is refused with `legal_acceptance_required` and
 * nothing is written (the caller asks and calls again). Two first sign-ins
 * racing for the same person: the loser retries once and finds what the
 * winner committed.
 */
export async function completeSsoSignIn(input: {
  connectionId: string;
  profile: SsoProfile;
  legalAcceptance?: LegalAcceptanceInput | null;
  legalMetadata?: LegalAcceptanceMetadata;
}): Promise<SsoSignInResult> {
  assertEnterpriseSsoAllowed();
  const now = currentDate();
  const serverId: { value: string | null } = { value: null };
  try {
    let resolved: Resolved;
    try {
      resolved = await signInOnce(input, now, serverId);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      resolved = await signInOnce(input, now, serverId);
    }
    if (resolved.linkedExisting) await notifyLinked(resolved.userId, resolved.connectionName);
    if (resolved.second.kind === "second_factor_required") {
      return { kind: "second_factor_required", userId: resolved.userId, connectionId: input.connectionId };
    }
    return {
      kind: "signed_in",
      userId: resolved.userId,
      connectionId: input.connectionId,
      session: resolved.second.session,
      createdAccount: resolved.createdAccount,
      linked: resolved.linked,
    };
  } catch (err) {
    if (!(err instanceof RefusedError)) throw err;
    if (err.reason !== "legal_acceptance_required") {
      await recordIntegrationAuditEventBestEffort({
        serverId: serverId.value,
        eventType: "sso.sign_in_refused",
        outcome: "failure",
        source: "web",
        actor: { type: "system" },
        target: { type: "sso_connection", id: input.connectionId },
        metadata: { connectionId: input.connectionId, reason: err.reason },
      });
    }
    return { kind: "refused", reason: err.reason };
  }
}

/** After commit; never throws: the link stands whether or not the mail went out. */
async function notifyLinked(userId: string, connectionName: string): Promise<void> {
  try {
    const [person] = await getDb().select({ email: users.email, displayName: users.displayName, name: users.name })
      .from(users).where(eq(users.id, userId));
    if (person) await sendSsoIdentityLinkedEmail(person.email, person.displayName ?? person.name, { connectionName });
  } catch (err) {
    console.error("[sso] linked-account email failed:", err instanceof Error ? err.message : String(err));
  }
}

/**
 * After a `signed_in` result: joins the connection's Server when its owner
 * turned auto-join on (RFC 083 §6.1), and only while the person's current
 * email is on a domain the Server has verified now (a lapsed domain, or an
 * email moved off the domain, joins no one).
 */
export async function autoJoinAfterSsoSignIn(
  signedIn: Extract<SsoSignInResult, { kind: "signed_in" }>,
): Promise<SsoAdmission | { kind: "off" }> {
  const [connection] = await getDb().select({ serverId: serverSsoConnections.serverId, autoJoin: serverSsoConnections.autoJoin, status: serverSsoConnections.status })
    .from(serverSsoConnections).where(eq(serverSsoConnections.id, signedIn.connectionId));
  if (!connection || connection.status !== "active" || !connection.autoJoin) return { kind: "off" };
  const [person] = await getDb().select({ email: users.email }).from(users).where(eq(users.id, signedIn.userId));
  const domain = person ? emailDomain(person.email) : null;
  if (!domain || !(await isDomainVerifiedFor(getDb(), connection.serverId, domain))) return { kind: "off" };
  return admitBySso({ serverId: connection.serverId, userId: signedIn.userId });
}

/**
 * The second step of an SSO sign-in passed (POST /api/auth/second-factor/verify,
 * flow sso_login), inside the transaction that consumed the challenge. The
 * world may have changed since the first step (Tenny 51a5590c): the
 * connection must still be active and the account still able to sign in, or
 * nothing is issued. The challenge itself is single use.
 */
export async function finishSsoSecondStep(
  tx: DatabaseExecutor,
  proof: SessionIssueProof,
  input: { userId: string; connectionId: string },
): Promise<Extract<SsoSignInResult, { kind: "signed_in" }>> {
  assertEnterpriseSsoAllowed();
  const [connection] = await tx.select({ status: serverSsoConnections.status, serverId: serverSsoConnections.serverId })
    .from(serverSsoConnections).where(eq(serverSsoConnections.id, input.connectionId)).for("share");
  if (!connection || connection.status !== "active" || !(await isSsoFlagOn(tx, connection.serverId))) {
    throw new SsoSecondStepRefusedError("connection_inactive");
  }
  try {
    await lockSignInableUser(tx, input.userId);
  } catch (err) {
    if (err instanceof RefusedError) throw new SsoSecondStepRefusedError(err.reason);
    throw err;
  }
  // The link the first step made or used must still be there (an IdP change clears links).
  const [link] = await tx.select({ id: ssoIdentities.id }).from(ssoIdentities)
    .where(and(eq(ssoIdentities.connectionId, input.connectionId), eq(ssoIdentities.userId, input.userId)));
  if (!link) throw new SsoSecondStepRefusedError("connection_inactive");
  const session = await createSession(proof, tx);
  await recordIntegrationAuditEvent({
    serverId: connection.serverId,
    eventType: "sso.signed_in",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: input.userId },
    target: { type: "sso_connection", id: input.connectionId },
    metadata: { connectionId: input.connectionId, sessionFamilyId: session.familyId },
  }, tx);
  return { kind: "signed_in", userId: input.userId, connectionId: input.connectionId, session, createdAccount: false, linked: false };
}

export class SsoSecondStepRefusedError extends Error {
  constructor(readonly reason: SsoSignInRefusal) {
    super(reason);
    this.name = "SsoSecondStepRefusedError";
  }
}
