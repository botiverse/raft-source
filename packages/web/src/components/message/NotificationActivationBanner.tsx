import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { Bell, Check, X } from "lucide-react";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import {
  enablePushNotifications,
  getPushPermissionState,
  isPushSubscribed,
  recordWebPushPromptEvent,
} from "../../utils/pushNotifications";
import Banner from "../ui/Banner";
import Button from "../ui/Button";
import type { MessageId } from "../../i18n/messages";

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
}: {
  placement: Placement;
}) {
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const [permission, setPermission] = useState<PermissionState>(() => getPushPermissionState());
  const [dismissed, setDismissed] = useState(wasDismissedThisSession);
  const [confirmingDismissal, setConfirmingDismissal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorId, setErrorId] = useState<MessageId | null>(null);
  const reconcileInFlightRef = useRef(false);
  const promptShownRecordedRef = useRef(false);

  const reconcilePermission = useCallback(async () => {
    const nextPermission = getPushPermissionState();
    setPermission(nextPermission);
    if (nextPermission !== "granted" || reconcileInFlightRef.current) return;

    reconcileInFlightRef.current = true;
    try {
      if (!(await isPushSubscribed())) {
        const result = await enablePushNotifications();
        void recordWebPushPromptEvent({
          event: result === "granted"
            ? "web_push_subscription_saved"
            : "web_push_subscription_failed",
          trigger: AUTO_RESOLVE_TRIGGER,
          result,
          permissionBefore: "granted",
          permissionAfter: getPushPermissionState(),
        });
      }
    } catch {
      void recordWebPushPromptEvent({
        event: "web_push_subscription_failed",
        trigger: AUTO_RESOLVE_TRIGGER,
        result: "error",
        permissionBefore: "granted",
        permissionAfter: getPushPermissionState(),
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

  const handleEnable = async () => {
    const permissionBefore = getPushPermissionState();
    setBusy(true);
    setErrorId(null);
    let result: Awaited<ReturnType<typeof enablePushNotifications>>;
    try {
      result = await enablePushNotifications();
    } catch {
      result = "error";
    }
    const permissionAfter = getPushPermissionState();

    void recordWebPushPromptEvent({
      event: "web_push_native_result",
      trigger: PROMPT_TRIGGER,
      result,
      permissionBefore,
      permissionAfter,
    });
    if (result === "granted") {
      void recordWebPushPromptEvent({
        event: "web_push_subscription_saved",
        trigger: PROMPT_TRIGGER,
        result,
        permissionBefore,
        permissionAfter,
      });
    } else if (result === "unavailable" || result === "error") {
      void recordWebPushPromptEvent({
        event: "web_push_subscription_failed",
        trigger: PROMPT_TRIGGER,
        result,
        permissionBefore,
        permissionAfter,
      });
      setErrorId(activationErrorMessageId(result));
    }

    setPermission(permissionAfter);
    setBusy(false);
  };

  const handleDismiss = () => {
    rememberDismissalForSession();
    setErrorId(null);
    setConfirmingDismissal(true);
  };

  if (!visible) return null;

  const placementClassName = placement === "desktop" ? "mx-3 mb-3" : "";
  if (confirmingDismissal) {
    return (
      <Banner
        intent="info"
        density="sm"
        icon={<Check size={16} className="mt-0.5 shrink-0" />}
        className={`relative overflow-hidden pb-3 ${placementClassName}`}
        aria-live="polite"
        data-testid="notification-activation-dismiss-confirm"
      >
        <span className="font-bold">{formatMessage({ id: "message.notificationActivation.hiddenForNow" })} </span>
        <button
          type="button"
          onClick={() => nav.toSettings("notifications")}
          className="font-bold underline"
        >
          {formatMessage({ id: "message.notificationActivation.settingsNotifications" })}
        </button>
        <div
          aria-hidden="true"
          className="notification-activation-progress absolute inset-x-0 bottom-0 h-1 bg-brutal-black"
        />
        {/* Functional clock: this hidden animation's end event is the only
            three-second auto-dismiss path. Do not remove it as decoration. */}
        <span
          aria-hidden="true"
          className="notification-activation-dismiss-timer pointer-events-none absolute size-px opacity-0"
          onAnimationEnd={() => setDismissed(true)}
        />
      </Banner>
    );
  }

  const isMobile = placement === "mobile";
  const actions = isMobile ? (
    <>
      <button
        type="button"
        onClick={handleDismiss}
        className="order-3 inline-flex size-7 shrink-0 items-center justify-center"
        aria-label={formatMessage({ id: "message.notificationActivation.hideReminderAria" })}
      >
        <X size={16} />
      </button>
      <Button
        size="sm"
        tone="pink"
        className="order-4 basis-full"
        disabled={busy}
        onClick={() => void handleEnable()}
      >
        {formatMessage({ id: busy ? "message.notificationActivation.enabling" : "message.notificationActivation.enable" })}
      </Button>
    </>
  ) : (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        tone="pink"
        disabled={busy}
        onClick={() => void handleEnable()}
      >
        {formatMessage({ id: busy ? "message.notificationActivation.enabling" : "message.notificationActivation.enable" })}
      </Button>
      <button
        type="button"
        onClick={handleDismiss}
        className="inline-flex size-7 shrink-0 items-center justify-center"
        aria-label={formatMessage({ id: "message.notificationActivation.hideReminderAria" })}
      >
        <X size={16} />
      </button>
    </div>
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
      className={`${isMobile
        ? "flex-wrap [&>div:last-child]:contents"
        : "[&>div:last-child]:self-center"} ${placementClassName}`}
      data-testid={`notification-activation-banner-${placement}`}
    >
      {isMobile
        ? formatMessage({ id: "message.notificationActivation.mobileBody" })
        : formatMessage({ id: "message.notificationActivation.desktopBody" })}
      {errorId ? (
        <div role="alert" className="mt-1 font-bold text-brutal-red">
          {formatMessage({ id: errorId })}
        </div>
      ) : null}
    </Banner>
  );
}
