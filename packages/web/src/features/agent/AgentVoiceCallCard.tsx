// Raft voice calls (#wg-runtime-form:#22): the call window, placed and wired.
// AgentVoiceCallPanel floats where notices go (16px above the composer or the
// tab bar, the trailing corner from `sm` up; ReferralSourcePrompt's place), at
// z-app: over the page, under every popup, dialog and toast. Its buttons act
// on the call store; its timer ticks every second while the call is up.
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { toastViewportNoticeMoved, useToastViewportBottom, useToastViewportNotice } from "../../components/toastViewportBottom";
import { setAgentVoiceCallWindow, useAgentVoiceCallStore } from "./agentVoiceCallStore";
import type { AgentVoiceCall } from "./agentVoiceCallStore";
import { AgentVoiceCallPanel } from "./AgentVoiceCallPanel";

const PLACE =
  "pointer-events-none fixed inset-x-0 z-app flex justify-center px-3 sm:justify-end sm:px-4 bottom-[calc(max(var(--toast-viewport-bottom,0px),env(safe-area-inset-bottom))+1rem)]";

/** Now, every second while the call is up (for its timer). */
function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

export function AgentVoiceCallCard({ call }: { call: AgentVoiceCall }) {
  const hangUp = useAgentVoiceCallStore((s) => s.hangUp);
  const close = useAgentVoiceCallStore((s) => s.close);
  const toggleMute = useAgentVoiceCallStore((s) => s.toggleMute);
  const toggleSpeaker = useAgentVoiceCallStore((s) => s.toggleSpeaker);
  const unlockPlayback = useAgentVoiceCallStore((s) => s.unlockPlayback);
  const now = useClock(call.phase === "live" || call.phase === "reconnecting");

  // Where notices go, as the referral prompt does: above the composer; a toast shown with it stacks above it.
  const noticeRef = useToastViewportNotice();
  const viewportBottom = useToastViewportBottom(false, false);
  const placeStyle = useMemo(
    () => (viewportBottom === null ? undefined : ({ "--toast-viewport-bottom": `${viewportBottom}px` } as CSSProperties)),
    [viewportBottom],
  );
  useLayoutEffect(() => toastViewportNoticeMoved(), [viewportBottom]);

  return (
    <div ref={noticeRef} className={PLACE} style={placeStyle}>
      <AgentVoiceCallPanel
        call={call}
        now={now}
        // A Call button pressed during this call brings this window forward (the store focuses it).
        windowRef={setAgentVoiceCallWindow}
        onHangUp={hangUp}
        onClose={close}
        onToggleMute={toggleMute}
        onToggleSound={toggleSpeaker}
        onUnlockPlayback={unlockPlayback}
      />
    </div>
  );
}
