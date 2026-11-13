import { Router, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import { requireServer } from "../middleware/auth";
import { asServerId } from "@botiverse/raft-shared";
import * as notificationSettings from "../services/notifications/settings";
import { getProductEventSink } from "../services/productEventIngest";
import { recordServerProductEvent } from "../services/serverProductEvents";
import { sendJsonServerError } from "./errorResponse";

// Notification levels (docs/contracts/notifications.md §2.2): the one write
// path for the server and channel scopes. A thread has no level, only Follow /
// Unfollow (POST /channels/threads/follow, /unfollow). Mounted under
// /api/notification-levels with requireAuth + requireVerified; PUT needs no
// server header (the id names the scope), GET lists one server's.
export const notificationLevelsRouter: RouterType = Router();

notificationLevelsRouter.put("/", async (req, res) => {
  const parsed = notificationSettings.parseSetLevelBody(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  if (parsed.scope === "thread") {
    res.status(400).json({ error: "A thread has no notification level; follow or unfollow it" });
    return;
  }
  try {
    const userId = req.userId!;
    const result = await notificationSettings.setLevel({ userId, scope: parsed.scope, id: parsed.id, level: parsed.level });
    await notificationSettings.emitLevelChange(req.app.get("io") as SocketServer | undefined, userId, result);
    // Which levels people choose (#proj-analytics:#17): every client writes here; only a real change counts.
    if (result.changed && (result.scope === "server" || result.scope === "channel")) {
      void recordServerProductEvent(getProductEventSink(req.app), {
        event: "notification_level_changed",
        userId,
        serverId: asServerId(result.serverId),
        properties: { scope: result.scope, level: result.level },
      });
    }
    // A pending read-position side effect of a follow change completes on its own; the level is written.
    const { changed: _changed, followChanged: _followChanged, pendingRead: _pendingRead, ...body } = result;
    res.json(body);
  } catch (err) {
    if (err instanceof notificationSettings.NotificationLevelError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    sendJsonServerError(req, res, {
      error: "Failed to set notification level",
      logPrefix: "[Notifications] Failed to set level:",
      err,
    });
  }
});

notificationLevelsRouter.get("/", requireServer, async (req, res) => {
  try {
    const snapshot = await notificationSettings.getServerLevels(req.userId!, req.serverId!);
    if (!snapshot) {
      res.status(404).json({ error: "Server not found" });
      return;
    }
    res.json({ serverId: snapshot.serverId, server: snapshot.server, channels: snapshot.channels, threads: snapshot.threads });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to list notification levels",
      logPrefix: "[Notifications] Failed to list levels:",
      err,
    });
  }
});
