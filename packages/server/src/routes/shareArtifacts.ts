import { Router, type NextFunction, type Request, type Response, type Router as RouterType } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { shareArtifacts } from "../db/schema.js";
import * as channelService from "../services/channelService.js";
import { getCdnStorage, isStorageTimeoutError } from "../services/storageService.js";
import { streamStorageResponse } from "../services/storageResponseStream.js";

const SHARE_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
const SHARE_ARTIFACT_MAX_LABEL = "10MB";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: SHARE_ARTIFACT_MAX_BYTES + 1024 * 1024 },
});

export const shareArtifactRouter: RouterType = Router();
export const shareArtifactPublicRouter: RouterType = Router();

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runShareArtifactUpload(req: Request, res: Response, next: NextFunction): void {
  upload.single("image")(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: `Max ${SHARE_ARTIFACT_MAX_LABEL} per image`,
        errorCode: "SHARE_ARTIFACT_TOO_LARGE",
        maxBytes: SHARE_ARTIFACT_MAX_BYTES,
      });
      return;
    }
    if (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : "Upload failed" });
      return;
    }
    next();
  });
}

function isPngBuffer(buffer: Buffer): boolean {
  return buffer.length >= 8
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function getServerBaseUrl(req: Request): string {
  return stripTrailingSlash(process.env.SERVER_URL || `${req.protocol}://${req.get("host")}`);
}

function getSharePageBaseUrl(req: Request): string {
  return stripTrailingSlash(process.env.SHARE_BASE_URL || `${getServerBaseUrl(req)}/share`);
}

function buildShareUrl(req: Request, artifactId: string): string {
  return `${getSharePageBaseUrl(req)}/${artifactId}`;
}

function buildShareImageUrl(req: Request, artifactId: string, storageKey: string): string {
  const cdnBase = process.env.CDN_BASE_URL?.trim();
  if (cdnBase) {
    return `${stripTrailingSlash(cdnBase)}/${storageKey}`;
  }
  return `${getServerBaseUrl(req)}/share/${artifactId}.png`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isCanonicalUuid(value: string | undefined): value is string {
  return typeof value === "string" && CANONICAL_UUID_RE.test(value);
}

function renderShareArtifactHtml(
  req: Request,
  artifactId: string,
  image: { storageKey: string; width: number | null; height: number | null },
): string {
  const shareUrl = buildShareUrl(req, artifactId);
  const imageUrl = buildShareImageUrl(req, artifactId, image.storageKey);
  const title = "Slock conversation screenshot";
  const description = "A conversation screenshot shared from Slock.";
  const imageSizeMeta = image.width && image.height
    ? `
  <meta property="og:image:width" content="${image.width}">
  <meta property="og:image:height" content="${image.height}">`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="robots" content="noindex, nofollow">
  <meta property="og:type" content="article">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(shareUrl)}">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:type" content="image/png">${imageSizeMeta}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
  <meta name="twitter:image:alt" content="${escapeHtml(title)}">
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #fffdf4; color: #111; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    .share-card { width: min(100%, 960px); margin-inline: auto; }
    img { display: block; width: 100%; height: auto; border: 2px solid #111; box-shadow: 4px 4px 0 #111; background: #fff; box-sizing: border-box; }
    p { font-size: 13px; color: rgba(0,0,0,.6); margin-top: 16px; }
  </style>
</head>
<body>
  <main>
    <div class="share-card">
      <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title)}">
      <p>Shared from Slock.</p>
    </div>
  </main>
</body>
</html>`;
}

shareArtifactRouter.post(
  "/message-selection",
  runShareArtifactUpload,
  async (req, res) => {
    try {
      const file = req.file;
      if (!file || file.size <= 0 || file.buffer.length <= 0) {
        res.status(400).json({ error: "image is required" });
        return;
      }
      if (file.size > SHARE_ARTIFACT_MAX_BYTES) {
        res.status(413).json({
          error: `Max ${SHARE_ARTIFACT_MAX_LABEL} per image`,
          errorCode: "SHARE_ARTIFACT_TOO_LARGE",
          maxBytes: SHARE_ARTIFACT_MAX_BYTES,
        });
        return;
      }
      if (!isPngBuffer(file.buffer)) {
        res.status(415).json({ error: "Share artifact must be a PNG image" });
        return;
      }

      const channelId = typeof req.body.channelId === "string" ? req.body.channelId : null;
      if (!channelId) {
        res.status(400).json({ error: "channelId is required" });
        return;
      }

      const canAccess = await channelService.canUserAccessChannel(channelId, req.userId!, req.serverId!);
      if (!canAccess) {
        res.status(403).json({ error: "You do not have access to this channel" });
        return;
      }

      const storage = getCdnStorage();
      if (!storage) {
        res.status(503).json({ error: "File storage is not configured on this server" });
        return;
      }

      const id = randomUUID();
      const storageKey = `${req.serverId}/share-artifacts/${id}.png`;
      const metadata = await sharp(file.buffer).metadata();
      await storage.put(storageKey, file.buffer, "image/png");

      const [artifact] = await getDb()
        .insert(shareArtifacts)
        .values({
          id,
          serverId: req.serverId!,
          channelId,
          createdByUserId: req.userId!,
          storageKey,
          mimeType: "image/png",
          sizeBytes: file.size,
          width: metadata.width ?? null,
          height: metadata.height ?? null,
        })
        .returning();

      res.json({
        id: artifact.id,
        url: buildShareUrl(req, artifact.id),
        imageUrl: buildShareImageUrl(req, artifact.id, artifact.storageKey),
      });
    } catch (err) {
      console.error("[ShareArtifacts] Failed to create share artifact", err);
      if (isStorageTimeoutError(err)) {
        res.status(504).json({ error: "Share image storage timed out" });
        return;
      }
      res.status(500).json({ error: "Failed to create share image" });
    }
  },
);

shareArtifactPublicRouter.get("/:id.png", async (req, res) => {
  try {
    if (!isCanonicalUuid(req.params.id)) {
      res.status(404).send("Not found");
      return;
    }

    const [artifact] = await getDb()
      .select({
        id: shareArtifacts.id,
        storageKey: shareArtifacts.storageKey,
        mimeType: shareArtifacts.mimeType,
        sizeBytes: shareArtifacts.sizeBytes,
      })
      .from(shareArtifacts)
      .where(eq(shareArtifacts.id, req.params.id))
      .limit(1);
    if (!artifact) {
      res.status(404).send("Not found");
      return;
    }

    const storage = getCdnStorage();
    if (!storage) {
      res.status(503).send("File storage is not configured");
      return;
    }

    const stream = await storage.get(artifact.storageKey);
    res.setHeader("Content-Type", artifact.mimeType);
    res.setHeader("Content-Length", String(artifact.sizeBytes));
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Cache-Control", "public, immutable, max-age=31536000");
    res.setHeader("X-Content-Type-Options", "nosniff");
    await streamStorageResponse(stream, res);
  } catch (err) {
    if (res.destroyed || res.headersSent) return;
    console.error("[ShareArtifacts] Failed to serve share artifact image", err);
    res.status(500).send("Failed to serve share image");
  }
});

shareArtifactPublicRouter.get("/:id", async (req, res) => {
  try {
    if (!isCanonicalUuid(req.params.id)) {
      res.status(404).send("Not found");
      return;
    }

    const [artifact] = await getDb()
      .select({
        id: shareArtifacts.id,
        storageKey: shareArtifacts.storageKey,
        width: shareArtifacts.width,
        height: shareArtifacts.height,
      })
      .from(shareArtifacts)
      .where(eq(shareArtifacts.id, req.params.id))
      .limit(1);
    if (!artifact) {
      res.status(404).send("Not found");
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.send(renderShareArtifactHtml(req, artifact.id, {
      storageKey: artifact.storageKey,
      width: artifact.width,
      height: artifact.height,
    }));
  } catch (err) {
    console.error("[ShareArtifacts] Failed to render share artifact", err);
    res.status(500).send("Failed to render share");
  }
});
