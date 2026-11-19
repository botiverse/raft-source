import { Router, type Router as RouterType } from "express";
import type { Server as SocketServer } from "socket.io";
import { currentDate } from "@botiverse/raft-shared";
import { accountSettingChanges } from "../services/notifications/accountSettingsEvents";
import { accountSettingsForClient, isFollowedThreadRepliesSwitchOn } from "../services/notifications/followedThreadRepliesSwitch";
import * as notificationSettings from "../services/notifications/settings";
import { listAccountAppLogins, revokeAccountAppLogin } from "../services/oauthAccountLogin";
import { getProductEventSink } from "../services/productEventIngest";
import { recordServerProductEvent } from "../services/serverProductEvents";
import { sendJsonServerError } from "./errorResponse";

// The signed-in user's own account-level state. Mounted under /api/me with
// requireAuth + requireVerified (no server context).
export const meRouter: RouterType = Router();

// Account notification settings plus every server's level
// (docs/contracts/notifications.md §2.1). While the followed-thread switch's
// flag is off for the person, every answer and the account frame leave
// `followedThreadReplies` out (followedThreadRepliesSwitch.ts).
meRouter.get("/notification-settings", async (req, res) => {
  try {
    const userId = req.userId!;
    const [settings, servers, switchOn] = await Promise.all([
      notificationSettings.getAccountNotificationSettings(userId),
      notificationSettings.listServerLevels(userId),
      isFollowedThreadRepliesSwitchOn(userId),
    ]);
    res.json({ settings: accountSettingsForClient(settings, switchOn), servers });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to get notification settings",
      logPrefix: "[Notifications] Failed to get account settings:",
      err,
    });
  }
});

meRouter.patch("/notification-settings", async (req, res) => {
  const now = currentDate();
  const parsed = notificationSettings.parseAccountSettingsPatch(req.body, now);
  if (!parsed.ok) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  try {
    const userId = req.userId!;
    const switchOn = await isFollowedThreadRepliesSwitchOn(userId);
    // Flag off: the switch is not offered, so a client that still sends it
    // (an older bundle) is answered as for the rest of its patch; nothing of
    // it is written, and the stored value stays as it is.
    const patch = { ...parsed.patch };
    if (!switchOn) delete patch.followedThreadReplies;
    const result = await notificationSettings.updateAccountNotificationSettings(userId, patch);
    if (result.kind === "version_conflict") {
      res.status(409).json({ error: "version_conflict", settings: accountSettingsForClient(result.settings, switchOn) });
      return;
    }
    if (result.changed) {
      notificationSettings.emitNotificationPrefsUpdated(req.app.get("io") as SocketServer | undefined, userId, {
        type: "account",
        settings: accountSettingsForClient(result.settings, switchOn),
      });
      // Which account-wide settings people change (#proj-analytics:fbb8f05c): every client
      // writes here; one event per setting this write changed. Account level, so no server.
      for (const properties of accountSettingChanges(result.previous, result.settings, now)) {
        void recordServerProductEvent(getProductEventSink(req.app), {
          event: "notification_settings_changed",
          userId,
          serverId: null,
          properties,
        });
      }
    }
    res.json({ settings: accountSettingsForClient(result.settings, switchOn) });
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to update notification settings",
      logPrefix: "[Notifications] Failed to update account settings:",
      err,
    });
  }
});

// The Apps the person signed in to with their Raft account (account-mode Login
// with Raft, RFC 079 phase 3a design §3.2): each active account-mode consent,
// newest first. The person's own data; never cached.
meRouter.get("/app-logins", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const logins = await listAccountAppLogins(req.userId!);
    res.json(logins.map((login) => ({
      id: login.id,
      clientId: login.clientId,
      name: login.name,
      logoUrl: login.logoUrl,
      scopes: login.scopes,
      grantedAt: login.grantedAt.toISOString(),
    })));
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to list app logins",
      logPrefix: "[OAuth] Failed to list account-mode app logins:",
      err,
    });
  }
});

// Revokes everything one App holds of the person (its open requests, tokens
// and consents, on every Server and none). `:clientId` is the App's public
// client key, as the list gives it. Always 204, whether or not the key names
// an App or the person ever used it, so it tells nobody which Apps exist. No
// step-up: it only removes access.
meRouter.delete("/app-logins/:clientId", async (req, res) => {
  try {
    await revokeAccountAppLogin({ userId: req.userId!, clientKey: req.params.clientId });
    res.status(204).end();
  } catch (err) {
    sendJsonServerError(req, res, {
      error: "Failed to revoke app login",
      logPrefix: "[OAuth] Failed to revoke an account-mode app login:",
      err,
    });
  }
});
