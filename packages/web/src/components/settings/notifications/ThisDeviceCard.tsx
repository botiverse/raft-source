// Settings › Notifications › This device (design §4.3 item 1): what THIS
// runtime can do. A browser: Web Push status, Enable / Disable and a test.
// Raft Desktop: the system owns the switch, so a note, a test through the real
// server path, and on Windows / Linux "keep running in the background".

import { useCallback, useEffect, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { Bell } from "lucide-react";
import { Badge, Button, ListRow, ListRowBody, ListRowDescription, ListRowGroup, ListRowTitle, Switch } from "@botiverse/raft-ui";
import type { MessageId } from "../../../i18n/messages";
import { resolveNotificationChannel } from "../../../utils/notificationChannel";
import type { NotificationChannel, NotificationUnsupportedReason } from "../../../utils/notificationChannel";
import {
  disablePushNotifications,
  getPushPermissionState,
  isPushServerConfigured,
  isPushSubscribed,
  isWebPushOptedOut,
  recordWebPushPromptEvent,
  runWebTestNotification,
} from "../../../utils/pushNotifications";
import { detectBrowserFamily, isBrowserPushRegistrationFailure, readPushSubscribeFailure } from "../../../utils/pushSubscribeFailure";
import { enablePushAndRecord, testFailureReasonCode } from "../../../utils/pushEnableRecording";
import type { PushSubscribeFailure } from "../../../utils/pushSubscribeFailure";
import { isDesktopNativeNotificationsAvailable, runDesktopTestNotification } from "../../../utils/desktopNativeNotifications";
import { getDesktopBridge } from "../../../utils/desktopBridge";
import Banner from "../../ui/Banner";
import SectionHeader from "../../ui/SectionHeader";
import { TestNotificationButton } from "./TestNotificationButton";

const UNSUPPORTED_REASON_MESSAGE: Record<NotificationUnsupportedReason, MessageId> = {
  "no-window": "settings.notifications.unsupportedHint",
  "no-notification-api": "settings.notifications.unsupportedReason.noNotificationApi",
  "insecure-context": "settings.notifications.unsupportedReason.insecureContext",
  "no-service-worker": "settings.notifications.unsupportedReason.noServiceWorker",
  "no-push-manager": "settings.notifications.unsupportedReason.noPushManager",
};

export function ThisDeviceCard() {
  // A property of the runtime, decided once and synchronously (task #93).
  const channel = useMemo(() => resolveNotificationChannel(), []);
  const { formatMessage } = useIntl();
  return (
    <div id="push-notifications">
      <SectionHeader className="mb-3" icon={<Bell size={16} />} label={formatMessage({ id: "settings.notifications.device.sectionLabel" })} />
      {channel.kind === "desktop-native" ? <DesktopDeviceCard /> : <BrowserDeviceCard channel={channel} />}
    </div>
  );
}

// Settings' half of the web push funnel (cindyz, #proj-analytics:fbb8f05c): the
// same web_push_prompt_events as the composer banner, told apart by `trigger`.
const SETTINGS_TRIGGER = "settings_this_device";

function BrowserDeviceCard({ channel }: { channel: Exclude<NotificationChannel, { kind: "desktop-native" }> }) {
  const { formatMessage } = useIntl();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("unsupported");
  const [serverConfigured, setServerConfigured] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [subscribeFailure, setSubscribeFailure] = useState<PushSubscribeFailure | null>(null);

  const refreshState = useCallback(async () => {
    setPermission(getPushPermissionState());
    // Every probe settles: a throw must never leave the card on "Checking…" (task #93).
    let configured = false;
    let currentSubscribed = false;
    try {
      [configured, currentSubscribed] = await Promise.all([isPushServerConfigured(), isPushSubscribed()]);
    } catch (err) {
      console.error("[Push] Failed to refresh notification state:", err);
    }
    setServerConfigured(configured);
    setSubscribed(currentSubscribed);
    setSubscribeFailure(readPushSubscribeFailure());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refreshState();
    // Permission can be revoked in the browser while this page is open (§9.2).
    const onVisible = () => { if (document.visibilityState === "visible") void refreshState(); };
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refreshState]);

  const handleEnable = useCallback(async () => {
    setBusy(true);
    setError("");
    const result = await enablePushAndRecord(SETTINGS_TRIGGER);
    if (result === "unavailable") setError(formatMessage({ id: "settings.notifications.errUnavailable" }));
    else if (result === "denied") setError(formatMessage({ id: "settings.notifications.errDenied" }));
    else if (result === "error") setError(formatMessage({ id: "settings.notifications.errEnableFailed" }));
    await refreshState();
    setBusy(false);
  }, [formatMessage, refreshState]);

  const handleDisable = useCallback(async () => {
    setBusy(true);
    setError("");
    const permissionBefore = getPushPermissionState();
    const disabled = await disablePushNotifications();
    void recordWebPushPromptEvent({
      event: "web_push_disabled",
      trigger: SETTINGS_TRIGGER,
      result: disabled ? "ok" : "error",
      permissionBefore,
      permissionAfter: getPushPermissionState(),
    });
    if (!disabled) setError(formatMessage({ id: "settings.notifications.errDisableFailed" }));
    await refreshState();
    setBusy(false);
  }, [formatMessage, refreshState]);

  const runTest = useCallback(async () => {
    const outcome = await runWebTestNotification();
    void recordWebPushPromptEvent({
      event: "web_push_test_result",
      trigger: SETTINGS_TRIGGER,
      result: outcome.state,
      permissionBefore: getPushPermissionState(),
      permissionAfter: getPushPermissionState(),
      ...(outcome.state === "failed" ? { detail: `reason=${testFailureReasonCode(outcome.reason)}` } : {}),
    });
    return outcome;
  }, []);

  const unsupported = permission === "unsupported";
  // Granted, but the browser (or its push service) refused to subscribe:
  // Brave with Google push services off, some Chromium forks, Firefox with
  // push disabled. Nothing reaches this device until that changes.
  const registrationFailed = !loading
    && serverConfigured
    && permission === "granted"
    && !subscribed
    && !isWebPushOptedOut()
    && isBrowserPushRegistrationFailure(subscribeFailure);
  const isBrave = registrationFailed && (subscribeFailure?.browser === "brave" || detectBrowserFamily() === "brave");
  const statusId: MessageId = loading
    ? "settings.notifications.statusChecking"
    : unsupported
      ? "settings.notifications.statusUnsupported"
      : !serverConfigured
        ? "settings.notifications.statusUnavailable"
        : permission === "denied"
          ? "settings.notifications.statusDenied"
          : subscribed
            ? "settings.notifications.statusEnabled"
            : registrationFailed
              ? "settings.notifications.statusUnavailable"
              : permission === "granted" && !isWebPushOptedOut()
                ? "settings.notifications.statusReady"
                : "settings.notifications.statusDisabled";
  const statusTone = loading ? "muted" : statusId === "settings.notifications.statusEnabled" ? "success" : permission === "denied" || registrationFailed ? "warning" : "muted";

  return (
    // A settings row like every other setting (cindyz, #proj-raft-ui:#220): the status
    // Badge follows the title; hints, a failure and the actions follow the row's text.
    <ListRowGroup data-testid="browser-notifications-card">
      <ListRow variant="plain" interactive={false}>
      <ListRowBody className="stack-y-2">
        {/* The title and its status; no sentence on how web push works (HelperText step 1). */}
        <div className="flex flex-wrap items-center gap-2">
          <ListRowTitle>{formatMessage({ id: "settings.notifications.device.browserTitle" })}</ListRowTitle>
          <Badge appearance="soft" variant={statusTone} data-testid="browser-notifications-status">{formatMessage({ id: statusId })}</Badge>
        </div>

      {unsupported && (
        <div className="text-footnote text-foreground-muted">
          {formatMessage({ id: channel.kind === "unsupported" ? UNSUPPORTED_REASON_MESSAGE[channel.reason] : "settings.notifications.unsupportedHint" })}
        </div>
      )}
      {!unsupported && !serverConfigured && !loading && (
        <div className="text-footnote text-foreground-muted">{formatMessage({ id: "settings.notifications.notConfiguredHint" })}</div>
      )}
      {permission === "denied" && (
        <div className="text-footnote text-foreground-muted">{formatMessage({ id: "settings.notifications.deniedHint" })}</div>
      )}
      {registrationFailed ? (
        <Banner
          intent="warning"
          density="sm"
          withIcon
          // Part of the card, read before acting; announced only right after Enable failed.
          live={Boolean(error)}
          title={formatMessage({ id: "settings.notifications.pushRegistrationFailedTitle" })}
          data-testid="browser-notifications-registration-failed"
        >
          {formatMessage({ id: "settings.notifications.pushRegistrationFailed" })}
          {isBrave ? <> {formatMessage({ id: "settings.notifications.pushRegistrationFailedBraveHint" })}</> : null}
        </Banner>
      ) : error ? <Banner intent="warning" density="sm">{error}</Banner> : null}

      <div className="flex flex-wrap gap-2">
        {subscribed ? (
          <Button variant="outline" size="md" type="button" onClick={handleDisable} disabled={busy} data-testid="browser-notifications-disable">
            {busy ? formatMessage({ id: "settings.notifications.disabling" }) : formatMessage({ id: "settings.notifications.disable" })}
          </Button>
        ) : (
          <Button variant="outline" size="md" type="button" onClick={handleEnable} disabled={busy || unsupported || !serverConfigured} data-testid="browser-notifications-enable">
            {busy ? formatMessage({ id: "settings.notifications.enabling" }) : formatMessage({ id: "settings.notifications.enable" })}
          </Button>
        )}
      </div>
      {subscribed && (
        <TestNotificationButton run={runTest} disabled={busy || unsupported || !serverConfigured} notShownHintId="settings.notifications.test.notShownBrowser" />
      )}
      </ListRowBody>
      </ListRow>
    </ListRowGroup>
  );
}

/** Windows / Linux shells from the unified notifications on expose runInBackground. */
/**
 * Windows / Linux shells from the unified notifications on expose
 * runInBackground. Shown only once `available()` says it can work (a Linux
 * desktop without a tray host cannot); a shell without `available` counts as
 * available. Nothing shows while that is pending, so the toggle never flashes.
 * `set` resolves the stored value: a `true` the shell refused shows off.
 */
function useRunInBackground() {
  const bridge = getDesktopBridge();
  const control = bridge?.runInBackground;
  const [state, setState] = useState<{ available: boolean | null; value: boolean | null }>({ available: null, value: null });
  useEffect(() => {
    if (!control) return;
    let live = true;
    const patch = (next: Partial<typeof state>) => { if (live) setState((current) => ({ ...current, ...next })); };
    const probe = typeof control.available === "function" ? control.available() : Promise.resolve(true);
    void probe.then((ok) => patch({ available: ok === true }), () => patch({ available: false }));
    void control.get().then((enabled) => patch({ value: enabled }), () => {});
    return () => { live = false; };
  }, [control]);
  const update = useCallback((next: boolean) => {
    if (!control) return;
    setState((current) => ({ ...current, value: next }));
    void control.set(next).then(
      (stored) => setState((current) => ({ ...current, value: stored })),
      () => setState((current) => ({ ...current, value: !next })),
    );
  }, [control]);
  const { available, value } = state;
  return control && available === true ? { value, update } : null;
}

function DesktopDeviceCard() {
  const { formatMessage } = useIntl();
  const available = isDesktopNativeNotificationsAvailable();
  const bridge = getDesktopBridge();
  const isMac = bridge?.platform === "darwin";
  // macOS / Windows shells that can open the OS notification settings (absent on Linux and older shells).
  const canOpenSystemSettings = typeof bridge?.openNotificationSettings === "function";
  const openSystemSettings = useCallback(() => bridge?.openNotificationSettings?.(), [bridge]);
  const runInBackground = useRunInBackground();
  const runTest = useCallback(() => runDesktopTestNotification(), []);
  const toggleBackground = useCallback((checked: boolean) => runInBackground?.update(checked), [runInBackground]);

  return (
    <ListRowGroup data-testid="desktop-notifications-card">
      <ListRow variant="plain" interactive={false}>
      <ListRowBody className="stack-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <ListRowTitle>{formatMessage({ id: "settings.notifications.desktop.title" })}</ListRowTitle>
          <Badge appearance="soft" variant={available ? "default" : "muted"}>
            {formatMessage({ id: available ? "settings.notifications.desktop.statusSystemManaged" : "settings.notifications.desktop.statusUnavailable" })}
          </Badge>
        </div>
      <div className="text-footnote text-foreground-muted" data-testid="desktop-notifications-system-hint">
        {formatMessage({
          id: !available
            ? "settings.notifications.desktop.unavailableHint"
            : isMac ? "settings.notifications.desktop.systemHint" : "settings.notifications.desktop.systemHintOther",
        })}
      </div>
      {canOpenSystemSettings && (
        <div className="flex gap-2">
          <Button variant="outline" size="md" type="button" onClick={openSystemSettings} data-testid="desktop-open-system-notification-settings">
            {formatMessage({ id: "settings.notifications.desktop.openSystemSettings" })}
          </Button>
        </div>
      )}
      <TestNotificationButton run={runTest} disabled={!available} notShownHintId="settings.notifications.test.notShownDesktop" />
      </ListRowBody>
      </ListRow>
      {runInBackground && (
          <ListRow variant="plain" interactive={false}>
            <ListRowBody>
              <ListRowTitle id="desktop-run-in-background-label">{formatMessage({ id: "settings.notifications.desktop.runInBackgroundTitle" })}</ListRowTitle>
              {/* Closing the window no longer quits once this is on: the way out (recovery, Kirby). */}
              <ListRowDescription id="desktop-run-in-background-description" wrap>{formatMessage({ id: "settings.notifications.desktop.runInBackgroundDescription" })}</ListRowDescription>
            </ListRowBody>
            <Switch
              checked={runInBackground.value === true}
              disabled={runInBackground.value === null}
              onCheckedChange={toggleBackground}
              aria-labelledby="desktop-run-in-background-label"
              aria-describedby="desktop-run-in-background-description"
              data-testid="desktop-run-in-background-switch"
            />
          </ListRow>
      )}
    </ListRowGroup>
  );
}
