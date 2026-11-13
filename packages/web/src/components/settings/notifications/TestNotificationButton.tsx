// "Send Test Notification" with the server's three results (contract §6):
// shown, sent but not shown (check the system / browser settings), or failed.

import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Button } from "@botiverse/raft-ui";
import type { TestNotificationOutcome } from "../../../notifications/notificationApi";
import Banner from "../../ui/Banner";

export function TestNotificationButton({
  run,
  disabled = false,
  notShownHintId,
}: {
  run: () => Promise<TestNotificationOutcome>;
  disabled?: boolean;
  /** What to check when it was sent but not shown (browser vs system settings). */
  notShownHintId: "settings.notifications.test.notShownBrowser" | "settings.notifications.test.notShownDesktop";
}) {
  const { formatMessage } = useIntl();
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<TestNotificationOutcome | null>(null);

  const handleClick = useCallback(() => {
    setRunning(true);
    setOutcome(null);
    void run()
      .catch((): TestNotificationOutcome => ({ state: "failed", reason: "error" }))
      .then((result) => setOutcome(result))
      .finally(() => setRunning(false));
  }, [run]);

  return (
    <div className="stack-y-3">
      {outcome?.state === "shown" && (
        <Banner intent="success" density="sm" role="status" data-testid="test-notification-shown">
          {formatMessage({ id: "settings.notifications.test.shown" })}
        </Banner>
      )}
      {outcome?.state === "not_shown" && (
        <Banner intent="warning" density="sm" role="status" data-testid="test-notification-not-shown">
          {formatMessage({ id: notShownHintId })}
        </Banner>
      )}
      {outcome?.state === "unconfirmed" && (
        <Banner intent="info" density="sm" role="status" data-testid="test-notification-unconfirmed">
          {formatMessage({ id: "settings.notifications.test.unconfirmed" })}
        </Banner>
      )}
      {outcome?.state === "failed" && (
        <Banner intent="warning" density="sm" role="status" data-testid="test-notification-failed">
          {formatMessage({ id: "settings.notifications.test.failed" }, { reason: outcome.reason })}
        </Banner>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="md"
          type="button"
          onClick={handleClick}
          disabled={disabled || running}
          data-testid="send-test-notification"
        >
          {running
            ? formatMessage({ id: "settings.notifications.test.waiting" })
            : formatMessage({ id: "settings.notifications.test.send" })}
        </Button>
      </div>
    </div>
  );
}
