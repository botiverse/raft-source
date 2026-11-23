/**
 * Computer pairings (design "one-click Computer login" §11 B, Tenny's
 * conditions 937c6726; contract docs/contracts/computer-pairing.md).
 *
 * The Add Computer window a person has open creates a pairing for one server;
 * its raw id goes into the copied setup command (`--pair <id>`). The Computer
 * runs its normal device authorization and sends the id with it; the server
 * links that one authorization to the pairing, so the window can show it and
 * approve it without a code. The id only routes: it grants nothing.
 *
 * - The raw id (32 random bytes, base64url) is returned once by create and
 *   never stored or logged: rows, traces and events carry the row id
 *   (`pairingRef`) or a prefix of the id's sha256.
 * - One machine per pairing: the first authorization that brings a live
 *   pairing's id links (compare-and-swap); a second one voids the pairing
 *   (`conflict`), and neither is approvable through it. Both stay ordinary
 *   device authorizations: their user codes still work on the device page.
 * - Only the sign-in that created it (same person, same session family) may
 *   read, renew, cancel or approve through it; revoking that sign-in voids it
 *   (sessionService.denyLoginCodesApprovedBy).
 * - Approving through it approves the authorization the server linked, never
 *   an id from the window, through approveDeviceAuthorization (ticket, pick of
 *   the pairing's server re-checked, step-up in the route), claiming the
 *   pairing in the same transaction.
 * - A bad pairing never fails the Computer's authorize: it proceeds as a
 *   normal device authorization, traced.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNotNull, isNull, ne } from "drizzle-orm";
import { getDb, type DatabaseExecutor } from "../db/index";
import { computerPairings, deviceAuthorizations, servers, type ComputerPairingVoidReason, type DeviceLoginGrantKind } from "../db/schema";
import { addTraceEvent } from "../tracing/semanticTrace";
import { attachableServer } from "./deviceLoginGrantChoices";

/** How long a pairing lives without the window renewing it. */
export const COMPUTER_PAIRING_TTL_MS = 10 * 60_000;
/** Live pairings one person may hold at once (one per open Add Computer window). */
export const MAX_ACTIVE_COMPUTER_PAIRINGS = 5;
/**
 * The longest a pairing can live, however often the window renews it (Tenny,
 * #proj-raft-computer:e269d2cc 9ee59a28): a leaked command's pairing has an
 * upper bound even while the window stays open.
 */
export const COMPUTER_PAIRING_MAX_LIFETIME_MS = 60 * 60_000;
/**
 * The first Computer version whose `raft-computer setup` takes `--pair`
 * (#15620). Add Computer's one-paste command installs the newest Computer on
 * its channel and hands `--pair` to it; an older Computer rejects the flag, so
 * the server makes a pairing only once the channel serves this version or
 * later (Tenny, #proj-raft-computer:e269d2cc 763d2d64). A release, not a
 * prerelease: alpha's `1.25.8-staging.*` builds predate #15620 too, and SemVer
 * orders them below 1.25.8 (staging's command carries no `--pair` anyway).
 * The one place this number lives: the Computer release checklist checks the
 * release contains #15620 and, if it doesn't, moves this to the first that does.
 * This holds because the window's one-paste command pins no version, so the
 * channel's newest is what gets installed; if that command ever gains a
 * version pin, check the pinned version here instead (Tenny d82e690e).
 */
export const COMPUTER_PAIRING_MIN_COMPUTER_VERSION = "1.25.8";

const PAIRING_ID_BYTES = 32;
const PAIRING_ID_RE = /^[A-Za-z0-9_-]{43}$/;
const SERVER_SLUG_MAX_LENGTH = 200;

/** The grant kinds a pairing can carry: what `raft-computer setup` / `attach` ask for. */
const PAIRABLE_GRANT_KINDS: ReadonlySet<DeviceLoginGrantKind> = new Set(["computer_attach", "computer_migrate"]);

/** How a raw pairing id is stored: sha256, hex. */
export function hashComputerPairingId(rawPairingId: string): string {
  return createHash("sha256").update(rawPairingId).digest("hex");
}

/** What a trace may carry about a pairing that has no row to name: 12 hex chars of the id's hash. */
function hashPrefix(pairingHash: string): string {
  return pairingHash.slice(0, 12);
}

function parsePairingId(raw: unknown): string | null {
  return typeof raw === "string" && PAIRING_ID_RE.test(raw) ? raw : null;
}

export type ComputerPairingState = "waiting" | "requested" | "conflict" | "voided" | "expired" | "approved" | "denied";

type PairingRow = typeof computerPairings.$inferSelect;
type LinkedAuthorization = { status: string; expiresAt: Date };

/**
 * The pairing's state, from its row and the authorization it linked. A linked
 * authorization resolved anywhere (through the pairing, or its user code on the
 * device page) ends the pairing with it.
 */
export function computerPairingState(row: Pick<PairingRow, "voidedAt" | "voidReason" | "expiresAt">, linked: LinkedAuthorization | null, now: Date): ComputerPairingState {
  if (row.voidedAt) return row.voidReason === "conflict" ? "conflict" : "voided";
  if (linked) {
    if (linked.status === "approved" || linked.status === "consumed") return "approved";
    if (linked.status === "denied") return "denied";
    if (linked.status !== "pending" || linked.expiresAt <= now) return "expired";
  }
  if (row.expiresAt <= now) return "expired";
  return linked ? "requested" : "waiting";
}

export type CreateComputerPairingResult =
  | { ok: true; pairingId: string; pairingRef: string; expiresAt: Date }
  | { ok: false; error: "server_not_allowed" | "too_many_pairings" };

/**
 * Create, for a server the person may add Computers to (the same rule as the
 * device approval's server pick, attachableServer). At most
 * MAX_ACTIVE_COMPUTER_PAIRINGS live at once per person.
 */
export async function createComputerPairing(input: { userId: string; serverId: string; sessionFamilyId: string }, now = new Date()): Promise<CreateComputerPairingResult> {
  if (!await attachableServer(input.userId, input.serverId)) return { ok: false, error: "server_not_allowed" };
  const db = getDb();
  const [active] = await db.select({ n: count() }).from(computerPairings).where(and(
    eq(computerPairings.userId, input.userId),
    gt(computerPairings.expiresAt, now),
    isNull(computerPairings.voidedAt),
    isNull(computerPairings.consumedAt),
  ));
  if ((active?.n ?? 0) >= MAX_ACTIVE_COMPUTER_PAIRINGS) return { ok: false, error: "too_many_pairings" };
  const pairingId = randomBytes(PAIRING_ID_BYTES).toString("base64url");
  const expiresAt = new Date(now.getTime() + COMPUTER_PAIRING_TTL_MS);
  const [row] = await db.insert(computerPairings).values({
    pairingHash: hashComputerPairingId(pairingId),
    userId: input.userId,
    serverId: input.serverId,
    sessionFamilyId: input.sessionFamilyId,
    createdAt: now,
    expiresAt,
  }).returning({ id: computerPairings.id });
  addTraceEvent("computer_pairing.created", { pairing_ref: row!.id, server_id: input.serverId, user_id: input.userId });
  return { ok: true, pairingId, pairingRef: row!.id, expiresAt };
}

/** The caller's sign-in, as every route but authorize names it. */
export interface PairingOwner {
  userId: string;
  sessionFamilyId: string;
}

export interface OwnComputerPairing {
  row: PairingRow;
  state: ComputerPairingState;
}

/**
 * The pairing, only for the sign-in that created it (same person, same
 * session family); null for anything else, a malformed id included, so another
 * session or person can't tell it exists.
 */
export async function findOwnComputerPairing(rawPairingId: unknown, owner: PairingOwner, now = new Date()): Promise<OwnComputerPairing | null> {
  const pairingId = parsePairingId(rawPairingId);
  if (!pairingId) return null;
  const [found] = await getDb()
    .select({ row: computerPairings, linkedStatus: deviceAuthorizations.status, linkedExpiresAt: deviceAuthorizations.expiresAt })
    .from(computerPairings)
    .leftJoin(deviceAuthorizations, eq(deviceAuthorizations.id, computerPairings.linkedDeviceAuthorizationId))
    .where(and(
      eq(computerPairings.pairingHash, hashComputerPairingId(pairingId)),
      eq(computerPairings.userId, owner.userId),
      eq(computerPairings.sessionFamilyId, owner.sessionFamilyId),
    ));
  if (!found) return null;
  const linked = found.linkedStatus && found.linkedExpiresAt ? { status: found.linkedStatus, expiresAt: found.linkedExpiresAt } : null;
  return { row: found.row, state: computerPairingState(found.row, linked, now) };
}

/** Renew while the window is open: only a waiting or requested pairing. Null when it can't be. */
export async function renewComputerPairing(pairing: OwnComputerPairing, now = new Date()): Promise<Date | null> {
  if (pairing.state !== "waiting" && pairing.state !== "requested") return null;
  const lifetimeEndsAt = pairing.row.createdAt.getTime() + COMPUTER_PAIRING_MAX_LIFETIME_MS;
  if (lifetimeEndsAt <= now.getTime()) return null;
  const expiresAt = new Date(Math.min(now.getTime() + COMPUTER_PAIRING_TTL_MS, lifetimeEndsAt));
  const [renewed] = await getDb().update(computerPairings).set({ expiresAt }).where(and(
    eq(computerPairings.id, pairing.row.id),
    gt(computerPairings.expiresAt, now),
    isNull(computerPairings.voidedAt),
    isNull(computerPairings.consumedAt),
  )).returning({ id: computerPairings.id });
  return renewed ? expiresAt : null;
}

/** The window closed: void it (idempotent; a pairing already ended stays as it ended). */
export async function cancelComputerPairing(pairing: OwnComputerPairing, now = new Date()): Promise<void> {
  const [voided] = await getDb().update(computerPairings).set({ voidedAt: now, voidReason: "cancelled" }).where(and(
    eq(computerPairings.id, pairing.row.id),
    isNull(computerPairings.voidedAt),
    isNull(computerPairings.consumedAt),
  )).returning({ id: computerPairings.id });
  if (voided) addTraceEvent("computer_pairing.voided", { pairing_ref: pairing.row.id, reason: "cancelled" satisfies ComputerPairingVoidReason });
}

/**
 * The approval's claim (approveDeviceAuthorization's `claim`, in its
 * transaction): consumes the pairing only while it is live, linked to this
 * authorization, and not in conflict. A second request's void takes the same
 * row, so exactly one of them wins.
 */
export function claimComputerPairing(pairingRef: string, linkedAuthorizationId: string, now = new Date()): (tx: DatabaseExecutor) => Promise<boolean> {
  return async (tx) => {
    const [claimed] = await tx.update(computerPairings).set({ consumedAt: now }).where(and(
      eq(computerPairings.id, pairingRef),
      eq(computerPairings.linkedDeviceAuthorizationId, linkedAuthorizationId),
      gt(computerPairings.expiresAt, now),
      isNull(computerPairings.voidedAt),
      isNull(computerPairings.conflictAt),
      isNull(computerPairings.consumedAt),
    )).returning({ id: computerPairings.id });
    return Boolean(claimed);
  };
}

/** What authorize did with a pairing id it was sent. */
export type ComputerPairingLinkOutcome =
  | { outcome: "linked"; pairingRef: string; userId: string }
  | { outcome: "conflict"; pairingRef: string; userId: string }
  | { outcome: "ignored" };

type IgnoredReason = "malformed" | "not_pairable" | "server_unnamed" | "unknown" | "server_mismatch" | "not_live";

function ignored(reason: IgnoredReason, attrs: Record<string, string> = {}): ComputerPairingLinkOutcome {
  addTraceEvent("computer_pairing.ignored", { reason, ...attrs });
  return { outcome: "ignored" };
}

/**
 * authorize's optional `pairingId` (with `serverSlug`, the server the Computer
 * was told to join), after the device authorization was written. Links it to
 * a live pairing for that same server, or voids the pairing when one is linked
 * already. Anything else (no grant a pairing carries, a loopback request, an
 * unknown, ended or other server's pairing) leaves the authorization as it is:
 * never an error for the Computer.
 */
export async function linkComputerPairing(input: {
  rawPairingId: unknown;
  serverSlug: unknown;
  authorizationId: string;
  grantKind: DeviceLoginGrantKind | null;
  grantId: string | null;
}, now = new Date()): Promise<ComputerPairingLinkOutcome> {
  const pairingId = parsePairingId(input.rawPairingId);
  if (!pairingId) return ignored("malformed");
  const pairingHash = hashComputerPairingId(pairingId);
  const hashAttrs = { pairing_hash_prefix: hashPrefix(pairingHash) };
  if (!input.grantKind || !PAIRABLE_GRANT_KINDS.has(input.grantKind)) return ignored("not_pairable", hashAttrs);
  const slug = typeof input.serverSlug === "string" ? input.serverSlug.trim().replace(/^\//, "") : "";
  if (!slug || slug.length > SERVER_SLUG_MAX_LENGTH) return ignored("server_unnamed", hashAttrs);
  const db = getDb();
  const [pairing] = await db
    .select({ id: computerPairings.id, userId: computerPairings.userId, serverSlug: servers.slug })
    .from(computerPairings)
    .innerJoin(servers, and(eq(servers.id, computerPairings.serverId), isNull(servers.deletedAt)))
    .where(eq(computerPairings.pairingHash, pairingHash));
  if (!pairing) return ignored("unknown", hashAttrs);
  const refAttrs = { pairing_ref: pairing.id, ...(input.grantId ? { grant_id: input.grantId } : {}) };
  if (pairing.serverSlug !== slug) return ignored("server_mismatch", refAttrs);
  const live = and(
    eq(computerPairings.id, pairing.id),
    gt(computerPairings.expiresAt, now),
    isNull(computerPairings.voidedAt),
    isNull(computerPairings.consumedAt),
  );
  // First request: link it (CAS on an unlinked, live pairing).
  const [linked] = await db.update(computerPairings)
    .set({ linkedDeviceAuthorizationId: input.authorizationId })
    .where(and(live, isNull(computerPairings.linkedDeviceAuthorizationId)))
    .returning({ id: computerPairings.id });
  if (linked) {
    addTraceEvent("computer_pairing.linked", refAttrs);
    return { outcome: "linked", pairingRef: pairing.id, userId: pairing.userId };
  }
  // Any later request while it is still live: the id was seen by another
  // machine too. Void it; neither request is approvable through it.
  const [conflicted] = await db.update(computerPairings)
    .set({ conflictAt: now, voidedAt: now, voidReason: "conflict" })
    .where(and(live, isNotNull(computerPairings.linkedDeviceAuthorizationId), ne(computerPairings.linkedDeviceAuthorizationId, input.authorizationId)))
    .returning({ id: computerPairings.id });
  if (conflicted) {
    addTraceEvent("computer_pairing.voided", { ...refAttrs, reason: "conflict" satisfies ComputerPairingVoidReason });
    return { outcome: "conflict", pairingRef: pairing.id, userId: pairing.userId };
  }
  return ignored("not_live", refAttrs);
}
