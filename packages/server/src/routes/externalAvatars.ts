import { Router, type Router as RouterType } from "express";
import { and, eq, isNotNull } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { externalProjectionAvatarArtifacts } from "../db/schema.js";
import { getCdnStorage, getStorage } from "../services/storageService.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const externalAvatarPublicRouter: RouterType = Router();

externalAvatarPublicRouter.get("/:id.webp", async (req, res) => {
  try {
    if (!UUID_PATTERN.test(req.params.id)) {
      res.status(404).send("Not found");
      return;
    }
    const [artifact] = await getDb().select({
      storageKey: externalProjectionAvatarArtifacts.storageKey,
      mimeType: externalProjectionAvatarArtifacts.mimeType,
      byteSize: externalProjectionAvatarArtifacts.byteSize,
      sourceDigest: externalProjectionAvatarArtifacts.sourceDigest,
    }).from(externalProjectionAvatarArtifacts).where(and(
      eq(externalProjectionAvatarArtifacts.id, req.params.id),
      eq(externalProjectionAvatarArtifacts.state, "active"),
      isNotNull(externalProjectionAvatarArtifacts.storageKey),
    )).limit(1);
    if (!artifact?.storageKey) {
      res.status(404).send("Not found");
      return;
    }
    const storage = getCdnStorage() ?? getStorage();
    if (!storage) {
      res.status(503).send("Avatar storage is unavailable");
      return;
    }
    const stream = await storage.get(artifact.storageKey);
    res.setHeader("Content-Type", artifact.mimeType);
    res.setHeader("Content-Length", String(artifact.byteSize));
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "public, no-cache, must-revalidate");
    res.setHeader("ETag", `"sha256-${artifact.sourceDigest}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // The web app and API intentionally use different origins in managed
    // deployments. Helmet defaults this header to same-origin, which makes a
    // successfully materialized Slack avatar fail at the browser boundary and
    // silently fall back to initials.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    stream.pipe(res);
  } catch {
    if (!res.headersSent) res.status(404).send("Not found");
    else res.destroy();
  }
});
