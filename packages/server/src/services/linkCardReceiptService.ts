import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { linkCardToastSchema } from "@botiverse/raft-shared/src/appLinkPreview";
import { getDb, type DatabaseExecutor } from "../db";
import { linkCardAttempts, linkCardClientRequests, linkCardOperations, linkCardViews, type LinkCardOperationState } from "../db/schema";
import { parseStrictJson } from "../lib/strictJson";
import { admitLinkCardAction } from "./linkCardActionLimits";
import {
  callLinkCardActionEndpoint, LINK_CARD_STATE_HINTS, linkCardRateLimited, type LinkCardActionResponse, type LinkCardCallResult,
} from "./linkCardActionService";
import {
  linkCardReceiptAccess, linkCardReceiptReadable, linkCardStatusTargetInForce, matchLinkCardUrlIdentity, type LinkCardMessageReader,
} from "./linkCardLiveState";
import type { LinkCardReceiptHints } from "./linkCardReceiptHints";
import { LINK_CARD_TOKEN_MAX_TTL_SECONDS, linkCardExecuteJti, signLinkCardOperationsCursor, verifyLinkCardOperationsCursor } from "./linkCardTokens";
import { signCardActionAssertion } from "./oidcService";

// Interactive link card receipts after the send (RFC 076 §6.4, rules 6-8;
// protocol v3.2.3 §5.4, §7.4, §8.1, §8.2 (2)-(3)):
// - `POST /api/link-cards/status { operation_id }` answers from Raft's records
//   and, when it may, forwards `phase: status` to the App in the same request.
// - `GET /api/link-cards/operations` looks operations up by `operation_id`, by
//   `client_request_id`, or by message and URL digest with a signed cursor.
// Both check the viewer's live access only (rule 6): the viewer and Server from
// the session own the operation, the App is still enabled with the original
// installation active, the viewer's consent holds, and the viewer can still
// read the message. Not the handle, official eligibility, card freshness or
// the current revision: they keep working after
// any of those changes (RFC 076 §9), and status never answers 410.
//
// Raft's own records answer only with ids, a coarse state, the receipt
// revision and Raft's fixed, object-free hint. An App's toast, code or
// attribution reaches the viewer only from a status forwarded in this same
// request, when the viewer may read the receipt now AND the App's current
// object-read check for the operation's executor passed (its answer is not
// `not_visible`). Raft never stores them, so they are never replayed.
//
// No network call runs under a database lock: a short transaction decides
// whether and where to forward and records the attempt, the App is called
// after it commits, and a second short transaction applies the answer.

/** Status bodies are refused above this size before they are parsed. */
export const LINK_CARD_STATUS_MAX_BODY_BYTES = 4 * 1024;
/**
 * A status is forwarded to the App at most this often per operation, the
 * shortest step of the client cadence (2 s, 5 s, 15 s, 60 s, then every 5
 * minutes; RFC 076 §6.4). A status inside the window, from another tab say, is
 * answered from Raft's records. Operating parameter.
 */
export const LINK_CARD_STATUS_FORWARD_INTERVAL_MS = 2000;
/** The by-URL lookup's page size (protocol §5.4). */
export const LINK_CARD_LOOKUP_PAGE_SIZE = 20;
/** Operations one `client_request_id` can name for a viewer on a Server (one per identity domain); bounded anyway. */
const CLIENT_REQUEST_LOOKUP_LIMIT = 20;
/** The states the by-URL lookup returns: what can still be in progress or needs reconciling. */
const OPEN_STATES = ["sent", "accepted", "unknown", "needs_reconciliation"] as const satisfies readonly LinkCardOperationState[];
const TERMINAL_STATES = ["done", "refused", "failed_not_sent", "resolved_manually"] as const satisfies readonly LinkCardOperationState[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._~:-]{16,128}$/;
const MAX_CURSOR_LENGTH = 2048;

const fail = (status: number, code: string, error: string): LinkCardActionResponse => ({ status, body: { error, code } });
const INVALID_REQUEST = fail(400, "INVALID_REQUEST", "Invalid link card request");
const INVALID_CURSOR = fail(400, "INVALID_CURSOR", "This page cursor does not belong to this lookup. Start from the first page.");
const NOT_FOUND = fail(404, "NOT_FOUND", "Not found");

// ---------------------------------------------------------------------------
// Requests: strict, own properties only.

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** `{ operation_id }`; anything else is null (400). */
export function parseLinkCardStatusBody(body: unknown): { operationId: string } | null {
  if (!isPlainObject(body) || Object.keys(body).length !== 1 || !Object.hasOwn(body, "operation_id")) return null;
  const operationId = body.operation_id;
  return typeof operationId === "string" && UUID.test(operationId) ? { operationId } : null;
}

export type LinkCardOperationsQuery =
  | { kind: "operation"; operationId: string }
  | { kind: "client_request"; clientRequestId: string }
  | { kind: "url"; messageId: string; urlSha256: string; cursor: string | null };

/**
 * Exactly one of `?operation_id=`, `?client_request_id=`, or
 * `?message_id=&url_sha256=` with an optional `cursor`; each once, nothing
 * else. Anything else is null (400).
 */
export function parseLinkCardOperationsQuery(query: unknown): LinkCardOperationsQuery | null {
  if (!query || typeof query !== "object" || Array.isArray(query)) return null;
  const params = query as Record<string, unknown>;
  const names = Object.keys(params);
  if (!names.every((name) => typeof params[name] === "string")) return null;
  const value = (name: string) => params[name] as string;
  const only = (...allowed: string[]) => names.every((name) => allowed.includes(name));
  if (names.length === 1 && names[0] === "operation_id") return UUID.test(value("operation_id")) ? { kind: "operation", operationId: value("operation_id") } : null;
  if (names.length === 1 && names[0] === "client_request_id") {
    return CLIENT_REQUEST_ID.test(value("client_request_id")) ? { kind: "client_request", clientRequestId: value("client_request_id") } : null;
  }
  if (!only("message_id", "url_sha256", "cursor") || !names.includes("message_id") || !names.includes("url_sha256")) return null;
  const cursor = names.includes("cursor") ? value("cursor") : null;
  if (!UUID.test(value("message_id")) || !SHA256.test(value("url_sha256")) || (cursor !== null && (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH))) return null;
  return { kind: "url", messageId: value("message_id"), urlSha256: value("url_sha256"), cursor };
}

// ---------------------------------------------------------------------------
// Answers.

type OperationRow = typeof linkCardOperations.$inferSelect;

/** The private part of a forwarded status: shown only when both gates passed in this request. */
export type LinkCardAppResult = { toast?: { tone: "info" | "success" | "warning"; text: string }; code?: string; attribution?: string };

/** One receipt from Raft's records: ids, coarse state, revision and the fixed hint. Never App text. */
function receiptItem(row: Pick<OperationRow, "operationId" | "state" | "receiptRevision">) {
  const state = row.state === "requested" ? "sent" : row.state;
  return { operation_id: row.operationId, state, receipt_revision: row.receiptRevision, hint: LINK_CARD_STATE_HINTS[state] };
}

/**
 * The viewer's own operation on this Server, by id; null otherwise. Another
 * viewer's operation, or the viewer's own on another Server, is
 * indistinguishable from none (404).
 */
async function ownOperation(db: DatabaseExecutor, viewerId: string, serverId: string, operationId: string): Promise<OperationRow | null> {
  const [row] = await db.select().from(linkCardOperations)
    .where(and(eq(linkCardOperations.operationId, operationId), eq(linkCardOperations.viewerId, viewerId), eq(linkCardOperations.serverId, serverId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Test seams.

type Hooks = {
  /** Status: after the forward is recorded, before the App is called. */
  beforeStatusCall?: (operationId: string) => Promise<void> | void;
  /** Status: after the App answered, before the answer is applied. */
  afterStatusAnswer?: (operationId: string) => Promise<void> | void;
  /** The per-operation forward interval, shortened in tests. */
  forwardIntervalMs?: number;
};
let hooks: Hooks = {};
export function __setLinkCardReceiptHooksForTests(value: Hooks | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("Link card receipt hooks are test-only");
  hooks = value ?? {};
}

// ---------------------------------------------------------------------------
// Status (RFC 076 §6.4; protocol §5.4, §8.2).

/**
 * `POST /api/link-cards/status`. 404 for an operation that is not the
 * viewer's on this Server; `{ operation_id, state: "not_visible" }` when it is
 * theirs but they may not read its receipt now (that never means "not
 * executed"); otherwise the receipt, after forwarding to the App if it may.
 */
export async function readLinkCardOperationStatus(input: {
  viewerId: string; serverId: string; operationId: string; locale: string; readMessage: LinkCardMessageReader; hints: LinkCardReceiptHints;
}): Promise<LinkCardActionResponse> {
  const budget = await admitLinkCardAction("status", input.viewerId, input.serverId);
  if (!budget.admitted) return linkCardRateLimited(budget.retryAfterSeconds);
  const op = await ownOperation(getDb(), input.viewerId, input.serverId, input.operationId);
  if (!op) return NOT_FOUND;
  // Gate 1: the viewer's live access to the receipt.
  const access = await linkCardReceiptAccess(op, input.readMessage);
  if (!access) return { status: 200, body: { operation_id: op.operationId, state: "not_visible" } };

  const forward = await beginStatusForward(op);
  if (forward.change) input.hints({ viewerId: op.viewerId, serverId: op.serverId, operationId: op.operationId, receiptRevision: forward.change });
  if (forward.kind === "records") return { status: 200, body: receiptItem(forward.row) };

  await hooks.beforeStatusCall?.(op.operationId);
  // The JWT and body_sha256 cover these exact bytes. `sub` is the operation's
  // own executor (addendum 1 §6), who is also the session's viewer here.
  const body = JSON.stringify({ version: 2, phase: "status", operation_id: op.operationId, locale: input.locale });
  const assertion = signCardActionAssertion({
    phase: "status", clientKey: forward.audienceKey, userId: op.viewerId, serverId: op.serverId, serverRole: access.serverRole,
    installationId: op.installationKey, messageId: op.messageId, urlSha256: op.urlSha256, body, jti: forward.jti, now: currentDate(),
  });
  const answer = readStatusAnswer(await callLinkCardActionEndpoint(forward.endpoint, body, assertion, input.locale));
  await hooks.afterStatusAnswer?.(op.operationId);
  const applied = await getDb().transaction((tx) => applyStatusAnswer(tx, op, forward.jti, answer));
  if (applied.moved) input.hints({ viewerId: op.viewerId, serverId: op.serverId, operationId: op.operationId, receiptRevision: applied.row.receiptRevision });
  // Gate 2 is the App's answer above (valid, not `not_visible`). Gate 1 is
  // asked again after it: access lost while the App was asked shows nothing private.
  const appResult = answer.appResult && await linkCardReceiptReadable(op, input.readMessage) ? answer.appResult : null;
  return { status: 200, body: { ...receiptItem(applied.row), ...(appResult ? { app_result: appResult } : {}) } };
}

type StatusForward =
  | { kind: "records"; row: OperationRow; change: number | null }
  | { kind: "send"; endpoint: string; audienceKey: string; jti: string; change: null };

/**
 * One short transaction, the operation row locked: whether to forward, and where.
 * - Not forwarded: `sent` (its execute answer is still due; status moves
 *   nothing from `sent`), `resolved_manually` (closed by a person), and an
 *   operation with no execute dispatch record (the App never saw it).
 * - Not forwarded, and `accepted`/`unknown` -> `needs_reconciliation`: the
 *   endpoint its execute went to is no longer approved and in force for its
 *   own App (rule 8; linkCardStatusTargetInForce). Credentials never go
 *   anywhere else.
 * - Not forwarded within the per-operation interval.
 * Otherwise the status attempt is recorded (audit, protocol §8.8) before
 * anything is signed or sent, and `last_status_at` moves.
 */
async function beginStatusForward(op: OperationRow): Promise<StatusForward> {
  const intervalMs = hooks.forwardIntervalMs ?? LINK_CARD_STATUS_FORWARD_INTERVAL_MS;
  try {
    return await getDb().transaction(async (tx): Promise<StatusForward> => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      const locked = await tx.execute<{ state: LinkCardOperationState; due: boolean; dispatched: boolean }>(sql`SELECT state,
          (last_status_at IS NULL OR last_status_at <= clock_timestamp() - make_interval(secs => ${intervalMs / 1000})) AS due,
          EXISTS (SELECT 1 FROM ${linkCardAttempts} a WHERE a.jti = ${linkCardExecuteJti(op.operationId)} AND a.operation_id = ${op.operationId} AND a.phase = 'execute') AS dispatched
        FROM ${linkCardOperations} WHERE operation_id = ${op.operationId} FOR UPDATE`);
      const current = locked.rows[0];
      const row = async () => (await ownOperation(tx, op.viewerId, op.serverId, op.operationId)) ?? op;
      if (!current || current.state === "requested" || current.state === "sent" || current.state === "resolved_manually" || current.dispatched !== true) {
        return { kind: "records", row: await row(), change: null };
      }
      const target = await linkCardStatusTargetInForce(tx, op);
      if (target === null) {
        const [moved] = await tx.update(linkCardOperations)
          .set({ state: "needs_reconciliation", receiptRevision: sql`${linkCardOperations.receiptRevision} + 1`, updatedAt: sql`now()` })
          .where(and(eq(linkCardOperations.operationId, op.operationId), inArray(linkCardOperations.state, ["accepted", "unknown"])))
          .returning();
        return moved ? { kind: "records", row: moved, change: moved.receiptRevision } : { kind: "records", row: await row(), change: null };
      }
      if (current.due !== true) return { kind: "records", row: await row(), change: null };
      const jti = randomUUID();
      await tx.insert(linkCardAttempts).values({
        jti, viewerId: op.viewerId, serverId: op.serverId, providerKind: op.providerKind, providerKey: op.providerKey, installationKey: op.installationKey,
        operationId: op.operationId, phase: "status",
      });
      await tx.update(linkCardOperations).set({ lastStatusAt: sql`clock_timestamp()` }).where(eq(linkCardOperations.operationId, op.operationId));
      return { kind: "send", endpoint: target.endpoint, audienceKey: target.audienceKey, jti, change: null };
    });
  } catch (error) {
    // Busy (a lock wait passed lock_timeout): answer from the records, forward next time.
    const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
    if (code !== "55P03") throw error;
    return { kind: "records", row: (await ownOperation(getDb(), op.viewerId, op.serverId, op.operationId)) ?? op, change: null };
  }
}

type StatusAnswer = {
  /** The transition the answer asks for, if any (protocol §8.1). */
  next: "accepted" | "done" | "refused" | "failed_not_sent" | null;
  /** Recorded on the attempt. */
  outcome: string;
  /** The App's private result, present only when its object-read check passed. */
  appResult: LinkCardAppResult | null;
};

const STATUS_FIELDS = new Set(["status", "code", "attribution", "toast"]);
const STATUS_VALUES = new Set(["accepted", "executing", "done", "refused", "failed_not_sent", "unknown", "not_visible"]);
const codePoints = (value: string) => [...value].length;
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && codePoints(value) >= 1 && codePoints(value) <= max;

/**
 * The App's status answer, parsed strictly from the raw text (protocol §10.1;
 * C0-control keys, duplicate keys and broken Unicode refuse it):
 * `{ status, code?, attribution?, toast? }` with `status` one of accepted,
 * executing, done, refused, failed_not_sent, unknown or not_visible, a toast
 * as protocol §4.4, `code` 1-64 and `attribution` 1-200 code points. Anything
 * else, no answer within the budget or a transport failure moves nothing and
 * shows nothing private. `not_visible` (the App's current object-read check
 * for `sub` failed) moves nothing and shows nothing private either, and it
 * never means "not executed".
 */
function readStatusAnswer(result: LinkCardCallResult): StatusAnswer {
  const none = (outcome: string): StatusAnswer => ({ next: null, outcome, appResult: null });
  if (result.kind === "timeout") return none("timeout");
  if (result.kind === "not_sent") return none("not_sent");
  if (result.kind !== "answered") return none("transport_error");
  let answer: Record<string, unknown>;
  try { answer = parseStrictJson(result.text); } catch { return none("invalid_answer"); }
  const status = answer.status;
  if (typeof status !== "string" || !STATUS_VALUES.has(status) || Object.keys(answer).some((key) => !STATUS_FIELDS.has(key))) return none("invalid_answer");
  if (Object.hasOwn(answer, "code") && !boundedText(answer.code, 64)) return none("invalid_answer");
  if (Object.hasOwn(answer, "attribution") && !boundedText(answer.attribution, 200)) return none("invalid_answer");
  const toast = Object.hasOwn(answer, "toast") ? linkCardToastSchema.safeParse(answer.toast) : null;
  if (toast && !toast.success) return none("invalid_answer");
  const outcome = `answered:${status}`;
  const next = status === "accepted" || status === "executing" ? "accepted"
    : status === "done" || status === "refused" || status === "failed_not_sent" ? status : null;
  if (status === "not_visible") return { next: null, outcome, appResult: null };
  const appResult: LinkCardAppResult = {
    ...(toast?.success ? { toast: toast.data } : {}),
    ...(Object.hasOwn(answer, "code") ? { code: answer.code as string } : {}),
    ...(Object.hasOwn(answer, "attribution") ? { attribution: answer.attribution as string } : {}),
  };
  return { next, outcome, appResult: Object.keys(appResult).length ? appResult : null };
}

/**
 * The App's status answer as one conditional transition (protocol §8.1; the
 * 0387 trigger enforces it for every writer): `accepted`/`executing` moves only
 * `unknown` to `accepted`; a terminal answer moves `accepted`, `unknown` or
 * `needs_reconciliation` (the reconciliation exit) to it. Nothing moves back,
 * and a terminal operation never moves. A terminal move releases the view on
 * the expected id. The attempt records the outcome either way.
 */
async function applyStatusAnswer(tx: DatabaseExecutor, op: OperationRow, jti: string, answer: StatusAnswer): Promise<{ row: OperationRow; moved: boolean }> {
  await tx.update(linkCardAttempts).set({ outcome: answer.outcome }).where(eq(linkCardAttempts.jti, jti));
  if (answer.next) {
    const from: LinkCardOperationState[] = answer.next === "accepted" ? ["unknown"] : ["accepted", "unknown", "needs_reconciliation"];
    const [moved] = await tx.update(linkCardOperations)
      .set({ state: answer.next, receiptRevision: sql`${linkCardOperations.receiptRevision} + 1`, updatedAt: sql`now()` })
      .where(and(eq(linkCardOperations.operationId, op.operationId), inArray(linkCardOperations.state, from)))
      .returning();
    if (moved) {
      if ((TERMINAL_STATES as readonly string[]).includes(moved.state)) {
        await tx.update(linkCardViews).set({ pendingOperationId: null })
          .where(and(eq(linkCardViews.viewNonce, op.viewNonce), eq(linkCardViews.pendingOperationId, op.operationId)));
      }
      return { row: moved, moved: true };
    }
  }
  return { row: (await ownOperation(tx, op.viewerId, op.serverId, op.operationId)) ?? op, moved: false };
}

// ---------------------------------------------------------------------------
// Operation lookups (RFC 076 §6.4; protocol §5.4, §7.4; T1).

/**
 * `GET /api/link-cards/operations`. Calls no App and writes nothing.
 * - `operation_id`: the viewer's own operation on this Server (any state), or
 *   404; `{ operation_id, state: "not_visible" }` when its receipt is not
 *   readable now.
 * - `client_request_id`: the viewer's own operations on this Server mapped from
 *   that id (one per identity domain), in `(created_at, operation_id)` order;
 *   an unreadable one is `{ state: "not_visible" }`, as execute's recovery
 *   answers it.
 * - `message_id` + `url_sha256` (+ `cursor`): the viewer's open operations on
 *   that link whose stored identity domain equals the one the link matches now,
 *   at most 20 per page ascending by `(created_at, operation_id)`, with a
 *   signed cursor to the next page. Re-authorized on every page: a message the
 *   viewer can no longer read, a link no longer in it, or a link that matches
 *   no provider now is an empty page; a cursor for another viewer, Server,
 *   identity domain, message or link is 400.
 * Every answer is `{ operations: [...], next_cursor }`.
 */
export async function lookupLinkCardOperations(input: {
  viewerId: string; serverId: string; query: LinkCardOperationsQuery; readMessage: LinkCardMessageReader;
}): Promise<LinkCardActionResponse> {
  const budget = await admitLinkCardAction("lookup", input.viewerId, input.serverId);
  if (!budget.admitted) return linkCardRateLimited(budget.retryAfterSeconds);
  const { query } = input;
  const page = (operations: unknown[], nextCursor: string | null = null): LinkCardActionResponse =>
    ({ status: 200, body: { operations, next_cursor: nextCursor } });

  if (query.kind === "operation") {
    const op = await ownOperation(getDb(), input.viewerId, input.serverId, query.operationId);
    if (!op) return NOT_FOUND;
    return page([await linkCardReceiptReadable(op, input.readMessage) ? receiptItem(op) : { operation_id: op.operationId, state: "not_visible" }]);
  }

  if (query.kind === "client_request") {
    const rows = await getDb().select({ op: linkCardOperations }).from(linkCardClientRequests)
      .innerJoin(linkCardOperations, eq(linkCardOperations.operationId, linkCardClientRequests.operationId))
      .where(and(eq(linkCardClientRequests.viewerId, input.viewerId), eq(linkCardClientRequests.serverId, input.serverId),
        eq(linkCardClientRequests.clientRequestId, query.clientRequestId),
        eq(linkCardOperations.viewerId, input.viewerId), eq(linkCardOperations.serverId, input.serverId)))
      .orderBy(asc(linkCardOperations.createdAt), asc(linkCardOperations.operationId))
      .limit(CLIENT_REQUEST_LOOKUP_LIMIT);
    const items = [];
    for (const { op } of rows) items.push(await linkCardReceiptReadable(op, input.readMessage) ? receiptItem(op) : { state: "not_visible" });
    return page(items);
  }

  const now = currentDate();
  const cursor = query.cursor === null ? null : verifyLinkCardOperationsCursor(query.cursor, now);
  if (query.cursor !== null && (!cursor || cursor.viewerId !== input.viewerId || cursor.serverId !== input.serverId
    || cursor.messageId !== query.messageId || cursor.urlSha256 !== query.urlSha256)) return INVALID_CURSOR;
  // Re-authorized on every page: the message as the viewer may read it now,
  // and the provider the link matches now (linkCardLiveState.ts).
  const identity = await matchLinkCardUrlIdentity({
    viewerId: input.viewerId, serverId: input.serverId, messageId: query.messageId, urlSha256: query.urlSha256, readMessage: input.readMessage, now,
  });
  if (!identity) return page([]);
  if (cursor && (cursor.providerKind !== identity.providerKind || cursor.providerKey !== identity.providerKey || cursor.installationKey !== identity.installationKey)) {
    return INVALID_CURSOR;
  }
  const rows = await getDb().select().from(linkCardOperations)
    .where(and(
      eq(linkCardOperations.viewerId, input.viewerId), eq(linkCardOperations.serverId, input.serverId),
      eq(linkCardOperations.messageId, query.messageId), eq(linkCardOperations.urlSha256, query.urlSha256),
      inArray(linkCardOperations.state, [...OPEN_STATES]),
      eq(linkCardOperations.providerKind, identity.providerKind), eq(linkCardOperations.providerKey, identity.providerKey),
      eq(linkCardOperations.installationKey, identity.installationKey),
      cursor ? sql`(${linkCardOperations.createdAt}, ${linkCardOperations.operationId}) > (to_timestamp(${cursor.lastCreatedAt}), ${cursor.lastOperationId}::uuid)` : undefined,
    ))
    .orderBy(asc(linkCardOperations.createdAt), asc(linkCardOperations.operationId))
    .limit(LINK_CARD_LOOKUP_PAGE_SIZE + 1);
  const shown = rows.slice(0, LINK_CARD_LOOKUP_PAGE_SIZE);
  const last = shown.at(-1);
  const iat = Math.floor(now.getTime() / 1000);
  const next = rows.length > LINK_CARD_LOOKUP_PAGE_SIZE && last ? signLinkCardOperationsCursor({
    viewerId: input.viewerId, serverId: input.serverId, ...identity, messageId: query.messageId, urlSha256: query.urlSha256,
    // Whole seconds are exact: link_card_operations.created_at is held to whole
    // seconds by a CHECK (migration 0400), and operation_id breaks ties.
    lastCreatedAt: Math.floor(last.createdAt.getTime() / 1000), lastOperationId: last.operationId, iat, exp: iat + LINK_CARD_TOKEN_MAX_TTL_SECONDS,
  }) : null;
  // The match above implies every operation of this identity domain is readable
  // (enabled App, active installation, consent, no decline, the message).
  return page(shown.map(receiptItem), next);
}
