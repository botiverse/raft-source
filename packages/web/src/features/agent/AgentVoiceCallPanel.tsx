// Raft voice calls (#wg-runtime-form:#22): what the call window shows, from
// the call's state and the time alone (AgentVoiceCallCard places it and wires
// it to the store; the visual case renders it from fixtures). A raft-ui Card:
// the agent (a ring while it speaks), how the call is going, the last two
// caption lines (two lines each at most), a warning when the microphone is
// lost mid-call, and Mute and Sound (raft-ui PanelToggleAction: the pressed
// sticker) and Hang up, straight under the text; once over, how long it lasted
// and Close.
import type { Ref } from "react";
import { useIntl } from "react-intl";
import { Mic, MicOff, PhoneOff, Volume2, VolumeOff } from "lucide-react";
import { AGENT_VOICE_CALL_MAX_MINUTES } from "@botiverse/raft-shared";
import { Button, Card, CardContent, CardDescription, CardHeader, CardLeading, CardTitle, PanelAction, PanelToggleAction, Text } from "@botiverse/raft-ui";
import AvatarSlot from "../../components/ui/AvatarSlot";
import Banner from "../../components/ui/Banner";
import Tooltip from "../../components/ui/Tooltip";
import type { MessageId } from "../../i18n/messages/en";
import { formatCallClock } from "./agentVoiceCallStore";
import type { AgentVoiceCall } from "./agentVoiceCallStore";
import type { AgentVoiceCallProblem } from "./agentVoiceCallClient";

/** Every way a call can fail to start or connect, in plain words. */
const PROBLEM_TEXT: Record<AgentVoiceCallProblem, MessageId> = {
  not_allowed: "agent.voice.call.problem.notAllowed",
  agent_offline: "agent.voice.call.problem.agentOffline",
  unavailable: "agent.voice.call.problem.unavailable",
  unsupported_runtime: "agent.voice.call.problem.unsupportedRuntime",
  rate_limited: "agent.voice.call.problem.rateLimited",
  failed: "agent.voice.call.problem.failed",
  mic_permission: "agent.voice.call.mic.permission",
  mic_busy: "agent.voice.call.mic.busy",
  mic_none: "agent.voice.call.mic.none",
};

/** The microphone stopped sending during a call that goes on (at the join, PROBLEM_TEXT's mic_* end the call). */
const MIC_LIVE_TEXT = {
  permission: "agent.voice.call.micLive.permission",
  busy: "agent.voice.call.micLive.busy",
  none: "agent.voice.call.micLive.none",
} as const satisfies Record<string, MessageId>;

/** A server close this close to the longest call is the limit, not a fault. */
const LIMIT_MARGIN_MS = 60_000;

export type AgentVoiceCallPanelProps = {
  call: AgentVoiceCall;
  /** Now (ms), for the live timer. */
  now: number;
  /** The Card's element, for bringing the window forward. */
  windowRef?: Ref<HTMLDivElement>;
  onHangUp: () => void;
  onClose: () => void;
  onToggleMute: () => void;
  onToggleSound: () => void;
  onUnlockPlayback: () => void;
};

export function AgentVoiceCallPanel({ call, now, windowRef, onHangUp, onClose, onToggleMute, onToggleSound, onUnlockPlayback }: AgentVoiceCallPanelProps) {
  const { formatMessage } = useIntl();
  const { agent, phase } = call;
  const name = agent.name;
  const inCall = phase === "live" || phase === "reconnecting";
  const over = phase === "ended" || phase === "failed";

  // What a screen reader hears: each change of phase, once; never the ticking clock.
  const announcement = phase === "starting" || phase === "connecting"
    ? formatMessage({ id: "agent.voice.call.connecting" })
    : phase === "reconnecting"
      ? formatMessage({ id: "agent.voice.call.reconnecting" })
      : phase === "live"
        ? formatMessage({ id: "agent.voice.call.connected" })
        : phase === "ended"
          ? formatMessage({ id: "agent.voice.call.ended" }, { duration: formatCallClock(call.durationMs ?? 0) })
          : formatMessage({ id: "agent.voice.call.notConnected" });
  const stateLine = phase === "live" ? formatCallClock(now - (call.liveSince ?? now)) : announcement;

  // What the person needs to know, one plain sentence each.
  const notes: string[] = [];
  if (phase === "failed" && call.problem) notes.push(formatMessage({ id: PROBLEM_TEXT[call.problem] }, { name }));
  const micWarning = inCall && call.micBlocked ? formatMessage({ id: MIC_LIVE_TEXT[call.micBlocked] }, { name }) : null;
  if (inCall && call.playbackBlocked) notes.push(formatMessage({ id: "agent.voice.call.playbackBlocked" }, { name }));
  if (phase === "ended") {
    if (call.endReason === "lost") notes.push(formatMessage({ id: "agent.voice.call.connectionLost" }));
    if (call.endReason === "closed" && (call.durationMs ?? 0) >= AGENT_VOICE_CALL_MAX_MINUTES * 60_000 - LIMIT_MARGIN_MS) {
      notes.push(formatMessage({ id: "agent.voice.call.limit" }, { minutes: AGENT_VOICE_CALL_MAX_MINUTES }));
    }
    notes.push(formatMessage({ id: "agent.voice.call.record" }, { name }));
  }

  // Toggles keep their names and say their state with aria-pressed, lit only when something is off (Kirby):
  // Mute pressed is muted, Sound off pressed is sound off (or held back by the browser until a click).
  const muteLabel = formatMessage({ id: "agent.voice.call.mute" });
  const soundLabel = formatMessage({ id: "agent.voice.call.soundOff" });
  const soundOff = call.speakerOff || call.playbackBlocked;
  const micUnavailableLabel = formatMessage({ id: "agent.voice.call.micUnavailable" });
  const hangUpLabel = formatMessage({ id: "agent.voice.call.hangUp" });

  return (
    <Card
      ref={windowRef}
      tabIndex={-1}
      role="region"
      aria-label={formatMessage({ id: "agent.voice.call.window" }, { name })}
      // Drawn like the other floating things (Raft DS › Elevation): layer-popover, a line-seam ring and shadow-float,
      // in place of the Card's own surface and hairline; the Card keeps its parts and padding.
      className="pointer-events-auto w-full max-w-[360px] border-0 bg-layer-popover shadow-float ring-1 ring-line-seam outline-none focus-visible:shadow-focus"
      data-testid="agent-voice-call-window"
      data-phase={phase}
    >
      <CardHeader>
        <CardLeading>
          {/* Speaking: a still ring round the agent's face (raft-ui has no speaking mark; statuses never animate). */}
          <AvatarSlot
            context="call-window"
            type="agent"
            agentAvatarUrl={agent.avatarUrl}
            className={call.agentSpeaking ? "outline-2 outline-offset-2 outline-presence-online" : undefined}
          />
        </CardLeading>
        <CardTitle className="truncate" data-speaking={call.agentSpeaking || undefined} data-testid="agent-voice-call-name">
          {name}
        </CardTitle>
        <CardDescription className="tabular-nums" data-testid="agent-voice-call-state">
          {stateLine}
        </CardDescription>
        <span className="sr-only" role="status" aria-live="polite" data-testid="agent-voice-call-announcement">
          {announcement}
        </span>
      </CardHeader>
      {/* One body at the card's padding: the text, then the buttons right under it. */}
      <CardContent className="flex flex-col gap-3">
        {call.captions.length > 0 && !over ? (
          <div className="stack-y-1" data-testid="agent-voice-call-captions">
            {call.captions.map((line) => (
              <Text.Sans key={line.id} size="small" variant={line.mine ? "muted" : "default"} className="line-clamp-2 break-words">
                <span className="mr-1 font-semibold">
                  {formatMessage({ id: "agent.voice.call.captionWho" }, { name: line.mine ? formatMessage({ id: "agent.voice.call.you" }) : name })}
                </span>
                {line.text}
              </Text.Sans>
            ))}
          </div>
        ) : null}
        {micWarning ? (
          <Banner intent="warning" density="sm" withIcon data-testid="agent-voice-call-mic">
            {micWarning}
          </Banner>
        ) : null}
        {notes.length > 0 ? (
          <div className="stack-y-1" data-testid="agent-voice-call-notes">
            {notes.map((note) => (
              <Text.Sans key={note} size="small" variant="muted">{note}</Text.Sans>
            ))}
          </div>
        ) : null}
        <div className="flex items-center justify-end gap-2">
          {over ? (
            <Button variant="default" onClick={onClose} data-testid="agent-voice-call-close">
              {formatMessage({ id: "common.close" })}
            </Button>
          ) : (
            <>
              {inCall ? (
                <>
                  {call.micBlocked ? (
                    // Unavailable while the microphone is lost. Base UI's Toggle can't stay focusable when disabled, so this is
                    // the same panel action as a Button (its aria-pressed draws the same sticker), focusable for its tooltip's reason.
                    <Tooltip content={micUnavailableLabel}>
                      <PanelAction aria-label={muteLabel} aria-pressed={call.muted} disabled focusableWhenDisabled data-testid="agent-voice-call-mute">
                        <MicOff />
                      </PanelAction>
                    </Tooltip>
                  ) : (
                    <Tooltip content={muteLabel}>
                      <PanelToggleAction aria-label={muteLabel} pressed={call.muted} onPressedChange={onToggleMute} data-testid="agent-voice-call-mute">
                        {call.muted ? <MicOff /> : <Mic />}
                      </PanelToggleAction>
                    </Tooltip>
                  )}
                  <Tooltip content={soundLabel}>
                    <PanelToggleAction
                      aria-label={soundLabel}
                      pressed={soundOff}
                      onPressedChange={call.playbackBlocked ? onUnlockPlayback : onToggleSound}
                      data-testid="agent-voice-call-sound"
                    >
                      {soundOff ? <VolumeOff /> : <Volume2 />}
                    </PanelToggleAction>
                  </Tooltip>
                </>
              ) : null}
              <Tooltip content={hangUpLabel}>
                <Button variant="warning" size="icon-lg" aria-label={hangUpLabel} onClick={onHangUp} data-testid="agent-voice-call-hang-up">
                  <PhoneOff />
                </Button>
              </Tooltip>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
