import { Router, type Response, type Router as RouterType } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { clearClockInterval, currentTimeMs, setClockInterval } from "@botiverse/raft-shared";

import { requireAuth, requireVerified } from "../middleware/auth.js";
import {
  NativeNotificationError,
  authenticateNativeCredential,
  exchangeEnrollmentGrant,
  issueEnrollmentGrant,
  isActiveNativeNotificationSessionFamily,
  isNativeNotificationEnabled,
  listNativeNotificationDevices,
  prepareNativeNotificationReplay,
  readNativeNotificationEventsAfter,
  revokeCurrentNativeCredential,
  revokeNativeNotificationDevice,
  rotateNativeCredential,
} from "../services/nativeNotificationService.js";

export const notificationRouter: RouterType = Router();

type NativeNotificationLiveWriteHook = (input: { index: number; eventCount: number }) => void | Promise<void>;
let nativeNotificationLiveWriteHookForTests: NativeNotificationLiveWriteHook | null = null;

export function __setNativeNotificationLiveWriteHookForTests(hook: NativeNotificationLiveWriteHook | null): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Native notification stream hooks are test-only");
  nativeNotificationLiveWriteHookForTests = hook;
}

const enrollmentGrantLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  message: { error: "Too many native notification enrollment attempts", code: "native_notification_rate_limited" },
});

const enrollmentExchangeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === "test",
  keyGenerator: (req) => ipKeyGenerator(req.ip ?? "unknown"),
  message: { error: "Too many native notification exchange attempts", code: "native_notification_rate_limited" },
});

notificationRouter.use((_req, res, next) => {
  if (!isNativeNotificationEnabled()) {
    res.status(404).json({ error: "Not found", code: "not_found" });
    return;
  }
  next();
});

function bearer(req: { headers: { authorization?: string } }): string | null {
  const header = req.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : null;
}

function respondError(res: Response, error: unknown): void {
  if (error instanceof NativeNotificationError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  console.error("[NativeNotifications] request failed");
  res.status(500).json({ error: "Native notification request failed", code: "native_notification_error" });
}

notificationRouter.post("/enrollment-grants", enrollmentGrantLimiter, requireAuth, requireVerified, async (req, res) => {
  if (!req.userId || !req.sessionFamilyId) {
    res.status(401).json({ error: "A live normal session family is required", code: "session_family_required" });
    return;
  }
  try {
    const result = await issueEnrollmentGrant({
      userId: req.userId,
      sessionFamilyId: req.sessionFamilyId,
      request: req.body ?? {},
    });
    res.status(201).json(result);
  } catch (error) {
    respondError(res, error);
  }
});

notificationRouter.post("/enrollment-exchanges", enrollmentExchangeLimiter, async (req, res) => {
  try {
    const result = await exchangeEnrollmentGrant({ grant: req.body?.grant, proof: req.body?.proof });
    res.status(201).json(result);
  } catch (error) {
    respondError(res, error);
  }
});

notificationRouter.get("/devices", requireAuth, requireVerified, async (req, res) => {
  if (!req.userId || !await isActiveNativeNotificationSessionFamily(req.userId, req.sessionFamilyId)) {
    res.status(401).json({ error: "Unauthorized", code: "auth_required" });
    return;
  }
  try {
    res.json({ devices: await listNativeNotificationDevices(req.userId) });
  } catch (error) {
    respondError(res, error);
  }
});

notificationRouter.delete("/devices/:deviceId", requireAuth, requireVerified, async (req, res) => {
  if (!req.userId || !await isActiveNativeNotificationSessionFamily(req.userId, req.sessionFamilyId)) {
    res.status(401).json({ error: "Unauthorized", code: "auth_required" });
    return;
  }
  try {
    const deviceId = req.params.deviceId;
    const revoked = await revokeNativeNotificationDevice(req.userId, typeof deviceId === "string" ? deviceId : "");
    if (!revoked) {
      res.status(404).json({ error: "Notification device not found", code: "notification_device_not_found" });
      return;
    }
    res.status(204).end();
  } catch (error) {
    respondError(res, error);
  }
});

notificationRouter.post("/credentials/rotate", async (req, res) => {
  const credential = bearer(req);
  if (!credential?.startsWith("rnc1.")) {
    res.status(401).json({ error: "Invalid native notification credential", code: "native_credential_invalid" });
    return;
  }
  try {
    res.status(201).json(await rotateNativeCredential({ credential, proof: req.body?.proof }));
  } catch (error) {
    respondError(res, error);
  }
});

notificationRouter.delete("/credentials/current", async (req, res) => {
  const credential = bearer(req);
  if (!credential?.startsWith("rnc1.")) {
    res.status(401).json({ error: "Invalid native notification credential", code: "native_credential_invalid" });
    return;
  }
  try {
    await revokeCurrentNativeCredential(credential);
    res.status(204).end();
  } catch (error) {
    respondError(res, error);
  }
});

notificationRouter.get("/stream", async (req, res) => {
  const credential = bearer(req);
  if (!credential?.startsWith("rnc1.")) {
    res.status(401).json({ error: "Invalid native notification credential", code: "native_credential_invalid" });
    return;
  }

  try {
    const principal = await authenticateNativeCredential(credential);
    if (!principal) {
      res.status(401).json({ error: "Invalid native notification credential", code: "native_credential_invalid" });
      return;
    }
    const lastEventHeader = req.headers["last-event-id"];
    if (Array.isArray(lastEventHeader)) {
      res.status(400).json({ error: "Invalid Last-Event-ID", code: "replay_cursor_invalid" });
      return;
    }
    const prepared = await prepareNativeNotificationReplay(principal.userId, lastEventHeader);
    if (!await authenticateNativeCredential(credential, { recordUse: false })) {
      res.status(401).json({ error: "Invalid native notification credential", code: "native_credential_invalid" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();

    let cursorSeq = prepared.cursorSeq;
    let closed = false;
    let polling = false;
    let lastHeartbeatAt = currentTimeMs();
    let timer: unknown;
    const pollMs = Math.max(250, Math.min(5_000, Number(process.env.NATIVE_NOTIFICATION_STREAM_POLL_MS) || 1_000));
    const heartbeatMs = Math.max(1_000, Math.min(30_000, Number(process.env.NATIVE_NOTIFICATION_STREAM_HEARTBEAT_MS) || 15_000));

    const writeEvent = (item: { streamSeq: number; event: { eventId: string } }) => {
      res.write(`event: native-notification.v1\nid: ${item.event.eventId}\ndata: ${JSON.stringify(item.event)}\n\n`);
      cursorSeq = item.streamSeq;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      if (timer) clearClockInterval(timer);
      if (!res.writableEnded) res.end();
    };
    for (const item of prepared.replay) {
      if (!await authenticateNativeCredential(credential, { recordUse: false })) {
        close();
        return;
      }
      writeEvent(item);
    }
    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        // Reauthorize before every durable read and again before every frame.
        // A credential can be revoked while an already-read batch is in flight.
        if (!await authenticateNativeCredential(credential, { recordUse: false })) {
          close();
          return;
        }
        const events = await readNativeNotificationEventsAfter(principal.userId, cursorSeq);
        for (const [index, item] of events.entries()) {
          if (process.env.NODE_ENV === "test") {
            await nativeNotificationLiveWriteHookForTests?.({ index, eventCount: events.length });
          }
          if (!await authenticateNativeCredential(credential, { recordUse: false })) {
            close();
            return;
          }
          writeEvent(item);
        }
        if (currentTimeMs() - lastHeartbeatAt >= heartbeatMs) {
          res.write(": heartbeat\n\n");
          lastHeartbeatAt = currentTimeMs();
        }
      } catch {
        close();
      } finally {
        polling = false;
      }
    };
    timer = setClockInterval(() => { void poll(); }, pollMs);
    (timer as ReturnType<typeof setInterval>).unref?.();
    req.on("close", close);
  } catch (error) {
    if (!res.headersSent) respondError(res, error);
    else if (!res.writableEnded) res.end();
  }
});
