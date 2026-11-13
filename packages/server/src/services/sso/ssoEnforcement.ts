/**
 * "Require SSO" (rfcs/083-server-sso.md §6.2), at the account, as Notion,
 * Figma and Atlassian enforce it: a person a requiring Server manages uses
 * Raft only with a session that Server's connection signed in within its max
 * age, on every surface (HTTP, sockets, App tokens), not only in that
 * Server. SSO already signs in the whole account for an email on a verified
 * domain (D1); requiring it is the same scope, and it leaves no per-route
 * or per-room check to forget (review in #raft-architecture:102593c2).
 *
 * Managed by Server S = S's connection is active and `required`, the
 * platform has reviewed S's requirement (`server_sso_required_v1`), and the
 * person's current email is on one of S's verified domains or they have an
 * SSO identity under that connection (so moving the email does not escape
 * it). S's owners (by membership role) are not managed by S (they can
 * always reach the settings); a deleted Server manages no one.
 * Everyone else, outside collaborators included, is untouched; agents,
 * Computers and App bots use their own credentials and never meet it. A
 * personal assistant acts as its owner and is held to the owner's
 * requirement (assistantOwnerPassesSso).
 *
 * Callers: verifyActiveAccessTokenWithAccount (requireAuth, attachment
 * links, sockets, optional-auth reads) and the App token lookups. A person on
 * no candidate domain and with no candidate identity costs no read
 * (managedCandidates).
 *
 * The source-available edition has no SSO (edition.ts): no one is managed and
 * no requirement applies there, whatever connections the database holds, so
 * password sign-in keeps working (managedCandidates, activeRequirements).
 */
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { enterpriseSsoAllowed } from "../../edition";
import { serverSsoConnections, sessionFamilies, users } from "../../db/schema";
import { evaluateFeatureFlag, SERVER_SSO_FEATURE_FLAG_KEY, SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY } from "../featureFlagService";

/** What a session family says about SSO (session_families.sso_*). */
export type SsoSessionFacts = { connectionId: string | null; authenticatedAt: Date | null };

export const NO_SSO_SESSION: SsoSessionFacts = { connectionId: null, authenticatedAt: null };

export type AccountSsoCheck =
  /** `expiresAt`: when the accepted SSO sign-in stops counting (a live socket closes then); null when nothing applies. */
  | { ok: true; expiresAt: Date | null }
  /** `serverId`: the Server whose SSO to sign in with. */
  | { ok: false; serverId: string };

const CANDIDATES_TTL_MS = 10_000;
type Candidates = { domains: ReadonlySet<string>; identityUserIds: ReadonlySet<string>; at: number };
let candidates: Candidates | null = null;
const NO_CANDIDATES: Candidates = { domains: new Set(), identityUserIds: new Set(), at: 0 };

/**
 * Who could be managed at all, read at most every 10 s per process: the
 * verified domains of active required connections, and the people with an SSO
 * identity under one. Anyone else (almost everyone on Raft) pays nothing, even
 * once some Server requires SSO (Tenny 5b32546f). Another replica sees a
 * change within that window.
 */
async function managedCandidates(executor: DatabaseExecutor): Promise<Candidates> {
  if (!enterpriseSsoAllowed()) return NO_CANDIDATES;
  const now = Date.now();
  if (candidates && now - candidates.at < CANDIDATES_TTL_MS) return candidates;
  const [domains, identities] = await Promise.all([
    executor.execute<{ domain: string }>(sql`
      SELECT DISTINCT d.domain FROM server_sso_domains d
      JOIN server_sso_connections c ON c.server_id = d.server_id
      JOIN servers s ON s.id = c.server_id
      WHERE c.status = 'active' AND c.required AND d.verified_at IS NOT NULL AND s.deleted_at IS NULL`),
    executor.execute<{ user_id: string }>(sql`
      SELECT DISTINCT i.user_id FROM sso_identities i
      JOIN server_sso_connections c ON c.id = i.connection_id
      JOIN servers s ON s.id = c.server_id
      WHERE c.status = 'active' AND c.required AND s.deleted_at IS NULL`),
  ]);
  candidates = {
    domains: new Set(domains.rows.map((row) => row.domain)),
    identityUserIds: new Set(identities.rows.map((row) => row.user_id)),
    at: now,
  };
  return candidates;
}

async function isManagedCandidate(userId: string, email: string, executor: DatabaseExecutor): Promise<boolean> {
  const { domains, identityUserIds } = await managedCandidates(executor);
  return identityUserIds.has(userId) || domains.has(email.slice(email.lastIndexOf("@") + 1).toLowerCase());
}

/** This process changed a connection's rules or domains: the next check reads again. */
export function forgetSsoRequirementCache(): void {
  candidates = null;
}

type Requirement = { connectionId: string; serverId: string; sessionMaxAgeDays: number; viaDomain: boolean };

/** The required connections that manage this person, their own Servers' excluded: one indexed query. */
async function requirementsManaging(userId: string, executor: DatabaseExecutor): Promise<Requirement[]> {
  const { rows } = await executor.execute<{ connection_id: string; server_id: string; session_max_age_days: number; via_domain: boolean }>(sql`
    SELECT c.id AS connection_id, c.server_id, c.session_max_age_days,
      EXISTS (
        SELECT 1 FROM server_sso_domains d
        WHERE d.server_id = c.server_id AND d.verified_at IS NOT NULL
          AND d.domain = lower(split_part(u.email, '@', 2))
      ) AS via_domain
    FROM server_sso_connections c
    JOIN servers s ON s.id = c.server_id
    JOIN users u ON u.id = ${userId}
    WHERE c.status = 'active' AND c.required AND s.deleted_at IS NULL
      -- An owner of S (any of them, by membership) is never managed by S.
      AND NOT EXISTS (SELECT 1 FROM server_members m WHERE m.server_id = c.server_id AND m.user_id = u.id AND m.role = 'owner')
      AND (
        EXISTS (SELECT 1 FROM sso_identities i WHERE i.connection_id = c.id AND i.user_id = u.id)
        OR EXISTS (
          SELECT 1 FROM server_sso_domains d
          WHERE d.server_id = c.server_id AND d.verified_at IS NOT NULL
            AND d.domain = lower(split_part(u.email, '@', 2))
        )
      )
    -- The same Server's link on every request.
    ORDER BY c.created_at, c.id`);
  return rows.map((row) => ({
    connectionId: row.connection_id,
    serverId: row.server_id,
    sessionMaxAgeDays: Number(row.session_max_age_days),
    viaDomain: row.via_domain === true,
  }));
}

/**
 * Both flags gate enforcement: SSO on for the Server, and its requirement
 * reviewed. Once a Server requires SSO, an unreadable flag enforces rather
 * than opens. For the review that is safe because an unreviewed Server
 * cannot turn `required` on (PATCH /sso/rules reads an unreadable flag as
 * not reviewed): a failed read keeps a reviewed organization enforced. The
 * exception is a Server whose review was withdrawn with `required` still
 * set, enforced again while the read fails (Warden 74f2e068).
 */
export async function ssoRequirementFlagsOn(serverId: string, executor: DatabaseExecutor = getDb()): Promise<boolean> {
  for (const key of [SERVER_SSO_FEATURE_FLAG_KEY, SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY]) {
    try {
      if (!(await evaluateFeatureFlag({ key, serverId }, executor)).enabled) return false;
    } catch {
      // Unreadable: this one counts as on.
    }
  }
  return true;
}

/**
 * Whether the platform has reviewed this Server's requirement: its owner may
 * turn `required` on. An unreadable flag reads as `unreadable` (default: not
 * reviewed, so nothing new is turned on). Never in an edition without SSO.
 */
export async function ssoRequirementReviewed(
  serverId: string,
  executor: DatabaseExecutor = getDb(),
  options: { unreadable?: boolean } = {},
): Promise<boolean> {
  if (!enterpriseSsoAllowed()) return false;
  try {
    return (await evaluateFeatureFlag({ key: SERVER_SSO_REQUIRED_FEATURE_FLAG_KEY, serverId }, executor)).enabled;
  } catch {
    return options.unreadable ?? false;
  }
}

/**
 * Whether this person may use Raft with a session carrying `facts`. Passing
 * means the session was signed in, within that connection's max age, by a
 * connection that manages them, with one precedence (Tenny 5b32546f): when
 * their current email is on a requiring Server's verified domain, only such a
 * domain's connection counts (so one Server's policy never rests on another
 * Server's IdP); an identity's connection counts only when the email is on
 * none.
 */
export async function checkAccountSso(
  input: {
    userId: string;
    email: string;
    facts: SsoSessionFacts;
    now?: Date;
    /**
     * Skip the 10 s candidate cache: a socket handshake. Sockets evicted on every replica after a
     * tightening reconnect at once, possibly to a replica whose cache predates it; an admitted
     * socket would then stay open with no timer (Tenny 5364bb43). HTTP heals within 10 s anyway.
     */
    fresh?: boolean;
  },
  executor: DatabaseExecutor = getDb(),
): Promise<AccountSsoCheck> {
  if (!input.fresh && !(await isManagedCandidate(input.userId, input.email, executor))) return { ok: true, expiresAt: null };
  return passesAny(await activeRequirements(input.userId, executor), [input.facts], input.now ?? currentDate());
}

/** The requirements that manage this person now, their flags read; none in an edition without SSO. */
async function activeRequirements(userId: string, executor: DatabaseExecutor): Promise<Requirement[]> {
  if (!enterpriseSsoAllowed()) return [];
  const managing: Requirement[] = [];
  for (const requirement of await requirementsManaging(userId, executor)) {
    if (await ssoRequirementFlagsOn(requirement.serverId, executor)) managing.push(requirement);
  }
  return managing;
}

/** Whether any of these sessions passes the requirements (precedence as in checkAccountSso). */
function passesAny(managing: Requirement[], sessions: readonly SsoSessionFacts[], now: Date): AccountSsoCheck {
  if (managing.length === 0) return { ok: true, expiresAt: null };
  const byDomain = managing.filter((requirement) => requirement.viaDomain);
  const counting = byDomain.length > 0 ? byDomain : managing;
  let refusedBy: Requirement | undefined;
  for (const facts of sessions) {
    const signedInBy = counting.find((requirement) => requirement.connectionId === facts.connectionId);
    if (signedInBy && facts.authenticatedAt) {
      const expiresAt = new Date(facts.authenticatedAt.getTime() + signedInBy.sessionMaxAgeDays * 24 * 60 * 60 * 1000);
      if (expiresAt.getTime() > now.getTime()) return { ok: true, expiresAt };
    }
    refusedBy ??= signedInBy;
  }
  return { ok: false, serverId: (refusedBy ?? counting[0]!).serverId };
}

/**
 * The SSO facts a session family was signed in with. They never change after
 * the family is created. `live: false` reads them from a family that has since
 * ended: an App token keeps the facts of the sign-in that approved it, the way
 * a device or app login copies them, and its own expiry ends it.
 */
export async function ssoFactsOfFamily(
  familyId: string | null,
  executor: DatabaseExecutor = getDb(),
  options: { live?: boolean } = {},
): Promise<SsoSessionFacts> {
  if (!familyId) return NO_SSO_SESSION;
  const live = options.live ?? true;
  const [row] = await executor.select({ connectionId: sessionFamilies.ssoConnectionId, authenticatedAt: sessionFamilies.ssoAuthenticatedAt })
    .from(sessionFamilies)
    .where(and(eq(sessionFamilies.id, familyId), live ? isNull(sessionFamilies.revokedAt) : undefined, live ? isNull(sessionFamilies.retiredAt) : undefined));
  return row ?? NO_SSO_SESSION;
}

/**
 * An App's access token acting for a person: it counts with the SSO facts of
 * the Raft session it was approved from (oauth_access_tokens.
 * issued_by_session_family_id; none for a token issued before that column,
 * whose App then signs the person in again). As for device and app logins,
 * the approving session had to be live when the token was issued; signing it
 * out later does not end the token, which expires on its own within the hour
 * or when that sign-in passes the max age (AppFather 9024ab48).
 */
export async function appTokenPassesSso(
  input: { userId: string; email: string; issuedBySessionFamilyId: string | null },
  executor: DatabaseExecutor = getDb(),
): Promise<boolean> {
  if (!(await isManagedCandidate(input.userId, input.email, executor))) return true;
  const facts = await ssoFactsOfFamily(input.issuedBySessionFamilyId, executor, { live: false });
  return (await checkAccountSso({ userId: input.userId, email: input.email, facts }, executor)).ok;
}

/**
 * A personal assistant acts as its owner (assistantAsOwner.ts, and the agent
 * API with its owner's rooms), so it may act only while the owner could
 * (Warden 44d9831f, WAWQAQ 2478b8a7): when the owner is managed by a
 * requiring Server, some live session of theirs must pass, the one they
 * signed in with SSO. An assistant has no session of its own; signing out
 * everywhere, or the max age passing, stops it too. Agents, Computers and
 * App bots act as themselves and never meet this.
 */
export async function assistantOwnerPassesSso(
  owner: { userId: string; email: string },
  executor: DatabaseExecutor = getDb(),
): Promise<AccountSsoCheck> {
  if (!(await isManagedCandidate(owner.userId, owner.email, executor))) return { ok: true, expiresAt: null };
  const managing = await activeRequirements(owner.userId, executor);
  if (managing.length === 0) return { ok: true, expiresAt: null };
  // The newest live SSO sign-in under each connection that could count; one read, checked in memory.
  // "Live" is not revoked or retired: a device session past its idle refresh window but not
  // revoked still counts within the SSO max age, on purpose (the max age is the bound).
  const families = await executor.selectDistinctOn([sessionFamilies.ssoConnectionId], {
    connectionId: sessionFamilies.ssoConnectionId,
    authenticatedAt: sessionFamilies.ssoAuthenticatedAt,
  })
    .from(sessionFamilies)
    .where(and(
      eq(sessionFamilies.userId, owner.userId),
      isNull(sessionFamilies.revokedAt),
      isNull(sessionFamilies.retiredAt),
      inArray(sessionFamilies.ssoConnectionId, managing.map((requirement) => requirement.connectionId)),
      isNotNull(sessionFamilies.ssoAuthenticatedAt),
    ))
    .orderBy(sessionFamilies.ssoConnectionId, desc(sessionFamilies.ssoAuthenticatedAt));
  return passesAny(managing, families, currentDate());
}

// Lowercase like its family (`assistant_route_not_allowed`): an agent-facing refusal, not the web's SSO_REQUIRED.
export const ASSISTANT_OWNER_SSO_REQUIRED_CODE = "assistant_owner_sso_required";
export const ASSISTANT_OWNER_SSO_REQUIRED_BODY = {
  error: "Your owner's organization requires single sign-on, and your owner is not signed in with it: you can't act for them right now.",
  code: ASSISTANT_OWNER_SSO_REQUIRED_CODE,
  suggestedNextAction: "Tell your owner to sign in to Raft with their organization's SSO. Retrying before then will not help.",
} as const;

/** How often each replica re-checks its own live sockets: the worst-case delay for changes nothing reconnects (RFC 083 §6.2). */
export const SSO_SOCKET_RECHECK_MS = 3 * 60 * 1000;

/**
 * The periodic socket re-check (Tenny afe6abbd): of these live sockets, the
 * ones whose person is a candidate now and whose session no longer passes.
 * Catches what no tightening reconnects: the flag turned on, an owner leaving
 * or handing over, an email moved onto a verified domain. One read of the
 * people's current emails, then only candidates are checked.
 */
export async function socketsFailingSso<T extends { userId: string; familyId: string }>(
  sockets: readonly T[],
  executor: DatabaseExecutor = getDb(),
): Promise<T[]> {
  const { domains, identityUserIds } = await managedCandidates(executor);
  if (sockets.length === 0 || (domains.size === 0 && identityUserIds.size === 0)) return [];
  const people = await executor.select({ id: users.id, email: users.email }).from(users)
    .where(inArray(users.id, [...new Set(sockets.map((socket) => socket.userId))]));
  const emailOf = new Map(people.map((person) => [person.id, person.email]));
  const failing: T[] = [];
  for (const socket of sockets) {
    const email = emailOf.get(socket.userId);
    if (email === undefined || !(await isManagedCandidate(socket.userId, email, executor))) continue;
    const facts = await ssoFactsOfFamily(socket.familyId, executor);
    if (!(await checkAccountSso({ userId: socket.userId, email, facts }, executor)).ok) failing.push(socket);
  }
  return failing;
}

/** The people a Server's requirement manages now (its owners excluded): whose live connections to re-check after a tightening. */
export async function usersManagedBy(serverId: string, executor: DatabaseExecutor = getDb()): Promise<string[]> {
  const { rows } = await executor.execute<{ id: string }>(sql`
    SELECT i.user_id AS id FROM sso_identities i
    JOIN server_sso_connections c ON c.id = i.connection_id
    WHERE c.server_id = ${serverId}
    UNION
    SELECT u.id FROM users u
    WHERE lower(split_part(u.email, '@', 2)) IN (
      SELECT d.domain FROM server_sso_domains d WHERE d.server_id = ${serverId} AND d.verified_at IS NOT NULL
    )
    EXCEPT
    SELECT m.user_id FROM server_members m WHERE m.server_id = ${serverId} AND m.role = 'owner'`);
  return rows.map((row) => row.id);
}

/**
 * Whether any Server offers single sign-on now (an active connection, its
 * flag on): the sign-in page shows "Continue with SSO" only then. Bounded:
 * the first few active connections are enough to answer. Never in an edition
 * without SSO.
 */
export async function anySsoSignInOffered(executor: DatabaseExecutor = getDb()): Promise<boolean> {
  if (!enterpriseSsoAllowed()) return false;
  const rows = await executor.select({ serverId: serverSsoConnections.serverId }).from(serverSsoConnections)
    .where(eq(serverSsoConnections.status, "active")).limit(20);
  for (const row of rows) {
    const flag = await evaluateFeatureFlag({ key: SERVER_SSO_FEATURE_FLAG_KEY, serverId: row.serverId }, executor).catch(() => ({ enabled: false }));
    if (flag.enabled) return true;
  }
  return false;
}

export const SSO_REQUIRED_CODE = "SSO_REQUIRED";
export const SSO_REQUIRED_TEXT = "Your organization requires you to sign in with its single sign-on.";
