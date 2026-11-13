import rateLimit from "express-rate-limit";
import express, { Router, type ErrorRequestHandler, type RequestHandler, type Router as RouterType } from "express";
import { actorResolveRequestSchema, type ActorResolveResponse } from "@botiverse/raft-shared";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import { resolveActors } from "../services/actorResolveService";

export const actorRouter: RouterType = Router();

// 200 refs of {"kind":"human","id":"<uuid>"} are about 12 KiB; the bound
// refuses anything far beyond that before it is parsed. Registered in app.ts
// ahead of the global JSON parser, like the link-card read.
export const ACTOR_RESOLVE_PATH = "/api/actors/resolve";
const ACTOR_RESOLVE_MAX_BODY_BYTES = 32 * 1024;
export const actorResolveBodyParser: RequestHandler = express.json({ limit: ACTOR_RESOLVE_MAX_BODY_BYTES });
export const actorResolveBodyErrorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  res.setHeader("Cache-Control", "private, no-store");
  const tooLarge = (err as { type?: unknown }).type === "entity.too.large";
  res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "Actor resolve request too large" : "Invalid actor resolve request" });
};

// replica-local: abuse guard only, per-replica budget is acceptable. One
// budget per person across Servers; a client batches its misses per render.
const actorResolveLimiter = rateLimit({
  windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => req.userId!,
  message: { error: "Too many actor resolve requests" },
});

// Display identity (name, avatar, home Server) for humans and agents the
// caller may see: this Server's members and agents (deleted agents too), and
// peers of active joint channels the caller is in. An actor that is missing
// or not visible is absent from the answer; the two are indistinguishable.
actorRouter.post("/resolve", actorResolveLimiter, async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  try {
    if (await getActorServerRoleInServer(req.serverId!, "user", req.userId!) === "guest") {
      res.status(403).json({ error: "Guests cannot resolve actors" });
      return;
    }
    const parsed = actorResolveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid actor resolve request" });
      return;
    }
    const body: ActorResolveResponse = {
      actors: await resolveActors({ serverId: req.serverId!, requesterId: req.userId!, actors: parsed.data.actors }),
    };
    res.json(body);
  } catch (err) {
    console.error("[actors] resolve failed:", err);
    res.status(500).json({ error: "Failed to resolve actors" });
  }
});
