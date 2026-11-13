/**
 * /api/me/account/deletion: a person deleting their own account (design
 * "删除账号：服务端设计 v1" §3, §4; services/accountDeletion).
 *
 *   GET    /             -> { status: "none" } | { status: "scheduled", requestedAt, scheduledFor },
 *                           each with soleOwnerServers: [{ id, name, slug, memberCount }] (hand over first),
 *                           soleMemberServers: [{ id, name, slug }] (closed with the account),
 *                           paidServersEndingAtPeriodEnd: [{ id, name, slug, periodEnd }] (subscription stops),
 *                           agents: [{ id, name, server, outcome, toUser }] (what happens to each) and
 *                           computers: [{ id, name, server: { id, name, slug }, agents: [{ id, name, ownedByMe }] }]
 *                           (the person's own Computers still attached: deleted when the deletion takes effect;
 *                           someone else's agent, `ownedByMe: false`, also has `owner: { id, name } | null`,
 *                           `personalAssistant`, `ownerNotifiedAt` and `ownerNextNotifyAt`: it blocks the request
 *                           until moved, or until forced),
 *                           and graceDays (how long a request made now would wait)
 *   POST   /             { secondFactor?: { code | backupCode | webauthn }, password?, emailCode?, forceAgentIds?: string[] (0-200) }
 *                        -> 200 { status: "scheduled", requestedAt, scheduledFor } (also when already scheduled)
 *                           403 { code: "reauth_required", methods }  (password | totp | passkey | backup_code | email_code)
 *                           409 { code: "sole_owner_servers", servers: [{ id, name, slug, memberCount }] }
 *                           409 { code: "others_agents_on_computers", agents: [{ id, name, server: { id, name, slug },
 *                                 computer: { id, name }, owner: { id, name } | null, ownerNotifiedAt }] }
 *                                 (someone else's agents on the person's live Computers, each also with ownerNextNotifyAt and
 *                                 personalAssistant: their owners move them first, or the person names every one of them in
 *                                 forceAgentIds and the request unbinds and stops them, telling their owners;
 *                                 400 { code: "invalid_force_agent_ids" } for a bad list)
 *                        A new request signs out every sign-in, this one included.
 *   POST   /notify-agent-owners { agentIds: string[] } (1-200)
 *                        -> { notified: [{ agentId, notifiedAt }],
 *                             skipped: [{ agentId, reason: "not_on_your_computer" | "no_owner" | "rate_limited" | "not_delivered", nextAllowedAt? }] }
 *                           asks each blocking agent's owner, by a system notice, to move it (once per agent per 24 hours;
 *                           services/accountDeletion/ownerNotices.ts); 400 { code: "invalid_agent_ids" }
 *   DELETE /requests/:requestId -> { status: "none" } for the bound request; 409
 *                           account_deletion_pending when a newer request remains.
 *                           The root DELETE retains older-client compatibility.
 *                           A dedicated path prevents old rolling-release peers
 *                           from ignoring the new request binding.
 *   POST   /email-code   -> { sent: true, expiresAt } (only for a person with neither a password nor two-step verification)
 *
 * And, mounted on its own (app.ts), with no sign-in and the auth rate limit:
 *   POST /api/auth/account-deletion/cancel { token }
 *                        -> 200 { status: "none" } (the request the emailed link belongs to is cancelled)
 *                           400 { code: "account_deletion_token_invalid" } for every refusal alike
 *                           (malformed, unknown, used, expired, no longer pending, flag off for the person)
 *
 * A person's own web (`full`) sign-in only: requireAuth (app.ts) refuses a
 * device login's session (none of these paths is a device-session route) and
 * a token with no family; requireWebSessionFamily narrows the family the
 * re-authentication reads. No requireVerified: an account that never verified
 * its email or finished setting up can be deleted too.
 *
 * Open to everyone: it shipped behind `account_deletion_v0`, which was on for
 * everyone in production and was retired (#raft-architecture:#32).
 *
 * While a deletion is scheduled, requireAuth admits GET and the DELETE paths here
 * (and POST /api/auth/logout, which needs no access token); everything else
 * answers 403 `account_deletion_pending` (middleware/auth.ts).
 */
import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import { currentDate } from "@botiverse/raft-shared";

import { getDb } from "../db/index";
import { refuse } from "../lib/refusal";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import {
  claimAccountDeletionEmailCode,
  consumeAccountDeletionEmailCode,
  parseAccountDeletionEmailCode,
  sendAccountDeletionEmailCode,
} from "../services/accountDeletion/emailCode";
import { accountDeletionReauthFor, type AccountDeletionReauthMethod } from "../services/accountDeletion/reauth";
import {
  AccountDeletionUnavailableError,
  cancelAccountDeletion,
  cancelAccountDeletionByLink,
  findOthersAgentsOnComputers,
  findSoleOwnerServers,
  getAccountDeletionOverview,
  othersAgentsWithOwnerNotifiedAt,
  getAccountDeletionStatus,
  requestAccountDeletion,
  requestAccountDeletionInTransaction,
  runAccountDeletionRequestedEffects,
  type AccountDeletionEffectDeps,
  type OthersAgentOnComputer,
  type RequestAccountDeletionOutcome,
  type SoleOwnerServer,
} from "../services/accountDeletion/requests";
import { notifyAgentOwners, parseAgentIdList, parseNotifyAgentOwnersBody } from "../services/accountDeletion/ownerNotices";
import { postAgentActionRequiredNotice } from "../services/agentActionRequiredNoticeService";
import { announceComputersRevokedWithMembership } from "../services/computerDetachedNotices";
import { SecondFactorError, parseStepUpAnswer, reauthenticateWithPassword, withSecondFactorAnswer } from "../services/secondFactor/management";
import { isRecentlyReauthenticated } from "../services/secondFactor/reauthentication";
import { webSessionFamilyOf } from "../services/sessionService";
import { sendJsonServerError } from "./errorResponse";

export const accountDeletionRouter: RouterType = Router();

function requireWebSessionFamily(req: Request, res: Response, next: NextFunction): void {
  if (!webSessionFamilyOf(req)) {
    res.status(403).json({ error: "Sign in again to delete your account.", code: "session_family_required" });
    return;
  }
  next();
}

accountDeletionRouter.use(requireWebSessionFamily, (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

function effectDeps(req: Request): AccountDeletionEffectDeps {
  const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
  const io = req.app.get("io") as SocketServer | undefined;
  if (!orchestrator) return {};
  return {
    // The account's agents go with it: `deleted` also ends their `raft proc` jobs.
    stopAgent: (agentId) => orchestrator.stopAgent(agentId, "manual", { daemonReason: "deleted" }),
    // A system notice, as when a Computer is detached; nothing about the person.
    ...(io ? {
      noticeUnboundAgent: ({ agentId, ownerUserId, computerName }) => postAgentActionRequiredNotice(io, orchestrator, {
        agentId, ownerUserId, notice: { kind: "computer_detached", computerName },
      }),
      // As when leaving a server revokes the Computers the person attached there.
      noticeDetachedComputers: (computers, departedUserId) => announceComputersRevokedWithMembership(io, orchestrator, computers, departedUserId, "account_deleted"),
    } : {}),
  };
}

function sendReauthRequired(res: Response, methods: AccountDeletionReauthMethod[]): void {
  res.status(403).json({ error: "Confirm it's you before deleting your account.", code: "reauth_required", methods });
}

function sendSoleOwner(res: Response, servers: SoleOwnerServer[]): void {
  res.status(409).json({
    error: "Make someone else an owner of these servers, or delete them, before deleting your account.",
    code: "sole_owner_servers",
    servers,
  });
}

/** `ownerNotifiedAt` is read here, after the request's transaction (it is kept in Redis). */
async function sendOthersAgents(res: Response, userId: string, agents: OthersAgentOnComputer[]): Promise<void> {
  res.status(409).json({
    error: "Other people's agents run on your computers. Ask their owners to move them before deleting your account.",
    code: "others_agents_on_computers",
    agents: await othersAgentsWithOwnerNotifiedAt(userId, agents),
  });
}

/**
 * The refusals checked before any code is spent (and again under the lock by
 * requestAccountDeletionInTransaction): sole owner, then someone else's agents
 * on the person's Computers not all named in `forceAgentIds`. True when one was sent.
 */
async function sendPrecheckConflict(res: Response, userId: string, forceAgentIds: readonly string[]): Promise<boolean> {
  const soleOwner = await findSoleOwnerServers(getDb(), userId);
  if (soleOwner.length > 0) { sendSoleOwner(res, soleOwner); return true; }
  const othersAgents = await findOthersAgentsOnComputers(getDb(), userId);
  const forced = new Set(forceAgentIds);
  if (othersAgents.some((agent) => !forced.has(agent.id))) { await sendOthersAgents(res, userId, othersAgents); return true; }
  return false;
}

async function sendOutcome(res: Response, userId: string, outcome: RequestAccountDeletionOutcome): Promise<void> {
  if (outcome.kind === "conflict") {
    if (outcome.code === "sole_owner_servers") sendSoleOwner(res, outcome.servers);
    else await sendOthersAgents(res, userId, outcome.agents);
    return;
  }
  res.json(await getAccountDeletionStatus(userId, undefined, outcome.request.id));
}

/** Thrown inside the request's transaction when the emailed code was used or ended in between. */
class EmailCodeGone extends Error {}

function sendError(req: Request, res: Response, err: unknown, failure: string): void {
  if (err instanceof SecondFactorError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...err.extra });
    return;
  }
  if (err instanceof AccountDeletionUnavailableError) {
    res.status(401).json({ error: "Invalid or expired token", code: "auth_required" });
    return;
  }
  sendJsonServerError(req, res, { error: failure, logPrefix: `[account-deletion] ${failure}:`, err });
}

function requestedDeletionId(req: Request, res: Response): string | undefined | null {
  const value = req.query.requestId;
  if (value === undefined) return undefined; // explicit older-client compatibility
  if (typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value;
  refuse(res, 400, { code: "account_deletion_request_invalid", error: "The deletion request ID is invalid. Reload the current request before trying again." });
  return null;
}

accountDeletionRouter.get("/", async (req, res) => {
  try {
    const requestId = requestedDeletionId(req, res);
    if (requestId === null) return;
    res.json(await getAccountDeletionOverview(req.userId!, undefined, requestId));
  } catch (err) {
    sendError(req, res, err, "Failed to load the account deletion");
  }
});

async function cancelDeletionRequest(req: Request, res: Response, requestId?: string): Promise<void> {
  try {
    const result = await cancelAccountDeletion({ userId: req.userId!, requestId });
    const current = await getAccountDeletionStatus(req.userId!, undefined, requestId ?? result.requestId);
    if (current.status === "scheduled") {
      refuse(res, 409, { code: "account_deletion_pending", error: "A deletion request is still scheduled. Review the current request before cancelling.", suggestedNextAction: "Reload the current deletion request and review its date before cancelling.", details: { accountDeletion: current } });
      return;
    }
    res.json({
      ...current,
      ...(current.subscriptionRestoration === "not_restored" ? { subscriptionNotResumed: true } : {}),
    });
  } catch (err) {
    sendError(req, res, err, "Failed to cancel the account deletion");
  }
}

accountDeletionRouter.delete("/", async (req, res) => {
  const requestId = requestedDeletionId(req, res);
  if (requestId !== null) await cancelDeletionRequest(req, res, requestId);
});

accountDeletionRouter.delete("/requests/:requestId", async (req, res) => {
  const requestId = req.params.requestId;
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    refuse(res, 400, { code: "account_deletion_request_invalid", error: "The deletion request ID is invalid. Reload the current request before trying again." });
    return;
  }
  await cancelDeletionRequest(req, res, requestId);
});

accountDeletionRouter.post("/email-code", async (req, res) => {
  try {
    const userId = req.userId!;
    const reauth = await accountDeletionReauthFor(userId);
    if (reauth.kind !== "email_code") {
      res.status(409).json({ error: "Confirm it's you another way.", code: "email_code_not_available", methods: reauth.methods });
      return;
    }
    const sent = await sendAccountDeletionEmailCode({ userId, familyId: webSessionFamilyOf(req)!, now: currentDate() });
    if (!sent.ok) {
      res.setHeader("Retry-After", String(sent.retryAfterSeconds));
      res.status(429).json({ error: "A code was just sent. Wait a minute before asking for another.", code: "email_code_recently_sent", retryAfterSeconds: sent.retryAfterSeconds });
      return;
    }
    res.json({ sent: true, expiresAt: sent.expiresAt.toISOString() });
  } catch (err) {
    sendError(req, res, err, "Failed to send the code");
  }
});

accountDeletionRouter.post("/notify-agent-owners", async (req, res) => {
  try {
    const userId = req.userId!;
    const agentIds = parseNotifyAgentOwnersBody(req.body);
    if (!agentIds) {
      res.status(400).json({ error: "agentIds must be a list of 1 to 200 agent ids.", code: "invalid_agent_ids" });
      return;
    }
    const io = req.app.get("io") as SocketServer | undefined;
    const orchestrator = req.app.get("agentOrchestrator") as AgentOrchestrator | undefined;
    res.json(await notifyAgentOwners({
      requesterId: userId,
      agentIds,
      blocking: await findOthersAgentsOnComputers(getDb(), userId),
      now: currentDate(),
      // A system notice to the agent's owner, never written as this person.
      post: async ({ agentId, ownerUserId, computerName }) => !!io && !!orchestrator
        && postAgentActionRequiredNotice(io, orchestrator, { agentId, ownerUserId, notice: { kind: "computer_owner_leaving", computerName } }),
    }));
  } catch (err) {
    sendError(req, res, err, "Failed to notify the agents' owners");
  }
});

accountDeletionRouter.post("/", async (req, res) => {
  try {
    const userId = req.userId!;
    const familyId = webSessionFamilyOf(req)!;
    const now = currentDate();
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { secondFactor?: unknown; emailCode?: unknown; password?: unknown; forceAgentIds?: unknown };
    const forceAgentIds = body.forceAgentIds === undefined ? [] : parseAgentIdList(body.forceAgentIds);
    if (!forceAgentIds) {
      res.status(400).json({ error: "forceAgentIds must be a list of at most 200 agent ids.", code: "invalid_force_agent_ids" });
      return;
    }
    const input = { userId, source: "self" as const, actorUserId: userId, now, forceAgentIds };
    const deps = effectDeps(req);
    const reauth = await accountDeletionReauthFor(userId);

    if (reauth.kind === "second_factor") {
      const answer = parseStepUpAnswer(body.secondFactor);
      if (!answer.code && !answer.backupCode && !answer.webauthn) { sendReauthRequired(res, reauth.methods); return; }
      // Answered before any code is spent; checked again under the lock.
      if (await sendPrecheckConflict(res, userId, forceAgentIds)) return;
      const outcome = await withSecondFactorAnswer(userId, answer, now, { allowBackupCode: true, passkey: { familyId } },
        (tx) => requestAccountDeletionInTransaction(tx, input));
      if (outcome.kind === "scheduled" && outcome.effects) await runAccountDeletionRequestedEffects(outcome.effects, deps);
      await sendOutcome(res, userId, outcome);
      return;
    }

    let recent = await isRecentlyReauthenticated(getDb(), familyId, now);
    // A password in the request re-authenticates this sign-in inline, exactly
    // as POST /api/auth/second-factor/reauth/password does (same check, same
    // reauth_attempt_windows claim-first counter: 401 password_incorrect,
    // 429 reauth_locked).
    if (!recent && reauth.kind === "password" && typeof body.password === "string" && body.password) {
      await reauthenticateWithPassword({ userId, familyId, password: body.password, now });
      recent = true;
    }
    const emailCode = reauth.kind === "email_code" && !recent ? parseAccountDeletionEmailCode(body.emailCode) : null;
    if (!recent && !emailCode) {
      if (reauth.kind === "email_code" && body.emailCode !== undefined) {
        res.status(400).json({ error: "Enter the 6-digit code from the email.", code: "email_code_invalid" });
        return;
      }
      sendReauthRequired(res, reauth.methods);
      return;
    }
    if (await sendPrecheckConflict(res, userId, forceAgentIds)) return;

    if (recent) {
      await sendOutcome(res, userId, await requestAccountDeletion(input, deps));
      return;
    }

    const claimed = await claimAccountDeletionEmailCode({ userId, familyId, code: emailCode!, now });
    if (!claimed.ok) {
      if (claimed.reason === "locked") {
        res.status(429).json({ error: "Too many wrong codes. Try again later.", code: "second_factor_locked", lockedUntil: claimed.lockedUntil.toISOString() });
        return;
      }
      res.status(400).json({ error: "That code didn't work. Check the email or ask for a new code.", code: "email_code_invalid" });
      return;
    }
    try {
      await sendOutcome(res, userId, await requestAccountDeletion(input, {
        ...deps,
        inTransaction: async (tx) => {
          if (!(await consumeAccountDeletionEmailCode(tx, { userId, challengeId: claimed.challengeId, now }))) throw new EmailCodeGone();
        },
      }));
    } catch (err) {
      if (!(err instanceof EmailCodeGone)) throw err;
      res.status(400).json({ error: "That code didn't work. Check the email or ask for a new code.", code: "email_code_invalid" });
    }
  } catch (err) {
    sendError(req, res, err, "Failed to request the account deletion");
  }
});

/** POST /api/auth/account-deletion/cancel: the emailed cancel link (cancelAccountDeletionByLink); unauthenticated. */
export async function accountDeletionCancelLinkHandler(req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  try {
    const body = (req.body && typeof req.body === "object" ? req.body : {}) as { token?: unknown };
    const result = await cancelAccountDeletionByLink(body.token, {});
    if (!result.ok) {
      res.status(400).json({ error: "This link can't be used. Sign in to see or cancel the deletion.", code: "account_deletion_token_invalid" });
      return;
    }
    res.json({ status: "none", ...(result.subscriptionNotResumed ? { subscriptionNotResumed: true } : {}), ...(result.subscriptionRestoration ? { subscriptionRestoration: result.subscriptionRestoration } : {}), ...('requestId' in result && result.requestId ? { requestId: result.requestId } : {}) });
  } catch (err) {
    sendJsonServerError(req, res, { error: "Failed to cancel the account deletion", logPrefix: "[account-deletion] cancel link:", err });
  }
}
