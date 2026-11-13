/**
 * The personal assistant's WeChat bridge (design "微信接入 Ottie" v8, task
 * #proj-assistant:#14): who may use it, the QR binding flow, disconnect and
 * the cleanup hooks. The poll and mirror worker is wechatBridgeWorker.ts; the
 * web dialog (PR 3) comes later.
 *
 * - Available for a person in a server only while `personal_assistant` is on
 *   for the server, `assistant_wechat_v0` is on for the person, and the
 *   credential key is configured (isWeChatBridgeAvailable). A disconnect and the
 *   status of an existing binding never depend on it.
 * - Binding: POST .../assistant/wechat/attempts asks iLink for a QR code and
 *   binds the attempt to the starting browser (an HttpOnly cookie holding a
 *   state whose SHA-256 is the attempt's state_hash, oauthBrowserBinding). Only
 *   that browser, signed in as that person, may poll it (POST .../poll, one
 *   poll at a time); it lasts minutes and is used once. On `confirmed`, one
 *   transaction spends the attempt, holds the Ottie, refuses a
 *   WeChat account already bound elsewhere, stores the binding (the bot token
 *   encrypted), audits it, and writes a system notice into the owner's DM with
 *   Ottie saying WeChat was connected and how to undo it (broadcast after
 *   commit). There is no second confirmation in Raft (v6): the notice is how
 *   a QR code someone else scanned first gets noticed.
 * - What Raft cannot prevent: the QR content iLink hands out (shown to the
 *   person) likely embeds iLink's polling handle, so anyone who sees the QR
 *   code before it is used (a shared screen) could poll iLink for the bot
 *   token directly, or scan it first. Single use, the short lifetime and the
 *   connected notice are the mitigation.
 * - Disconnect and the cleanup on account deletion, departure, archive and
 *   server deletion: wechatBridgeCleanup.ts.
 * - Polling, inbound messages (the tag-first contract in
 *   wechatTurn.ts) and the outbound mirror: wechatBridgeWorker.ts.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { getDb, type DatabaseExecutor } from "../db/index";
import { agents, messages, servers, users, wechatBridgeAttempts, wechatBridgeBindings, wechatBridgeInboundMessages } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import { getMyAssistant, isPersonalAssistantEnabled } from "./assistantService";
import * as channelService from "./channelService";
import { ASSISTANT_WECHAT_FEATURE_FLAG_KEY, evaluateFeatureFlag } from "./featureFlagService";
import { recordIntegrationAuditEvent } from "./integrationAuditService";
import * as messageService from "./messageService";
import {
  clearOAuthBrowserBindingCookieForStateHash,
  oauthBrowserBindingCookie,
  oauthBrowserBindingStateHash,
  oauthRequestIsBoundToStateHash,
  type OAuthBrowserBinding,
} from "./oauthBrowserBinding";
import { wechatBridgeCredentialCipher } from "./wechatBridgeCredentialCipher";
import {
  ILINK_DEFAULT_BASE_URL,
  ILINK_QR_STATUS_TIMEOUT_MS,
  ILinkRequestError,
  wechatILinkClient,
  type ILinkQrStatus,
  type WeChatILinkClient,
} from "./wechatILinkClient";
import { recordTraceEvent } from "../tracing/semanticTrace";

/** How long a QR binding attempt (and its browser cookie) lives. */
export const WECHAT_ATTEMPT_TTL_MS = 5 * 60_000;
/** One status poll per attempt at a time: a lease a little longer than iLink's longest answer. */
export const WECHAT_POLL_LEASE_MS = ILINK_QR_STATUS_TIMEOUT_MS + 10_000;
const BROWSER_BINDING_PREFIX = "raft_wechat_bind";
const VERIFY_CODE_RE = /^[0-9A-Za-z]{1,16}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** pg_advisory_xact_lock namespace for starting attempts ("WXAT"). */
const START_LOCK_NAMESPACE = 0x57584154;

/** What the browser's poll learns: a status word, never an iLink id or token. */
export type WeChatAttemptStatus =
  | "wait"
  | "scanned"
  | "need_verify_code"
  | "confirmed"
  | "expired"
  | "blocked"
  | "already_bound";

export class WeChatBridgeError extends Error {
  override readonly name = "WeChatBridgeError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The attempt ended: the route clears its browser cookie. */
    readonly endedStateHash: string | null = null,
  ) {
    super(message);
  }
}

export const WECHAT_UNAVAILABLE_CODE = "wechat_unavailable";

function unavailable(): WeChatBridgeError {
  return new WeChatBridgeError(404, WECHAT_UNAVAILABLE_CODE, "WeChat is not available here.");
}

/**
 * Whether this person may bind WeChat in this server now. Every evaluation
 * failure reads as no.
 */
export async function isWeChatBridgeAvailable(serverId: string, userId: string): Promise<boolean> {
  if (!wechatBridgeCredentialCipher()) return false;
  if (!await isPersonalAssistantEnabled(serverId)) return false;
  try {
    return (await evaluateFeatureFlag({ key: ASSISTANT_WECHAT_FEATURE_FLAG_KEY, userId, serverId })).enabled;
  } catch {
    return false;
  }
}

/** The browser binding of a server's attempts: its cookie goes only to the attempts routes. */
export function wechatAttemptBrowserBinding(attemptsPath: string): OAuthBrowserBinding {
  return { prefix: BROWSER_BINDING_PREFIX, callbackPath: attemptsPath };
}

export interface WeChatBindingView {
  /** The binding's id: the one its connected notice names (randomId `wechat-connected:<id>`). */
  bindingId: string;
  state: "active" | "reconnect_required";
  connectedAt: string;
}

/** The person's binding in this server as they may see it: which one, its state and when it was made. */
export async function getWeChatBindingView(serverId: string, userId: string): Promise<WeChatBindingView | null> {
  const [row] = await getDb()
    .select({ id: wechatBridgeBindings.id, state: wechatBridgeBindings.state, createdAt: wechatBridgeBindings.createdAt })
    .from(wechatBridgeBindings)
    .where(and(eq(wechatBridgeBindings.serverId, serverId), eq(wechatBridgeBindings.userId, userId)))
    .limit(1);
  return row ? { bindingId: row.id, state: row.state, connectedAt: row.createdAt.toISOString() } : null;
}

// ── Starting an attempt ─────────────────────────────────────────────────────

export interface StartedWeChatAttempt {
  attemptId: string;
  qrContent: string;
  expiresAt: Date;
  /** Goes only into the browser's HttpOnly cookie; the row keeps its hash. */
  state: string;
}

function startLockKey(serverId: string, userId: string): number {
  return createHash("sha256").update(`${serverId}:${userId}`).digest().readInt32BE(0);
}

/**
 * The lock order of every transaction that writes this person's attempts or
 * binding: the server row, then the person's row (KEY SHARE: what the foreign
 * keys would take anyway, taken first), then their Ottie, then the attempt. A
 * server deletion (server, then attempts), an account deletion request (person,
 * then attempts) and an archive (Ottie, then attempts) take theirs in the same
 * order, so none of them can deadlock with a binding being made.
 */
async function lockWeChatParents(tx: DatabaseExecutor, serverId: string, userId: string): Promise<void> {
  await tx.select({ id: servers.id }).from(servers).where(eq(servers.id, serverId)).for("key share");
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("key share");
}

function isPendingAttemptUniqueViolation(err: unknown): boolean {
  return isUniqueViolationOf(err, "idx_wechat_bridge_attempts_pending");
}

/**
 * Start (or restart) the person's QR binding: their earlier attempts in this
 * server end, a new QR code is fetched from iLink. Needs their own assistant;
 * refused while a working binding exists (disconnect first). Two starts at
 * once are serialized; the later one replaces the earlier.
 */
export async function startWeChatAttempt(input: {
  serverId: string;
  userId: string;
  client?: WeChatILinkClient;
  now?: Date;
}): Promise<StartedWeChatAttempt> {
  const now = input.now ?? new Date();
  if (!await isWeChatBridgeAvailable(input.serverId, input.userId)) throw unavailable();
  const mine = await getMyAssistant(input.serverId, input.userId);
  if (!mine) throw new WeChatBridgeError(404, "assistant_not_found", "You have no assistant in this server.");
  const existing = await getWeChatBindingView(input.serverId, input.userId);
  if (existing?.state === "active") {
    throw new WeChatBridgeError(409, "wechat_already_connected", "WeChat is already connected. Disconnect it first.");
  }
  let qr;
  try {
    qr = await (input.client ?? wechatILinkClient()).getBotQrcode();
  } catch (err) {
    recordTraceEvent("server.assistant.wechat.qrcode_failed", { reason: err instanceof ILinkRequestError ? err.kind : "error" });
    throw new WeChatBridgeError(502, "wechat_upstream_unavailable", "WeChat could not be reached. Try again.");
  }
  const state = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + WECHAT_ATTEMPT_TTL_MS);
  const attemptId = randomUUID();
  try {
    await getDb().transaction(async (tx) => {
      // Concurrent starts by one person take turns here: each replaces the one before.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${START_LOCK_NAMESPACE}, ${startLockKey(input.serverId, input.userId)})`);
      await lockWeChatParents(tx, input.serverId, input.userId);
      await tx.delete(wechatBridgeAttempts).where(and(
        eq(wechatBridgeAttempts.serverId, input.serverId),
        eq(wechatBridgeAttempts.userId, input.userId),
      ));
      await tx.insert(wechatBridgeAttempts).values({
        id: attemptId,
        serverId: input.serverId,
        userId: input.userId,
        stateHash: oauthBrowserBindingStateHash(state),
        qrcode: qr.qrcode,
        qrBaseUrl: ILINK_DEFAULT_BASE_URL,
        status: "pending",
        expiresAt,
        createdAt: now,
      });
    });
  } catch (err) {
    // The backstop if the lock is ever bypassed: never a 500 for a double click.
    if (isPendingAttemptUniqueViolation(err)) {
      throw new WeChatBridgeError(409, "wechat_attempt_in_progress", "A QR code is already being made. Try again.");
    }
    throw err;
  }
  return { attemptId, qrContent: qr.qrContent, expiresAt, state };
}

/** Set-Cookie binding a started attempt to this browser, for as long as the attempt lives. */
export function wechatAttemptCookie(attemptsPath: string, started: StartedWeChatAttempt, now: Date = new Date()): string {
  return oauthBrowserBindingCookie(
    wechatAttemptBrowserBinding(attemptsPath),
    started.state,
    (started.expiresAt.getTime() - now.getTime()) / 1000,
  );
}

/** Set-Cookie removing an ended attempt's browser binding. */
export function clearWeChatAttemptCookie(attemptsPath: string, stateHash: string): string {
  return clearOAuthBrowserBindingCookieForStateHash(wechatAttemptBrowserBinding(attemptsPath), stateHash);
}

// ── Polling an attempt ──────────────────────────────────────────────────────

type AttemptRow = typeof wechatBridgeAttempts.$inferSelect;

/** End a pending attempt (single use): consumed now, its QR handle forgotten. */
async function endAttempt(executor: DatabaseExecutor, attemptId: string, status: "confirmed" | "expired" | "failed", now: Date): Promise<void> {
  await executor.update(wechatBridgeAttempts)
    .set({ status, consumedAt: now, qrcode: null, pollInFlightUntil: null })
    .where(and(eq(wechatBridgeAttempts.id, attemptId), eq(wechatBridgeAttempts.status, "pending")));
}

/** Take the attempt's poll lease, or null when another poll holds it. */
async function claimPoll(attemptId: string, now: Date): Promise<Date | null> {
  const until = new Date(now.getTime() + WECHAT_POLL_LEASE_MS);
  const [claimed] = await getDb().update(wechatBridgeAttempts)
    .set({ pollInFlightUntil: until })
    .where(and(
      eq(wechatBridgeAttempts.id, attemptId),
      eq(wechatBridgeAttempts.status, "pending"),
      or(isNull(wechatBridgeAttempts.pollInFlightUntil), lt(wechatBridgeAttempts.pollInFlightUntil, now)),
    ))
    .returning({ id: wechatBridgeAttempts.id });
  return claimed ? until : null;
}

async function releasePoll(attemptId: string, until: Date): Promise<void> {
  await getDb().update(wechatBridgeAttempts)
    .set({ pollInFlightUntil: null })
    .where(and(eq(wechatBridgeAttempts.id, attemptId), eq(wechatBridgeAttempts.pollInFlightUntil, until)));
}

export interface WeChatAttemptPoll {
  status: WeChatAttemptStatus;
  /** Set when the attempt ended with this poll: the route clears its cookie. */
  endedStateHash: string | null;
}

/**
 * One poll of the person's attempt from the browser that started it, with
 * WeChat's verification code when the last poll answered `need_verify_code`.
 * Another person gets the same 404 as for an attempt that does not exist; the
 * same person in another browser (no binding cookie) a 403, before iLink is
 * asked anything. A spent or expired attempt is refused (410); a poll while
 * another poll of the attempt is running, 429.
 */
export async function pollWeChatAttempt(input: {
  serverId: string;
  userId: string;
  attemptId: string;
  attemptsPath: string;
  cookieHeader: string | undefined;
  verifyCode?: string | null;
  io?: SocketServer;
  orchestrator?: AgentOrchestrator;
  client?: WeChatILinkClient;
  now?: Date;
}): Promise<WeChatAttemptPoll> {
  const now = input.now ?? new Date();
  if (!await isWeChatBridgeAvailable(input.serverId, input.userId)) throw unavailable();
  if (!UUID_RE.test(input.attemptId)) throw attemptNotFound();
  if (input.verifyCode != null && !VERIFY_CODE_RE.test(input.verifyCode)) {
    throw new WeChatBridgeError(400, "invalid_verify_code", "The verification code is malformed.");
  }
  const [attempt] = await getDb().select().from(wechatBridgeAttempts)
    .where(and(eq(wechatBridgeAttempts.id, input.attemptId), eq(wechatBridgeAttempts.serverId, input.serverId)))
    .limit(1);
  if (!attempt || attempt.userId !== input.userId) throw attemptNotFound();
  if (!oauthRequestIsBoundToStateHash(wechatAttemptBrowserBinding(input.attemptsPath), input.cookieHeader, attempt.stateHash)) {
    throw new WeChatBridgeError(403, "wechat_attempt_unbound", "Finish connecting WeChat in the browser you started in.");
  }
  if (attempt.status !== "pending" || !attempt.qrcode) {
    throw new WeChatBridgeError(410, "wechat_attempt_used", "This QR code was already used. Start again.", attempt.stateHash);
  }
  if (attempt.expiresAt.getTime() <= now.getTime()) {
    await endAttempt(getDb(), attempt.id, "expired", now);
    throw new WeChatBridgeError(410, "wechat_attempt_expired", "This QR code expired. Start again.", attempt.stateHash);
  }
  const lease = await claimPoll(attempt.id, now);
  if (!lease) throw new WeChatBridgeError(429, "wechat_poll_in_flight", "Still checking this QR code. Try again in a moment.");
  try {
    return await pollClaimedAttempt({ ...input, attempt: { ...attempt, qrcode: attempt.qrcode }, now });
  } finally {
    await releasePoll(attempt.id, lease).catch(() => undefined);
  }
}

async function pollClaimedAttempt(input: {
  attempt: AttemptRow & { qrcode: NonNullable<AttemptRow["qrcode"]> };
  verifyCode?: string | null;
  io?: SocketServer;
  orchestrator?: AgentOrchestrator;
  client?: WeChatILinkClient;
  now: Date;
}): Promise<WeChatAttemptPoll> {
  const { attempt, now } = input;
  let upstream: ILinkQrStatus;
  try {
    upstream = await (input.client ?? wechatILinkClient()).getQrcodeStatus({
      baseUrl: attempt.qrBaseUrl,
      qrcode: attempt.qrcode,
      verifyCode: input.verifyCode ?? null,
    });
  } catch (err) {
    if (err instanceof ILinkRequestError && err.kind === "host_not_allowed") {
      // iLink named a host outside the allowlist: nothing more is asked of it for this attempt.
      await endAttempt(getDb(), attempt.id, "failed", now);
      recordTraceEvent("server.assistant.wechat.host_refused", { attempt_id: attempt.id });
      throw new WeChatBridgeError(502, "wechat_upstream_refused", "WeChat answered unexpectedly. Start again.", attempt.stateHash);
    }
    throw new WeChatBridgeError(502, "wechat_upstream_unavailable", "WeChat could not be reached. Try again.");
  }

  switch (upstream.status) {
    case "wait":
      return { status: "wait", endedStateHash: null };
    case "scaned":
      return { status: "scanned", endedStateHash: null };
    case "need_verifycode":
      return { status: "need_verify_code", endedStateHash: null };
    case "scaned_but_redirect":
      if (upstream.redirectBaseUrl) {
        await getDb().update(wechatBridgeAttempts)
          .set({ qrBaseUrl: upstream.redirectBaseUrl })
          .where(and(eq(wechatBridgeAttempts.id, attempt.id), eq(wechatBridgeAttempts.status, "pending")));
      }
      return { status: "scanned", endedStateHash: null };
    case "expired":
      await endAttempt(getDb(), attempt.id, "expired", now);
      return { status: "expired", endedStateHash: attempt.stateHash };
    case "verify_code_blocked":
      await endAttempt(getDb(), attempt.id, "failed", now);
      return { status: "blocked", endedStateHash: attempt.stateHash };
    case "binded_redirect":
      await endAttempt(getDb(), attempt.id, "failed", now);
      return { status: "already_bound", endedStateHash: attempt.stateHash };
    case "confirmed":
      await confirmAttempt({ attempt, confirmed: upstream, io: input.io, orchestrator: input.orchestrator, now });
      return { status: "confirmed", endedStateHash: attempt.stateHash };
  }
}

function attemptNotFound(): WeChatBridgeError {
  return new WeChatBridgeError(404, "wechat_attempt_not_found", "No such QR code.");
}

function isUniqueViolationOf(err: unknown, constraint: string): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown; cause?: unknown };
    if (candidate.code === "23505" && (
      candidate.constraint === constraint
      || candidate.constraint_name === constraint
      || (typeof candidate.message === "string" && candidate.message.includes(constraint))
    )) return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * The attempt was confirmed in WeChat: in one transaction hold the person's
 * Ottie (an archive racing this either finishes first and the binding is
 * refused, or waits and removes the new binding with the Ottie), spend the
 * attempt, refuse a WeChat account bound anywhere else, replace the person's
 * own binding in this server (a reconnect; its messages' reply tokens are
 * cleared), write the connected notice into the owner's DM with Ottie
 * (randomId `wechat-connected:<binding id>`: one per binding, ever), store the
 * new binding with its token encrypted and its outbound cursor at the notice,
 * and audit.
 * After commit the notice is broadcast. The token is never stored anywhere
 * else, and is dropped when the binding is refused.
 */
async function confirmAttempt(input: {
  attempt: AttemptRow;
  confirmed: Extract<ILinkQrStatus, { status: "confirmed" }>;
  io?: SocketServer;
  orchestrator?: AgentOrchestrator;
  now: Date;
}): Promise<void> {
  const { attempt, confirmed, now } = input;
  const ended = attempt.stateHash;
  const cipher = wechatBridgeCredentialCipher();
  const mine = await getMyAssistant(attempt.serverId, attempt.userId);
  const dmChannelId = mine
    ? mine.dmChannelId ?? (await channelService.findOrCreateDM(attempt.serverId, attempt.userId, mine.agentId))?.id ?? null
    : null;
  if (!cipher || !mine || !dmChannelId) {
    await endAttempt(getDb(), attempt.id, "failed", now);
    if (!cipher) throw new WeChatBridgeError(404, WECHAT_UNAVAILABLE_CODE, "WeChat is not available here.", ended);
    throw assistantGone(ended);
  }
  const noticeText = wechatConnectedNoticeText(now, await ownerTimezone(attempt.userId));

  type Outcome =
    | { kind: "bound"; bindingId: string; notice: typeof messages.$inferSelect }
    | { kind: "used" } | { kind: "expired" } | { kind: "in_use" } | { kind: "assistant_gone" };
  let outcome: Outcome;
  try {
    outcome = await getDb().transaction(async (tx): Promise<Outcome> => {
      // Lock order (lockWeChatParents): server, person, Ottie, then the attempt.
      await lockWeChatParents(tx, attempt.serverId, attempt.userId);
      // The Ottie as of now, held until commit (an archive locks it FOR UPDATE).
      const [ottie] = await tx.select({ id: agents.id }).from(agents)
        .where(and(
          eq(agents.id, mine.agentId),
          eq(agents.serverId, attempt.serverId),
          eq(agents.assistantOwnerUserId, attempt.userId),
          isNull(agents.deletedAt),
        ))
        .for("share");
      const [locked] = await tx.select({ status: wechatBridgeAttempts.status, userId: wechatBridgeAttempts.userId, expiresAt: wechatBridgeAttempts.expiresAt })
        .from(wechatBridgeAttempts)
        .where(eq(wechatBridgeAttempts.id, attempt.id))
        .for("update");
      // Another poll of the same attempt got here first, or a cleanup removed it: single use.
      if (!locked || locked.status !== "pending" || locked.userId !== attempt.userId) return { kind: "used" };
      if (locked.expiresAt.getTime() <= now.getTime()) {
        await endAttempt(tx, attempt.id, "expired", now);
        return { kind: "expired" };
      }
      if (!ottie) {
        await endAttempt(tx, attempt.id, "failed", now);
        return { kind: "assistant_gone" };
      }
      const [holder] = await tx.select({ serverId: wechatBridgeBindings.serverId, userId: wechatBridgeBindings.userId })
        .from(wechatBridgeBindings)
        .where(eq(wechatBridgeBindings.ilinkUserId, confirmed.ilinkUserId))
        .limit(1);
      if (holder && !(holder.serverId === attempt.serverId && holder.userId === attempt.userId)) {
        await endAttempt(tx, attempt.id, "failed", now);
        return { kind: "in_use" };
      }
      // A reconnect: the person's earlier binding here (a stale token) gives way.
      // Its messages' reply tokens go with it (as in wechatBridgeCleanup): the
      // new binding (maybe another WeChat account) never answers through them.
      const earlier = await tx.select({ id: wechatBridgeBindings.id }).from(wechatBridgeBindings)
        .where(and(eq(wechatBridgeBindings.serverId, attempt.serverId), eq(wechatBridgeBindings.userId, attempt.userId)))
        .for("update");
      if (earlier.length > 0) {
        await tx.update(wechatBridgeInboundMessages).set({ contextToken: null })
          .where(inArray(wechatBridgeInboundMessages.bindingId, earlier.map((row) => row.id)));
      }
      const replaced = await tx.delete(wechatBridgeBindings)
        .where(and(eq(wechatBridgeBindings.serverId, attempt.serverId), eq(wechatBridgeBindings.userId, attempt.userId)))
        .returning({ id: wechatBridgeBindings.id });
      const bindingId = randomUUID();
      // The connected notice commits with the binding: no binding without it, never two.
      const notice = await messageService.createMessage(dmChannelId, "user", "system", noticeText, "system", undefined, {
        randomId: `wechat-connected:${bindingId}`,
        systemSubtype: CONNECTED_NOTICE_POLICY.producer,
      }, tx);
      await messageService.recordInboxFactsForPersistedMessages([notice], { inboxFactPolicy: CONNECTED_NOTICE_POLICY, executor: tx });
      const sealed = cipher.seal({ bindingId, userId: attempt.userId, ilinkBotId: confirmed.ilinkBotId, botToken: confirmed.botToken });
      await tx.insert(wechatBridgeBindings).values({
        id: bindingId,
        serverId: attempt.serverId,
        userId: attempt.userId,
        agentId: mine.agentId,
        dmChannelId,
        ilinkBotId: confirmed.ilinkBotId,
        ilinkUserId: confirmed.ilinkUserId,
        // Already a normalized, allowlisted origin (parseGetQrcodeStatusResponse).
        baseUrl: confirmed.baseUrl,
        encryptedBotToken: sealed.encryptedBotToken,
        envelopeKeyId: sealed.envelopeKeyId,
        aadVersion: sealed.aadVersion,
        state: "active",
        // The outbound mirror starts after the notice: nothing the assistant wrote before is counted or sent.
        outboundSeq: notice.seq,
        createdAt: now,
        updatedAt: now,
      });
      await endAttempt(tx, attempt.id, "confirmed", now);
      await recordIntegrationAuditEvent({
        serverId: attempt.serverId,
        eventType: "assistant.wechat_bound",
        outcome: "success",
        source: "web",
        actor: { type: "human", id: attempt.userId },
        subject: { type: "human", id: attempt.userId },
        target: { type: "wechat_bridge_binding", id: bindingId },
        metadata: { agentId: mine.agentId, channelId: dmChannelId, replacedBinding: replaced.length > 0 },
      }, tx);
      return { kind: "bound", bindingId, notice };
    });
  } catch (err) {
    if (!isUniqueViolationOf(err, "idx_wechat_bridge_bindings_ilink_user")) throw err;
    // Bound elsewhere by a concurrent confirmation.
    await endAttempt(getDb(), attempt.id, "failed", now);
    outcome = { kind: "in_use" };
  }

  if (outcome.kind === "used") throw new WeChatBridgeError(410, "wechat_attempt_used", "This QR code was already used. Start again.", ended);
  if (outcome.kind === "expired") throw new WeChatBridgeError(410, "wechat_attempt_expired", "This QR code expired. Start again.", ended);
  if (outcome.kind === "assistant_gone") throw assistantGone(ended);
  if (outcome.kind === "in_use") {
    recordTraceEvent("server.assistant.wechat.account_in_use", { server_id: attempt.serverId, subject_user_id: attempt.userId });
    throw new WeChatBridgeError(409, "wechat_account_in_use", "This WeChat account is already connected to another assistant.", ended);
  }
  await broadcastWeChatNotice({
    io: input.io,
    orchestrator: input.orchestrator,
    notice: outcome.notice,
    ownerUserId: attempt.userId,
    agentId: mine.agentId,
    policy: CONNECTED_NOTICE_POLICY,
    traceName: "server.assistant.wechat.connected_notice",
  });
}

function assistantGone(endedStateHash: string): WeChatBridgeError {
  return new WeChatBridgeError(409, "assistant_not_found", "You have no assistant in this server.", endedStateHash);
}

// ── The connected notice ────────────────────────────────────────────────────

/** `2026-11-02 15:04 (Asia/Shanghai)`, in the owner's zone when Raft knows a valid one, else UTC. */
export function formatWeChatNoticeTime(at: Date, timezone: string | null): string {
  const format = (timeZone: string) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} (${timeZone})`;
  };
  if (timezone) {
    try {
      return format(timezone);
    } catch {
      // An unknown zone name: fall through to UTC.
    }
  }
  return format("UTC");
}

/**
 * The connected notice, the one place its copy lives (final copy is settled
 * with the web dialog, PR 3). `{time}` becomes formatWeChatNoticeTime's text.
 */
export const WECHAT_CONNECTED_NOTICE_TEMPLATE = "微信已在 {time} 连接。如果不是你本人操作，请在 Ottie 设置里断开微信。";

export function wechatConnectedNoticeText(at: Date, timezone: string | null): string {
  return WECHAT_CONNECTED_NOTICE_TEMPLATE.replace("{time}", formatWeChatNoticeTime(at, timezone));
}

const CONNECTED_NOTICE_POLICY = {
  mode: "record",
  producer: "assistant.wechat_connected",
  reason: "the owner learns their WeChat was connected, in case it was not them",
} as const;

async function ownerTimezone(userId: string): Promise<string | null> {
  const [owner] = await getDb()
    .select({ preferredTimezone: users.preferredTimezone, lastObservedTimezone: users.lastObservedTimezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return owner?.preferredTimezone || owner?.lastObservedTimezone || null;
}

/**
 * Show a committed bridge notice (the connected notice; the poll worker's
 * reconnect notice) in the owner's open clients. Never throws: the notice is
 * already durable (their DM has it on the next load); a broadcast that failed
 * is traced as `<traceName>.broadcast_failed`.
 */
export async function broadcastWeChatNotice(input: {
  io: SocketServer | undefined;
  orchestrator: AgentOrchestrator | undefined;
  notice: typeof messages.$inferSelect;
  ownerUserId: string;
  agentId: string;
  policy: messageService.SystemMessageInboxFactPolicy;
  traceName: string;
}): Promise<void> {
  const attrs = { agent_id: input.agentId, subject_user_id: input.ownerUserId, channel_id: input.notice.channelId };
  try {
    if (!input.io || !input.orchestrator) {
      recordTraceEvent(`${input.traceName}.broadcast_failed`, { ...attrs, reason: "no_socket_server" });
      return;
    }
    await messageService.broadcastSystemMessage(input.io, input.orchestrator, input.notice.channelId, input.notice.content, {
      inboxFactPolicy: input.policy,
      persistedMessage: input.notice,
      // For the owner; Ottie need not wake for it.
      targetAgentIds: [],
    });
    recordTraceEvent(input.traceName, attrs);
  } catch (err) {
    recordTraceEvent(`${input.traceName}.broadcast_failed`, { ...attrs, reason: err instanceof Error ? err.name : "error" });
  }
}
