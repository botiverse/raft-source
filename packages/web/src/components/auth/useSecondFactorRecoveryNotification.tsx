import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useIntl } from "react-intl";

import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { NotificationEntry } from "../layout/useSystemNotifications";
import { showToast } from "../toastBridge";
import { cancelSecondFactorRecovery, fetchSecondFactorRecovery } from "./secondFactorRecovery";
import type { SecondFactorRecovery } from "./secondFactorRecovery";

/**
 * "Reset requested" in every signed-in session (#triage:#135, design v2
 * set-reset-pending / set-reset-cancelled; server: every session shows the
 * request with Cancel while it is there), as the notification center's
 * first entry (#proj-raft-ui:7b942888, option B: an account-wide state is a
 * notification, not a banner over the page).
 *
 * Read on mount and whenever the window comes back (focus, visible): a
 * request started, cancelled, finished elsewhere or auto-cancelled by a
 * right second step shows up the next time the person looks. Waiting: when
 * a sign-in can finish it. Ready: the next sign-in can. Either way Cancel
 * Reset ends it in one step, with no step-up and no confirm (cancelling is
 * the safe direction, design A10). The entry can't be dismissed: it goes only
 * when the request does (cancelled, finished, auto-cancelled, lapsed), and
 * while it is listed the Bell wears the security marker (`security`).
 */
export function useSecondFactorRecoveryNotification(): NotificationEntry | null {
  const { formatMessage } = useIntl();
  const { formatMediumDateTime } = useTimeFormatter();
  const [recovery, setRecovery] = useState<SecondFactorRecovery | null>(null);
  const [busy, setBusy] = useState(false);
  // Only the latest read applies (a cancel also outdates one in flight).
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const next = await fetchSecondFactorRecovery();
      if (mine === generation.current) setRecovery(next);
    } catch {
      // Not reachable: keep what is shown.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onReturn = () => {
      if (document.visibilityState !== "hidden") void refresh();
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [refresh]);

  const handleCancel = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    generation.current += 1;
    try {
      await cancelSecondFactorRecovery();
      setRecovery(null);
      showToast({ title: formatMessage({ id: "auth.recovery.cancelled" }), type: "success" });
    } catch {
      showToast({ title: formatMessage({ id: "auth.recovery.cancelFailed" }), type: "error" });
    } finally {
      setBusy(false);
    }
  }, [busy, formatMessage]);

  return useMemo<NotificationEntry | null>(() => {
    if (!recovery) return null;
    const ready = recovery.status === "ready";
    const body = [
      ready
        ? formatMessage({ id: "auth.recovery.noticeReady" }, { time: formatMediumDateTime(recovery.expiresAt) })
        : formatMessage({ id: "auth.recovery.noticeWaiting" }, { time: formatMediumDateTime(recovery.eligibleAt) }),
      recovery.firstFactorRequired === "set_password" ? formatMessage({ id: "auth.recovery.noticeSetPassword" }) : null,
    ].filter(Boolean).join(" ");
    return {
      id: "second-factor-recovery",
      kind: "warning",
      icon: <ShieldAlert size={16} className="text-foreground" />,
      security: true,
      title: formatMessage({ id: ready ? "auth.recovery.noticeReadyTitle" : "auth.recovery.noticeWaitingTitle" }),
      body,
      // No dismissalKey and no Dismiss: it stays until the request is gone.
      action: {
        label: formatMessage({ id: "auth.recovery.cancelReset" }),
        onClick: () => void handleCancel(),
        disabled: busy,
      },
    };
  }, [busy, formatMediumDateTime, formatMessage, handleCancel, recovery]);
}
