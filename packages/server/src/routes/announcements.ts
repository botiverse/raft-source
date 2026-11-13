import { sql } from "drizzle-orm";
import { getDb } from "../db/index";
import { streamStorageResponse } from "../services/storageResponseStream";
import { getDirectUploadStorage, isStorageNotFoundError } from "../services/storageService";
import {
  Router,
  type Router as RouterType,
} from "express";
import { ANNOUNCEMENT_SIDEBAR_STACK_MAX, asServerId, currentTimeMs } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import { requireAuth, requireVerified } from "../middleware/auth";
import { UUID_RE } from "../lib/messageId";
import * as announcementService from "../services/announcementService";
import { parseRaftAppClient, requestClientPlatform } from "../services/productEventContext";

export const announcementRouter: RouterType = Router();

export function emitAnnouncementInvalidation(io: SocketServer | undefined, announcementId: string): void {
  // Socket delivery is only a nudge. Eligibility, onboarding suppression,
  // expiry, and dismissal are always re-read from the server.
  io?.emit("announcement:new", { announcementId });
}

export async function publishAndBroadcast(
  io: SocketServer,
  params: {
    title: string;
    pages: announcementService.AnnouncementPage[];
    startsAt?: Date | null;
    endsAt?: Date | null;
  },
): Promise<announcementService.Announcement> {
  const announcement = await announcementService.publish(params);
  if (new Date(announcement.startsAt).getTime() <= currentTimeMs()) {
    emitAnnouncementInvalidation(io, announcement.id);
  }
  return announcement;
}

announcementRouter.get("/active", requireAuth, requireVerified, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const rawServer = req.query.server_id;
  if (rawServer !== undefined && (typeof rawServer !== "string" || !UUID_RE.test(rawServer))) {
    res.status(400).json({ error: "server_id must be a Server UUID" });
    return;
  }
  const serverId = typeof rawServer === "string" ? asServerId(rawServer.toLowerCase()) : undefined;
  const rawAfter = req.query.after;
  if (rawAfter !== undefined && typeof rawAfter !== "string") {
    res.status(400).json({ error: "after must be an announcement UUID" });
    return;
  }
  const afterAnnouncementId = rawAfter?.trim() || undefined;
  if (afterAnnouncementId && !UUID_RE.test(afterAnnouncementId)) {
    res.status(400).json({ error: "after must be an announcement UUID" });
    return;
  }
  // Optional and additive: clients that omit it keep the one-row contract.
  const rawSidebarLimit = req.query.sidebar_limit;
  const sidebarLimit = rawSidebarLimit === undefined ? 1 : Number(rawSidebarLimit);
  if (!Number.isInteger(sidebarLimit) || sidebarLimit < 1 || sidebarLimit > ANNOUNCEMENT_SIDEBAR_STACK_MAX) {
    res.status(400).json({ error: `sidebar_limit must be an integer from 1 to ${ANNOUNCEMENT_SIDEBAR_STACK_MAX}` });
    return;
  }
  const items = await announcementService.listUndismissedForUser(
    userId,
    req.sessionFamilyId,
    undefined,
    afterAnnouncementId,
    serverId,
    // Coarse platform/build only; the raw User-Agent is not kept (productEventContext.ts).
    parseRaftAppClient(req.get("user-agent")),
    sidebarLimit,
    announcementService.announcementRulePlatform(requestClientPlatform(req.get("x-raft-client-platform"), req.get("user-agent"))),
  );
  res.json({ announcements: items });
});

announcementRouter.post("/:id/dismiss", requireAuth, requireVerified, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const rawServer = req.query.server_id;
  if (rawServer !== undefined && (typeof rawServer !== "string" || !UUID_RE.test(rawServer))) {
    res.status(400).json({ error: "server_id must be a Server UUID" });
    return;
  }
  const serverId = typeof rawServer === "string" ? asServerId(rawServer.toLowerCase()) : undefined;
  const ok = await announcementService.dismiss(
    userId,
    req.params.id as string,
    undefined,
    serverId,
    parseRaftAppClient(req.get("user-agent")),
    announcementService.announcementRulePlatform(requestClientPlatform(req.get("x-raft-client-platform"), req.get("user-agent"))),
  );
  if (!ok) {
    res.status(404).json({ error: "Announcement not found" });
    return;
  }
  res.json({ ok: true });
});

// Anonymous delivery is allowed only after the owning announcement has actually
// been published and reached its start time. Draft bytes stay in private storage.
announcementRouter.get("/images/:id", async (req, res) => {
  const id = req.params.id as string;
  if (!UUID_RE.test(id)) { res.sendStatus(404); return; }
  const result = await getDb().execute(sql`
    SELECT asset.storage_key, asset.content_type
    FROM announcement_image_assets asset
    WHERE asset.id = ${id}::uuid AND asset.deleting_at IS NULL AND EXISTS (
      SELECT 1 FROM announcements a
      CROSS JOIN LATERAL json_each(a.localized_content) locale
      WHERE locale.value->'image'->>'assetId' = ${id}
      AND a.deleted_at IS NULL AND a.published_at IS NOT NULL AND a.starts_at <= now()
    )
  `);
  const row = result.rows[0] as { storage_key: string; content_type: string } | undefined;
  if (!row) { res.sendStatus(404); return; }
  const storage = getDirectUploadStorage();
  if (!storage) { res.sendStatus(503); return; }
  try {
    const body = await storage.get(row.storage_key);
    res.setHeader("Content-Type", row.content_type);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    await streamStorageResponse(body, res);
  } catch (error) { if (!res.headersSent) res.sendStatus(isStorageNotFoundError(error) ? 404 : 503); else res.destroy(); }
});
