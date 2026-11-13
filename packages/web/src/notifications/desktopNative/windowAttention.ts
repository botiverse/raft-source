// Whether the user is in front of the Raft Desktop window, from the shell's
// window-activity facts (raftDesktop.getWindowActivity / onWindowActivity).
//
// Subscribe first; an older async initial snapshot must not overwrite a later
// hide/focus event. `onChange` hears only real native states (never the
// "unknown" default), so a consumer that reports attention outward cannot
// report a guess. `away` (idle or screen locked) and the raw state (its
// system-wide last-input time and screen lock) are passed along for the
// presence report (notifications/presenceReport.ts), which reports them
// whatever the window's focus.

import { isDesktopWindowAttended } from "@botiverse/raft-shared";
import type { DesktopWindowActivity } from "@botiverse/raft-shared";

export interface WindowActivityBridge {
  getWindowActivity?: () => Promise<DesktopWindowActivity | null>;
  onWindowActivity?: (handler: (state: DesktopWindowActivity) => void) => () => void;
}

export interface WindowAttention {
  isAttended(): boolean;
  dispose(): void;
}

export function observeWindowAttention(
  bridge: WindowActivityBridge,
  onChange?: (attended: boolean, away: boolean, state: DesktopWindowActivity) => void,
): WindowAttention {
  let disposed = false;
  let revision = -1;
  let attended = true; // unknown: avoid surprising notifications before the snapshot
  const accept = (state: DesktopWindowActivity | null) => {
    if (disposed || !state || state.revision < revision) return;
    revision = state.revision;
    attended = isDesktopWindowAttended(state);
    onChange?.(attended, state.away === true, state);
  };
  const unsubscribe = bridge.onWindowActivity?.(accept);
  void bridge.getWindowActivity?.().then(accept).catch(() => { /* wait for the next native event */ });
  return {
    isAttended: () => attended,
    dispose: () => { disposed = true; unsubscribe?.(); },
  };
}
