import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { currentDate } from "@botiverse/raft-shared";
import {
  asLinkCardObjectRef, LINK_CARD_CHANGED_EVENT, type LinkCardChangedEvent, type LinkCardObjectKeySha256, type LinkCardObjectRef,
} from "@botiverse/raft-shared/src/appLinkPreview";
import { getDb } from "../db";
import { oauthAppLinkPreviews, oauthClients, serverMembers, servers } from "../db/schema";
import { parseStrictJsonBytes, type StrictJsonValue } from "../lib/strictJson";
import { socketUserServerRoom } from "../socket/platformScope";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { recordTraceEvent } from "../tracing/semanticTrace";
import { LINK_PREVIEW_PROOF_HARD_TTL_MS, provenWithin } from "./appLinkPreviewService";
import { createFixedWindowCounter } from "./fixedWindowRateLimit";
import type { LinkCardActionResponse } from "./linkCardActionService";
import {
  linkCardChangedHintsOn, linkCardObjectKeySha256, linkCardObjectReaders, linkCardReaderStore, trackLinkCardChangedWork, type LinkCardReader,
} from "./linkCardReaders";

// An App tells Raft its objects changed (docs/development/app-link-previews.md,
// "Telling Raft a card changed"): `POST /api/oauth/link-preview/changed`,
// `{ "objects": [object_ref, ...] }` with the App's Basic client credentials.
// Raft nudges the people who read a card of each object in the last 24 hours
// (linkCardReaders.ts) and are still members of the Server they read it on:
// `link_card.changed { app, object_key_sha256 }` to their own user+Server room.
// The nudge carries no content; each client reads the card again from the App
// with its own access, through the usual read path.
//
// An object key is (App id, object_ref), so an App only ever reaches readers
// of its own cards. The answer is always `202 { accepted }` once the
// credentials and body are good: it never says whether anyone reads an object,
// whether the App is eligible, or whether anything was sent.
//
// Merging repeats, per object, across replicas (the window lives in the
// store): the first change opens a 5-second window and is sent at once; more
// changes during it only mark it dirty, and the replica that opened it sends
// exactly one more when it closes the window after 5 seconds. The window key
// expires 2 seconds after that on its own, only for a replica that dies (or is
// restarted) holding it: then the trailing nudge of that window is lost, and so
// are changes in the next 2 seconds or so; those cards update on their next
// display, as without this feature.

/** Bodies are refused above this size before they are parsed. */
export const LINK_CARD_CHANGED_MAX_BODY_BYTES = 16 * 1024;
/** Objects per call. */
export const LINK_CARD_CHANGED_MAX_OBJECTS = 50;
/** Objects an App may name per minute, over all its calls (429 RATE_LIMITED past it). */
export const LINK_CARD_CHANGED_OBJECTS_PER_MINUTE = 600;
/** Nudges sent per App per minute, over all its objects; the rest are dropped and counted. */
export const LINK_CARD_CHANGED_NUDGES_PER_MINUTE = 20_000;
/** An object's coalescing window. */
export const LINK_CARD_CHANGED_WINDOW_MS = 5_000;
/** How long a window outlives its timer in the store: only matters when its replica dies holding it. */
const WINDOW_GRACE_MS = 2_000;
/** Readers whose membership is checked per query. */
const MEMBERSHIP_CHUNK = 500;

/** Trace event: nudges dropped over the App's per-minute cap (`app_id`, `app_key`, `count`). */
export const LINK_CARD_CHANGED_DROPPED_EVENT = "server.link_card.changed_dropped";
/** Trace event: an App's accepted call (`app_key`, `accepted`); never the objects. */
export const LINK_CARD_CHANGED_ACCEPTED_EVENT = "server.link_card.changed";

const FIELDS = new Set(["objects"]);
const BODY_SHAPE = `{ "objects": ["<object_ref>", ...] } with 1 to ${LINK_CARD_CHANGED_MAX_OBJECTS} entries`;
export type LinkCardChangedBody = { objects: LinkCardObjectRef[] } | { error: string };

/**
 * The raw body (already bounded in bytes), parsed strictly (invalid UTF-8,
 * duplicate keys, C0-control keys and broken Unicode refuse it), then
 * `{ objects }` and nothing else: 1-50 strings, each an object_ref (1-200
 * printable ASCII characters). Repeats are merged. Anything else is an error
 * naming the field (400); the error never echoes the body.
 */
export function parseLinkCardChangedBody(raw: unknown): LinkCardChangedBody {
  if (!(raw instanceof Uint8Array)) return { error: `The body must be JSON: ${BODY_SHAPE}.` };
  let body: { [key: string]: StrictJsonValue };
  try { body = parseStrictJsonBytes(raw); } catch { return { error: `The body must be one strict JSON object (UTF-8, no repeated keys): ${BODY_SHAPE}.` }; }
  if (Object.keys(body).some((key) => !FIELDS.has(key))) return { error: `Only the field objects is allowed: ${BODY_SHAPE}.` };
  const objects = Object.hasOwn(body, "objects") ? body.objects : undefined;
  if (!Array.isArray(objects) || objects.length < 1 || objects.length > LINK_CARD_CHANGED_MAX_OBJECTS) {
    return { error: `objects must be an array of 1 to ${LINK_CARD_CHANGED_MAX_OBJECTS} object_ref strings.` };
  }
  const refs: LinkCardObjectRef[] = [];
  for (const [index, value] of objects.entries()) {
    const ref = asLinkCardObjectRef(value);
    if (!ref) return { error: `objects[${index}] must be an object_ref: a string of 1 to 200 printable ASCII characters.` };
    refs.push(ref);
  }
  return { objects: [...new Set(refs)] };
}

/** Sends one nudge to one reader's own room on the Server they read on. */
export type LinkCardChangedHints = (reader: LinkCardReader, event: LinkCardChangedEvent) => void;
export const noLinkCardChangedHints: LinkCardChangedHints = () => {};
/** Nudges through this Socket.IO server (cross-replica through its adapter); none without one. */
export function linkCardChangedHints(io: SocketServer | null | undefined): LinkCardChangedHints {
  if (!io) return noLinkCardChangedHints;
  return (reader, event) => {
    try {
      io.to(socketUserServerRoom(reader.viewerId, reader.serverId)).emit(LINK_CARD_CHANGED_EVENT, event);
    } catch (error) {
      // Best effort: a lost nudge costs a card its live update, nothing more.
      console.error("[LinkCardChanged] emit failed", serializeErrorForLog(error));
    }
  };
}

/** The App whose objects changed: `id` names the objects and the nudges, `key` (its client key) is what logs carry. */
export type LinkCardChangedApp = { id: string; key: string; hints: LinkCardChangedHints };

const entryCounter = createFixedWindowCounter();
const nudgeCounter = createFixedWindowCounter();

/** Spends `count` of the App's per-minute object budget (429 past it). */
export function admitLinkCardChangedObjects(appId: string, count: number, nowMs = Date.now()) {
  return entryCounter.admit(`slock:link-card:changed:${appId}`, LINK_CARD_CHANGED_OBJECTS_PER_MINUTE, 60, nowMs, count);
}
/** Spends `count` nudges of the App's per-minute fan-out budget; answers how many may go. */
export function grantLinkCardChangedNudges(appId: string, count: number, nowMs = Date.now()) {
  return nudgeCounter.grant(`slock:link-card:changed_nudges:${appId}`, LINK_CARD_CHANGED_NUDGES_PER_MINUTE, 60, count, nowMs);
}

/**
 * The App's credentials are enabled (else 401, whatever its type) and its
 * link-preview registration may be read now: not suspended and proven within
 * the hard TTL, the checks a read makes before calling the App
 * (linkCardReadService.ts). An ineligible App's changes are taken and dropped.
 */
async function appHintState(appId: string): Promise<"disabled" | "ineligible" | "eligible"> {
  const [row] = await getDb().select({ enabled: oauthClients.enabled, verifiedAt: oauthAppLinkPreviews.verifiedAt, suspendedAt: oauthAppLinkPreviews.suspendedAt })
    .from(oauthClients).leftJoin(oauthAppLinkPreviews, eq(oauthAppLinkPreviews.clientId, oauthClients.id))
    .where(eq(oauthClients.id, appId)).limit(1);
  if (!row?.enabled) return "disabled";
  if (!row.verifiedAt || row.suspendedAt !== null || !provenWithin(row.verifiedAt, LINK_PREVIEW_PROOF_HARD_TTL_MS, currentDate())) return "ineligible";
  return "eligible";
}

export const LINK_CARD_CHANGED_INVALID_CLIENT: LinkCardActionResponse = { status: 401, body: { error: "Invalid client credentials", code: "INVALID_CLIENT" } };

/**
 * Takes an App's changed objects (the caller authenticated `app` and parsed
 * the body): 401 once its credentials are disabled; 429 RATE_LIMITED past 600
 * objects a minute (`Retry-After`, `retry_after`); otherwise 202
 * `{ accepted }`, the number of distinct objects taken, whether or not
 * anything is sent. The nudges go out in the background.
 */
export async function acceptLinkCardChanged(input: { app: LinkCardChangedApp; objects: readonly LinkCardObjectRef[] }): Promise<LinkCardActionResponse> {
  const { app, objects } = input;
  const state = await appHintState(app.id);
  if (state === "disabled") return LINK_CARD_CHANGED_INVALID_CLIENT;
  const budget = await admitLinkCardChangedObjects(app.id, objects.length);
  if (!budget.admitted) {
    return {
      status: 429, retryAfterSeconds: budget.retryAfterSeconds,
      body: { error: "Too many changed objects for this App. Wait for Retry-After before the next call.", code: "RATE_LIMITED", retry_after: budget.retryAfterSeconds },
    };
  }
  recordTraceEvent(LINK_CARD_CHANGED_ACCEPTED_EVENT, { app_key: app.key, accepted: objects.length });
  if (state === "eligible") {
    const objectKeys = objects.map((ref) => linkCardObjectKeySha256(app.id, ref));
    trackLinkCardChangedWork(changed(app, objectKeys));
  }
  return { status: 202, body: { accepted: objects.length } };
}

type Schedule = (ms: number, run: () => void) => void;
const defaultSchedule: Schedule = (ms, run) => { setTimeout(run, ms).unref?.(); };

/**
 * The coalescing step (exported for its own test): opens or marks each
 * object's window, sends the opened ones now, and after the window closes the
 * ones it opened, sending once more those marked meanwhile. `send` never
 * throws here: failures are logged with the App key and a count.
 */
export function createLinkCardChangedCoalescer(deps: {
  send: (app: LinkCardChangedApp, objectKeys: LinkCardObjectKeySha256[], trailing: boolean) => Promise<void>;
  windowMs?: number;
  schedule?: Schedule;
}) {
  const windowMs = deps.windowMs ?? LINK_CARD_CHANGED_WINDOW_MS;
  const schedule = deps.schedule ?? defaultSchedule;
  const guarded = async (app: LinkCardChangedApp, step: string, count: number, work: () => Promise<void>) => {
    try { await work(); } catch (error) {
      console.warn(`[LinkCardChanged] ${step} failed`, { app_key: app.key, objects: count, error: serializeErrorForLog(error) });
    }
  };
  return async function changed(app: LinkCardChangedApp, objectKeys: readonly LinkCardObjectKeySha256[]): Promise<void> {
    const token = randomUUID();
    const opened: LinkCardObjectKeySha256[] = [];
    await guarded(app, "change window", objectKeys.length, async () => {
      const store = linkCardReaderStore();
      // Sequential, at most 50 short calls: one window per object.
      for (const objectKey of objectKeys) if (await store.openOrMark(objectKey, token, windowMs + WINDOW_GRACE_MS)) opened.push(objectKey);
    });
    if (!opened.length) return;
    schedule(windowMs, () => trackLinkCardChangedWork(guarded(app, "trailing nudge", opened.length, async () => {
      const store = linkCardReaderStore();
      const dirty: LinkCardObjectKeySha256[] = [];
      for (const objectKey of opened) if (await store.close(objectKey, token)) dirty.push(objectKey);
      if (dirty.length) await deps.send(app, dirty, true);
    })));
    await guarded(app, "nudge", opened.length, () => deps.send(app, opened, false));
  };
}

/**
 * Of these readers, the ones still members of the Server they read on (a
 * Server not deleted), as `viewerId:serverId`: one query per 500 readers.
 */
export async function linkCardReadersStillMembers(readers: readonly LinkCardReader[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let at = 0; at < readers.length; at += MEMBERSHIP_CHUNK) {
    const pairs = readers.slice(at, at + MEMBERSHIP_CHUNK).map((reader) => sql`(${reader.viewerId}::uuid, ${reader.serverId}::uuid)`);
    const rows = await getDb().select({ userId: serverMembers.userId, serverId: serverMembers.serverId }).from(serverMembers)
      .innerJoin(servers, eq(servers.id, serverMembers.serverId))
      .where(sql`${servers.deletedAt} IS NULL AND (${serverMembers.userId}, ${serverMembers.serverId}) IN (${sql.join(pairs, sql`, `)})`);
    for (const row of rows) found.add(`${row.userId}:${row.serverId}`);
  }
  return found;
}

/**
 * Nudges each object's recent readers who are still members of the Server
 * they read on, where `link_card_changed_hints` is on for it, within the App's
 * per-minute fan-out budget. A trailing send first checks the App is still
 * eligible (it may have been suspended during the window).
 *
 * The budget is taken first, for every (reader, object) recorded, and the list
 * is cut to what it grants before any membership or flag lookup: the cap bounds
 * the database work as well as the sends. The ones cut are dropped and counted.
 * A granted reader then left out (no longer a member, or the flag off for its
 * Server) has still spent its unit; that only makes the cap stricter, and is
 * accepted. `stillMembers` is replaceable for tests only.
 */
export async function sendLinkCardChangedNudges(
  app: LinkCardChangedApp, objectKeys: LinkCardObjectKeySha256[], trailing: boolean, stillMembers = linkCardReadersStillMembers,
): Promise<void> {
  if (trailing && await appHintState(app.id) !== "eligible") return;
  const readers = await linkCardObjectReaders(objectKeys, Date.now());
  const candidates = objectKeys.flatMap((objectKey, index) => readers[index]!.map((reader) => ({ reader, objectKey })));
  if (!candidates.length) return;
  const granted = await grantLinkCardChangedNudges(app.id, candidates.length);
  if (granted < candidates.length) {
    const dropped = candidates.length - granted;
    recordTraceEvent(LINK_CARD_CHANGED_DROPPED_EVENT, { app_id: app.id, app_key: app.key, count: dropped });
    console.warn("[LinkCardChanged] nudges over the per-App cap dropped", { app_key: app.key, dropped, granted });
  }
  const kept = candidates.slice(0, granted);
  if (!kept.length) return;
  const distinct = new Map<string, LinkCardReader>();
  for (const { reader } of kept) distinct.set(`${reader.viewerId}:${reader.serverId}`, reader);
  const members = await stillMembers([...distinct.values()]);
  const serverIds = [...new Set([...distinct.values()].filter((reader) => members.has(`${reader.viewerId}:${reader.serverId}`)).map((reader) => reader.serverId))];
  if (!serverIds.length) return;
  const on = await linkCardChangedHintsOn(serverIds);
  const hinted = new Set(serverIds.filter((_, index) => on[index]));
  for (const { reader, objectKey } of kept) {
    if (hinted.has(reader.serverId) && members.has(`${reader.viewerId}:${reader.serverId}`)) app.hints(reader, { app: app.id, object_key_sha256: objectKey });
  }
}

const changed = createLinkCardChangedCoalescer({ send: (app, objectKeys, trailing) => sendLinkCardChangedNudges(app, objectKeys, trailing) });

/** @internal Tests: forget this process's object and nudge budgets. */
export function __resetLinkCardChangedLimitsForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Link card changed hooks are test-only");
  entryCounter.clear();
  nudgeCounter.clear();
}
