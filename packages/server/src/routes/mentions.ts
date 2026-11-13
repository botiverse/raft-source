// Core's mention audience (shared mentionAudienceContract.ts), at
// `/api/mentions` behind requireAuth, requireVerified, requireServer (the
// reader is req.userId in req.serverId) and a per-user limit (app.ts).
//
// `POST /audience { audience, q? }` checks the body (400 INVALID_REQUEST),
// resolves an object audience's kind in the app registry (its app must be
// the one named), then asks platform/mentions, whose rule is the one place
// (who sees the audience, whom core shows the reader, the order and the cap):
// every audience it can't answer, and every unknown app, kind or object, is
// the same 404 NOT_FOUND. POST keeps object ids out of URLs and logs. Every
// answer is the reader's own: `private, no-store`.
import { Router, type Response, type Router as RouterType } from "express";
import {
  MENTION_AUDIENCE_MAX_CANDIDATES,
  MENTION_AUDIENCE_MAX_ID_CHARS,
  MENTION_AUDIENCE_QUERY_MAX_CHARS,
  asChannelId,
  asFirstPartyAppId,
  asFirstPartyObjectId,
  asFirstPartyObjectKind,
  type MentionAudience,
  type MentionAudienceCandidates,
  type MentionAudienceErrorCode,
} from "@botiverse/raft-shared";
import { registeredObjectKind } from "../apps/firstPartyApps";
import { setRequestTraceErrorCode } from "../middleware/requestObservability";
import { mentionAudience, type MentionAudienceTarget } from "../platform/mentions";
import { serializeErrorForLog } from "../tracing/safeErrorLog";

class Refusal extends Error {
  constructor(readonly status: number, readonly code: MentionAudienceErrorCode, error: string) {
    super(error);
  }
}

const notFound = () => new Refusal(404, "NOT_FOUND", "no such audience");

function refuse(res: Response, refusal: Refusal): void {
  setRequestTraceErrorCode(res, refusal.code);
  res.status(refusal.status).json({ error: refusal.message, code: refusal.code });
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MENTION_AUDIENCE_MAX_ID_CHARS;

/** The body as the contract has it, `q` trimmed and cut (Refusal 400 INVALID_REQUEST for anything else). */
export function parseMentionAudienceInput(body: unknown): { audience: MentionAudience; q: string } {
  const invalid = new Refusal(400, "INVALID_REQUEST", `the body is { audience: { kind: "conversation", channelId } | { kind: "object", app, objectKind, objectId }, q?: string }, ids of 1 to ${MENTION_AUDIENCE_MAX_ID_CHARS} characters`);
  if (!isObject(body)) throw invalid;
  const { audience, q, ...rest } = body;
  if (Object.keys(rest).length > 0 || !isObject(audience) || (q !== undefined && typeof q !== "string")) throw invalid;
  const query = Array.from((q ?? "").trim()).slice(0, MENTION_AUDIENCE_QUERY_MAX_CHARS).join("");
  if (audience.kind === "conversation") {
    const { kind: _kind, channelId, ...others } = audience;
    if (Object.keys(others).length > 0 || !isId(channelId)) throw invalid;
    return { audience: { kind: "conversation", channelId: asChannelId(channelId) }, q: query };
  }
  if (audience.kind === "object") {
    const { kind: _kind, app, objectKind, objectId, ...others } = audience;
    if (Object.keys(others).length > 0 || !isId(app) || !isId(objectKind) || !isId(objectId)) throw invalid;
    return { audience: { kind: "object", app: asFirstPartyAppId(app), objectKind: asFirstPartyObjectKind(objectKind), objectId: asFirstPartyObjectId(objectId) }, q: query };
  }
  throw invalid;
}

/** The audience as platform/mentions takes it; null for an object kind no registered app of that id has. */
function targetOf(audience: MentionAudience): MentionAudienceTarget | null {
  if (audience.kind === "conversation") return { kind: "conversation", channelId: audience.channelId };
  const registered = registeredObjectKind(audience.objectKind);
  if (!registered || registered.app.id !== audience.app) return null;
  return { kind: "object", registered, objectId: audience.objectId };
}

export const mentionsRouter: RouterType = Router();

mentionsRouter.post("/audience", async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    const input = parseMentionAudienceInput(req.body as unknown);
    const target = targetOf(input.audience);
    if (!target) throw notFound();
    const answer = await mentionAudience({ userId: req.userId!, serverId: req.serverId! }, target, { q: input.q, limit: MENTION_AUDIENCE_MAX_CANDIDATES });
    if (!answer) throw notFound();
    res.json(answer satisfies MentionAudienceCandidates);
  } catch (error) {
    if (error instanceof Refusal) {
      refuse(res, error);
      return;
    }
    if (res.headersSent) return;
    console.error("api.mentions.audience failed", serializeErrorForLog(error));
    res.status(500).json({ error: "Failed to read the mention audience" });
  }
});
