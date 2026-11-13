import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { linkCardToastSchema } from "@botiverse/raft-shared/src/appLinkPreview";
import { getDb, type DatabaseExecutor } from "../db";
import { linkCardOperations, linkCardUpdateTokens, linkCardViews, oauthClients, type LinkCardOperationState } from "../db/schema";
import { canonicalJsonSha256 } from "../lib/canonicalJson";
import { parseStrictJsonBytes, type StrictJsonValue } from "../lib/strictJson";
import { admitLinkCardUpdate } from "./linkCardActionLimits";
import type { LinkCardActionResponse } from "./linkCardActionService";
import type { LinkCardReceiptHints } from "./linkCardReceiptHints";

// The App's terminal update (RFC 076 §6.5, rule 6; protocol v3.2.3 §8.1,
// §8.2 (1)): `POST /api/oauth/link-preview/card-updates`, authenticated with
// the App's client credentials, body `{ update_token, update_id, outcome,
// toast? }`. Execute's dispatch minted the token for one operation and stored
// only its SHA-256 (linkCardActionService.ts); it lives 10 minutes and takes one
// terminal update.
//
// Recording is separate from showing. An update is accepted on its own
// bindings alone: the App that authenticated is the operation's App and its
// credentials are enabled now; the token exists, is unexpired and was not
// consumed by another update_id; the token's identity domain, Server and
// registration revision equal the operation's original ones; and the move is
// allowed (§8.1). It is NOT compared with the current revision, whether the
// installation is still active, the viewer's access or consent, eligibility,
// the flag or the view: it is accepted after an uninstall, an eligibility
// revocation, the flag turned off or a registration change. Never once the
// App's credentials are disabled (then the operation waits in reconciliation
// for a person), and never with a token whose own checks fail.
//
// Accepting shows nothing by itself: no card is stored, and the toast is
// validated and covered by the content digest but never stored or relayed.
// What a viewer sees comes from status under their current access
// (linkCardReceiptService.ts); a moved receipt is hinted to them.

/** Bodies are refused above this size before they are parsed. */
export const LINK_CARD_UPDATE_MAX_BODY_BYTES = 8 * 1024;
/** `lcu_` + 32 random bytes in base64url, as dispatch mints it. */
const UPDATE_TOKEN = /^lcu_[A-Za-z0-9_-]{43}$/;
const UPDATE_ID = /^[A-Za-z0-9._~:-]{1,128}$/;
const OUTCOMES = ["done", "refused", "failed_not_sent"] as const;
type Outcome = (typeof OUTCOMES)[number];
/** The states a terminal update may move (protocol §8.1, including the reconciliation exit within the token's life). */
const FROM_STATES = ["sent", "accepted", "unknown", "needs_reconciliation"] as const satisfies readonly LinkCardOperationState[];
const FIELDS = new Set(["update_token", "update_id", "outcome", "toast"]);

const fail = (status: number, code: string, error: string, extra: Partial<LinkCardActionResponse> = {}): LinkCardActionResponse =>
  ({ status, body: { error, code }, ...extra });
export const LINK_CARD_UPDATE_INVALID_CLIENT = fail(401, "INVALID_CLIENT", "Invalid client credentials");
const TOKEN_INVALID = fail(410, "UPDATE_TOKEN_INVALID", "This update token is unknown, expired or no longer matches its operation.");
const UPDATE_CONFLICT = fail(409, "UPDATE_CONFLICT", "This update token was already used for a different update.");
const LOCK_TIMEOUT = fail(429, "LOCK_TIMEOUT", "Busy. Retry with the same update_id.", { retryAfterSeconds: 1 });

export type LinkCardUpdateRequest = {
  updateToken: string;
  updateId: string;
  outcome: Outcome;
  /** SHA-256 of the JCS form of `{ outcome, toast? }`: same update_id, same digest -> the original receipt. */
  contentSha256: string;
};

/**
 * The raw body (already bounded in bytes) parsed strictly (protocol §10.1:
 * invalid UTF-8, duplicate keys, C0-control keys and broken Unicode refuse it),
 * then `{ update_token, update_id, outcome, toast? }` with nothing else:
 * `outcome` is done, refused or failed_not_sent; `toast` as protocol §4.4.
 * Anything else is null (400).
 */
export function parseLinkCardUpdateBody(raw: unknown): LinkCardUpdateRequest | null {
  if (!(raw instanceof Uint8Array)) return null;
  let body: { [key: string]: StrictJsonValue };
  try { body = parseStrictJsonBytes(raw); } catch { return null; }
  if (Object.keys(body).some((key) => !FIELDS.has(key))) return null;
  const { update_token: updateToken, update_id: updateId, outcome } = body;
  if (typeof updateToken !== "string" || !UPDATE_TOKEN.test(updateToken) || typeof updateId !== "string" || !UPDATE_ID.test(updateId)
    || typeof outcome !== "string" || !(OUTCOMES as readonly string[]).includes(outcome)) return null;
  let toast: unknown;
  if (Object.hasOwn(body, "toast")) {
    const parsed = linkCardToastSchema.safeParse(body.toast);
    if (!parsed.success) return null;
    toast = parsed.data;
  }
  return {
    updateToken, updateId, outcome: outcome as Outcome,
    contentSha256: canonicalJsonSha256({ outcome, ...(toast === undefined ? {} : { toast }) }),
  };
}

type Receipt = NonNullable<typeof linkCardUpdateTokens.$inferSelect["receipt"]>;
const receiptBody = (receipt: Receipt) => ({ operation_id: receipt.operationId, state: receipt.state, receipt_revision: receipt.receiptRevision });
const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

class UpdateStop extends Error {
  constructor(readonly response: LinkCardActionResponse) { super("link card update stopped"); }
}

type Hooks = {
  /** Inside the acceptance transaction, after the token and operation rows are locked. */
  underUpdateLocks?: (tx: DatabaseExecutor) => Promise<void> | void;
};
let hooks: Hooks = {};
export function __setLinkCardUpdateHooksForTests(value: Hooks | null) {
  if (process.env.NODE_ENV !== "test") throw new Error("Link card update hooks are test-only");
  hooks = value ?? {};
}

/**
 * Accepts one terminal update. 200 with the receipt
 * `{ operation_id, state, receipt_revision }`: the state the operation is in
 * after the update (when it was already terminal, the update is recorded and
 * moves nothing). The same update_id with the same content gets the original
 * receipt again; any other use of a consumed token is 409. An unknown,
 * expired or foreign token, or one whose bindings no longer equal its
 * operation's, is 410. The caller authenticated `client`.
 */
export async function acceptLinkCardUpdate(input: {
  client: { id: string; clientId: string }; request: LinkCardUpdateRequest; hints: LinkCardReceiptHints;
}): Promise<LinkCardActionResponse> {
  const { client, request } = input;
  const tokenSha256 = sha256Hex(request.updateToken);
  // The token names the installation whose budget this spends. Another App's
  // token is indistinguishable from an unknown one.
  const [named] = await getDb().select({ installationKey: linkCardUpdateTokens.installationKey }).from(linkCardUpdateTokens)
    .where(and(eq(linkCardUpdateTokens.tokenSha256, tokenSha256), eq(linkCardUpdateTokens.providerKind, "app"), eq(linkCardUpdateTokens.providerKey, client.clientId)))
    .limit(1);
  if (!named) return TOKEN_INVALID;
  const budget = await admitLinkCardUpdate(named.installationKey);
  if (!budget.admitted) {
    return fail(429, "RATE_LIMITED", "Too many card updates. Try again shortly.", { retryAfterSeconds: budget.retryAfterSeconds });
  }
  let accepted: { receipt: Receipt; moved: { viewerId: string; serverId: string } | null };
  try {
    accepted = await getDb().transaction((tx) => acceptInTransaction(tx, { client, request, tokenSha256 }));
  } catch (error) {
    if (error instanceof UpdateStop) return error.response;
    const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
    if (code === "55P03") return LOCK_TIMEOUT;
    throw error;
  }
  const { receipt, moved } = accepted;
  if (moved) input.hints({ viewerId: moved.viewerId, serverId: moved.serverId, operationId: receipt.operationId, receiptRevision: receipt.receiptRevision });
  return { status: 200, body: receiptBody(receipt) };
}

async function acceptInTransaction(tx: DatabaseExecutor, input: { client: { id: string; clientId: string }; request: LinkCardUpdateRequest; tokenSha256: string }) {
  const { client, request } = input;
  await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
  // The App's credentials are enabled now, FOR SHARE: disabling it (an UPDATE
  // of this row) is ordered with this acceptance, and after it nothing more is
  // accepted from that App.
  const [enabled] = await tx.select({ id: oauthClients.id }).from(oauthClients)
    .where(and(eq(oauthClients.id, client.id), eq(oauthClients.clientId, client.clientId), eq(oauthClients.enabled, true))).for("share");
  if (!enabled) throw new UpdateStop(LINK_CARD_UPDATE_INVALID_CLIENT);
  // One update per token: its row is locked, so two concurrent updates with it serialize.
  const locked = await tx.execute<{
    operation_id: string; server_id: string; provider_kind: string; provider_key: string; installation_key: string; registration_revision: string;
    consumed_update_id: string | null; content_sha256: string | null; receipt: Receipt | null; expired: boolean;
  }>(sql`SELECT operation_id, server_id, provider_kind, provider_key, installation_key, registration_revision, consumed_update_id, content_sha256, receipt,
      expires_at <= clock_timestamp() AS expired
    FROM ${linkCardUpdateTokens}
    WHERE token_sha256 = ${input.tokenSha256} AND provider_kind = 'app' AND provider_key = ${client.clientId} FOR UPDATE`);
  const token = locked.rows[0];
  if (!token) throw new UpdateStop(TOKEN_INVALID);
  if (token.consumed_update_id !== null) {
    // An identical retry gets the original receipt and changes nothing, even
    // after the token's own life; anything else on a used token is a conflict.
    if (token.consumed_update_id === request.updateId && token.content_sha256 === request.contentSha256 && token.receipt) return { receipt: token.receipt, moved: null };
    throw new UpdateStop(UPDATE_CONFLICT);
  }
  if (token.expired !== false) throw new UpdateStop(TOKEN_INVALID);
  const [op] = await tx.select().from(linkCardOperations).where(eq(linkCardOperations.operationId, token.operation_id)).for("update");
  // The token's full original binding (protocol §8.2 (1)): identity domain,
  // Server and the revision the operation was sent under, and the App that
  // authenticated is the operation's own. Not the current revision.
  if (!op || op.providerKind !== token.provider_kind || op.providerKey !== token.provider_key || op.providerKey !== client.clientId
    || op.installationKey !== token.installation_key || op.serverId !== token.server_id || op.registrationRevision !== token.registration_revision) {
    throw new UpdateStop(TOKEN_INVALID);
  }
  await hooks.underUpdateLocks?.(tx);
  // Forward only (protocol §8.1; the 0387 trigger enforces it for every
  // writer). A terminal operation stays as it is: the update is recorded, not applied.
  const [moved] = await tx.update(linkCardOperations)
    .set({ state: request.outcome, receiptRevision: sql`${linkCardOperations.receiptRevision} + 1`, updatedAt: sql`now()` })
    .where(and(eq(linkCardOperations.operationId, op.operationId), inArray(linkCardOperations.state, [...FROM_STATES])))
    .returning({ state: linkCardOperations.state, receiptRevision: linkCardOperations.receiptRevision });
  if (moved) {
    // Lazy release already frees the view; clearing it on the expected id keeps it in the sweep's index.
    await tx.update(linkCardViews).set({ pendingOperationId: null })
      .where(and(eq(linkCardViews.viewNonce, op.viewNonce), eq(linkCardViews.pendingOperationId, op.operationId)));
  }
  const receipt: Receipt = { operationId: op.operationId, state: moved?.state ?? op.state, receiptRevision: moved?.receiptRevision ?? op.receiptRevision };
  const consumed = await tx.update(linkCardUpdateTokens)
    .set({ consumedUpdateId: request.updateId, contentSha256: request.contentSha256, receipt })
    .where(and(eq(linkCardUpdateTokens.tokenSha256, input.tokenSha256), isNull(linkCardUpdateTokens.consumedUpdateId)))
    .returning({ tokenSha256: linkCardUpdateTokens.tokenSha256 });
  if (!consumed.length) throw new UpdateStop(UPDATE_CONFLICT);
  return { receipt, moved: moved ? { viewerId: op.viewerId, serverId: op.serverId } : null };
}
