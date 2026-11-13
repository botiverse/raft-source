/**
 * FCM transport (docs/contracts/notifications.md §4.3): data-only messages,
 * every value a string. The HTTP v1 client and credentials stay in
 * services/fcmPushProvider.ts; this module serializes and sends one message
 * to one registration.
 */
import { createHash } from "node:crypto";
import { formatPushSurfaceTitle } from "@botiverse/raft-shared";
import {
  defaultFcmPushProvider,
  isNonRetryableFcmError,
  isTerminalFcmTokenError,
  type FcmMessage,
  type FcmPushProvider,
} from "../../fcmPushProvider";
import type {
  BuiltNotification,
  ExternalSendResult,
  MobileBackgroundPush,
  MobileRegistrationTarget,
} from "../types";
import { localizationInKeySet } from "./localizationKeys";
import { FCM_DATA_MAX_BYTES, jsonByteLength, shrinkTextToFit } from "./payloadBudget";

/**
 * One key per conversation (`notificationKey`); Android clients up to 1.16
 * use it as the notification id. Same derivation as before the unified
 * notifications, so a redacted push keeps the key of its full form.
 */
export function mobilePushConversationKey(serverId: string, channelId: string): string {
  return createHash("sha256")
    .update("mobile-push-conversation-v1\0")
    .update(serverId)
    .update("\0")
    .update(channelId)
    .digest("base64url");
}

export function fcmAlertMessage(
  built: BuiltNotification,
  badge: number | undefined,
  extra: { testId?: string; serverBadge?: number; previewKeySet?: number } = {},
): FcmMessage {
  const { envelope, mobile, push } = built;
  // An app of key set 3 shows `subtitle` itself (its own line); an older
  // Android app does not know it, so the context joins its title (as Web Push).
  const showsSubtitle = (extra.previewKeySet ?? 1) >= 3;
  const data: Record<string, string> = {
    serverId: mobile.serverId,
    category: envelope.category,
    title: push.subtitle && !showsSubtitle ? formatPushSurfaceTitle(push.title, push.subtitle) : push.title,
    body: push.body,
    // The context line (server label for a receiver of 2+ servers); additive, older apps ignore it.
    ...(push.subtitle ? { subtitle: push.subtitle } : {}),
    notificationKey: mobile.notificationKey,
    type: "alert",
    id: envelope.id,
    groupKey: envelope.groupKey,
    routeUrl: built.routeUrl,
    priority: envelope.priority,
    silent: envelope.silent ? "true" : "false",
  };
  // Events without a message (reminder, system_notice, test) omit the
  // conversation identity (contract §4.1).
  if (mobile.channelId) data.channelId = mobile.channelId;
  if (mobile.kind) data.kind = mobile.kind;
  if (envelope.conversationId) data.conversationId = envelope.conversationId;
  if (envelope.seq !== null) data.seq = String(envelope.seq);
  if (built.route) data.route = JSON.stringify(built.route);
  if (extra.serverBadge !== undefined) data.serverBadge = String(extra.serverBadge);
  if (mobile.messageId) data.messageId = mobile.messageId;
  if (mobile.threadId) data.threadId = mobile.threadId;
  if (mobile.parentChannelId) data.parentChannelId = mobile.parentChannelId;
  if (mobile.parentMessageId) data.parentMessageId = mobile.parentMessageId;
  if (mobile.taskId) data.taskId = mobile.taskId;
  if (mobile.taskConversationChannelId) data.taskConversationChannelId = mobile.taskConversationChannelId;
  if (mobile.taskMessageId) data.taskMessageId = mobile.taskMessageId;
  if (badge !== undefined) data.badge = String(badge);
  // Every Android app has always been sent the redacted-preview keys (key
  // sets 1 and 2; it shows the text for a key it lacks), whatever set it
  // declares. The other banner keys (set 3) go only to an app that declares
  // them, as on APNs: an older app never saw a key on a full preview.
  const keys = localizationInKeySet(push.localization, Math.max(extra.previewKeySet ?? 1, 2));
  if (keys) {
    if (keys.bodyKey && envelope.previewMode !== "full") data.previewMode = envelope.previewMode;
    if (keys.titleKey) data.titleKey = keys.titleKey;
    if (keys.titleKey && keys.titleArgs?.length) data.titleArgs = JSON.stringify(keys.titleArgs);
    if (keys.subtitleKey) data.subtitleKey = keys.subtitleKey;
    if (keys.subtitleKey && keys.subtitleArgs?.length) data.subtitleArgs = JSON.stringify(keys.subtitleArgs);
    if (keys.bodyKey) {
      data.bodyKey = keys.bodyKey;
      data.bodyArgs = JSON.stringify(keys.bodyArgs ?? []);
    }
  }
  if (extra.testId) data.testId = extra.testId;
  // FCM refuses data over 4 KB (INVALID_ARGUMENT): cut the body, then the subtitle, then the title.
  for (const key of ["body", "subtitle", "title"] as const) {
    if (data[key] === undefined) continue;
    shrinkTextToFit(() => jsonByteLength(data), FCM_DATA_MAX_BYTES, () => data[key]!, (value) => { data[key] = value; });
  }
  return { data, priority: envelope.priority === "high" ? "HIGH" : "NORMAL" };
}

export function fcmBackgroundMessage(push: MobileBackgroundPush): FcmMessage {
  const data: Record<string, string> = push.type === "sync"
    ? { type: "sync" }
    : {
      type: "retract",
      serverId: push.serverId,
      conversationId: push.conversationId,
      groupKey: push.groupKey,
      // Empty string: every notification of the group.
      throughSeq: push.throughSeq === null ? "" : String(push.throughSeq),
    };
  if (push.type === "sync" && push.serverId) data.serverId = push.serverId;
  if (push.badge !== undefined) data.badge = String(push.badge);
  if (push.serverBadge !== undefined) data.serverBadge = String(push.serverBadge);
  // NORMAL, retract included: FCM deprioritises an app whose HIGH messages
  // show nothing, and that would slow the real alerts. A retract may wait for
  // Doze's next window (slock_notification_retracts_total counts them).
  return { data, priority: "NORMAL" };
}

let fcmPushProvider: FcmPushProvider = defaultFcmPushProvider;

export const fcmTransport = {
  send(target: MobileRegistrationTarget, message: FcmMessage): Promise<ExternalSendResult> {
    return fcmPushProvider.send({
      registrationId: target.id,
      installationId: target.installationId,
      deviceToken: target.deviceToken,
      message,
    });
  },
  /** UNREGISTERED / SENDER_ID_MISMATCH / 404: revoke the registration. */
  isTerminalTargetError: isTerminalFcmTokenError,
  /** INVALID_ARGUMENT: drop without retrying or revoking. */
  isNonRetryable: isNonRetryableFcmError,
  isConfigured(): boolean {
    return fcmPushProvider.isConfigured?.() !== false;
  },
  /** Boot warm-up: the access token, so the first send skips the exchange. */
  async warm(): Promise<"warmed" | "not_configured"> {
    return (await fcmPushProvider.prefetchAccessToken?.()) ?? "not_configured";
  },
};

export function __setFcmPushProviderForTests(provider: FcmPushProvider) {
  fcmPushProvider = provider;
}

export function __resetFcmPushProviderForTests() {
  fcmPushProvider = defaultFcmPushProvider;
}
