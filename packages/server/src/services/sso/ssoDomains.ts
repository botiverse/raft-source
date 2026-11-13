/**
 * Company email domains a Server proves by DNS TXT (rfcs/083-server-sso.md
 * §4, §5.5). A verified domain is what lets the Server's SSO connection link,
 * create and auto-join accounts on it; it stops doing so the moment the
 * record is confirmed gone, and never because of one failed lookup.
 *
 * The record: `_raft-verification.<domain>` TXT `raft-domain-verification=<token>`.
 */
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { domainToASCII } from "node:url";
import { and, asc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { ServerRole } from "@botiverse/raft-shared";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../../db/index";
import { enterpriseSsoAllowed } from "../../edition";
import { integrationAuditEvents, serverMembers, servers, serverSsoDomains, users } from "../../db/schema";
import { sendSsoDomainNoticeEmail, type SsoDomainNoticeKind } from "../emailService";
import { recordIntegrationAuditEvent, serverAuditContextMetadata } from "../integrationAuditService";
import { ssoRequirementReviewed } from "./ssoEnforcement";
import { ssoReviewedDomainVerifiedTotal } from "../../metrics";

export type ServerSsoDomainRow = typeof serverSsoDomains.$inferSelect;
export type DomainCheckResult = "present" | "absent" | "lookup_failed";

export const SSO_DOMAIN_RECORD_PREFIX = "_raft-verification";
export const SSO_DOMAIN_RECORD_VALUE_PREFIX = "raft-domain-verification=";
/** Two confirmed absences at least this far apart unverify a domain. */
export const SSO_DOMAIN_ABSENCE_CONFIRM_MS = 60 * 60 * 1000;
/** Nothing but failed lookups for this long unverifies a domain. */
export const SSO_DOMAIN_FAILURE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const DNS_TIMEOUT_MS = 5_000;
const MAX_DOMAINS_PER_SERVER = 20;

/**
 * Mailbox providers anyone can sign up to: proving one would let a Server
 * claim every account on it. Not exhaustive; it covers the providers Raft
 * accounts actually use.
 */
const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com",
  "proton.me", "protonmail.com", "pm.me", "gmx.com", "gmx.net", "mail.com",
  "yandex.com", "yandex.ru", "mail.ru", "zoho.com", "fastmail.com", "hey.com",
  "qq.com", "foxmail.com", "163.com", "126.com", "yeah.net", "sina.com",
  "sina.cn", "sohu.com", "aliyun.com", "139.com", "189.cn", "naver.com",
  "gmx.de", "gmx.at", "gmx.ch", "web.de", "t-online.de", "freenet.de", "orange.fr",
  "free.fr", "laposte.net", "wanadoo.fr", "libero.it", "virgilio.it", "seznam.cz",
  "wp.pl", "o2.pl", "interia.pl", "rambler.ru", "bk.ru", "list.ru", "inbox.ru",
  "hotmail.co.uk", "hotmail.fr", "hotmail.de", "hotmail.it", "hotmail.es", "outlook.de",
  "live.co.uk", "yahoo.co.uk", "yahoo.co.jp", "yahoo.fr", "yahoo.de", "yahoo.com.br",
  "btinternet.com", "comcast.net", "verizon.net", "att.net", "sbcglobal.net",
  "daum.net", "hanmail.net", "rediffmail.com", "tutanota.com", "tuta.io", "mailbox.org",
  "posteo.de", "duck.com", "skiff.com", "126.net", "vip.qq.com", "vip.163.com",
]);

export class SsoDomainError extends Error {
  constructor(
    readonly code: "domain_invalid" | "domain_public" | "domain_limit",
    message: string,
  ) {
    super(message);
    this.name = "SsoDomainError";
  }
}

/**
 * Lowercase ASCII (punycode for IDNs), no trailing dot, at least two labels,
 * no IP literal, no wildcard; null for anything else.
 */
export function normalizeSsoDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase().replace(/\.$/u, "");
  if (!trimmed || trimmed.length > 253 || /[\s/@:*?#]/u.test(trimmed)) return null;
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253) return null;
  const labels = ascii.split(".");
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) return null;
  }
  if (/^[0-9]+$/u.test(labels[labels.length - 1]!)) return null;
  return ascii;
}

export function isPublicEmailDomain(domain: string): boolean {
  return PUBLIC_EMAIL_DOMAINS.has(domain);
}

export function ssoDomainRecordName(domain: string): string {
  return `${SSO_DOMAIN_RECORD_PREFIX}.${domain}`;
}

export function ssoDomainRecordValue(token: string): string {
  return `${SSO_DOMAIN_RECORD_VALUE_PREFIX}${token}`;
}

export type TxtResolver = (name: string) => Promise<string[][]>;

let txtResolverOverride: TxtResolver | null = null;

/** Tests answer DNS themselves; null restores the real resolver. */
export function setSsoTxtResolverForTests(resolver: TxtResolver | null): void {
  txtResolverOverride = resolver;
}

function defaultTxtResolver(): TxtResolver {
  if (txtResolverOverride) return txtResolverOverride;
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  return (name) => resolver.resolveTxt(name);
}

/**
 * What DNS says about the record now. NXDOMAIN (`ENOTFOUND`) and NODATA
 * (`ENODATA`) are authoritative answers that the record is not there
 * (RFC 083 §5.5: a domain that expired or moved answers NXDOMAIN); any
 * other error is a failed lookup that says nothing either way.
 */
export async function checkSsoDomainRecord(
  domain: string,
  token: string,
  resolveTxt: TxtResolver = defaultTxtResolver(),
): Promise<DomainCheckResult> {
  const expected = ssoDomainRecordValue(token);
  try {
    const records = await resolveTxt(ssoDomainRecordName(domain));
    // A TXT record may arrive split into several strings.
    return records.some((chunks) => chunks.join("").trim() === expected) ? "present" : "absent";
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "ENOTFOUND" || code === "ENODATA") return "absent";
    return "lookup_failed";
  }
}

export type SsoDomainState = Pick<
  ServerSsoDomainRow,
  "verifiedAt" | "lastCheckedAt" | "lastCheckResult" | "absentSince" | "failingSince"
>;

/**
 * The domain's state after a check (RFC 083 §5.5):
 * - present: verified (kept or set now); absence and failure streaks end.
 * - absent: an unverified domain stays unverified. A verified one starts an
 *   absence streak and is unverified once a later check, at least
 *   SSO_DOMAIN_ABSENCE_CONFIRM_MS after the first, is absent too.
 * - lookup_failed: nothing changes but the failure streak; a verified
 *   domain is unverified only after SSO_DOMAIN_FAILURE_GRACE_MS of it.
 */
export function nextSsoDomainState(state: SsoDomainState, result: DomainCheckResult, now: Date): SsoDomainState {
  switch (result) {
    case "present":
      return {
        verifiedAt: state.verifiedAt ?? now,
        lastCheckedAt: now,
        lastCheckResult: "present",
        absentSince: null,
        failingSince: null,
      };
    case "absent": {
      const absentSince = state.absentSince ?? now;
      const confirmed = state.verifiedAt !== null
        && now.getTime() - absentSince.getTime() >= SSO_DOMAIN_ABSENCE_CONFIRM_MS;
      return {
        verifiedAt: confirmed ? null : state.verifiedAt,
        lastCheckedAt: now,
        lastCheckResult: "absent",
        absentSince: state.verifiedAt === null || confirmed ? null : absentSince,
        failingSince: null,
      };
    }
    case "lookup_failed": {
      const failingSince = state.failingSince ?? now;
      const lapsed = state.verifiedAt !== null
        && now.getTime() - failingSince.getTime() >= SSO_DOMAIN_FAILURE_GRACE_MS;
      return {
        verifiedAt: lapsed ? null : state.verifiedAt,
        lastCheckedAt: now,
        lastCheckResult: "lookup_failed",
        // A failed lookup neither confirms nor clears an absence streak.
        absentSince: lapsed ? null : state.absentSince,
        failingSince: lapsed ? null : failingSince,
      };
    }
  }
}

export async function listServerSsoDomains(serverId: string, executor: DatabaseExecutor = getDb()): Promise<ServerSsoDomainRow[]> {
  return executor.select().from(serverSsoDomains)
    .where(eq(serverSsoDomains.serverId, serverId))
    .orderBy(asc(serverSsoDomains.createdAt));
}

export async function getServerSsoDomain(serverId: string, domainId: string, executor: DatabaseExecutor = getDb()) {
  const [row] = await executor.select().from(serverSsoDomains)
    .where(and(eq(serverSsoDomains.serverId, serverId), eq(serverSsoDomains.id, domainId)));
  return row ?? null;
}

/** Adds the domain unverified with a fresh token, or returns the Server's existing row for it. */
export async function addServerSsoDomain(
  input: { serverId: string; domain: unknown; actorUserId: string },
  executor: DatabaseExecutor = getDb(),
): Promise<{ row: ServerSsoDomainRow; created: boolean }> {
  const domain = normalizeSsoDomain(input.domain);
  if (!domain) throw new SsoDomainError("domain_invalid", "Enter a domain such as acme.com");
  if (isPublicEmailDomain(domain)) {
    throw new SsoDomainError("domain_public", "A public email domain cannot be verified for SSO");
  }
  const existing = await listServerSsoDomains(input.serverId, executor);
  const same = existing.find((row) => row.domain === domain);
  if (same) return { row: same, created: false };
  if (existing.length >= MAX_DOMAINS_PER_SERVER) {
    throw new SsoDomainError("domain_limit", `A Server can verify at most ${MAX_DOMAINS_PER_SERVER} domains`);
  }
  const [row] = await executor.insert(serverSsoDomains).values({
    serverId: input.serverId,
    domain,
    verificationToken: randomBytes(24).toString("base64url"),
    createdByUserId: input.actorUserId,
  }).onConflictDoNothing().returning();
  if (row) return { row, created: true };
  const raced = (await listServerSsoDomains(input.serverId, executor)).find((candidate) => candidate.domain === domain);
  if (!raced) throw new Error("server_sso_domains insert conflicted without a row");
  return { row: raced, created: false };
}

export type StoredSsoDomainCheck = {
  row: ServerSsoDomainRow;
  result: DomainCheckResult;
  becameVerified: boolean;
  becameUnverified: boolean;
  /** A later check was stored while this one's DNS ran: its result was dropped. */
  superseded: boolean;
  /** It became verified on a Server whose requirement the platform reviewed: operators re-check it. */
  needsReview?: boolean;
};

/** /verify answers 429 inside this window after the last check (each check is up to two 5 s lookups). */
export const SSO_DOMAIN_VERIFY_COOLDOWN_MS = 10_000;

export type SsoDomainCheckActor = { type: "human"; id: string; role: string } | { type: "system" };

/**
 * Checks the domain's record and stores the outcome. DNS runs first, outside
 * any transaction, and the time it was asked is noted; the row is then
 * re-read under FOR UPDATE. If another check was stored after this one asked
 * (`last_checked_at` later than `queriedAt`), this result is older news and
 * is dropped: a slow "present" can never restore a verification that a newer
 * "absent" just removed. Null when the domain is gone.
 */
export async function checkServerSsoDomain(
  input: { serverId: string; domainId: string; actor: SsoDomainCheckActor; source: "web" | "system" },
  options: { resolveTxt?: TxtResolver; now?: () => Date } = {},
): Promise<StoredSsoDomainCheck | null> {
  const before = await getServerSsoDomain(input.serverId, input.domainId);
  if (!before) return null;
  const queriedAt = (options.now ?? currentDate)();
  const result = await checkSsoDomainRecord(before.domain, before.verificationToken, options.resolveTxt);
  // Read before the transaction: a failed read inside it would abort the check's own writes.
  const reviewed = result === "present" && before.verifiedAt === null && await ssoRequirementReviewed(input.serverId);
  return getDb().transaction(async (tx) => {
    const [row] = await tx.select().from(serverSsoDomains)
      .where(and(eq(serverSsoDomains.serverId, input.serverId), eq(serverSsoDomains.id, input.domainId)))
      .for("update");
    // Gone, or re-created with another token while DNS ran: nothing to store.
    if (!row || row.verificationToken !== before.verificationToken) return null;
    if (row.lastCheckedAt && row.lastCheckedAt.getTime() > queriedAt.getTime()) {
      return { row, result, becameVerified: false, becameUnverified: false, superseded: true };
    }
    // Stamped with when DNS was asked, so a check that asked later always wins.
    const next = nextSsoDomainState(row, result, queriedAt);
    const [stored] = await tx.update(serverSsoDomains).set(next).where(eq(serverSsoDomains.id, row.id)).returning();
    const outcome: StoredSsoDomainCheck = {
      row: stored!,
      result,
      becameVerified: row.verifiedAt === null && stored!.verifiedAt !== null,
      becameUnverified: row.verifiedAt !== null && stored!.verifiedAt === null,
      superseded: false,
    };
    if (outcome.becameVerified || outcome.becameUnverified) {
      await recordIntegrationAuditEvent({
        serverId: input.serverId,
        eventType: outcome.becameVerified ? "sso.domain_verified" : "sso.domain_unverified",
        outcome: "success",
        source: input.source,
        actor: input.actor.type === "human" ? { type: "human", id: input.actor.id } : { type: "system" },
        target: { type: "sso_domain", id: row.id },
        metadata: {
          domainId: row.id,
          domain: row.domain,
          result,
          ...(input.actor.type === "human" ? serverAuditContextMetadata({ actorRole: input.actor.role as ServerRole }) : {}),
        },
      }, tx);
    }
    // The platform reviewed this Server's requirement with the domains it had then: a new one needs a human look (Warden 74f2e068).
    // A domain verified before (lapsed, now back) is not new: only its first verification counts.
    const firstVerification = outcome.becameVerified && reviewed && (await tx.select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
      .where(and(eq(integrationAuditEvents.eventType, "sso.domain_verified"), eq(integrationAuditEvents.targetId, row.id)))
      .limit(2)).length === 1;
    if (firstVerification) {
      await recordIntegrationAuditEvent({
        serverId: input.serverId,
        eventType: "sso.reviewed_domain_verified",
        outcome: "success",
        source: input.source,
        actor: { type: "system" },
        target: { type: "sso_domain", id: row.id },
        metadata: { domainId: row.id, domain: row.domain },
      }, tx);
      outcome.needsReview = true;
    }
    return outcome;
  }).then((outcome) => {
    // The operators' alert watches the counter (docs/development/sso.md, "Reviewing an organization");
    // which Server and domain: the audit event `sso.reviewed_domain_verified`.
    if (outcome?.needsReview) {
      ssoReviewedDomainVerifiedTotal.inc();
      console.warn(`[sso-review] reviewed Server ${input.serverId} verified a new domain ${outcome.row.domain}: re-check it`);
    }
    return outcome;
  });
}

/** Admins hear about a domain whose lookups have failed this long (RFC 083 §5.5). */
export const SSO_DOMAIN_FAILURE_NOTICE_MS = 24 * 60 * 60 * 1000;

/**
 * Tells the Server's owners and admins, once per streak: a domain whose
 * lookups have failed for a day, and a domain that just lost its
 * verification. The audit log is the record that a notice went out, so a
 * streak is announced once whatever the sweep's schedule.
 */
async function noticeAdminsIfNeeded(outcome: StoredSsoDomainCheck, now: Date): Promise<void> {
  const row = outcome.row;
  let kind: SsoDomainNoticeKind | null = null;
  let since: Date | null = null;
  if (outcome.becameUnverified) {
    kind = "unverified";
    since = row.lastCheckedAt ?? now;
  } else if (row.verifiedAt && row.failingSince && now.getTime() - row.failingSince.getTime() >= SSO_DOMAIN_FAILURE_NOTICE_MS) {
    kind = "lookup_failing";
    since = row.failingSince;
  }
  if (!kind || !since) return;
  const eventType = kind === "unverified" ? "sso.domain_unverified_notice" : "sso.domain_lookup_failing_notice";
  // Every replica runs the sweep: deciding under the domain row's lock sends one notice per streak.
  const decided = await getDb().transaction(async (tx) => {
    await tx.select({ id: serverSsoDomains.id }).from(serverSsoDomains).where(eq(serverSsoDomains.id, row.id)).for("update");
    const [already] = await tx.select({ id: integrationAuditEvents.id }).from(integrationAuditEvents)
      .where(and(
        eq(integrationAuditEvents.eventType, eventType),
        eq(integrationAuditEvents.targetId, row.id),
        // The streak it was for, not the clock: one notice per streak.
        sql`${integrationAuditEvents.metadata}->>'since' = ${since.toISOString()}`,
      ))
      .limit(1);
    if (already) return null;
    const [server] = await tx.select({ name: servers.name }).from(servers).where(eq(servers.id, row.serverId));
    const admins = await tx.select({ email: users.email, name: users.name, displayName: users.displayName })
      .from(serverMembers)
      .innerJoin(users, eq(users.id, serverMembers.userId))
      .where(and(eq(serverMembers.serverId, row.serverId), inArray(serverMembers.role, ["owner", "admin"]), isNull(users.retiredAt)));
    await recordIntegrationAuditEvent({
      serverId: row.serverId,
      eventType,
      outcome: "success",
      source: "system",
      actor: { type: "system" },
      target: { type: "sso_domain", id: row.id },
      metadata: { domainId: row.id, domain: row.domain, recipients: admins.length, since: since.toISOString() },
    }, tx);
    return { server, admins };
  });
  if (!decided) return;
  const { server, admins } = decided;
  for (const admin of admins) {
    await sendSsoDomainNoticeEmail(admin.email, admin.displayName ?? admin.name, { kind, serverName: server?.name ?? "your server", domain: row.domain })
      .catch((err) => console.error("[sso] domain notice email failed:", err instanceof Error ? err.message : String(err)));
  }
}

/** Re-check verified domains this often, and every hour while a streak runs (RFC 083 §5.5). */
export const SSO_DOMAIN_RECHECK_MS = 24 * 60 * 60 * 1000;
const SSO_DOMAIN_SWEEP_BATCH = 200;

/**
 * The hourly maintenance sweep: every verified domain not checked for a day,
 * and every verified domain in an absence or failure streak, is checked
 * again. One domain's failure never stops the others. An edition without SSO
 * (edition.ts) looks nothing up and mails no one.
 */
export async function recheckServerSsoDomains(options: { resolveTxt?: TxtResolver; now?: () => Date } = {}): Promise<{ checked: number; unverified: number }> {
  if (!enterpriseSsoAllowed()) return { checked: 0, unverified: 0 };
  const now = (options.now ?? currentDate)();
  const stale = new Date(now.getTime() - SSO_DOMAIN_RECHECK_MS);
  const due = await getDb().select({ id: serverSsoDomains.id, serverId: serverSsoDomains.serverId })
    .from(serverSsoDomains)
    .where(and(
      isNotNull(serverSsoDomains.verifiedAt),
      or(
        isNull(serverSsoDomains.lastCheckedAt),
        lt(serverSsoDomains.lastCheckedAt, stale),
        isNotNull(serverSsoDomains.absentSince),
        isNotNull(serverSsoDomains.failingSince),
      ),
    ))
    .orderBy(asc(serverSsoDomains.lastCheckedAt))
    .limit(SSO_DOMAIN_SWEEP_BATCH);
  let checked = 0;
  let unverified = 0;
  for (const domain of due) {
    try {
      const outcome = await checkServerSsoDomain(
        { serverId: domain.serverId, domainId: domain.id, actor: { type: "system" }, source: "system" },
        options,
      );
      if (!outcome || outcome.superseded) continue;
      checked += 1;
      if (outcome.becameUnverified) unverified += 1;
      await noticeAdminsIfNeeded(outcome, now).catch((err) => {
        console.error("[sso] domain notice failed:", domain.id, err instanceof Error ? err.message : String(err));
      });
    } catch (error) {
      console.error("[sso] domain re-check failed:", domain.id, error instanceof Error ? error.message : String(error));
    }
  }
  return { checked, unverified };
}

export async function removeServerSsoDomain(serverId: string, domainId: string, executor: DatabaseExecutor = getDb()) {
  const [removed] = await executor.delete(serverSsoDomains)
    .where(and(eq(serverSsoDomains.serverId, serverId), eq(serverSsoDomains.id, domainId)))
    .returning();
  return removed ?? null;
}

/** What the settings page shows: never more than the admin needs to publish the record. */
export function serverSsoDomainView(row: ServerSsoDomainRow) {
  return {
    id: row.id,
    domain: row.domain,
    verified: row.verifiedAt !== null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastCheckResult: row.lastCheckResult ?? null,
    record: {
      type: "TXT" as const,
      name: ssoDomainRecordName(row.domain),
      value: ssoDomainRecordValue(row.verificationToken),
    },
  };
}
