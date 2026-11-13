import { Router, type Request, type Response, type Router as RouterType } from "express";
import { UUID_RE } from "../lib/messageId";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { shareArtifacts } from "../db/schema";
import { refuse } from "../lib/refusal";
import { runtimeFormCopyLocale } from "../services/runtimeFormV2Copy";
import { getCdnStorage } from "../services/storageService";
import { streamStorageResponse } from "../services/storageResponseStream";

/**
 * Share to X, and with it every way to make, list or delete a share link, was
 * retired on 2026-11-09 (docs/contracts/share-artifacts.md). The links made
 * before stay in `share_artifacts` and their images stay in the CDN bucket, so
 * they can be brought back; while this is true the public page answers 410
 * with a "no longer available" page (no image, no card tags) and the server's
 * own image route answers 410. Set it to false to serve existing links again.
 *
 * Not covered by this switch: the CDN URL (`CDN_BASE_URL/<serverId>/share-artifacts/<id>.png`,
 * cdn.raft.build), which botiverse/raft-cdn-worker serves straight from the
 * bucket without reading the row.
 */
export const SHARE_ARTIFACTS_RETIRED: boolean = true;

let retiredForTests: boolean | null = null;

function shareArtifactsRetired(): boolean {
  return retiredForTests ?? SHARE_ARTIFACTS_RETIRED;
}

/** Tests only: serve existing links as before (false) or as retired (true); null restores the switch. */
export function __setShareArtifactsRetiredForTests(retired: boolean | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Share artifact retirement hooks are test-only");
  retiredForTests = retired;
}

const SHARE_ARTIFACT_RETIRED_CODE = "SHARE_ARTIFACT_RETIRED";

/**
 * The public page and the server's own copy of the image: a minute, the same
 * as cdn.raft.build gives the image (botiverse/raft-cdn-worker), so retiring
 * or restoring links takes effect within a minute.
 */
const SHARE_ARTIFACT_PUBLIC_CACHE_CONTROL = "public, max-age=60";

export const shareArtifactRouter: RouterType = Router();
export const shareArtifactPublicRouter: RouterType = Router();

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
  return typeof value === "string" && UUID_RE.test(value);
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

/** The retired page's one sentence: Simplified Chinese when asked for, else English. */
const SHARE_ARTIFACT_RETIRED_COPY = {
  en: { lang: "en", text: "This shared link is no longer available." },
  "zh-cn": { lang: "zh-CN", text: "这个分享链接已失效。" },
} as const;

function shareArtifactRetiredCopy(acceptLanguage: string | undefined): { lang: string; text: string } {
  return runtimeFormCopyLocale(acceptLanguage) === "zh-cn"
    ? SHARE_ARTIFACT_RETIRED_COPY["zh-cn"]
    : SHARE_ARTIFACT_RETIRED_COPY.en;
}

/**
 * The page an existing link answers while links are retired: the sentence,
 * and no image or card tags, so X and other sites show no screenshot.
 */
function renderShareArtifactRetiredHtml(copy: { lang: string; text: string }): string {
  const text = escapeHtml(copy.text);
  return `<!doctype html>
<html lang="${escapeHtml(copy.lang)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${text}</title>
  <meta name="robots" content="noindex, nofollow">
  <meta property="og:title" content="${text}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${text}">
  <style>
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #fffdf4; color: #111; }
    main { min-height: 100vh; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
    p { font-size: 15px; margin: 0; }
  </style>
</head>
<body>
  <main>
    <p>${text}</p>
  </main>
</body>
</html>`;
}

function answerRetiredSharePage(req: Request, res: Response): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", SHARE_ARTIFACT_PUBLIC_CACHE_CONTROL);
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.vary("Accept-Language");
  // refusal-ok: a public HTML page for browsers and card crawlers, not the JSON envelope
  res.status(410).send(renderShareArtifactRetiredHtml(shareArtifactRetiredCopy(req.get("accept-language"))));
}

// Creation was retired on 2026-11-09. Older web, desktop and mobile builds
// still offer Share to X and POST here: they get 410 with a sentence they can
// show (the web shows a refusal's `error`) instead of a bare 404. List
// (GET /) and delete (DELETE /:id) are gone and answer 404.
shareArtifactRouter.post("/message-selection", (_req, res) => {
  refuse(res, 410, {
    code: SHARE_ARTIFACT_RETIRED_CODE,
    error: "Sharing to X has been retired, so new share links can't be made: download the image or copy it instead.",
  });
});

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
    if (shareArtifactsRetired()) {
      res.setHeader("Cache-Control", SHARE_ARTIFACT_PUBLIC_CACHE_CONTROL);
      // refusal-ok: the public image route answers plain text, like its 404
      res.status(410).send("Gone");
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
    res.setHeader("Cache-Control", SHARE_ARTIFACT_PUBLIC_CACHE_CONTROL);
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
    if (shareArtifactsRetired()) {
      answerRetiredSharePage(req, res);
      return;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", SHARE_ARTIFACT_PUBLIC_CACHE_CONTROL);
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
