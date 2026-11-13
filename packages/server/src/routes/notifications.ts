import { Router, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";

import { requireAuth, requireServer, requireVerified } from "../middleware/auth";
import {
  ackTestNotification,
  parseTestNotificationDevice,
  readTestNotificationStatus,
  sendTestNotification,
} from "../services/notifications/testNotification";

/** Test notifications (docs/contracts/notifications.md §6). */
export const notificationRouter: RouterType = Router();

const TEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

notificationRouter.post("/test", requireAuth, requireVerified, requireServer, async (req, res) => {
  const device = parseTestNotificationDevice((req.body as { device?: unknown } | undefined)?.device);
  if (!device) {
    res.status(400).json({ error: "device.kind must be desktop, web or mobile" });
    return;
  }
  try {
    const result = await sendTestNotification({
      io: req.app.get("io") as SocketServer | undefined,
      userId: req.userId!,
      serverId: req.serverId!,
      device,
    });
    res.json(result);
  } catch {
    console.error("[Notifications] test notification failed");
    res.status(500).json({ error: "Failed to send test notification" });
  }
});

notificationRouter.post("/test/:testId/ack", requireAuth, async (req, res) => {
  const shown = (req.body as { shown?: unknown } | undefined)?.shown;
  if (typeof shown !== "boolean") {
    res.status(400).json({ error: "shown must be a boolean" });
    return;
  }
  const testId = String(req.params.testId);
  if (!TEST_ID_RE.test(testId) || !(await ackTestNotification(req.userId!, testId, shown))) {
    res.status(404).json({ error: "Unknown test notification" });
    return;
  }
  res.json({ ok: true });
});

notificationRouter.get("/test/:testId", requireAuth, async (req, res) => {
  const testId = String(req.params.testId);
  const status = TEST_ID_RE.test(testId) ? await readTestNotificationStatus(req.userId!, testId) : null;
  if (!status) {
    res.status(404).json({ error: "Unknown test notification" });
    return;
  }
  res.json(status);
});
