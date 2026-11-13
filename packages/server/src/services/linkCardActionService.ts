import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db";
import {
  linkCardAttempts, linkCardClientRequests, linkCardHandleUses, linkCardOperations, linkCardPreparedActions, linkCardUpdateTokens, linkCardViews,
  type LinkCardOperationState,
} from "../db/schema";
import { canonicalJsonSha256 } from "../lib/canonicalJson";
import { parseStrictJson, type StrictJsonValue } from "../lib/strictJson";
import { linkCardOpenOperations } from "../metrics";
import { PreviewNotSentError } from "./appLinkPreviewHttp";
import { linkPreviewAudienceKey, previewTransport } from "./appLinkPreviewService";
import { admitLinkCardAction, admitLinkCardAppExecute } from "./linkCardActionLimits";
import { linkCardPreparedDigest, parseLinkCardPreparedDescription, type LinkCardPreparedDescription } from "./linkCardDescription";
import {
  linkCardDispatchTargetInForce, linkCardReceiptReadable, linkCardViewMatches, lockLinkCardActionEligibility, recheckLinkCardViewerInTransaction,
  verifyLinkCardActionAgainstLiveState, type LinkCardLiveState, type LinkCardMessageReader,
} from "./linkCardLiveState";
import { noLinkCardReceiptHints, type LinkCardReceiptHints } from "./linkCardReceiptHints";
import {
  linkCardExecuteJti, linkCardSelectorMatchesHandle, readLinkCardHandleSelector, verifyLinkCardHandle,
  type LinkCardHandleClaims, type LinkCardHandleSelector, type LinkCardProviderKind,
} from "./linkCardTokens";
import { CardActionPastDeadlineError, signCardActionAssertion } from "./oidcService";

// Interactive link card actions up to and including the send (RFC 076 §6.2,
// §6.3; protocol v3.2.3 §5.2, §5.3): `POST /api/link-cards/prepare` and
// `POST /api/link-cards/execute`. What follows the send is in
// linkCardReceiptService.ts (status, operation lookups) and
// linkCardUpdateService.ts (the App's terminal update); every receipt change
// here and there is hinted to the viewer (linkCardReceiptHints.ts).
//
// Every comparison of a handle with live state goes through
// linkCardLiveState.ts (one entry point for both endpoints). No network call
// runs under a database lock: prepare calls the App after its one short write,
// and execute sends only after its admission transaction and its dispatch
// transaction have both committed.

/** The synchronous budget of a prepare or execute call to an App (protocol §5.1, Q-A2). */
export const LINK_CARD_ACTION_BUDGET_MS = 2500;
/** Request bodies are refused above these sizes before they are parsed. */
export const LINK_CARD_PREPARE_MAX_BODY_BYTES = 16 * 1024;
export const LINK_CARD_EXECUTE_MAX_BODY_BYTES = 64 * 1024;
/** Open-operation caps (RFC 076 §5.2; protocol §13.2). Operating parameters, not load-tested. */
export const LINK_CARD_VIEWER_OPEN_CAP = 20;
export const LINK_CARD_INSTALLATION_OPEN_CAP = 1000;
/** Lifetime of a prepared record (addendum 1 §6), also capped by the handle's exp. */
const PREPARED_TTL_MS = 5 * 60_000;
const MAX_HANDLE_LENGTH = 4096;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9._~:-]{16,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TERMINAL: readonly LinkCardOperationState[] = ["done", "refused", "failed_not_sent", "resolved_manually"];

export type LinkCardActionResponse = { status: number; body: Record<string, unknown>; retryAfterSeconds?: number };

const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): LinkCardActionResponse =>
  ({ status, body: { error, code, ...extra } });
const INVALID_REQUEST = fail(400, "INVALID_REQUEST", "Invalid link card request");
const PREPARE_REQUIRED = fail(400, "PREPARE_REQUIRED", "This action needs a confirmation first");
const PREPARED_NOT_ALLOWED = fail(400, "PREPARED_NOT_ALLOWED", "This action takes no confirmation");
const NOT_FOUND = fail(404, "NOT_FOUND", "Not found");
const HANDLE_INVALID = fail(410, "HANDLE_INVALID", "This card is out of date. Refresh it and try again.");
const PREPARED_INVALID = fail(410, "PREPARED_INVALID", "This confirmation is out of date. Try again.");
const NOT_ELIGIBLE = fail(410, "PROVIDER_NOT_ELIGIBLE", "This app can't run card actions right now.");
const VIEW_PENDING = fail(409, "VIEW_PENDING", "An earlier action on this card is still in progress.");
const CLIENT_REQUEST_CONFLICT = fail(409, "CLIENT_REQUEST_CONFLICT", "This request id was already used for a different action.");
const OPEN_OPERATIONS_CAP = fail(429, "OPEN_OPERATIONS_CAP", "Can't run this right now, try later");
const LOCK_TIMEOUT = fail(429, "LOCK_TIMEOUT", "Busy. Try again with the same request.");
const PREPARE_FAILED = fail(502, "PREPARE_FAILED", "The app could not prepare this action. Try again.");
const UNAVAILABLE = fail(503, "UNAVAILABLE", "Couldn't run this right now. Try again with the same request.");
const rateLimited = (retryAfterSeconds: number): LinkCardActionResponse =>
  ({ ...fail(429, "RATE_LIMITED", "Too many card actions. Try again shortly.", { retry_after: retryAfterSeconds }), retryAfterSeconds });
export { rateLimited as linkCardRateLimited };

export type LinkCardHint = { tone: "info" | "success" | "warning"; text: string };
/**
 * The only toast Raft's own records answer with (rule 6; protocol §5.3.2 step
 * 7, §8.2 (3)): one fixed, object-free hint per state. An App's toast, code or
 * attribution is never relayed from a synchronous answer or from Raft's
 * records; it is shown only through a forwarded status that passed the App's
 * current object-read check (linkCardReceiptService.ts). Copy owner:
 * product/design; clients may localize by `state`.
 */
const hint = (tone: LinkCardHint["tone"], text: string): Readonly<LinkCardHint> => Object.freeze({ tone, text });
export const LINK_CARD_STATE_HINTS: Readonly<Record<Exclude<LinkCardOperationState, "requested">, Readonly<LinkCardHint>>> = Object.freeze({
  sent: hint("info", "Sent. Waiting for the app."),
  accepted: hint("info", "Accepted. The app is finishing it."),
  done: hint("success", "Done. Open the app to see the result."),
  refused: hint("warning", "The action was not carried out."),
  failed_not_sent: hint("warning", "The action was not carried out."),
  unknown: hint("warning", "The result isn't confirmed yet."),
  needs_reconciliation: hint("warning", "The result isn't confirmed yet."),
  resolved_manually: hint("info", "The result could not be confirmed."),
});
const answered = (operationId: string, state: LinkCardOperationState): LinkCardActionResponse => {
  const shown = state === "requested" ? "sent" : state;
  return { status: 200, body: { operation_id: operationId, state: shown, toast: LINK_CARD_STATE_HINTS[shown] } };
};

// ---------------------------------------------------------------------------
// Request bodies: strict, own properties only, already bounded in bytes.

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const own = (body: Record<string, unknown>, name: string) => (Object.hasOwn(body, name) ? body[name] : undefined);
const boundedString = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

export type LinkCardPrepareRequest = { handle: string; claimedBusinessRevision: string };

/** `{ handle, claimed: { business_revision } }`; anything else is null (400). */
export function parseLinkCardPrepareBody(body: unknown): LinkCardPrepareRequest | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== "handle" && key !== "claimed")) return null;
  const handle = own(body, "handle");
  const claimed = own(body, "claimed");
  if (!boundedString(handle, MAX_HANDLE_LENGTH) || !isPlainObject(claimed) || Object.keys(claimed).some((key) => key !== "business_revision")) return null;
  const businessRevision = own(claimed, "business_revision");
  return boundedString(businessRevision, 512) ? { handle, claimedBusinessRevision: businessRevision } : null;
}

export type LinkCardExecuteRequest = {
  clientRequestId: string;
  handle: string;
  /** Both or neither (a pair with one half is a schema error). */
  prepared: { actionId: string; digest: string } | null;
};
const EXECUTE_FIELDS = new Set(["client_request_id", "handle", "prepared_action_id", "prepared_digest", "prepared_description"]);

/**
 * `{ client_request_id, handle, prepared_action_id?, prepared_digest?, prepared_description? }`.
 * `prepared_description` belongs to native providers (RFC 076 §7), and none is
 * registered yet, so it is refused for now; the request digest already has
 * its slot (linkCardRequestSha256).
 */
export function parseLinkCardExecuteBody(body: unknown): LinkCardExecuteRequest | null {
  if (!isPlainObject(body) || Object.keys(body).some((key) => !EXECUTE_FIELDS.has(key))) return null;
  if (own(body, "prepared_description") !== undefined) return null;
  const clientRequestId = own(body, "client_request_id");
  const handle = own(body, "handle");
  const preparedActionId = own(body, "prepared_action_id");
  const preparedDigest = own(body, "prepared_digest");
  if (typeof clientRequestId !== "string" || !CLIENT_REQUEST_ID.test(clientRequestId) || !boundedString(handle, MAX_HANDLE_LENGTH)) return null;
  if ((preparedActionId === undefined) !== (preparedDigest === undefined)) return null;
  if (preparedActionId === undefined) return { clientRequestId, handle, prepared: null };
  if (typeof preparedActionId !== "string" || !UUID.test(preparedActionId) || typeof preparedDigest !== "string" || !SHA256.test(preparedDigest)) return null;
  return { clientRequestId, handle, prepared: { actionId: preparedActionId, digest: preparedDigest } };
}

/**
 * The intent digest (protocol §5.3.1): lowercase hex SHA-256 of the JCS form
 * of `{ url_sha256, action_id, handle_sha256, prepared_action_id?,
 * prepared_digest?, prepared_description_sha256? }` (the last for native
 * providers only). Same id, different digest: 409.
 */
export function linkCardRequestSha256(input: {
  urlSha256: string; actionId: string; handleSha256: string; prepared: { actionId: string; digest: string } | null; preparedDescriptionSha256?: string;
}): string {
  return canonicalJsonSha256({
    url_sha256: input.urlSha256, action_id: input.actionId, handle_sha256: input.handleSha256,
    ...(input.prepared ? { prepared_action_id: input.prepared.actionId, prepared_digest: input.prepared.digest } : {}),
    ...(input.preparedDescriptionSha256 ? { prepared_description_sha256: input.preparedDescriptionSha256 } : {}),
  });
}

// ---------------------------------------------------------------------------
// Test seams.

type Hooks = {
  /** Execute: after the recovery lookup missed, before the new-intent checks. */
  afterRecoveryMiss?: () => Promise<void> | void;
  /** Execute: after the live-state check, before the admission transaction opens. */
  beforeAdmission?: () => Promise<void> | void;
  /** Execute: inside the admission transaction, right after both advisory locks. */
  underAdmissionLocks?: (tx: DatabaseExecutor) => Promise<void> | void;
  /** Execute: inside the admission transaction, right after the viewer's side passed its re-check (its locks held). */
  afterViewerRecheck?: (tx: DatabaseExecutor) => Promise<void> | void;
  /** Execute: after the admission commit, before the dispatch transaction. */
  beforeDispatch?: (operationId: string) => Promise<void> | void;
  /** The App call budget, shortened in tests. */
  budgetMs?: number;
  /** Raft's clock when it signs the execute JWT (a sender paused past the deadline). */
  signingNow?: () => Date;
};
let hooks: Hooks = {};
export function __setLinkCardActionHooksForTests(value: Hooks | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("Link card action hooks are test-only");
  hooks = value ?? {};
}

// ---------------------------------------------------------------------------
// The App call.

export type LinkCardCallResult = { kind: "answered"; text: string } | { kind: "timeout" } | { kind: "not_sent" } | { kind: "failed" };
type CallResult = LinkCardCallResult;

/**
 * One call to the action endpoint within the budget, through the preview
 * transport (HTTPS 443, public DNS pinned, no redirects, 32 KiB, re-checked on
 * every call). The answer is raw text for the strict parser. Never logs the
 * endpoint, assertion, body or answer.
 */
export async function callLinkCardActionEndpoint(endpoint: string, body: string, assertion: string, locale: string): Promise<CallResult> {
  const budgetMs = hooks.budgetMs ?? LINK_CARD_ACTION_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<CallResult>((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), budgetMs); });
  const call = Promise.resolve()
    .then(() => previewTransport()(endpoint, body, assertion, { response: "text", acceptLanguage: locale, timeoutMs: budgetMs }))
    .then((text): CallResult => (typeof text === "string" ? { kind: "answered", text } : { kind: "failed" }))
    .catch((error: unknown): CallResult => (error instanceof PreviewNotSentError ? { kind: "not_sent" } : { kind: "failed" }));
  try { return await Promise.race([call, timeout]); } finally { clearTimeout(timer); }
}

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// Prepare (RFC 076 §6.2; protocol §5.2).

/**
 * Asks the App for a confirmation description and stores it as a new
 * immutable prepared record. Never consumes the handle, never creates an
 * operation; two concurrent prepares make two records and neither is chosen.
 */
export async function prepareLinkCardAction(input: {
  viewerId: string; serverId: string; request: LinkCardPrepareRequest; locale: string; readMessage: LinkCardMessageReader;
}): Promise<LinkCardActionResponse> {
  // The MAC and expiry (410), then what depends on signed fields (400), as execute orders them.
  const verified = verifyLinkCardHandle(input.request.handle, currentDate());
  if (!verified) return HANDLE_INVALID;
  const { claims } = verified;
  if (!claims.requiresPrepare) return PREPARED_NOT_ALLOWED;
  const budget = await admitLinkCardAction("prepare", input.viewerId, input.serverId);
  if (!budget.admitted) return rateLimited(budget.retryAfterSeconds);
  // The claim must be the revision the handle signed: anything else is a stale or altered card.
  if (input.request.claimedBusinessRevision !== claims.businessRevision) return HANDLE_INVALID;
  const checked = await verifyLinkCardActionAgainstLiveState({
    phase: "prepare", viewerId: input.viewerId, serverId: input.serverId, claims, readMessage: input.readMessage, now: currentDate(),
  });
  if (!checked.ok) return checked.reason === "eligibility" ? NOT_ELIGIBLE : HANDLE_INVALID;
  const { live } = checked;
  const identity = { viewerId: input.viewerId, serverId: input.serverId, providerKind: "app" as const, providerKey: live.entry.app.key, installationKey: live.entry.installationId };

  // The attempt is recorded before anything is signed or sent (protocol §5.2, §8.8).
  const preparedActionId = randomUUID();
  const jti = randomUUID();
  await getDb().insert(linkCardAttempts).values({ jti, ...identity, preparedActionId, phase: "prepare" });
  const body = JSON.stringify({
    version: 2, phase: "prepare", url: live.url, action_id: claims.actionId, card_revision: claims.cardRevision,
    claimed: { business_revision: claims.businessRevision }, prepared_action_id: preparedActionId, locale: input.locale,
  });
  const assertion = signCardActionAssertion({
    phase: "prepare", clientKey: linkPreviewAudienceKey(live.entry), userId: input.viewerId, serverId: input.serverId, serverRole: live.entry.serverRole,
    installationId: live.entry.installationId, messageId: claims.binding.messageId, urlSha256: claims.binding.urlSha256, body, jti, now: currentDate(),
  });
  const result = await callLinkCardActionEndpoint(live.actionEndpoint, body, assertion, input.locale);
  // read_at is Raft's receive time (T3); the App's own read_at stays inside the digested description.
  const receivedAt = currentDate();
  const outcome = readPrepareAnswer(result, { preparedActionId, actionId: claims.actionId });
  const recordOutcome = (value: string) => getDb().update(linkCardAttempts).set({ outcome: value }).where(eq(linkCardAttempts.jti, jti));
  if (outcome.kind === "refused") {
    await recordOutcome("refused");
    // Raft relays no App toast or code here either: only its fixed hint.
    return { status: 200, body: { status: "refused", toast: LINK_CARD_STATE_HINTS.refused } };
  }
  if (outcome.kind !== "prepared") {
    // Timeout or failure: no operation, nothing stored, prepare may be retried.
    await recordOutcome(outcome.kind);
    return PREPARE_FAILED;
  }
  const expiresAtMs = Math.min(receivedAt.getTime() + PREPARED_TTL_MS, claims.exp * 1000);
  if (expiresAtMs <= receivedAt.getTime()) {
    await recordOutcome("expired");
    return HANDLE_INVALID;
  }
  const { description, digest } = outcome;
  await getDb().transaction(async (tx) => {
    await tx.insert(linkCardPreparedActions).values({
      preparedActionId, ...identity, viewNonce: claims.viewNonce, handleSha256: verified.handleSha256, descriptionSha256: digest,
      businessRevision: description.business_revision, target: description.target ?? null, executionMode: description.execution_mode ?? null,
      executionAccountLink: description.execution_account ?? null, readAt: receivedAt, expiresAt: new Date(expiresAtMs),
    });
    await tx.update(linkCardAttempts).set({ outcome: "prepared" }).where(eq(linkCardAttempts.jti, jti));
  });
  return { status: 200, body: { prepared_action_id: preparedActionId, prepared_digest: digest, description } };
}

type PrepareOutcome =
  | { kind: "prepared"; description: LinkCardPreparedDescription; digest: string }
  | { kind: "refused" }
  | { kind: "invalid" | "timeout" | "not_sent" | "failed" };

/**
 * `{ status: "prepared", description }` or `{ status: "refused", code?, toast? }`,
 * parsed strictly from the raw text (protocol §10.1: duplicate keys, broken
 * Unicode and C0-control keys refuse the whole answer, addendum 4 §4 K1), then
 * the description schema; its ids must be the ones Raft sent. Anything else is
 * invalid: nothing is digested, stored or signed from it.
 */
function readPrepareAnswer(result: CallResult, expected: { preparedActionId: string; actionId: string }): PrepareOutcome {
  if (result.kind !== "answered") return { kind: result.kind };
  let answer: { [key: string]: StrictJsonValue };
  try { answer = parseStrictJson(result.text); } catch { return { kind: "invalid" }; }
  const keys = Object.keys(answer);
  if (answer.status === "refused" && keys.every((key) => key === "status" || key === "code" || key === "toast")) return { kind: "refused" };
  if (answer.status !== "prepared" || keys.length !== 2 || !Object.hasOwn(answer, "description")) return { kind: "invalid" };
  const parsed = parseLinkCardPreparedDescription(answer.description!);
  if (!parsed.ok || parsed.description.prepared_action_id !== expected.preparedActionId || parsed.description.action_id !== expected.actionId) return { kind: "invalid" };
  return { kind: "prepared", description: parsed.description, digest: linkCardPreparedDigest(parsed.description) };
}

// ---------------------------------------------------------------------------
// Execute (RFC 076 §6.3; protocol §5.3.2-§5.3.4).

type ClientRequestKey = {
  viewerId: string; serverId: string; providerKind: LinkCardProviderKind; providerKey: string; installationKey: string; clientRequestId: string;
};
type ClientRequestHit = {
  operationId: string; requestSha256: string;
  op: Pick<typeof linkCardOperations.$inferSelect, "viewerId" | "serverId" | "providerKind" | "providerKey" | "installationKey" | "messageId" | "state">;
};

async function lookupClientRequest(db: DatabaseExecutor, key: ClientRequestKey): Promise<ClientRequestHit | null> {
  const [row] = await db.select({
    operationId: linkCardClientRequests.operationId, requestSha256: linkCardClientRequests.requestSha256,
    op: {
      viewerId: linkCardOperations.viewerId, serverId: linkCardOperations.serverId, providerKind: linkCardOperations.providerKind,
      providerKey: linkCardOperations.providerKey, installationKey: linkCardOperations.installationKey, messageId: linkCardOperations.messageId,
      state: linkCardOperations.state,
    },
  }).from(linkCardClientRequests)
    .innerJoin(linkCardOperations, eq(linkCardOperations.operationId, linkCardClientRequests.operationId))
    .where(and(
      eq(linkCardClientRequests.viewerId, key.viewerId), eq(linkCardClientRequests.serverId, key.serverId),
      eq(linkCardClientRequests.providerKind, key.providerKind), eq(linkCardClientRequests.providerKey, key.providerKey),
      eq(linkCardClientRequests.installationKey, key.installationKey), eq(linkCardClientRequests.clientRequestId, key.clientRequestId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * A request id that already has an operation (protocol §5.3.2 step 2). Same
 * intent digest: the operation as the viewer may read it now, or
 * `not_visible`; nothing is checked again (flag, eligibility, handle,
 * prepared, caps, the 400s) and nothing is written. Different digest: 409.
 */
async function recovered(hit: ClientRequestHit, requestSha256: string, readMessage: LinkCardMessageReader): Promise<LinkCardActionResponse> {
  if (hit.requestSha256 !== requestSha256) return CLIENT_REQUEST_CONFLICT;
  if (!await linkCardReceiptReadable(hit.op, readMessage)) return { status: 200, body: { state: "not_visible" } };
  return answered(hit.operationId, hit.op.state);
}

/**
 * Executes one card action. The viewer and Server come from the authenticated
 * session; the handle's plain text only selects which client request to look
 * up (protocol §5.3.1).
 */
export async function executeLinkCardAction(input: {
  viewerId: string; serverId: string; request: LinkCardExecuteRequest; locale: string; readMessage: LinkCardMessageReader;
  /** Receipt hints for each change the send and its answer make (RFC 076 §6.8). */
  hints?: LinkCardReceiptHints;
}): Promise<LinkCardActionResponse> {
  // 1. The selector (400 if the handle has none).
  const selector = readLinkCardHandleSelector(input.request.handle);
  if (!selector) return INVALID_REQUEST;
  const key: ClientRequestKey = {
    viewerId: input.viewerId, serverId: input.serverId, providerKind: selector.providerKind, providerKey: selector.providerKey,
    installationKey: selector.installationKey, clientRequestId: input.request.clientRequestId,
  };
  const requestSha256 = linkCardRequestSha256({ urlSha256: selector.urlSha256, actionId: selector.actionId, handleSha256: selector.handleSha256, prepared: input.request.prepared });
  // 2. Recovery first, without a lock (RFC 076 §9).
  // It spends no execute budget or cap, only one unit of a generous lookup
  // budget, before its first query (429 + Retry-After past it).
  const lookups = await admitLinkCardAction("recovery", input.viewerId, input.serverId);
  if (!lookups.admitted) return rateLimited(lookups.retryAfterSeconds);
  const existing = await lookupClientRequest(getDb(), key);
  if (existing) return recovered(existing, requestSha256, input.readMessage);
  await hooks.afterRecoveryMiss?.();
  const admission = await admitNewIntent(input, selector, key, requestSha256);
  if (admission.kind === "admitted") return dispatchAndAnswer(admission.op, input.locale, input.hints ?? noLinkCardReceiptHints);
  if (admission.kind === "recover") return recovered(admission.hit, requestSha256, input.readMessage);
  // 5. Any error on the new-intent path looks the mapping up once more: a
  // concurrent request with this id may have won (rule 5; protocol §5.3.3).
  const winner = await lookupClientRequest(getDb(), key);
  return winner ? recovered(winner, requestSha256, input.readMessage) : admission.response;
}

type AdmittedOperation = {
  operationId: string;
  viewerId: string;
  serverId: string;
  claims: LinkCardHandleClaims;
  live: LinkCardLiveState;
  prepared: LinkCardExecuteRequest["prepared"];
  registrationRevision: string;
};
type Admission = { kind: "admitted"; op: AdmittedOperation } | { kind: "recover"; hit: ClientRequestHit } | { kind: "refused"; response: LinkCardActionResponse };

/** Ends the admission transaction (rolled back) with a refusal or a recovery. */
class AdmissionStop extends Error {
  constructor(readonly admission: Exclude<Admission, { kind: "admitted" }>) { super("link card admission stopped"); }
}
const stop = (response: LinkCardActionResponse) => new AdmissionStop({ kind: "refused", response });
const pgCode = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;

async function admitNewIntent(
  input: Parameters<typeof executeLinkCardAction>[0], selector: LinkCardHandleSelector, key: ClientRequestKey, requestSha256: string,
): Promise<Admission> {
  const refused = (response: LinkCardActionResponse): Admission => ({ kind: "refused", response });
  // 3. New intent, in this order (RFC 076 §6.3 step 3; protocol §3.4, §5.3.2):
  // 3.1 the MAC, kind and expiry (410), and the plain-text selector that keyed
  // the lookup (and keys every write below) equal to what was signed;
  const verified = verifyLinkCardHandle(input.request.handle, currentDate());
  if (!verified || !linkCardSelectorMatchesHandle(selector, verified)) return refused(HANDLE_INVALID);
  const { claims } = verified;
  // 3.2 requiresPrepare against the presence of prepared_* (400), only after the MAC;
  if (claims.requiresPrepare && !input.request.prepared) return refused(PREPARE_REQUIRED);
  if (!claims.requiresPrepare && input.request.prepared) return refused(PREPARED_NOT_ALLOWED);
  // 3.3 the rate limits (429);
  const budget = await admitLinkCardAction("execute", input.viewerId, input.serverId);
  if (!budget.admitted) return refused(rateLimited(budget.retryAfterSeconds));
  // 3.4 the handle's other bindings and the pre-call checks (410).
  const checked = await verifyLinkCardActionAgainstLiveState({
    phase: "execute", viewerId: input.viewerId, serverId: input.serverId, claims, readMessage: input.readMessage, now: currentDate(),
  });
  if (!checked.ok) return refused(checked.reason === "eligibility" ? NOT_ELIGIBLE : HANDLE_INVALID);
  const { live } = checked;
  // 3.5 an App acting under its own-Server confirmation (RFC 076 §17), not
  // reviewed by the platform, also spends the viewer's budget for that App
  // (429). Only the live check knows which way the App is eligible, so this
  // limit comes after it.
  if (live.basis === "own_server") {
    const appBudget = await admitLinkCardAppExecute(input.viewerId, input.serverId, live.entry.app.key);
    if (!appBudget.admitted) return refused(rateLimited(appBudget.retryAfterSeconds));
  }
  await hooks.beforeAdmission?.();
  // 4. One transaction.
  try {
    return await getDb().transaction(async (tx) => ({
      kind: "admitted" as const,
      op: await admitInTransaction(tx, {
        key, requestSha256, claims, handleSha256: verified.handleSha256, live, prepared: input.request.prepared, readMessage: input.readMessage,
      }),
    }));
  } catch (error) {
    if (error instanceof AdmissionStop) return error.admission;
    const code = pgCode(error);
    // One lock wait passed lock_timeout: 429, after the final mapping check.
    if (code === "55P03") return refused(LOCK_TIMEOUT);
    // A unique key refused the write (protocol §5.3.3): the caller's final
    // mapping check finds a same-id winner; otherwise the handle was consumed
    // by a different intent.
    if (code === "23505") return refused(await handleUsedConflict({ handleSha256: verified.handleSha256, viewerId: key.viewerId, serverId: key.serverId }, input.readMessage));
    // Anything else (a deadlock, a broken invariant) wrote nothing either; the
    // caller's final mapping check still runs. Only the code is logged.
    console.error("[LinkCardExecute] admission failed", code ?? (error instanceof Error ? error.name : "unknown"));
    return refused(UNAVAILABLE);
  }
}

/**
 * 409 for a different intent on a used handle, with the operation id only if
 * the viewer can read it now. The use is looked up by the handle's digest and
 * the session's viewer and Server together, so the answer can only ever name
 * this viewer's own operation, whatever the digest matched.
 */
async function handleUsedConflict(use: { handleSha256: string; viewerId: string; serverId: string }, readMessage: LinkCardMessageReader): Promise<LinkCardActionResponse> {
  const [row] = await getDb().select({
    operationId: linkCardOperations.operationId, viewerId: linkCardOperations.viewerId, serverId: linkCardOperations.serverId,
    providerKind: linkCardOperations.providerKind, providerKey: linkCardOperations.providerKey, installationKey: linkCardOperations.installationKey,
    messageId: linkCardOperations.messageId,
  }).from(linkCardHandleUses)
    .innerJoin(linkCardOperations, eq(linkCardOperations.operationId, linkCardHandleUses.operationId))
    .where(and(eq(linkCardHandleUses.handleSha256, use.handleSha256), eq(linkCardOperations.viewerId, use.viewerId), eq(linkCardOperations.serverId, use.serverId)))
    .limit(1);
  const readable = row ? await linkCardReceiptReadable(row, readMessage) : false;
  return fail(409, "HANDLE_USED", "This button was already used.", readable ? { operation_id: row!.operationId } : {});
}

/** The installation's open count past half its cap feeds the alert metric (RFC 076 §5.2). */
function reportInstallationLoad(installationKey: string, open: number) {
  if (open > LINK_CARD_INSTALLATION_OPEN_CAP / 2) linkCardOpenOperations.set({ installation_key: installationKey }, open);
  else linkCardOpenOperations.remove({ installation_key: installationKey });
}

/**
 * Protocol §5.3.2 step 4, in its order. The 0386 foreign keys are immediate,
 * so the operation row goes in first; every refusal rolls everything back.
 */
async function admitInTransaction(tx: DatabaseExecutor, input: {
  key: ClientRequestKey; requestSha256: string; claims: LinkCardHandleClaims; handleSha256: string; live: LinkCardLiveState; prepared: LinkCardExecuteRequest["prepared"];
  readMessage: LinkCardMessageReader;
}): Promise<AdmittedOperation> {
  const { key, claims, live } = input;
  const installationKey = live.entry.installationId;
  // A bound on each lock wait, not on the whole transaction.
  await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
  // (a) Eligibility, FOR SHARE on the registry, install and registration rows.
  if (!await lockLinkCardActionEligibility(tx, { live, claims, serverId: key.serverId })) throw stop(NOT_ELIGIBLE);
  // (b) Admission locks, the same order for every writer: viewer, then installation.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`link_card:viewer:${key.viewerId}:${key.serverId}`}, 0))`);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`link_card:installation:${installationKey}`}, 0))`);
  await hooks.underAdmissionLocks?.(tx);
  // (b1) The mapping again, under the locks and before the caps: a same-id
  // winner is recovered, never a 429 (Tenny f259e339).
  const winner = await lookupClientRequest(tx, key);
  if (winner) throw new AdmissionStop({ kind: "recover", hit: winner });
  // (b2) The handle's expiry by the real clock: the lock wait may have passed it.
  const clock = await tx.execute<{ expired: boolean }>(sql`SELECT extract(epoch FROM clock_timestamp()) >= ${claims.exp} AS expired`);
  if (clock.rows[0]?.expired !== false) throw stop(HANDLE_INVALID);
  // (b3) The viewer's side again, after every lock wait above (Tenny, #10971
  // review): consent FOR SHARE, the decline under the choice lock, and the
  // message as the viewer may read it now with the signed content digest. A
  // revocation, decline, removal, edit or deletion that committed while this
  // waited is 410 here, everything rolled back and no App called; one that
  // starts now waits for this commit (consent, decline) or is ordered after it.
  if (await recheckLinkCardViewerInTransaction(tx, { viewerId: key.viewerId, serverId: key.serverId, claims, live, readMessage: input.readMessage })) {
    throw stop(HANDLE_INVALID);
  }
  await hooks.afterViewerRecheck?.(tx);
  // (b4) The caps, counted under the locks.
  const counts = await tx.execute<{ viewer_open: number; installation_open: number }>(sql`SELECT
    (SELECT count(*)::int FROM ${linkCardOperations} WHERE viewer_id = ${key.viewerId} AND server_id = ${key.serverId}
      AND state IN ('sent', 'accepted', 'unknown')) AS viewer_open,
    (SELECT count(*)::int FROM ${linkCardOperations} WHERE installation_key = ${installationKey}
      AND state IN ('sent', 'accepted', 'unknown', 'needs_reconciliation')) AS installation_open`);
  const viewerOpen = Number(counts.rows[0]?.viewer_open ?? 0);
  const installationOpen = Number(counts.rows[0]?.installation_open ?? 0);
  reportInstallationLoad(installationKey, installationOpen);
  if (viewerOpen >= LINK_CARD_VIEWER_OPEN_CAP || installationOpen >= LINK_CARD_INSTALLATION_OPEN_CAP) throw stop(OPEN_OPERATIONS_CAP);
  // (c) The operation, first. created_at and first_send_deadline come from one
  // whole-second reading of the clock, so they are exactly 10 minutes apart.
  const operationId = randomUUID();
  const registrationRevision = claims.binding.registrationRevision;
  await tx.execute(sql`INSERT INTO ${linkCardOperations} (operation_id, viewer_id, server_id, provider_kind, provider_key, installation_key,
      registration_revision, view_nonce, message_id, url_sha256, action_endpoint_sha256, action_origin, action_id, request_sha256, state,
      created_at, first_send_deadline)
    SELECT ${operationId}::uuid, ${key.viewerId}::uuid, ${key.serverId}::uuid, 'app', ${live.entry.app.key}, ${installationKey},
      ${registrationRevision}, ${claims.viewNonce}, ${claims.binding.messageId}::uuid, ${claims.binding.urlSha256}, ${live.actionEndpointSha256},
      ${live.entry.config.origin}, ${claims.actionId}, ${input.requestSha256}, 'requested', t.created_at, t.created_at + interval '10 minutes'
    FROM (SELECT date_trunc('second', clock_timestamp()) AS created_at) AS t`);
  // (d) The request mapping.
  await tx.insert(linkCardClientRequests).values({
    ...key, operationId, urlSha256: claims.binding.urlSha256, actionId: claims.actionId, requestSha256: input.requestSha256,
  });
  // (e) The handle is consumed: its primary key refuses a second use.
  await tx.insert(linkCardHandleUses).values({ handleSha256: input.handleSha256, operationId, expiresAt: new Date(claims.exp * 1000) });
  // (f) The prepared record, consumed only if it is this handle's, unexpired,
  // unconsumed, in this identity domain, and has the digest the viewer confirmed.
  if (claims.requiresPrepare) {
    const prepared = input.prepared!;
    const consumed = await tx.update(linkCardPreparedActions).set({ consumedByOperationId: operationId })
      .where(and(
        eq(linkCardPreparedActions.preparedActionId, prepared.actionId), isNull(linkCardPreparedActions.consumedByOperationId),
        sql`${linkCardPreparedActions.expiresAt} > clock_timestamp()`,
        eq(linkCardPreparedActions.handleSha256, input.handleSha256), eq(linkCardPreparedActions.descriptionSha256, prepared.digest),
        eq(linkCardPreparedActions.viewerId, key.viewerId), eq(linkCardPreparedActions.serverId, key.serverId),
        eq(linkCardPreparedActions.providerKind, "app"), eq(linkCardPreparedActions.providerKey, live.entry.app.key),
        eq(linkCardPreparedActions.installationKey, installationKey),
      ))
      .returning({ id: linkCardPreparedActions.preparedActionId });
    if (!consumed.length) throw stop(PREPARED_INVALID);
  }
  // (g) The view's pending slot. Created (or rebuilt after a sweep) at the
  // first execute and locked; free when empty or pointing at a terminal
  // operation (lazy release), claimed by a conditional update on what was seen.
  const [view] = await tx.insert(linkCardViews).values({
    viewNonce: claims.viewNonce, viewInstanceId: claims.viewInstanceId, viewerId: key.viewerId, serverId: key.serverId, providerKind: "app",
    providerKey: live.entry.app.key, installationKey, messageId: claims.binding.messageId, urlSha256: claims.binding.urlSha256, pendingOperationId: null,
  }).onConflictDoUpdate({ target: linkCardViews.viewNonce, set: { updatedAt: sql`${linkCardViews.updatedAt}` } }).returning();
  if (!view || !linkCardViewMatches(view, claims)) throw stop(HANDLE_INVALID);
  if (view.pendingOperationId !== null) {
    const [pending] = await tx.select({ state: linkCardOperations.state }).from(linkCardOperations).where(eq(linkCardOperations.operationId, view.pendingOperationId));
    if (pending && !TERMINAL.includes(pending.state)) throw stop(VIEW_PENDING);
  }
  const claimed = await tx.update(linkCardViews).set({ pendingOperationId: operationId, updatedAt: sql`now()` })
    .where(and(eq(linkCardViews.viewNonce, claims.viewNonce),
      view.pendingOperationId === null ? isNull(linkCardViews.pendingOperationId) : eq(linkCardViews.pendingOperationId, view.pendingOperationId)))
    .returning({ viewNonce: linkCardViews.viewNonce });
  if (!claimed.length) throw stop(VIEW_PENDING);
  // (h) requested -> sent, in the same transaction.
  await tx.update(linkCardOperations).set({ state: "sent", updatedAt: sql`now()` })
    .where(and(eq(linkCardOperations.operationId, operationId), eq(linkCardOperations.state, "requested")));
  return { operationId, viewerId: key.viewerId, serverId: key.serverId, claims, live, prepared: input.prepared, registrationRevision };
}

// ---------------------------------------------------------------------------
// After commit: dispatch, send, apply the synchronous answer.

async function dispatchAndAnswer(op: AdmittedOperation, locale: string, hints: LinkCardReceiptHints): Promise<LinkCardActionResponse> {
  let state: LinkCardOperationState;
  try {
    const settled = await dispatchExecute(op, locale);
    state = settled.state;
    // After the commit: the viewer's other sessions learn the receipt moved.
    if (settled.receiptRevision !== null) hints({ viewerId: op.viewerId, serverId: op.serverId, operationId: op.operationId, receiptRevision: settled.receiptRevision });
  } catch {
    // The operation is committed; whatever happened, report what is recorded.
    // A sent operation without a dispatch record is closed by the deadline sweep.
    const [row] = await getDb().select({ state: linkCardOperations.state }).from(linkCardOperations).where(eq(linkCardOperations.operationId, op.operationId));
    state = row?.state ?? "sent";
  }
  return answered(op.operationId, state);
}

/** The state after a settle, and the new receipt revision when it moved (null when it did not). */
type Settled = { state: LinkCardOperationState; receiptRevision: number | null };

/**
 * One conditional transition (state machine: protocol §8.1; the 0387 trigger
 * enforces it for every writer). Raft's own conclusions move only `sent`. The
 * App's answer to this operation's execute may also move `unknown` to what it
 * answered (unknown -> accepted, done, refused or failed_not_sent, all allowed
 * by §8.1 and the trigger): the deadline sweep can converge the operation to
 * `unknown` while that answer is on its way, and the answer must not be lost
 * (Tenny, #10971 review). It is the answer to the same execute jti by
 * construction (derived from the operation id), and the update also requires
 * that dispatch record. Nothing past `unknown` (accepted, terminal) moves.
 */
async function settle(
  tx: DatabaseExecutor, op: AdmittedOperation, next: LinkCardOperationState, outcome: string | null, by: "raft" | "app_answer" = "raft",
): Promise<Settled> {
  const jti = linkCardExecuteJti(op.operationId);
  const lateAnswer = by === "app_answer" && next !== "unknown";
  const [moved] = await tx.update(linkCardOperations)
    .set({ state: next, receiptRevision: sql`${linkCardOperations.receiptRevision} + 1`, updatedAt: sql`now()` })
    .where(and(
      eq(linkCardOperations.operationId, op.operationId),
      lateAnswer ? inArray(linkCardOperations.state, ["sent", "unknown"]) : eq(linkCardOperations.state, "sent"),
      lateAnswer ? sql`EXISTS (SELECT 1 FROM ${linkCardAttempts} a WHERE a.jti = ${jti} AND a.operation_id = ${op.operationId} AND a.phase = 'execute')` : undefined,
    ))
    .returning({ state: linkCardOperations.state, receiptRevision: linkCardOperations.receiptRevision });
  if (outcome !== null) await tx.update(linkCardAttempts).set({ outcome }).where(eq(linkCardAttempts.jti, jti));
  if (moved && TERMINAL.includes(next)) {
    // Lazy release already frees the view; clearing it on the expected id keeps
    // free rows in the sweep's index. A later operation's claim is never touched.
    await tx.update(linkCardViews).set({ pendingOperationId: null })
      .where(and(eq(linkCardViews.viewNonce, op.claims.viewNonce), eq(linkCardViews.pendingOperationId, op.operationId)));
  }
  if (moved) return { state: moved.state, receiptRevision: moved.receiptRevision };
  const [row] = await tx.select({ state: linkCardOperations.state }).from(linkCardOperations).where(eq(linkCardOperations.operationId, op.operationId));
  return { state: row?.state ?? next, receiptRevision: null };
}

/**
 * The synchronous answer as a transition (RFC 076 §6.3 step 7): never a
 * made-up accepted. `by` says whether the App answered (a valid status) or
 * Raft concluded it (no answer, a failure, an invalid answer, never sent).
 */
function readExecuteAnswer(result: CallResult): { next: LinkCardOperationState; outcome: string; by: "raft" | "app_answer" } {
  if (result.kind === "not_sent") return { next: "failed_not_sent", outcome: "not_sent", by: "raft" };
  if (result.kind !== "answered") return { next: "unknown", outcome: result.kind === "timeout" ? "timeout" : "transport_error", by: "raft" };
  let answer: Record<string, unknown>;
  try { answer = parseStrictJson(result.text); } catch { return { next: "unknown", outcome: "invalid_answer", by: "raft" }; }
  if (Object.keys(answer).some((key) => !["status", "code", "attribution", "toast"].includes(key))) return { next: "unknown", outcome: "invalid_answer", by: "raft" };
  switch (answer.status) {
    case "accepted": case "executing": return { next: "accepted", outcome: `answered:${answer.status}`, by: "app_answer" };
    case "done": case "refused": case "failed_not_sent": return { next: answer.status, outcome: `answered:${answer.status}`, by: "app_answer" };
    case "unknown": return { next: "unknown", outcome: "answered:unknown", by: "app_answer" };
    default: return { next: "unknown", outcome: "invalid_answer", by: "raft" };
  }
}

/**
 * Protocol §5.3.4. A short transaction locks the operation and requires
 * `sent`, no earlier execute attempt and a time before its first-send
 * deadline, re-checks the endpoint it will call, then records the dispatch
 * (link_card_attempts, phase execute, one per operation) and the update token.
 * Only after that commits is the JWT signed (exp capped at the deadline) and
 * the request sent, once. Retries and recovery never send.
 */
async function dispatchExecute(op: AdmittedOperation, locale: string): Promise<Settled> {
  await hooks.beforeDispatch?.(op.operationId);
  const { claims, live } = op;
  const jti = linkCardExecuteJti(op.operationId);
  // Opaque to the App: a 10-minute, single-use credential for one terminal
  // update of this operation (RFC 076 §6.5; linkCardUpdateService.ts). Only its SHA-256 is stored.
  const updateToken = `lcu_${randomBytes(32).toString("base64url")}`;
  const identity = { viewerId: op.viewerId, serverId: op.serverId, providerKind: "app" as const, providerKey: live.entry.app.key, installationKey: live.entry.installationId };
  const gate = await getDb().transaction(async (tx): Promise<{ send: true; deadline: Date } | { send: false; settled: Settled | null }> => {
    const locked = await tx.execute<{ state: LinkCardOperationState; first_send_deadline: string | Date; open: boolean }>(sql`SELECT state, first_send_deadline,
        clock_timestamp() < first_send_deadline AS open
      FROM ${linkCardOperations} WHERE operation_id = ${op.operationId} FOR UPDATE`);
    const row = locked.rows[0];
    if (!row || row.state !== "sent" || row.open !== true) return { send: false, settled: row ? { state: row.state, receiptRevision: null } : null };
    const [earlier] = await tx.select({ jti: linkCardAttempts.jti }).from(linkCardAttempts)
      .where(and(eq(linkCardAttempts.operationId, op.operationId), eq(linkCardAttempts.phase, "execute"))).limit(1);
    if (earlier) return { send: false, settled: { state: row.state, receiptRevision: null } };
    if (!await linkCardDispatchTargetInForce(tx, { providerKey: identity.providerKey, actionOrigin: live.entry.config.origin, actionEndpointSha256: live.actionEndpointSha256 })) {
      // Nothing was dispatched and nothing will be: proved never sent.
      return { send: false, settled: await settle(tx, op, "failed_not_sent", null) };
    }
    await tx.execute(sql`INSERT INTO ${linkCardAttempts} (jti, viewer_id, server_id, provider_kind, provider_key, installation_key, operation_id, phase, sent_at)
      VALUES (${jti}, ${identity.viewerId}, ${identity.serverId}, 'app', ${identity.providerKey}, ${identity.installationKey}, ${op.operationId}, 'execute', clock_timestamp())`);
    await tx.insert(linkCardUpdateTokens).values({
      tokenSha256: sha256Hex(updateToken), operationId: op.operationId, serverId: identity.serverId, providerKind: "app", providerKey: identity.providerKey,
      installationKey: identity.installationKey, registrationRevision: op.registrationRevision, expiresAt: sql`clock_timestamp() + interval '10 minutes'`,
    });
    return { send: true, deadline: new Date(row.first_send_deadline) };
  });
  if (!gate.send) return gate.settled ?? { state: "sent", receiptRevision: null };
  // The JWT and body_sha256 cover these exact bytes.
  const body = JSON.stringify({
    version: 2, phase: "execute", url: live.url, action_id: claims.actionId, card_revision: claims.cardRevision,
    claimed: { business_revision: claims.businessRevision },
    ...(op.prepared ? { prepared_action_id: op.prepared.actionId, prepared_digest: op.prepared.digest } : {}),
    operation_id: op.operationId, locale, update_token: updateToken,
  });
  let assertion: string;
  try {
    assertion = signCardActionAssertion({
      phase: "execute", notAfter: gate.deadline, clientKey: linkPreviewAudienceKey(live.entry), userId: op.viewerId, serverId: op.serverId,
      serverRole: live.entry.serverRole, installationId: identity.installationKey, messageId: claims.binding.messageId,
      urlSha256: claims.binding.urlSha256, body, jti, now: hooks.signingNow?.() ?? currentDate(),
    });
  } catch (error) {
    if (!(error instanceof CardActionPastDeadlineError)) throw error;
    // Dispatched but past the deadline: never signed, never sent; the record
    // says "may have been sent", so the operation converges to unknown.
    return getDb().transaction((tx) => settle(tx, op, "unknown", "past_deadline"));
  }
  const result = await callLinkCardActionEndpoint(live.actionEndpoint, body, assertion, locale);
  const { next, outcome, by } = readExecuteAnswer(result);
  return getDb().transaction((tx) => settle(tx, op, next, outcome, by));
}

