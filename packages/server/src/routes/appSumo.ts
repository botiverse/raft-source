import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { z } from "zod";
import { currentDate } from "@botiverse/raft-shared";
import { getDb, type Database } from "../db/index";
import { parseAppSumoClaimId } from "../services/appSumoContracts";
import { getAppSumoConfig, type AppSumoConfig } from "../services/appSumoConfig";
import { createAppSumoProvider, parseAppSumoWebhook, verifyAppSumoSignature } from "../services/appSumoProvider";
import { AppSumoConflict, receiveAppSumoEvent } from "../services/appSumoLifecycleService";
import { APP_SUMO_CLAIM_TTL_MS, bindAppSumoRedemption, getAppSumoRedemptionStatus, startAppSumoRedemption } from "../services/appSumoRedemptionService";
import { inspectStripeBillingForAppSumo } from "../services/billingService";

const cookieName = "__Host-raft_appsumo_claim";
function claimCookie(req: Request): string {
  const values = (req.headers.cookie ?? "").split(";").map((part) => part.trim()).filter((part) => part.startsWith(cookieName + "="));
  return values.length === 1 ? values[0].slice(cookieName.length + 1) : "";
}
function noStore(res: Response) { res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer"); }
function fail(res: Response, error: unknown) {
  if (error instanceof AppSumoConflict) {
    res.status(error.code === "owner_required" ? 403 : error.code === "stripe_verification_unavailable" ? 503 : 409).json({ code: error.code });
  } else {
    res.status(503).json({ code: "appsumo_unavailable" });
  }
}
export function createAppSumoHandlers(dependencies: {
  db: () => Database;
  config: () => AppSumoConfig | null;
  now: () => Date;
  provider: typeof createAppSumoProvider;
  inspectStripe?: typeof inspectStripeBillingForAppSumo;
}) {
  return {
    async webhook(req: Request, res: Response) {
      noStore(res);
      if (!Buffer.isBuffer(req.body)) { res.status(400).json({ code: "invalid_payload" }); return; }
      const event = parseAppSumoWebhook(req.body);
      if (!event) { res.status(400).json({ code: "invalid_payload" }); return; }
      // Portal validation cannot create rows or grant access. It is deliberately
      // available before provider configuration; AppSumo generates OAuth credentials after validation.
      if (event.test) { res.json({ event: event.event, success: true }); return; }
      const config = dependencies.config();
      if (!config) { res.status(503).json({ code: "appsumo_not_configured" }); return; }
      if (!verifyAppSumoSignature({ rawBody: req.body, timestamp: req.get("X-Appsumo-Timestamp"),
        signature: req.get("X-Appsumo-Signature"), apiKey: config.apiKey, now: dependencies.now() })) {
        res.status(401).json({ code: "invalid_signature" }); return;
      }
      try {
        await receiveAppSumoEvent({ db: dependencies.db(), productId: config.productId, event,
          requestDigest: createHash("sha256").update(req.body).digest("hex"), now: dependencies.now() });
        res.json({ event: event.event, success: true });
      } catch (error) { fail(res, error); }
    },
    async callback(req: Request, res: Response) {
      noStore(res);
      // AppSumo's setup probe is a GET without a payload; no claim is minted.
      if (Object.keys(req.query).length === 0) { res.status(200).json({ success: true }); return; }
      const config = dependencies.config();
      if (!config) { res.status(503).json({ code: "appsumo_not_configured" }); return; }
      const parsed = z.object({ code: z.string().min(1).max(2048).refine(value => !/\p{Cc}/u.test(value)) }).safeParse(req.query);
      if (!parsed.success) { res.status(400).json({ code: "invalid_authorization" }); return; }
      if (!config.clientId || !config.clientSecret) { res.status(503).json({ code: "appsumo_oauth_not_configured" }); return; }
      try {
        const provider = dependencies.provider(config);
        const token = await startAppSumoRedemption({ db: dependencies.db(), productId: config.productId, code: parsed.data.code,
          priorToken: claimCookie(req), now: dependencies.now, exchangeCode: provider.exchangeCode });
        res.cookie(cookieName, token, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: APP_SUMO_CLAIM_TTL_MS });
        res.redirect(303, new URL("/appsumo/redeem", config.appOrigin).href);
      } catch (error) { fail(res, error); }
    },
    async status(req: Request, res: Response) {
      noStore(res);
      if (!req.userId || req.actingAgentId || req.machineId || (req.principalKind && req.principalKind !== "user")) { res.status(403).json({ code: "human_login_required" }); return; }
      try { res.json(await getAppSumoRedemptionStatus({ db: dependencies.db(), token: claimCookie(req), userId: req.userId, now: dependencies.now() })); }
      catch (error) { fail(res, error); }
    },
    async bind(req: Request, res: Response) {
      noStore(res);
      const config = dependencies.config();
      if (!config) { res.status(503).json({ code: "appsumo_not_configured" }); return; }
      if (!req.userId || req.actingAgentId || req.machineId || (req.principalKind && req.principalKind !== "user")) { res.status(403).json({ code: "human_login_required" }); return; }
      if (req.get("Origin") !== config.appOrigin) { res.status(403).json({ code: "invalid_origin" }); return; }
      const parsed = z.object({ serverId: z.string().uuid(), claimId: z.string().uuid().transform(value => parseAppSumoClaimId(value)!) }).strict().safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ code: "invalid_binding" }); return; }
      try {
        res.json(await bindAppSumoRedemption({ db: dependencies.db(), token: claimCookie(req), ...parsed.data,
          userId: req.userId, now: dependencies.now(), inspectStripe: dependencies.inspectStripe ?? inspectStripeBillingForAppSumo }));
      } catch (error) { fail(res, error); }
    },
  };
}
export const appSumoHandlers = createAppSumoHandlers({ db: getDb, config: getAppSumoConfig, now: currentDate, provider: createAppSumoProvider });
