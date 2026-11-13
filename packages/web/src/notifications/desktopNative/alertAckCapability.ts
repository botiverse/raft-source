// Whether this page acks the server's desktop alerts (presence `ackAlerts`,
// contract §1.3): only while the desktop alert consumer actually runs
// (desktopNotificationConsumer.ts). The presence report reads it and
// re-reports when it changes, so the server never waits for acks nobody sends.

let running = 0;
const listeners = new Set<() => void>();

/** The desktop alert consumer started; returns its stop. */
export function markDesktopAlertConsumerRunning(): () => void {
  running += 1;
  for (const listener of [...listeners]) listener();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    running -= 1;
    for (const listener of [...listeners]) listener();
  };
}

export function desktopAlertConsumerRunning(): boolean {
  return running > 0;
}

export function onDesktopAlertConsumerChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
