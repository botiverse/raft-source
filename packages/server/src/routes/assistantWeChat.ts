import { Router, type Request, type Response, type Router as RouterType } from "express";
import rateLimit from "express-rate-limit";
import type { Server as SocketServer } from "socket.io";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { denyServerGuests } from "../middleware/denyServerGuests";
import { disconnectWeChat } from "../services/wechatBridgeCleanup";
import { UUID_RE } from "../lib/messageId";
import {
  clearWeChatAttemptCookie,
  getWeChatBindingView,
  isWeChatBridgeAvailable,
  pollWeChatAttempt,
  startWeChatAttempt,
  wechatAttemptCookie,
  WeChatBridgeError,
} from "../services/wechatBridgeService";

// The personal assistant's WeChat bridge (wechatBridgeService.ts), mounted at
// /api/servers/:id/assistant/wechat behind the server membership check; a
// Guest may only disconnect (the guard below). Each
// person sees and changes only their own binding. No answer carries a bot
// token, a context token, or iLink's ids for the bot or the WeChat user. The
// one thing that does come from iLink is the QR content (POST /attempts): it is
// iLink's and likely embeds the QR code's polling handle, so whoever sees the
// QR code before it is used could poll iLink for the token themselves. Raft
// cannot prevent that; single use, a few minutes' life and the connected
// notice in the owner's DM are the mitigation.
export const assistantWeChatRouter: RouterType = Router({ mergeParams: true });

// A Guest has no assistant (myAssistantRouter), so no bridge to it: every
// route, present or future, answers as the guest-hidden surfaces do
// (denyServerGuests), before any handler or rate limit runs. The one
// exception is Disconnect, exactly DELETE /binding: the binding holds the
// person's WeChat credential, and they can always take it back out.
assistantWeChatRouter.use(async (req, res, next) => {
  if (req.method === "DELETE" && req.path === "/binding") {
    next();
    return;
  }
  await denyServerGuests(req, res, next);
});

/** The attempts route as this browser requested it: the binding cookie is scoped to it. */
function attemptsPath(req: Request): string {
  return `${req.baseUrl}/attempts`;
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}

function sendWeChatError(req: Request, res: Response, err: unknown, what: string): void {
  noStore(res);
  if (err instanceof WeChatBridgeError) {
    if (err.endedStateHash) res.append("Set-Cookie", clearWeChatAttemptCookie(attemptsPath(req), err.endedStateHash));
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  console.error(`assistant-wechat: ${what} failed:`, err instanceof Error ? err.name : "error");
  res.status(500).json({ error: "Something went wrong with WeChat. Try again." });
}

// Whether this person may connect WeChat here, and their connection if they
// have one (shown even while unavailable, so they can still disconnect it).
// Reads only.
assistantWeChatRouter.get("/status", async (req, res) => {
  try {
    noStore(res);
    res.json({
      available: await isWeChatBridgeAvailable(req.serverId!, req.userId!),
      binding: await getWeChatBindingView(req.serverId!, req.userId!),
    });
  } catch (err) {
    sendWeChatError(req, res, err, "status");
  }
});

// Each start asks iLink for a QR code: a few a minute per person per server.
const attemptLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.serverId ?? "none"}:${req.userId ?? "none"}`,
  message: { error: "Too many QR codes; wait a minute.", code: "wechat_rate_limited" },
});

// Start (or restart) connecting: a QR code to show, bound to this browser.
assistantWeChatRouter.post("/attempts", attemptLimiter, async (req, res) => {
  try {
    const now = new Date();
    const started = await startWeChatAttempt({ serverId: req.serverId!, userId: req.userId!, now });
    noStore(res);
    res.append("Set-Cookie", wechatAttemptCookie(attemptsPath(req), started, now));
    res.status(201).json({ attemptId: started.attemptId, qrContent: started.qrContent, expiresAt: started.expiresAt.toISOString() });
  } catch (err) {
    sendWeChatError(req, res, err, "start");
  }
});

// Poll a started attempt from the browser that started it: a POST (a poll may
// spend the attempt and store the binding). `{ "verifyCode": "..." }`
// (optional) carries the code WeChat showed the scanner after a
// `need_verify_code` answer, in the body so it never lands in a URL or an
// access log. One poll per attempt at a time (429 while one runs).
assistantWeChatRouter.post("/attempts/:attemptId/poll", async (req, res) => {
  try {
    const body = (req.body ?? {}) as { verifyCode?: unknown };
    if (body.verifyCode !== undefined && body.verifyCode !== null && typeof body.verifyCode !== "string") {
      noStore(res);
      res.status(400).json({ error: "verifyCode must be text.", code: "invalid_verify_code" });
      return;
    }
    const poll = await pollWeChatAttempt({
      serverId: req.serverId!,
      userId: req.userId!,
      attemptId: String(req.params.attemptId),
      attemptsPath: attemptsPath(req),
      cookieHeader: req.headers.cookie,
      verifyCode: typeof body.verifyCode === "string" ? body.verifyCode : null,
      io: req.app.get("io") as SocketServer | undefined,
      orchestrator: req.app.get("agentOrchestrator") as AgentOrchestrator | undefined,
    });
    noStore(res);
    if (poll.endedStateHash) res.append("Set-Cookie", clearWeChatAttemptCookie(attemptsPath(req), poll.endedStateHash));
    res.json({ status: poll.status });
  } catch (err) {
    sendWeChatError(req, res, err, "poll");
  }
});

// Disconnect: Raft forgets the binding and its token. Always allowed, flag or
// not, and to a Guest too (one left from before they became one): a person
// can always take their WeChat back out. `?bindingId=` names the binding
// meant (a connected notice's): a newer one is not removed (409).
assistantWeChatRouter.delete("/binding", async (req, res) => {
  try {
    const raw = req.query.bindingId;
    if (raw !== undefined && (typeof raw !== "string" || !UUID_RE.test(raw))) {
      res.status(400).json({ error: "bindingId must be a binding's id.", code: "invalid_binding_id" });
      return;
    }
    const outcome = await disconnectWeChat({ serverId: req.serverId!, userId: req.userId!, bindingId: raw });
    noStore(res);
    if (outcome === "not_connected") {
      res.status(404).json({ error: "WeChat is not connected.", code: "wechat_not_connected" });
      return;
    }
    if (outcome === "changed") {
      res.status(409).json({ error: "WeChat was connected again since; that connection has ended.", code: "wechat_binding_changed" });
      return;
    }
    res.json({ binding: null });
  } catch (err) {
    sendWeChatError(req, res, err, "disconnect");
  }
});
