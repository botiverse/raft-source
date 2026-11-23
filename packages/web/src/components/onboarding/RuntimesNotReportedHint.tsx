import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import { Button, TextLink } from "@botiverse/raft-ui";
import Banner from "../ui/Banner";

/**
 * How long a Computer may be online without listing its runtimes before Screen
 * B says so. The intent of the old setup-gate timeout (389c65077f, 15 s): only
 * a long-lived "not reported yet" is actionable; a short one is the normal gap
 * between online and the runtime list.
 */
const RUNTIMES_NOT_REPORTED_HINT_MS = 15_000;

/**
 * Screen B, Computer online, runtimes never reported: after a while, say so and
 * offer a way on while online (Check Again; Start Over where the server allows
 * a reset). Before this the step sat on "Detecting runtime…" with no hint, and
 * Start Over showed only for an offline Computer.
 */
export function RuntimesNotReportedHint({
  waiting,
  computerName,
  onCheckAgain,
  onStartOver,
}: {
  /** Online, and the server has no runtime verdict yet. */
  waiting: boolean;
  computerName: string;
  onCheckAgain?: () => void;
  onStartOver?: () => void;
}) {
  const { formatMessage } = useIntl();
  // Each wait (and each Check Again) gets its own timer; the hint shows when it ends.
  const [attempt, setAttempt] = useState(0);
  const [timedOutAttempt, setTimedOutAttempt] = useState<number | null>(null);
  useEffect(() => {
    if (!waiting) return;
    const timer = setClockTimeout(() => setTimedOutAttempt(attempt), RUNTIMES_NOT_REPORTED_HINT_MS);
    return () => clearClockTimeout(timer);
  }, [attempt, waiting]);
  const checkAgain = useCallback(() => {
    setAttempt((value) => value + 1);
    onCheckAgain?.();
  }, [onCheckAgain]);
  if (!waiting || timedOutAttempt !== attempt) return null;
  return (
    <Banner
      intent="warning"
      density="sm"
      withIcon
      data-testid="onboarding-runtimes-not-reported"
      actions={onCheckAgain ? (
        <Button type="button" size="md" variant="default" onClick={checkAgain} data-testid="onboarding-runtimes-check-again">
          {formatMessage({ id: "onboarding.computerRuntime.runtimesNotReportedCheckAgain" })}
        </Button>
      ) : undefined}
    >
      <p>{formatMessage({ id: "onboarding.computerRuntime.runtimesNotReported" }, { computer: computerName })}</p>
      {onStartOver ? (
        <p>
          {formatMessage(
            { id: "onboarding.computerRuntime.runtimesNotReportedStartOver" },
            {
              link: (chunks: ReactNode) => (
                <TextLink
                  key="start-over"
                  variant="strong"
                  nativeButton={false}
                  onClick={onStartOver}
                  data-testid="onboarding-runtimes-start-over"
                >
                  {chunks}
                </TextLink>
              ),
            },
          )}
        </p>
      ) : null}
    </Banner>
  );
}
