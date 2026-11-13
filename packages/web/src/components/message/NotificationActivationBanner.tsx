import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Bell, Check } from "lucide-react";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import {
  ensurePushSubscriptionIfAllowed,
  getPushPermissionState,
  isPushSubscribed,
  recordWebPushPromptEvent,
  rememberedPushEndpoint,
} from "../../utils/pushNotifications";
import {
  buildPushSubscribeFailure,
  clearPushSubscribeFailure,
  pushSubscribeFailureDetail,
  readPushSubscribeFailure,
  rememberPushSubscribeFailure,
  shouldAutoRetryPushSubscribe,
} from "../../utils/pushSubscribeFailure";
import { enablePushAndRecord } from "../../utils/pushEnableRecording";
import Banner from "../ui/Banner";
import { Button, TextLink } from "@botiverse/raft-ui";
import type { MessageId } from "../../i18n/messages";
import { requestComposerFocus } from "./composerFocusRequest";

export const NOTIFICATION_ACTIVATION_DISMISSED_SESSION_KEY =
  "raft:notification-activation-banner-dismissed:v1";

const PROMPT_TRIGGER = "primary_composer_activation_banner";
const AUTO_RESOLVE_TRIGGER = "primary_composer_foreground_auto_resolve";

type Placement = "desktop" | "mobile";
type PermissionState = NotificationPermission | "unsupported";

export function isNotificationActivationComposerEligible({
  hasChannel,
  showComposer,
  readOnly,
  channelType,
  joined,
  archived,
  jointLocked,
  quotaReadOnly,
  selectMode,
}: {
  hasChannel: boolean;
  showComposer: boolean;
  readOnly: boolean;
  channelType: string | undefined;
  joined: boolean | undefined;
  archived: boolean;
  jointLocked: boolean;
  quotaReadOnly: boolean;
  selectMode: boolean;
}): boolean {
  return hasChannel
    && showComposer
    && !readOnly
    && channelType !== "thread"
    && !archived
    && !jointLocked
    && !quotaReadOnly
    && (channelType === "dm" || joined === true)
    && !selectMode;
}

function wasDismissedThisSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(NOTIFICATION_ACTIVATION_DISMISSED_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDismissalForSession(): void {
  try {
    window.sessionStorage.setItem(NOTIFICATION_ACTIVATION_DISMISSED_SESSION_KEY, "1");
  } catch {
    // Storage can be unavailable in hardened/private browsing contexts. The
    // mounted instance still dismisses; a later remount may show again.
  }
}

function activationErrorMessageId(
  result: "unavailable" | "error",
): MessageId {
  return result === "unavailable"
    ? "message.notificationActivation.errorUnavailable"
    : "message.notificationActivation.errorGeneric";
}

export default function NotificationActivationBanner({
  placement,
  composerChannelId,
}: {
  placement: Placement;
  /** The composer under the banner: when the banner goes, focus moves to
   *  its frame, the next element, never to the document. */
  composerChannelId: string;
}) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const [permission, setPermission] = useState<PermissionState>(() => getPushPermissionState());
  const openNotificationSettings = useCallback(() => {
    void recordWebPushPromptEvent({
      event: "web_push_prompt_settings_opened",
      trigger: PROMPT_TRIGGER,
      permissionBefore: permission,
      permissionAfter: permission,
    });
    nav.toSettings("notifications");
  }, [nav, permission]);
  const [dismissed, setDismissed] = useState(wasDismissedThisSession);
  const [confirmingDismissal, setConfirmingDismissal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorId, setErrorId] = useState<MessageId | null>(null);
  const reconcileInFlightRef = useRef(false);
  const promptShownRecordedRef = useRef(false);
  const confirmationRef = useRef<HTMLDivElement>(null);

  const reconcilePermission = useCallback(async () => {
    const nextPermission = getPushPermissionState();
    setPermission(nextPermission);
    if (nextPermission !== "granted") {
      // Permission moved away from granted: a later grant is a new episode.
      if (nextPermission !== "unsupported") clearPushSubscribeFailure();
      return;
    }
    if (reconcileInFlightRef.current) return;

    reconcileInFlightRef.current = true;
    try {
      if (!(await isPushSubscribed())) {
        // A re-subscribe that already failed here is not retried (or re-logged)
        // on every focus: only once permission, the endpoint or the app
        // version changed, the backoff passed, or the user pressed Enable.
        if (!shouldAutoRetryPushSubscribe({ permission: "granted", endpoint: rememberedPushEndpoint() })) return;
        // The automatic path: never re-subscribes a browser the user disabled
        // push in (design §8); only the Enable button below clears that.
        const result = await ensurePushSubscriptionIfAllowed();
        if (result === "opted_out") return;
        const failure = result === "unavailable" || result === "error" ? readPushSubscribeFailure() : null;
        void recordWebPushPromptEvent({
          event: result === "granted"
            ? "web_push_subscription_saved"
            : "web_push_subscription_failed",
          trigger: AUTO_RESOLVE_TRIGGER,
          result,
          permissionBefore: "granted",
          permissionAfter: getPushPermissionState(),
          ...(failure ? { detail: pushSubscribeFailureDetail(failure) } : {}),
        });
      }
    } catch (err) {
      const failure = buildPushSubscribeFailure({
        kind: "unexpected",
        error: err,
        permission: "granted",
        endpoint: rememberedPushEndpoint(),
      });
      rememberPushSubscribeFailure(failure);
      void recordWebPushPromptEvent({
        event: "web_push_subscription_failed",
        trigger: AUTO_RESOLVE_TRIGGER,
        result: "error",
        permissionBefore: "granted",
        permissionAfter: getPushPermissionState(),
        detail: pushSubscribeFailureDetail(failure),
      });
    } finally {
      setPermission(getPushPermissionState());
      reconcileInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    void reconcilePermission();
    const handleFocus = () => void reconcilePermission();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void reconcilePermission();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [reconcilePermission]);

  const visible = permission === "default" && !dismissed;
  useEffect(() => {
    if (!visible || promptShownRecordedRef.current) return;
    promptShownRecordedRef.current = true;
    void recordWebPushPromptEvent({
      event: "web_push_prompt_shown",
      trigger: PROMPT_TRIGGER,
      permissionBefore: permission,
      permissionAfter: permission,
    });
  }, [permission, visible]);

  const handleEnable = useCallback(async () => {
    setBusy(true);
    setErrorId(null);
    const result = await enablePushAndRecord(PROMPT_TRIGGER);
    if (result === "unavailable" || result === "error") setErrorId(activationErrorMessageId(result));
    setPermission(getPushPermissionState());
    setBusy(false);
  }, []);

  // Dismiss goes away under the pointer, so focus moves on to the composer
  // before the confirmation replaces the banner.
  const handleDismiss = useCallback(() => {
    void recordWebPushPromptEvent({
      event: "web_push_prompt_dismissed",
      trigger: PROMPT_TRIGGER,
      permissionBefore: permission,
      permissionAfter: permission,
    });
    rememberDismissalForSession();
    requestComposerFocus(composerChannelId, "user");
    setErrorId(null);
    setConfirmingDismissal(true);
  }, [composerChannelId, permission]);

  // The confirmation closes by itself; focus is left where it is unless it
  // was inside (on its Settings link), which would drop it to the document.
  // Its own timer, not the person: an async request, so it never takes focus
  // from a field or an open dialog.
  const handleConfirmationEnd = useCallback(() => {
    if (confirmationRef.current?.contains(document.activeElement)) {
      requestComposerFocus(composerChannelId, "async");
    }
    setDismissed(true);
  }, [composerChannelId]);

  if (!visible) return null;

  // Equal 8px open bands above and below the banner, on the composer stack's
  // own scale: the pinned top margin matches the column's 8px gap that
  // already separates the banner from the form. Measuring the bottom spacing
  // through the form's border and pt-3 padding hid the real gap behind the
  // composer line and made the two sides read asymmetric in every theme.
  // Its sides are the composer frame's: ChatPanel's notice stack keeps the
  // composer's edge (COMPOSER_EDGE_CLASS), so no side margin here.
  const placementClassName = placement === "desktop" ? "mb-0 mt-2" : "";
  if (confirmingDismissal) {
    return (
      <Banner
        ref={confirmationRef}
        intent="info"
        density="sm"
        icon={<Check size={16} className="mt-0.5 shrink-0" />}
        className={`relative overflow-hidden pb-3 ${placementClassName}`}
        aria-live="polite"
        data-testid="notification-activation-dismiss-confirm"
      >
        <span className="font-bold">{formatMessage({ id: "message.notificationActivation.hiddenForNow" })} </span>
        <TextLink
          onClick={openNotificationSettings}
          variant="strong"
        >
          {formatMessage({ id: "message.notificationActivation.settingsNotifications" })}
        </TextLink>
        <div
          aria-hidden="true"
          className="notification-activation-progress absolute inset-x-0 bottom-0 h-1 bg-foreground"
        />
        {/* Functional clock: this hidden animation's end event is the only
            three-second auto-dismiss path. Do not remove it as decoration. */}
        <span
          aria-hidden="true"
          className="notification-activation-dismiss-timer pointer-events-none absolute size-px opacity-0"
          onAnimationEnd={handleConfirmationEnd}
        />
      </Banner>
    );
  }

  const isMobile = placement === "mobile";
  // A banner with a button closes with a ghost Dismiss just before it, never
  // a × (Raft Design System › Banner).
  const actions = (
    <>
      <Button
        type="button"
        size="md"
        variant="ghost"
        onClick={handleDismiss}
      >
        {formatMessage({ id: "message.notificationActivation.dismiss" })}
      </Button>
      <Button
        type="button"
        size="md"
        variant="outline"
        disabled={busy}
        onClick={handleEnable}
      >
        {formatMessage({ id: busy ? "message.notificationActivation.enabling" : "message.notificationActivation.enable" })}
      </Button>
    </>
  );

  return (
    <Banner
      intent="info"
      density="sm"
      icon={<Bell size={16} className="mt-0.5 shrink-0" />}
      title={isMobile
        ? formatMessage({ id: "message.notificationActivation.mobileTitle" })
        : formatMessage({ id: "message.notificationActivation.desktopTitle" })}
      actions={actions}
      className={`[&>div:last-child]:self-center ${placementClassName}`}
      data-testid={`notification-activation-banner-${placement}`}
    >
      {isMobile
        ? formatMessage({ id: "message.notificationActivation.mobileBody" })
        : formatMessage({ id: "message.notificationActivation.desktopBody" })}
      {errorId ? (
        // Recoverable (try again, or in Settings): warning, not danger.
        <div role="alert" className="mt-1 font-semibold text-warning-strong">
          {formatMessage({ id: errorId })}
        </div>
      ) : null}
    </Banner>
  );
}
