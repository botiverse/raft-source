import { useEffect, useState } from "react";
import type { IntlShape } from "react-intl";
import { clearClockInterval, currentTimeMs, setClockInterval } from "@botiverse/raft-shared";

/** The countdown under the undo toast's title, the seconds in Space Mono; not announced each second. */
export function LinkCardUndoCountdown({ deadline, format }: { deadline: number; format: IntlShape["formatMessage"] }) {
  const [now, setNow] = useState(currentTimeMs);
  useEffect(() => {
    const interval = setClockInterval(() => setNow(currentTimeMs()), 250);
    return () => clearClockInterval(interval);
  }, []);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return (
    <span aria-live="off" data-link-card-undo-countdown={seconds}>
      {format({ id: "message.appLink.action.undo.countdown" }, { seconds: <span key="seconds" className="font-mono">{seconds}</span> })}
    </span>
  );
}
