import { AgentVoiceCallPanel } from "../src/features/agent/AgentVoiceCallPanel";
import type { AgentVoiceCall } from "../src/features/agent/agentVoiceCallStore";

// Raft voice calls (#wg-runtime-form:#22): the call window in its states, one
// sheet (the React provider shoots one image per case), from fixture calls
// and a fixed clock, with no room: AgentVoiceCallPanel is what the window
// draws, without its place on the page or the store. Top to bottom:
// connecting; live 3:12 with the agent speaking and two caption lines (the
// person's finished, the agent's unfinished and long enough to be clamped);
// live with the microphone lost mid-call; ended 7:45 after the line was lost;
// failed, the agent offline. `.phone`: the same sheet at a phone's width, as
// the window takes it there (12px from each side). The window over the
// composer, in its real place, is VoiceCallOverComposerCase in
// VisualTestingCases.tsx.

export const AGENT_VOICE_CALL_CASE_ID = "components.agent.voice-call.states";
export const AGENT_VOICE_CALL_PHONE_CASE_ID = "components.agent.voice-call.phone";
export const AGENT_VOICE_CALL_OVER_COMPOSER_CASE_ID = "components.agent.voice-call.over-composer";

const NOW = Date.parse("2026-11-16T10:00:00.000Z");

const BASE: AgentVoiceCall = {
  agent: { id: "visual-wug", name: "Wug", avatarUrl: "pixel:catbot" },
  serverId: "visual-server",
  phase: "starting",
  liveSince: null,
  durationMs: null,
  endReason: null,
  problem: null,
  micBlocked: null,
  muted: false,
  speakerOff: false,
  playbackBlocked: false,
  agentSpeaking: false,
  captions: [],
};

const LIVE: AgentVoiceCall = { ...BASE, phase: "live", liveSince: NOW - 192_000 };

/** The fixture calls, by the state each shows. */
export const VOICE_CALL_STATES: ReadonlyArray<readonly [string, AgentVoiceCall]> = [
  ["connecting", { ...BASE, phase: "connecting" }],
  ["live-captions", {
    ...LIVE,
    agentSpeaking: true,
    captions: [
      { id: "u1", mine: true, text: "Is the deploy to staging done yet?", final: true },
      { id: "a1", mine: false, text: "Yes, it finished a few minutes ago: all three services are green, the migration ran once, and the smoke tests on staging passed, so the", final: false },
    ],
  }],
  ["live-mic-blocked", { ...LIVE, micBlocked: "busy" }],
  ["ended-lost", { ...BASE, phase: "ended", liveSince: NOW - 465_000, durationMs: 465_000, endReason: "lost" }],
  ["failed-agent-offline", { ...BASE, phase: "failed", problem: "agent_offline" }],
];

const noop = () => undefined;

/** A live call for the window over the composer (its clock runs from when the case opens). */
export function liveVoiceCallFixture(now: number): AgentVoiceCall {
  return { ...VOICE_CALL_STATES[1]![1], liveSince: now - 192_000 };
}

export function AgentVoiceCallCase({ phone = false }: { phone?: boolean }) {
  return (
    <main className={phone ? "min-h-screen bg-layer-canvas font-display text-foreground" : "min-h-screen bg-layer-canvas p-6 font-display text-foreground"}>
      <div
        data-visual-case={phone ? AGENT_VOICE_CALL_PHONE_CASE_ID : AGENT_VOICE_CALL_CASE_ID}
        className={phone ? "flex w-[390px] flex-col items-center gap-4 px-3 py-4" : "flex w-[392px] flex-col gap-4 p-4"}
      >
        {VOICE_CALL_STATES.map(([state, call]) => (
          <div key={state} data-voice-call-state={state} className="flex w-full justify-center">
            <AgentVoiceCallPanel
              call={call}
              now={NOW}
              onHangUp={noop}
              onClose={noop}
              onToggleMute={noop}
              onToggleSound={noop}
              onUnlockPlayback={noop}
            />
          </div>
        ))}
      </div>
    </main>
  );
}
