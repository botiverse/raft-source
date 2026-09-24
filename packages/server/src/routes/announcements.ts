import {
  Router,
  type Router as RouterType,
} from "express";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import { requireAuth, requireVerified } from "../middleware/auth.js";
import { UUID_RE } from "../lib/messageId.js";
import * as announcementService from "../services/announcementService.js";

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
  const items = await announcementService.listUndismissedForUser(
    userId,
    req.sessionFamilyId,
    undefined,
    afterAnnouncementId,
  );
  res.json({ announcements: items });
});

announcementRouter.post("/:id/dismiss", requireAuth, requireVerified, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const ok = await announcementService.dismiss(userId, req.params.id as string);
  if (!ok) {
    res.status(404).json({ error: "Announcement not found" });
    return;
  }
  res.json({ ok: true });
});
