// Raft voice calls (#wg-runtime-form:#22): the one call this tab is on, for
// the call window (AgentVoiceCallWindow, mounted once at the app root). A Call
// button asks for a call; while one is on, the ask only brings its window
// forward. The room (@holtjs/live-client, loaded on the first call) lives
// beside the store, never in it.
//
// starting (POST …/voice/calls) → connecting (joining the room) → live ⇄
// reconnecting → ended (how long it lasted, and why: the person left, the
// server closed it, the line was lost); or failed, with why. Hanging up before
// the call is live just closes the window. The server hears the hang-up once,
// unless it closed the room itself.
import { create } from "zustand";
import type { DataMessage, EndReason, LiveRoom, MicBlocked } from "@holtjs/live-client";
import type { AgentVoiceCallId } from "@botiverse/raft-shared";
import {
  hangUpAgentVoiceCall,
  renewAgentVoiceCallToken,
  startAgentVoiceCall,
  startProblemOf,
} from "./agentVoiceCallClient";
import type { AgentVoiceCallProblem } from "./agentVoiceCallClient";

export type AgentVoiceCallPhase = "starting" | "connecting" | "live" | "reconnecting" | "ended" | "failed";

export type AgentVoiceCallee = { id: string; name: string; avatarUrl: string | null };

/** One caption line: its id, whether the person said it, what, and whether it is finished. */
export type AgentVoiceCaption = { id: string; mine: boolean; text: string; final: boolean };

export type AgentVoiceCall = {
  agent: AgentVoiceCallee;
  serverId: string;
  phase: AgentVoiceCallPhase;
  /** When the call first went live (ms), for the timer. */
  liveSince: number | null;
  /** How long it lasted, once ended. */
  durationMs: number | null;
  /** Why the room ended: the person left, the server closed it, or the line was lost. */
  endReason: EndReason | null;
  problem: AgentVoiceCallProblem | null;
  /** Why the microphone isn't sending, during the call. */
  micBlocked: MicBlocked | null;
  muted: boolean;
  speakerOff: boolean;
  /** The browser holds the agent's voice back until a click (unlockPlayback). */
  playbackBlocked: boolean;
  agentSpeaking: boolean;
  /** The last two lines. */
  captions: AgentVoiceCaption[];
};

type AgentVoiceCallState = {
  call: AgentVoiceCall | null;
  startCall: (agent: AgentVoiceCallee, serverId: string) => void;
  hangUp: () => void;
  /** Takes an ended or failed call's window down. */
  close: () => void;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  unlockPlayback: () => void;
};

/** The live part of the current call, outside React state. */
type Session = {
  agentId: string;
  serverId: string;
  abort: AbortController;
  callId: AgentVoiceCallId | null;
  room: LiveRoom | null;
  /** This participant's identity (from the peers event, before the join resolves), and who is speaking. */
  self: string;
  speaking: Set<string>;
  /** Caption ids already finished: a late unfinished message for one of them is ignored (bounded). */
  finishedCaptions: Set<string>;
  /** The person's Mute and Sound choices, applied to the room once it is joined. */
  muted: boolean;
  speakerOff: boolean;
  done: boolean;
  hungUp: boolean;
};

/** How a call ends: why the room ended, why it failed, and whether the window just goes (hung up before it was live). */
type Ending = { reason?: EndReason; problem?: AgentVoiceCallProblem; dismiss?: boolean };

let session: Session | null = null;
/** The call window's element (AgentVoiceCallCard's ref), focused when a Call button is pressed during a call. */
let windowElement: HTMLElement | null = null;

export function setAgentVoiceCallWindow(element: HTMLElement | null): void {
  windowElement = element;
}

const CAPTION_LINES = 2;
/** How many finished caption ids a call remembers (far more than a late unfinished message trails by). */
const FINISHED_CAPTIONS_KEPT = 200;

function micProblem(blocked: MicBlocked): AgentVoiceCallProblem {
  return blocked === "permission" ? "mic_permission" : blocked === "busy" ? "mic_busy" : "mic_none";
}

/**
 * A caption from one of the room's data messages, or null for anything else.
 * holt-live's contract (raft-deck #1448): topic "caption", JSON `{ type:
 * "caption", role: "user" | "agent", text, final, id }`. An unfinished line
 * comes about every 300 ms with the whole text so far, over the unreliable
 * channel; the finished one, with the same id, over the reliable channel (so
 * an unfinished message can still arrive after it). A finished line with empty
 * text withdraws the line. Nothing else is read.
 */
export function captionOf(message: DataMessage): AgentVoiceCaption | null {
  if (message.topic !== "caption") return null;
  const data = message.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const { type, role, text, final, id } = data as Record<string, unknown>;
  if (type !== "caption" || (role !== "user" && role !== "agent")) return null;
  if (typeof text !== "string" || typeof final !== "boolean" || typeof id !== "string") return null;
  return { id, mine: role === "user", text, final };
}

/**
 * The captions with one more message: it replaces the line with its id (the
 * whole text so far, or the finished line); a finished line with empty text
 * withdraws its line, and an unfinished one with empty text changes nothing.
 * The last two stay.
 */
export function withCaption(lines: AgentVoiceCaption[], line: AgentVoiceCaption): AgentVoiceCaption[] {
  if (line.text === "") return line.final ? lines.filter((earlier) => earlier.id !== line.id) : lines;
  const at = lines.findIndex((earlier) => earlier.id === line.id);
  const next = at === -1 ? [...lines, line] : lines.map((earlier, index) => (index === at ? line : earlier));
  return next.slice(-CAPTION_LINES);
}

/** A call's length as m:ss (mm:ss from ten minutes). */
export function formatCallClock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const useAgentVoiceCallStore = create<AgentVoiceCallState>((set, get) => {
  /** Change the current call, only while `s` is still the session it belongs to. */
  const update = (s: Session, change: Partial<AgentVoiceCall> | ((call: AgentVoiceCall) => Partial<AgentVoiceCall>)) => {
    if (session !== s) return;
    const call = get().call;
    if (!call) return;
    set({ call: { ...call, ...(typeof change === "function" ? change(call) : change) } });
  };

  const tellServer = (s: Session) => {
    if (s.hungUp || !s.callId) return;
    s.hungUp = true;
    void hangUpAgentVoiceCall(s.agentId, s.callId, s.serverId).catch(() => undefined);
  };

  /**
   * The one way out of a call: leave the room, tell the server (not when it
   * closed the room itself: a hang-up racing its end would be recorded as the
   * caller's), and say how it went, or take the window down.
   */
  const finish = (s: Session, ending: Ending = {}) => {
    if (s.done) return;
    s.done = true;
    s.abort.abort();
    void s.room?.leave().catch(() => undefined);
    if (ending.reason !== "closed") tellServer(s);
    if (ending.dismiss) {
      if (session === s) {
        session = null;
        set({ call: null });
      }
      return;
    }
    const quiet = { agentSpeaking: false, playbackBlocked: false, micBlocked: null, endReason: ending.reason ?? null };
    update(s, (call) => (call.liveSince !== null && !ending.problem
      ? { ...quiet, phase: "ended", durationMs: Date.now() - call.liveSince }
      : { ...quiet, phase: "failed", problem: ending.problem ?? "failed" }));
  };

  const run = async (s: Session) => {
    let answer;
    try {
      answer = await startAgentVoiceCall(s.agentId, s.serverId);
    } catch (error) {
      if (s.done) return;
      s.done = true;
      update(s, { phase: "failed", problem: startProblemOf(error) });
      return;
    }
    s.callId = answer.callId;
    if (s.done) {
      tellServer(s); // hung up while the call was being placed
      return;
    }
    const grant = answer.room;
    const callId = answer.callId;
    if (!grant || !callId) {
      finish(s, { problem: "failed" }); // not a grant the browser can join with
      return;
    }
    update(s, { phase: "connecting" });
    try {
      const { joinRoom } = await import("@holtjs/live-client");
      const room = await joinRoom({
        url: grant.url,
        token: grant.token,
        expiresAt: grant.expiresAt,
        renew: async () => {
          const renewed = (await renewAgentVoiceCallToken(s.agentId, callId, s.serverId)).room;
          if (!renewed) throw new Error("The renewed room grant is incomplete.");
          return { token: renewed.token, expiresAt: renewed.expiresAt };
        },
        // The server's `relay` is a region name, not the TURN relay joinRoom takes: no relay.
        relay: null,
        mic: { denoise: "soft" },
        signal: s.abort.signal,
        on: {
          state: (state, reason) => {
            if (state === "ended") finish(s, { reason: reason ?? "lost" });
            else if (state === "live") update(s, (call) => ({ phase: "live", liveSince: call.liveSince ?? Date.now() }));
            else if (state === "reconnecting") update(s, { phase: "reconnecting" });
          },
          peers: (peers) => {
            s.self = peers.find((peer) => peer.local)?.identity ?? s.self;
          },
          speaking: (identity, on) => {
            if (on) s.speaking.add(identity);
            else s.speaking.delete(identity);
            update(s, { agentSpeaking: [...s.speaking].some((who) => who !== s.self) });
          },
          mic: (status) => update(s, { micBlocked: status.blocked ?? null }),
          playback: (blocked) => update(s, { playbackBlocked: blocked }),
          data: (message) => {
            const line = captionOf(message);
            if (!line) return;
            if (!line.final && s.finishedCaptions.has(line.id)) return; // late, over the unreliable channel
            if (line.final) {
              s.finishedCaptions.add(line.id);
              if (s.finishedCaptions.size > FINISHED_CAPTIONS_KEPT) s.finishedCaptions.delete(s.finishedCaptions.values().next().value as string);
            }
            update(s, (call) => ({ captions: withCaption(call.captions, line) }));
          },
        },
      });
      if (s.done) {
        void room.leave().catch(() => undefined);
        return;
      }
      s.room = room;
      s.self = room.identity;
      // A call the person can't speak in: end it now and say why.
      if (room.mic?.blocked) {
        finish(s, { problem: micProblem(room.mic.blocked) });
        return;
      }
      // What the person chose while the room was still joining.
      if (s.muted) room.mute(true);
      if (s.speakerOff) room.speaker(false);
      update(s, (call) => ({
        phase: room.state === "reconnecting" ? "reconnecting" : "live",
        liveSince: call.liveSince ?? Date.now(),
        playbackBlocked: room.playbackBlocked,
      }));
    } catch {
      finish(s, { problem: "failed" }); // (a no-op when the person hung up meanwhile: the join was cancelled)
    }
  };

  return {
    call: null,
    startCall: (agent, serverId) => {
      const current = get().call;
      if (current && current.phase !== "ended" && current.phase !== "failed") {
        windowElement?.focus();
        return;
      }
      const s: Session = {
        agentId: agent.id,
        serverId,
        abort: new AbortController(),
        callId: null,
        room: null,
        self: "",
        speaking: new Set(),
        finishedCaptions: new Set(),
        muted: false,
        speakerOff: false,
        done: false,
        hungUp: false,
      };
      session = s;
      set({
        call: {
          agent,
          serverId,
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
        },
      });
      void run(s);
    },
    hangUp: () => {
      const s = session;
      const call = get().call;
      // Not live yet: no call to sum up, the window goes.
      if (s && call) finish(s, { reason: "left", dismiss: call.liveSince === null });
    },
    close: () => {
      const call = get().call;
      if (call && (call.phase === "ended" || call.phase === "failed")) {
        session = null;
        set({ call: null });
      }
    },
    toggleMute: () => {
      const s = session;
      if (!s || s.done) return;
      s.muted = !s.muted;
      s.room?.mute(s.muted);
      update(s, { muted: s.muted });
    },
    toggleSpeaker: () => {
      const s = session;
      if (!s || s.done) return;
      s.speakerOff = !s.speakerOff;
      s.room?.speaker(!s.speakerOff);
      update(s, { speakerOff: s.speakerOff });
    },
    unlockPlayback: () => {
      void session?.room?.unlockPlayback().catch(() => undefined);
    },
  };
});
