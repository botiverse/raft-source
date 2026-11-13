/**
 * The confirm tier of a personal assistant's owner actions (#proj-assistant:#19,
 * PR 2; the table: services/assistantOwnerActions.ts).
 *
 * The assistant calls a `confirm` entry's route like a direct one, and auth
 * admits it the same way (middleware/assistantAsOwner.ts: the table entry, its
 * fields, its target as the owner sees it). Then nothing runs. Raft posts an
 * `assistant:owner_action` card in the owner's DM with the assistant, worded
 * by Raft from the entry's `card` (the assistant writes none of it), and
 * answers 202 `pending_owner_confirm`.
 *
 *   Same request again (same entry, path and body: `paramsKey`)
 *     - while its card waits: the same card, "already waiting";
 *     - after the owner declined it, until the owner writes in the DM after
 *       that: 409 `owner_declined`, no new card (Sage: no asking again in a loop);
 *     - otherwise a new card.
 *   Confirm (only the owner: the form handler checks it): admission is checked
 *     again as the owner, then the stored route runs IN-PROCESS through the
 *     Express app with the Authorization header of the owner's own Confirm
 *     request, so it is the owner's real web session through requireAuth, the
 *     route's own middleware and its unchanged handler (dispatchOwnerRoute).
 *     Its answer, success or the route's own error, goes to the assistant.
 *   Decline: nothing runs.
 *   24 hours unanswered: the card ends expired.
 * Each end is a `system.assistant` agent event to the assistant (Sage's text),
 * written in the same transaction that ends the card, on the card's own inbox
 * item `app:system.assistant/card/<card message id>` (ownerActionCardObjectRef).
 */
import { createHash } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import {
  asServerId,
  buildAssistantOwnerActionForms,
  formatUtcTimestamp,
  type ActionCardMetadata,
  type ActionCardResult,
  type AssistantOwnerActionCardAction,
} from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { afterAmbientTransaction } from "../db/ambientTransaction";
import { actionCards, agents, messages } from "../db/schema";
import type { ActionCardFormHandler } from "./actionCardForms";
import * as channelService from "./channelService";
import {
  ASSISTANT_OWNER_ACTION_EVENT,
  matchAssistantOwnerAction,
  ownerLabel,
  type AssistantOwnerAction,
  type AssistantOwnerActionRequestScope,
} from "./assistantOwnerActions";
import { recordIntegrationAuditEventBestEffort } from "./integrationAuditService";
import { createSystemAppAgentEvent, type SystemAppAgentEvent } from "./systemAppAgentEvents";

export const ASSISTANT_OWNER_ACTION_CARD_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an outcome event waits for the assistant (it reads them through /events). */
const OUTCOME_EVENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SYSTEM_ASSISTANT_APP = "system.assistant" as const;

export type OwnerRouteRequest = { method: AssistantOwnerActionCardAction["request"]["method"]; path: string; body: Record<string, unknown> };

/** An error with the status and code the execute route answers with (routes/actions.ts handleError). */
export class OwnerActionCardError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "OwnerActionCardError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Same entry, route and body: the same card. */
export function ownerActionParamsKey(actionKey: string, request: OwnerRouteRequest): string {
  return createHash("sha256").update(canonicalJson({ actionKey, method: request.method, path: request.path, body: request.body })).digest("hex");
}

function cardTitle(action: Pick<AssistantOwnerActionCardAction, "assistantName" | "phrase">): string {
  return `${action.assistantName} wants to ${action.phrase} as you`;
}

// ── Sage's strings (#proj-assistant:#19) ─────────────────────────────────────

export const ownerActionText = {
  pending: (owner: string, title: string, expiresAt: string) =>
    `Not done yet. Raft posted a card in your DM asking ${owner} to confirm: "${title}". Nothing changes unless they press Confirm; the card expires at ${expiresAt}. Don't call this again: you'll get an event when they confirm or decline, or when it expires. If ${owner} asked for this, tell them the card is waiting.`,
  alreadyWaiting: (owner: string, postedAt: string, expiresAt: string) =>
    `Already waiting for ${owner} to confirm this (card posted ${postedAt}, expires ${expiresAt}). Don't call it again; you'll get an event when they decide.`,
  declinedBefore: (owner: string, declinedAt: string) =>
    `${owner} declined this at ${declinedAt}. Raft won't post the same card again until ${owner} writes to you after that. Don't retry; if they bring it up, call it again then.`,
  confirmedDone: (owner: string, done: string) => `${owner} confirmed, and it's done: ${done}.`,
  confirmedFailed: (owner: string, error: string, tool: string) =>
    `${owner} confirmed, but it failed: ${error}. Tell ${owner} what failed. To try again, call ${tool} again: it posts a new card.`,
  declined: (owner: string, phrase: string) => `${owner} declined: ${phrase}. Nothing changed. Don't ask again unless ${owner} brings it up.`,
  /** The route's answer never came (the dispatch timeout, or a claim that outlived it): it may have run. */
  confirmedUnknown: (owner: string) =>
    `${owner} confirmed, but Raft didn't hear back in time, so it may have run. Don't post a new card: check with ${owner} first.`,
  expired: (phrase: string, owner: string, tool: string) =>
    `The card to ${phrase} expired without an answer. Nothing changed. Don't post it again on your own; if ${owner} still wants it, call ${tool} again when they ask.`,
};

// ── Asking: the confirm-tier call ────────────────────────────────────────────

export interface OwnerActionConfirmationAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * The assistant's call to a confirm entry, admitted as the owner: the same
 * card, a refusal after a decline, or a new card. Never runs the route.
 */
export async function requestOwnerActionConfirmation(input: {
  io: SocketServer | null;
  action: AssistantOwnerAction<unknown>;
  scope: AssistantOwnerActionRequestScope;
  before: unknown;
  owner: string;
  request: OwnerRouteRequest;
  now?: Date;
}): Promise<OwnerActionConfirmationAnswer> {
  const { action, scope, owner } = input;
  const now = input.now ?? new Date();
  if (!action.card) throw new Error(`confirm entry ${action.key} has no card`);
  const dmChannelId = await channelService.findHumanAgentDmChannelId(scope.serverId, scope.ownerUserId, scope.agentId);
  if (!dmChannelId) {
    return { status: 409, body: { error: `There's no DM between you and ${owner} to post the card in.`, code: "assistant_owner_action_no_dm" } };
  }
  const paramsKey = ownerActionParamsKey(action.key, input.request);
  const db = getDb();
  const [latest] = await db.select({ messageId: actionCards.messageId, state: actionCards.state, payload: actionCards.payload, createdAt: actionCards.createdAt })
    .from(actionCards)
    .where(and(
      eq(actionCards.actionType, "assistant:owner_action"),
      eq(actionCards.requesterAgentId, scope.agentId),
      sql`${actionCards.payload} ->> 'paramsKey' = ${paramsKey}`,
    ))
    .orderBy(desc(actionCards.createdAt), desc(actionCards.id))
    .limit(1);
  if (latest) {
    const stored = latest.payload as AssistantOwnerActionCardAction;
    if (latest.state === "prepared") {
      // Waiting, or being decided right now (a claim): the same card.
      if (new Date(stored.expiresAt) > now || await isClaimed(latest.messageId)) {
        return {
          status: 202,
          body: {
            assistant: {
              state: "pending_owner_confirm",
              already: true,
              text: ownerActionText.alreadyWaiting(owner, formatUtcTimestamp(stored.createdAt), formatUtcTimestamp(stored.expiresAt)),
              cardMessageId: latest.messageId,
              expiresAt: stored.expiresAt,
            },
          },
        };
      }
      // Past its time but not swept yet: end it (the assistant hears it expired), then ask again.
      await expireAssistantOwnerActionCard({ messageId: latest.messageId, io: input.io });
    } else if (latest.state === "executed") {
      const declinedAt = await declinedAtOf(latest.messageId);
      if (declinedAt && !await ownerWroteSince(dmChannelId, scope.ownerUserId, declinedAt)) {
        return {
          status: 409,
          body: {
            error: ownerActionText.declinedBefore(owner, formatUtcTimestamp(declinedAt)),
            code: "owner_declined",
            assistant: { state: "owner_declined", text: ownerActionText.declinedBefore(owner, formatUtcTimestamp(declinedAt)), cardMessageId: latest.messageId },
          },
        };
      }
    }
  }

  const text = await action.card(scope, input.before, owner);
  const [assistant] = await db.select({ name: agents.name, displayName: agents.displayName }).from(agents).where(eq(agents.id, scope.agentId)).limit(1);
  const cardAction: AssistantOwnerActionCardAction = {
    type: "assistant:owner_action",
    assistantAgentId: scope.agentId,
    assistantName: (assistant?.displayName || assistant?.name || "Your assistant").slice(0, 120),
    ownerUserId: scope.ownerUserId,
    actionKey: action.key,
    tool: action.tool,
    phrase: text.phrase.slice(0, 200),
    done: text.done.slice(0, 200),
    description: text.description.slice(0, 1000),
    request: input.request,
    paramsKey,
    args: text.args,
    ...(text.view ? { view: text.view } : {}),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ASSISTANT_OWNER_ACTION_CARD_TTL_MS).toISOString(),
  };
  const posted = await postCard({ io: input.io, serverId: scope.serverId, agentId: scope.agentId, channelId: dmChannelId, action: cardAction });
  return {
    status: 202,
    body: {
      assistant: {
        state: "pending_owner_confirm",
        text: ownerActionText.pending(owner, cardTitle(cardAction), formatUtcTimestamp(cardAction.expiresAt)),
        cardMessageId: posted.messageId,
        expiresAt: cardAction.expiresAt,
      },
    },
  };
}

async function postCard(args: { io: SocketServer | null; serverId: string; agentId: string; channelId: string; action: AssistantOwnerActionCardAction }) {
  // Imported lazily: actionCardsService imports the form registry, which imports this module.
  const { postServerBuiltActionCard } = await import("./actionCardsService");
  return postServerBuiltActionCard({ io: args.io, serverId: asServerId(args.serverId), requesterAgentId: args.agentId, channelId: args.channelId, action: args.action });
}

/** When the owner declined this card; null when it did not end in a decline. */
async function declinedAtOf(messageId: string): Promise<Date | null> {
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId)).limit(1);
  const result = (row?.actionMetadata as ActionCardMetadata | null | undefined)?.result;
  if (result?.kind !== "assistant-owner-action" || result.decision !== "declined") return null;
  return new Date(result.decidedAt);
}

async function ownerWroteSince(dmChannelId: string, ownerUserId: string, since: Date): Promise<boolean> {
  const [row] = await getDb().select({ id: messages.id }).from(messages)
    .where(and(eq(messages.channelId, dmChannelId), eq(messages.senderType, "user"), eq(messages.senderId, ownerUserId), gt(messages.createdAt, since)))
    .limit(1);
  return !!row;
}

// ── Deciding: the card's form ────────────────────────────────────────────────

/**
 * Marks a request this module dispatched (dispatchOwnerRoute): a JS Symbol on
 * the request object, so no client can set it. A marked request never comes
 * back in as the assistant (middleware/assistantAsOwner.ts) and never confirms
 * an owner-action card (routes/actions.ts): no dispatch from inside a dispatch.
 */
export const OWNER_DISPATCH_MARK: unique symbol = Symbol("raft.assistantOwnerDispatch");

/** Whether `req` is one dispatchOwnerRoute made. */
export function isOwnerDispatch(req: object): boolean {
  return (req as { [OWNER_DISPATCH_MARK]?: unknown })[OWNER_DISPATCH_MARK] !== undefined;
}

/**
 * The owner's own Confirm request, which the confirmed route runs as
 * (routes/actions.ts builds it from the live request). Only these headers are
 * carried over, never stored: the credential lives only as long as that
 * request. Nothing that changes trust or the client address (X-Forwarded-*,
 * CloudFront headers) is copied; the owner's address, as the rate limits read
 * it, is carried as `clientIp` and becomes the synthetic socket's address.
 */
export interface OwnerConfirmRequest {
  /** The Express app (`req.app`): the stored route goes through it like any request. */
  app: (req: IncomingMessage, res: ServerResponse) => void;
  headers: {
    authorization?: string;
    cookie?: string;
    origin?: string;
  };
  /** clientIpForRateLimit of the Confirm request. */
  clientIp: string;
}

export interface OwnerRouteAnswer {
  status: number;
  body: Record<string, unknown>;
}

export type OwnerRouteDispatcher = (input: { ownerRequest: OwnerConfirmRequest; serverId: string; request: OwnerRouteRequest; cardMessageId: string }) => Promise<OwnerRouteAnswer>;

/**
 * 30 s: the routes in the confirm tier answer once they have validated and
 * committed (migrate provisions a transfer lease and records the migration;
 * the transfer itself runs afterwards on the computers), including when the
 * request is handed to the instance holding the computer. A route that takes
 * longer may still finish: the assistant is told so.
 */
export const OWNER_DISPATCH_TIMEOUT_MS = 30_000;
export const OWNER_DISPATCH_TIMEOUT_CODE = "assistant_owner_action_timeout";
const UNKNOWN_SUMMARY = "Confirmed, but Raft didn't hear back in time, so it may have run.";
/** What the assistant can be told about a route's answer; more is cut and marked. */
export const OWNER_DISPATCH_MAX_RESPONSE_BYTES = 256 * 1024;

let dispatchTimeoutMs = OWNER_DISPATCH_TIMEOUT_MS;
let dispatchMaxBytes = OWNER_DISPATCH_MAX_RESPONSE_BYTES;
/** Tests only. */
export function setOwnerDispatchBoundsForTest(bounds: { timeoutMs?: number; maxBytes?: number } | null): void {
  dispatchTimeoutMs = bounds?.timeoutMs ?? OWNER_DISPATCH_TIMEOUT_MS;
  dispatchMaxBytes = bounds?.maxBytes ?? OWNER_DISPATCH_MAX_RESPONSE_BYTES;
}

/**
 * Runs the one stored request through the Express app as one more request, in
 * this process, marked (OWNER_DISPATCH_MARK). It carries only the Confirm
 * request's Authorization, Cookie and Origin (X-Server-Id is the card's own
 * server, never the request's): the owner's live
 * web session, which requireAuth verifies as for any request, so their session
 * scope (2FA recency, full-session checks) is what the route sees. Its socket
 * address is the owner's (clientIp), with no forwarding headers, so `req.ip`
 * and clientIpForRateLimit read the owner's address. Every middleware and the
 * route's unchanged handler run; a handler that hands the request to the
 * instance holding a computer forwards it with these headers. Bounded: an
 * answer after OWNER_DISPATCH_TIMEOUT_MS is a 504 ("may still finish"), and at
 * most OWNER_DISPATCH_MAX_RESPONSE_BYTES of the body are kept.
 */
export const dispatchOwnerRoute: OwnerRouteDispatcher = ({ ownerRequest, serverId, request, cardMessageId }) => new Promise((resolve, reject) => {
  const payload = Buffer.from(JSON.stringify(request.body));
  const socket = new Socket();
  // Not connected: the owner's own address, so the rate limits count this against them.
  Object.defineProperty(socket, "remoteAddress", { value: ownerRequest.clientIp });
  const req = new IncomingMessage(socket);
  req.method = request.method;
  req.url = request.path;
  const headers: Record<string, string> = {
    host: "raft.internal",
    "content-type": "application/json",
    "content-length": String(payload.length),
    // Always the card's own server, never the Confirm request's header (Tenny 1ee69bd8).
    "x-server-id": serverId,
  };
  if (ownerRequest.headers.authorization) headers.authorization = ownerRequest.headers.authorization;
  if (ownerRequest.headers.cookie) headers.cookie = ownerRequest.headers.cookie;
  if (ownerRequest.headers.origin) headers.origin = ownerRequest.headers.origin;
  req.headers = headers;
  req.rawHeaders = Object.entries(headers).flat();
  (req as unknown as { [OWNER_DISPATCH_MARK]: string })[OWNER_DISPATCH_MARK] = cardMessageId;
  req.push(payload);
  req.push(null);
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  let kept = 0;
  let truncated = false;
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    resolve({
      status: 504,
      body: {
        error: `The route didn't answer within ${Math.round(dispatchTimeoutMs / 1000)} seconds; it may still finish, so check before trying again`,
        code: OWNER_DISPATCH_TIMEOUT_CODE,
      },
    });
  }, dispatchTimeoutMs);
  timer.unref?.();
  const keep = (buffer: Buffer) => {
    if (kept >= dispatchMaxBytes) { truncated = true; return; }
    const room = dispatchMaxBytes - kept;
    if (buffer.length > room) { truncated = true; chunks.push(buffer.subarray(0, room)); kept = dispatchMaxBytes; return; }
    chunks.push(buffer);
    kept += buffer.length;
  };
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const text = Buffer.concat(chunks).toString("utf8");
    let body: Record<string, unknown> = {};
    if (truncated) {
      body = { error: `The route answered HTTP ${res.statusCode} with more than ${dispatchMaxBytes} bytes; the answer was cut`, truncated: true };
    } else {
      try {
        const parsed: unknown = text ? JSON.parse(text) : {};
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch { body = { error: text.slice(0, 500) }; }
    }
    resolve({ status: res.statusCode, body });
  };
  const toBuffer = (chunk: unknown, encoding?: unknown) => typeof chunk === "string"
    ? Buffer.from(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8")
    : Buffer.from(chunk as Uint8Array);
  res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    if (chunk !== undefined && chunk !== null) keep(toBuffer(chunk, encoding));
    const done = typeof encoding === "function" ? encoding : cb;
    if (typeof done === "function") (done as () => void)();
    return true;
  }) as ServerResponse["write"];
  res.end = ((chunk?: unknown, encoding?: unknown, cb?: unknown) => {
    if (chunk !== undefined && chunk !== null && typeof chunk !== "function") keep(toBuffer(chunk, encoding));
    const done = [chunk, encoding, cb].find((value) => typeof value === "function");
    finish();
    if (typeof done === "function") (done as () => void)();
    res.emit("finish");
    return res;
  }) as ServerResponse["end"];
  try {
    ownerRequest.app(req, res);
  } catch (err) {
    if (!settled) { settled = true; clearTimeout(timer); reject(err); }
  }
});

let dispatcher: OwnerRouteDispatcher = dispatchOwnerRoute;
/** Tests only: what a confirmed card runs instead of the real route. */
export function setOwnerRouteDispatcherForTest(next: OwnerRouteDispatcher | null): void {
  dispatcher = next ?? dispatchOwnerRoute;
}

interface DecisionInput {
  decision: "confirm" | "decline";
  result?: Extract<ActionCardResult, { kind: "assistant-owner-action" }>;
  /** The assistant's event text, with the result. */
  eventText?: string;
  /** What the assistant's event says happened. */
  outcome?: "declined" | "confirmed_done" | "confirmed_failed" | "confirmed_unknown";
}

function routeErrorText(entry: AssistantOwnerAction<unknown> | null, answer: OwnerRouteAnswer, owner: string): string {
  const code = typeof answer.body.code === "string" ? answer.body.code : typeof answer.body.errorCode === "string" ? answer.body.errorCode : undefined;
  const rewrite = code ? entry?.errorText?.[code] : undefined;
  const message = rewrite ? rewrite(owner) : typeof answer.body.error === "string" ? answer.body.error : `Raft answered HTTP ${answer.status}`;
  const next = typeof answer.body.suggestedNextAction === "string" ? ` ${answer.body.suggestedNextAction}` : "";
  return `${message.replace(/[.\s]+$/u, "")}${code ? ` (${code})` : ""}${next ? `.${next.replace(/\.$/u, "")}` : ""}`;
}

export const assistantOwnerActionFormHandler: ActionCardFormHandler<"assistant:owner_action", DecisionInput> = {
  buildForm(action) {
    return buildAssistantOwnerActionForms(action);
  },

  async validate(values) {
    // The shared checks passed: the decision is chosen and is one of the two.
    return { input: { decision: values.decision === "confirm" ? "confirm" : "decline" } };
  },

  // Before execute's transaction (which locks the DM): the route may take a while.
  async deliver(input, ctx) {
    // One decision at a time: a Confirm or Decline claims the card first (phone and desktop, a
    // double click), so only one dispatches; the claim ends in execute or is released on a throw.
    if (ctx.userId === ctx.action.ownerUserId && new Date(ctx.action.expiresAt) > new Date()) {
      if (!await claimOwnerActionCard(ctx.messageId, ctx.userId, input.decision)) {
        throw new OwnerActionCardError(409, "OWNER_ACTION_ALREADY_CONFIRMING", "Already being confirmed.");
      }
      const progress = { dispatched: false };
      try {
        return await decideOwnerActionCard(input, ctx, progress);
      } catch (err) {
        // Released only while nothing has run (Tenny ab2c84bd): once the dispatch has started the
        // route may have run, so the claim stays and the stale sweep ends the card as unknown.
        if (!progress.dispatched) await releaseOwnerActionCardClaim(ctx.messageId);
        throw err;
      }
    }
    return decideOwnerActionCard(input, ctx, { dispatched: false });
  },

  async execute(input, ctx) {
    return recordOwnerActionDecision(input, ctx);
  },
};

type DecisionContext = Parameters<NonNullable<ActionCardFormHandler<"assistant:owner_action", DecisionInput>["deliver"]>>[1];

async function decideOwnerActionCard(input: DecisionInput, ctx: DecisionContext, progress: { dispatched: boolean }): Promise<DecisionInput> {
  {
    const action = ctx.action;
    const owner = await ownerLabel(action.ownerUserId);
    if (ctx.userId !== action.ownerUserId) {
      throw new OwnerActionCardError(403, "NOT_OWNER", `Only ${owner} can decide what ${action.assistantName} does as them.`);
    }
    const now = new Date();
    if (new Date(action.expiresAt) <= now) {
      throw new OwnerActionCardError(409, "OWNER_ACTION_EXPIRED", "This card expired; nothing was done.");
    }
    const decidedAt = now.toISOString();
    if (input.decision === "decline") {
      return {
        ...input,
        result: { kind: "assistant-owner-action", decision: "declined", status: null, ok: true, summary: `Declined. Nothing changed.`, line: { kind: "declined" }, decidedAt },
        eventText: ownerActionText.declined(owner, action.phrase),
        outcome: "declined",
      };
    }
    const done = action.done;
    // The route as stored must still be this confirm entry, and its target still the owner's.
    const match = matchAssistantOwnerAction(action.request.method, action.request.path, action.request.body);
    const entry = match && match.action.key === action.actionKey && match.action.tier === "confirm" ? match.action : null;
    let answer: OwnerRouteAnswer;
    let dispatchThrew = false;
    if (!entry || !match) {
      answer = { status: 409, body: { error: "This action is no longer something an assistant can ask for", code: "assistant_owner_action_not_available" } };
    } else {
      const scope: AssistantOwnerActionRequestScope = { agentId: action.assistantAgentId, serverId: ctx.serverId, ownerUserId: action.ownerUserId, params: match.params, body: action.request.body };
      const admitted = await entry.admit(scope, owner);
      if (!admitted.ok) {
        answer = admitted.refusal
          ? { status: admitted.refusal.status, body: { error: admitted.refusal.error, code: admitted.refusal.code } }
          : { status: 404, body: { error: `${owner} can't see that any more`, code: "assistant_owner_action_target_not_found" } };
      } else if (!ctx.ownerRequest?.headers.authorization && !ctx.ownerRequest?.headers.cookie) {
        throw new OwnerActionCardError(409, "OWNER_SESSION_REQUIRED", "Confirm this card from Raft, signed in as yourself.");
      } else {
        progress.dispatched = true;
        try {
          answer = await dispatcher({ ownerRequest: ctx.ownerRequest, serverId: ctx.serverId, request: action.request, cardMessageId: ctx.messageId });
        } catch (err) {
          // The dispatch threw after it started: the route may have run, so this is "unknown",
          // not "failed" (a failed card invites a second card, and a second run).
          console.warn("[assistant-owner-action] dispatch threw", err instanceof Error ? err.message : err);
          dispatchThrew = true;
          answer = { status: 502, body: { error: "The route did not answer", code: "assistant_owner_action_dispatch_error" } };
        }
      }
    }
    const ok = answer.status >= 200 && answer.status < 300;
    if (ok) {
      await recordIntegrationAuditEventBestEffort({
        serverId: ctx.serverId,
        eventType: ASSISTANT_OWNER_ACTION_EVENT,
        outcome: "success",
        source: "api",
        actor: { type: "human", id: action.ownerUserId },
        subject: { type: "human", id: action.ownerUserId },
        target: { type: "user", id: action.ownerUserId },
        // What "Changed by your assistant" lists: the target (the path's :id) and, for a card with its own
        // copy, the names before and after (move_agent: the computers).
        metadata: {
          action: action.actionKey, tool: action.tool, via: action.assistantAgentId, confirmed: true, cardMessageId: ctx.messageId, status: answer.status,
          targetId: match?.params.id ?? null,
          previousValue: action.view?.kind === "moveAgent" ? action.view.from : null,
          nextValue: action.view?.kind === "moveAgent" ? action.view.to : null,
        },
      });
    }
    // No answer in time: not "failed" (it may have run), and not something to post again (Sage ee5c99a3).
    if (answer.body.code === OWNER_DISPATCH_TIMEOUT_CODE || dispatchThrew) {
      return {
        ...input,
        result: { kind: "assistant-owner-action", decision: "confirmed", status: answer.status, ok: false, unknown: true, summary: UNKNOWN_SUMMARY, line: { kind: "unknown" }, decidedAt },
        eventText: ownerActionText.confirmedUnknown(owner),
        outcome: "confirmed_unknown",
      };
    }
    if (ok) {
      const confirmed = entry?.confirmedText?.(action, owner, answer.body) ?? { event: ownerActionText.confirmedDone(owner, done), summary: `${done}.` };
      return {
        ...input,
        result: { kind: "assistant-owner-action", decision: "confirmed", status: answer.status, ok: true, summary: confirmed.summary, ...(confirmed.line ? { line: confirmed.line } : {}), decidedAt },
        eventText: confirmed.event,
        outcome: "confirmed_done",
      };
    }
    const errorText = routeErrorText(entry, answer, owner);
    return {
      ...input,
      result: { kind: "assistant-owner-action", decision: "confirmed", status: answer.status, ok: false, summary: `Confirmed, but it failed: ${errorText}`, line: { kind: "failed", error: errorText }, decidedAt },
      eventText: ownerActionText.confirmedFailed(owner, errorText, action.tool),
      outcome: "confirmed_failed",
    };
  }
}

/** Execute's step: records the decision (ending the claim) and writes the assistant's event, in execute's transaction. */
async function recordOwnerActionDecision(input: DecisionInput, ctx: Parameters<ActionCardFormHandler<"assistant:owner_action", DecisionInput>["execute"]>[1]): Promise<ActionCardResult> {
  {
    if (!input.result || !input.eventText) throw new Error("An owner-action card is recorded only once its decision was delivered");
    // In execute's transaction: the card and the assistant's event end together.
    const event = await createOutcomeEvent(ctx.executor, {
      serverId: ctx.serverId,
      agentId: ctx.action.assistantAgentId,
      cardMessageId: ctx.messageId,
      text: input.eventText,
      payload: {
        type: "owner_action",
        state: input.outcome ?? (input.result.decision === "declined" ? "declined" : input.result.ok ? "confirmed_done" : "confirmed_failed"),
        tool: ctx.action.tool,
        args: publicArgs(ctx.action),
        card_message_id: ctx.messageId,
        status: input.result.status,
      },
    });
    afterAmbientTransaction(() => scheduleDelivery(event));
    return input.result;
  }
}

// ── The claim: one decision at a time ────────────────────────────────────────
//
// A prepared card's action_cards.result is null until execute writes it, so a
// claim ("running") is a marker there, with when it was taken: a conditional
// UPDATE from "prepared, not expired, no claim", so exactly one of two
// concurrent decisions wins, and a claim is never taken over (that could run
// the route twice). Execute overwrites it with the outcome; a throw before
// execute releases it. A claim older than OWNER_ACTION_CLAIM_STALE_MS (the
// process died mid-dispatch, or execute never recorded it) is ended by the
// sweep as failed, "it may have run"; the expiry sweep leaves claimed cards to that.

const OWNER_ACTION_CLAIM_KIND = "assistant-owner-action-claim";
/** 2x the dispatch timeout: a claim this old outlived any dispatch, and the sweep fails it. */
export const OWNER_ACTION_CLAIM_STALE_MS = 2 * OWNER_DISPATCH_TIMEOUT_MS;

/** For the expiry sweep: a prepared card nobody is deciding right now. */
export function expirableOwnerActionCardCondition() {
  return isNull(actionCards.result);
}

export async function claimOwnerActionCard(messageId: string, userId: string, decision: "confirm" | "decline"): Promise<boolean> {
  const claimed = await getDb().update(actionCards)
    .set({ result: { kind: OWNER_ACTION_CLAIM_KIND, claimedAt: new Date().toISOString(), userId, decision }, updatedAt: new Date() })
    .where(and(
      eq(actionCards.messageId, messageId),
      eq(actionCards.actionType, "assistant:owner_action"),
      eq(actionCards.state, "prepared"),
      sql`(${actionCards.payload} ->> 'expiresAt')::timestamptz > now()`,
      isNull(actionCards.result),
    ))
    .returning({ id: actionCards.id });
  return claimed.length === 1;
}

async function isClaimed(messageId: string): Promise<boolean> {
  const [row] = await getDb().select({ id: actionCards.id }).from(actionCards)
    .where(and(eq(actionCards.messageId, messageId), sql`${actionCards.result} ->> 'kind' = ${OWNER_ACTION_CLAIM_KIND}`)).limit(1);
  return !!row;
}

export async function releaseOwnerActionCardClaim(messageId: string): Promise<void> {
  await getDb().update(actionCards)
    .set({ result: null, updatedAt: new Date() })
    .where(and(
      eq(actionCards.messageId, messageId),
      eq(actionCards.state, "prepared"),
      sql`${actionCards.result} ->> 'kind' = ${OWNER_ACTION_CLAIM_KIND}`,
    ));
}

function publicArgs(action: AssistantOwnerActionCardAction): Record<string, string> {
  return { ...action.args };
}

/**
 * The inbox item (RFC 081 `object.ref`) of a card's outcome events:
 * `app:system.assistant/card/<card message id>`, so each card is its own row
 * (and its own wake) and a card's later events join it. The id is the card
 * message's, as `card_message_id` in the payload.
 */
export function ownerActionCardObjectRef(cardMessageId: string): string {
  return `card/${cardMessageId}`;
}

async function createOutcomeEvent(executor: DatabaseExecutor, input: { serverId: string; agentId: string; cardMessageId: string; text: string; payload: Record<string, unknown> }): Promise<SystemAppAgentEvent> {
  // The card's conversation (the owner's DM with the assistant) is the item's related one (RFC 081 D8).
  const [card] = await executor.select({ channelId: messages.channelId }).from(messages).where(eq(messages.id, input.cardMessageId)).limit(1);
  return createSystemAppAgentEvent({
    serverId: input.serverId,
    agentId: input.agentId,
    systemApp: SYSTEM_ASSISTANT_APP,
    kind: "event",
    summary: input.text,
    payload: input.payload,
    ttlMs: OUTCOME_EVENT_TTL_MS,
    executor,
    objectRef: ownerActionCardObjectRef(input.cardMessageId),
    relatedChannelId: card?.channelId ?? null,
  });
}

/** Push it once the transaction committed; a missed push stays queued for /events and the sweeps. */
function scheduleDelivery(event: SystemAppAgentEvent): void {
  const timer = setTimeout(() => {
    void (async () => {
      const { deliverAssistantSystemEvent } = await import("./assistantService");
      await deliverAssistantSystemEvent(event);
    })().catch((err) => console.warn("[assistant-owner-action] event delivery failed", err instanceof Error ? err.message : err));
  }, 250);
  timer.unref?.();
}

// ── Expiry ──────────────────────────────────────────────────────────────────

/** Ends one card past its `expiresAt` and tells its assistant; false when it was not open or not due. */
export async function expireAssistantOwnerActionCard(input: { messageId: string; io: SocketServer | null | undefined }): Promise<boolean> {
  const { endPreparedActionCardInTransaction, emitActionCardMessageUpdated } = await import("./actionCardsService");
  const ended = await getDb().transaction(async (tx) => {
    const card = await endPreparedActionCardInTransaction(tx, input.messageId, "expired", "assistant:owner_action");
    if (!card || card.metadata.action.type !== "assistant:owner_action") return null;
    const action = card.metadata.action;
    const owner = await ownerLabel(action.ownerUserId);
    const event = await createOutcomeEvent(tx, {
      serverId: (await tx.select({ serverId: actionCards.serverId }).from(actionCards).where(eq(actionCards.messageId, card.messageId)).limit(1))[0]!.serverId,
      agentId: action.assistantAgentId,
      cardMessageId: card.messageId,
      text: ownerActionText.expired(action.phrase, owner, action.tool),
      payload: { type: "owner_action", state: "expired", tool: action.tool, args: publicArgs(action), card_message_id: card.messageId, status: null },
    });
    return { card, event };
  });
  if (!ended) return false;
  if (input.io) await emitActionCardMessageUpdated(input.io, { id: ended.card.messageId });
  scheduleDelivery(ended.event);
  return true;
}

/**
 * Ends one card whose claim is older than OWNER_ACTION_CLAIM_STALE_MS as
 * failed ("it may have run"): the dispatch outlived its timeout without
 * execute recording it. Under the card's source lock (as execute), from the
 * claim only, so an execute that recorded it first wins. False when not due.
 */
export async function failStaleOwnerActionClaim(input: { messageId: string; io: SocketServer | null | undefined }): Promise<boolean> {
  const { lockActionCardSourceInTransaction } = await import("./actionCardConversionService");
  const { emitActionCardMessageUpdated } = await import("./actionCardsService");
  const ended = await getDb().transaction(async (tx) => {
    await lockActionCardSourceInTransaction(tx, input.messageId);
    const [card] = await tx.select({ id: actionCards.id, serverId: actionCards.serverId, payload: actionCards.payload, result: actionCards.result })
      .from(actionCards)
      .where(and(
        eq(actionCards.messageId, input.messageId),
        eq(actionCards.actionType, "assistant:owner_action"),
        eq(actionCards.state, "prepared"),
        sql`${actionCards.result} ->> 'kind' = ${OWNER_ACTION_CLAIM_KIND}`,
        sql`(${actionCards.result} ->> 'claimedAt')::timestamptz < now() - (${OWNER_ACTION_CLAIM_STALE_MS} * interval '1 millisecond')`,
      ))
      .limit(1);
    if (!card) return null;
    const action = card.payload as AssistantOwnerActionCardAction;
    const claim = card.result as { userId?: string; decision?: string };
    const owner = await ownerLabel(action.ownerUserId);
    const now = new Date();
    const declined = claim.decision === "decline";
    const result: Extract<ActionCardResult, { kind: "assistant-owner-action" }> = declined
      ? { kind: "assistant-owner-action", decision: "declined", status: null, ok: true, summary: "Declined. Nothing changed.", line: { kind: "declined" }, decidedAt: now.toISOString() }
      : { kind: "assistant-owner-action", decision: "confirmed", status: null, ok: false, unknown: true, summary: UNKNOWN_SUMMARY, line: { kind: "unknown" }, decidedAt: now.toISOString() };
    await tx.update(actionCards)
      .set({ state: "executed", result, executedAt: now, executedByUserId: claim.userId ?? action.ownerUserId, updatedAt: now })
      .where(eq(actionCards.id, card.id));
    const [row] = await tx.select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, input.messageId)).limit(1);
    const stored = row?.actionMetadata as ActionCardMetadata | null | undefined;
    if (stored) {
      await tx.update(messages)
        .set({ actionMetadata: { ...stored, state: "executed", result, executedAt: now.toISOString(), executedByUserId: claim.userId ?? action.ownerUserId }, updatedAt: now })
        .where(eq(messages.id, input.messageId));
    }
    const event = await createOutcomeEvent(tx, {
      serverId: card.serverId,
      agentId: action.assistantAgentId,
      cardMessageId: input.messageId,
      text: declined ? ownerActionText.declined(owner, action.phrase) : ownerActionText.confirmedUnknown(owner),
      payload: { type: "owner_action", state: declined ? "declined" : "confirmed_unknown", tool: action.tool, args: publicArgs(action), card_message_id: input.messageId, status: null, stale_claim: true },
    });
    return { event };
  });
  if (!ended) return false;
  if (input.io) await emitActionCardMessageUpdated(input.io, { id: input.messageId });
  scheduleDelivery(ended.event);
  return true;
}

/** Owner-action cards past their `expiresAt`, ended as expired (each assistant told). */
export async function sweepExpiredAssistantOwnerActionCards(io: SocketServer | null | undefined): Promise<number> {
  const due = await getDb().select({ messageId: actionCards.messageId })
    .from(actionCards)
    .where(and(
      eq(actionCards.actionType, "assistant:owner_action"),
      eq(actionCards.state, "prepared"),
      sql`(${actionCards.payload} ->> 'expiresAt')::timestamptz <= now()`,
      // Not while a decision is running on it: execute ends it.
      expirableOwnerActionCardCondition(),
    ))
    .orderBy(sql`(${actionCards.payload} ->> 'expiresAt')::timestamptz asc`, asc(actionCards.id))
    .limit(200);
  let ended = 0;
  // Claims that outlived their dispatch: failed, "it may have run".
  const stale = await getDb().select({ messageId: actionCards.messageId })
    .from(actionCards)
    .where(and(
      eq(actionCards.actionType, "assistant:owner_action"),
      eq(actionCards.state, "prepared"),
      sql`${actionCards.result} ->> 'kind' = ${OWNER_ACTION_CLAIM_KIND}`,
      sql`(${actionCards.result} ->> 'claimedAt')::timestamptz < now() - (${OWNER_ACTION_CLAIM_STALE_MS} * interval '1 millisecond')`,
    ))
    .limit(200);
  for (const { messageId } of stale) {
    try {
      if (await failStaleOwnerActionClaim({ messageId, io })) ended += 1;
    } catch (err) {
      console.error("[assistant-owner-action] could not end a stale claim", messageId, err instanceof Error ? err.message : err);
    }
  }
  for (const { messageId } of due) {
    try {
      if (await expireAssistantOwnerActionCard({ messageId, io })) ended += 1;
    } catch (err) {
      console.error("[assistant-owner-action] could not expire", messageId, err instanceof Error ? err.message : err);
    }
  }
  return ended;
}
