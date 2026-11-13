import { createFixedWindowCounter, type FixedWindowAdmission } from "./fixedWindowRateLimit";

// Interactive link card action limits (RFC 076 §8; protocol v3.2.3 §13.6).
// They apply only after a click and must hold across replicas, so they count
// in Redis: one fixed one-minute window per viewer per Server and kind (per
// installation for an App's terminal updates), INCR
// and its TTL in one Lua call (fixedWindowRateLimit.ts, the pattern of machineConnectRateLimit). Without
// Redis the server runs as one replica (Redis is what enables multi-replica
// support), so this process's memory is the whole count. A Redis error falls
// back to the memory count instead of failing open: the open-operation caps
// (Postgres, inside the execute transaction) stay the hard bound either way.
// Initial values are operating parameters, not load-tested (Q-A2, Q-C9).

/** Execute: 30 per viewer per Server per minute (protocol §13.6). */
export const LINK_CARD_EXECUTE_PER_MINUTE = 30;
/**
 * Prepare: the same 30. RFC 076 §8 names no number for prepare; it calls the
 * App like execute does, so it gets its own budget of the same size.
 */
export const LINK_CARD_PREPARE_PER_MINUTE = 30;
/**
 * Execute's same-id lookup (recovery): 120. Recovery takes no lock and no
 * quota of the open-operation caps or the execute budget, so a retry always
 * gets its answer, but each one runs a handful of queries (the mapping, the
 * receipt's live access, the message read). This generous bound keeps a client
 * stuck in a retry loop from making that unbounded (Tenny, #10971 review);
 * every execute request spends one unit before its first query.
 */
export const LINK_CARD_RECOVERY_PER_MINUTE = 120;
/**
 * Status: 120 per viewer per Server per minute (RFC 076 §6.4, §8 name no
 * number). The client cadence (2 s, 5 s, 15 s, 60 s, then every 5 minutes) for a
 * viewer's open operations, plus one read per receipt hint, stays well inside
 * it; each request may call the App once (and at most once per operation per
 * forward interval, linkCardReceiptService.ts).
 */
export const LINK_CARD_STATUS_PER_MINUTE = 120;
/** Operation lookups (by id, by client request id, by URL page): 120 per viewer per Server per minute. They call no App and write nothing. */
export const LINK_CARD_LOOKUP_PER_MINUTE = 120;
/**
 * Terminal updates from an App (`POST /api/oauth/link-preview/card-updates`):
 * 600 per installation per minute (RFC 076 §8 "provider budgets"; no number is
 * given). Each operation gets one update token, so this only bounds retries
 * and floods; the installation's open operations are capped at 1,000.
 */
export const LINK_CARD_UPDATE_PER_INSTALLATION_PER_MINUTE = 600;
/**
 * Execute per App acting under its own-Server confirmation (RFC 076 §17,
 * Tenny): 10 per viewer per Server per App per minute, on top of the 30
 * above. Its card buttons act without platform review, so each person gets a
 * tighter bound per App. Official Apps (reviewed) keep only the 30.
 */
export const LINK_CARD_EXECUTE_PER_APP_PER_MINUTE = 10;
const WINDOW_SECONDS = 60;

export type LinkCardActionKind = "prepare" | "execute" | "recovery" | "status" | "lookup";
export type LinkCardActionAdmission = FixedWindowAdmission;

const LIMITS: Record<LinkCardActionKind, number> = {
  prepare: LINK_CARD_PREPARE_PER_MINUTE, execute: LINK_CARD_EXECUTE_PER_MINUTE, recovery: LINK_CARD_RECOVERY_PER_MINUTE,
  status: LINK_CARD_STATUS_PER_MINUTE, lookup: LINK_CARD_LOOKUP_PER_MINUTE,
};
const key = (kind: LinkCardActionKind, viewerId: string, serverId: string) => `slock:link-card:${kind}:${serverId}:${viewerId}`;

const counter = createFixedWindowCounter();

/** Spends one unit of the viewer's budget for `kind` on this Server. */
export async function admitLinkCardAction(kind: LinkCardActionKind, viewerId: string, serverId: string, nowMs = Date.now()): Promise<LinkCardActionAdmission> {
  return admit(key(kind, viewerId, serverId), LIMITS[kind], nowMs);
}

/** Spends one unit of the viewer's execute budget for one App (`appKey`: the handle's provider key) on this Server. */
export async function admitLinkCardAppExecute(viewerId: string, serverId: string, appKey: string, nowMs = Date.now()): Promise<LinkCardActionAdmission> {
  return admit(`slock:link-card:execute_app:${serverId}:${viewerId}:${appKey}`, LINK_CARD_EXECUTE_PER_APP_PER_MINUTE, nowMs);
}

/** Spends one unit of an installation's terminal-update budget. */
export async function admitLinkCardUpdate(installationKey: string, nowMs = Date.now()): Promise<LinkCardActionAdmission> {
  return admit(`slock:link-card:card_update:${installationKey}`, LINK_CARD_UPDATE_PER_INSTALLATION_PER_MINUTE, nowMs);
}

function admit(name: string, limit: number, nowMs: number): Promise<LinkCardActionAdmission> {
  return counter.admit(name, limit, WINDOW_SECONDS, nowMs);
}

export function __resetLinkCardActionLimitsForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Link card limit hooks are test-only");
  counter.clear();
}
