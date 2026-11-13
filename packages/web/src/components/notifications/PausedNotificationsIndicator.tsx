// Top bar: a small moon while notifications are paused (design §4.3, item 5);
// a click resumes them. Quiet hours alone show nothing here: they are a
// schedule the person set, not a temporary state to undo.

import { useCallback, useEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Moon } from "lucide-react";
import { Button, toast } from "@botiverse/raft-ui";
import { useNotificationSettingsStore } from "../../store/notificationSettingsStore";
import { isPausedNow } from "../../notifications/pause";
import Tooltip from "../ui/Tooltip";

/** Re-renders when the pause ends (a timer at pausedUntil), so the moon leaves on time. */
export function usePausedUntil(): string | null {
  const pausedUntil = useNotificationSettingsStore((s) => s.account?.pausedUntil ?? null);
  const [, setTick] = useState(0);
  const paused = isPausedNow(pausedUntil, Date.now());
  useEffect(() => {
    if (!pausedUntil || !paused) return;
    const wait = Math.min(Date.parse(pausedUntil) - Date.now() + 50, 2_147_000_000);
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, wait));
    return () => clearTimeout(timer);
  }, [pausedUntil, paused]);
  return paused ? pausedUntil : null;
}

export function PausedNotificationsIndicator() {
  const { formatMessage, formatDate } = useIntl();
  const pausedUntil = usePausedUntil();
  const [busy, setBusy] = useState(false);
  const resume = useCallback(() => {
    setBusy(true);
    void useNotificationSettingsStore.getState().patchAccount({ pausedUntil: null }).then((result) => {
      if (result.kind === "error") toast.error(formatMessage({ id: "notifications.pause.resumeFailed" }));
    }).finally(() => setBusy(false));
  }, [formatMessage]);
  if (!pausedUntil) return null;
  const until = formatDate(new Date(pausedUntil), { weekday: "short", hour: "numeric", minute: "2-digit" });
  const label = formatMessage({ id: "notifications.pause.indicator" }, { until });
  return (
    <Tooltip content={label}>
      <Button
        variant="on-frame"
        size="icon-md"
        aria-label={label}
        disabled={busy}
        onClick={resume}
        data-testid="paused-notifications-indicator"
      >
        <Moon aria-hidden />
      </Button>
    </Tooltip>
  );
}
