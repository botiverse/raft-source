import { Router, type Request, type Response, type Router as RouterType } from "express";
import * as featureFlagService from "../services/featureFlagService.js";
import * as serverService from "../services/serverService.js";

export const featureFlagsRouter: RouterType = Router();

const FLAG_KEY_RE = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORMS = new Set<featureFlagService.FeatureFlagPlatform>(["web", "mobile"]);

function badRequest(res: Response, error: string) {
  res.status(400).json({ error });
}

function parseFlagKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return FLAG_KEY_RE.test(trimmed) ? trimmed : null;
}

function bodyObject(req: Request): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

featureFlagsRouter.post("/evaluate", async (req, res) => {
  try {
    const body = bodyObject(req);
    const rawKeys = Array.isArray(body.keys)
      ? body.keys
      : typeof body.key === "string"
        ? [body.key]
        : [];
    const keys = rawKeys.map(parseFlagKey);
    if (keys.length === 0 || keys.length > 50 || keys.some((key) => !key)) {
      badRequest(res, "keys must contain 1-50 valid feature flag keys");
      return;
    }

    const serverId = typeof body.serverId === "string" && UUID_RE.test(body.serverId)
      ? body.serverId
      : undefined;
    if (body.serverId !== undefined && !serverId) {
      badRequest(res, "serverId must be a valid UUID");
      return;
    }
    if (serverId && !(await serverService.isMember(serverId, req.userId!))) {
      res.status(403).json({ error: "Not a member of this server" });
      return;
    }

    const platform = typeof body.platform === "string" && PLATFORMS.has(body.platform as featureFlagService.FeatureFlagPlatform)
      ? body.platform as featureFlagService.FeatureFlagPlatform
      : undefined;
    if (body.platform !== undefined && !platform) {
      badRequest(res, "platform must be web or mobile");
      return;
    }

    const uniqueKeys = [...new Set(keys as string[])];
    const evaluations = await featureFlagService.evaluateFeatureFlags(
      uniqueKeys.map((key) => ({ key, userId: req.userId!, serverId, platform })),
    );
    res.json({ evaluations });
  } catch (err) {
    console.error("Feature flag evaluate error:", err);
    res.status(500).json({ error: "Failed to evaluate feature flags" });
  }
});
