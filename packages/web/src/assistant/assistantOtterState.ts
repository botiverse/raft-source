// The personal assistant's otter on the composer (Kirby's prototype v13):
// which composer it lies on, and what it shows. The view is AssistantOtter.tsx.

import { useLayoutEffect } from "react";
import { create } from "zustand";
import type { AgentActivity } from "@botiverse/raft-shared";
import { useAgentDisplayState } from "../store/agentStore";
import { useOtterVisiblePref } from "./assistantOtterPrefs";
import { useMessageStore } from "../store/messageStore";
import type { Message } from "../store/messageStore";
import { useAssistantPause } from "./AssistantPaused";
import type { AssistantRecord } from "./assistantClient";

// ---- Which composer ------------------------------------------------------------
//
// One otter per screen. Every composer that may carry it registers while it
// is mounted; the otter lies on the one used last: the one focused last, else
// the one that appeared last (a thread opened beside the channel), else the
// one before it. `order` is that recency, newest last.

type OtterHosts = {
  order: readonly string[];
};

const useOtterHosts = create<OtterHosts>(() => ({ order: [] }));

function moveToFront(hostId: string) {
  useOtterHosts.setState((state) => ({ order: [...state.order.filter((id) => id !== hostId), hostId] }));
}

/**
 * Registers a composer while `eligible`; true while the otter lies on it. A
 * `fallback` host (a page with no composer, AssistantPageOtter) goes behind
 * every other: any composer on screen takes the otter first, whenever it
 * appeared.
 */
export function useOtterHost(hostId: string, eligible: boolean, fallback = false): boolean {
  useLayoutEffect(() => {
    if (!eligible) return;
    if (fallback) useOtterHosts.setState((state) => ({ order: [hostId, ...state.order.filter((id) => id !== hostId)] }));
    else moveToFront(hostId);
    return () => {
      useOtterHosts.setState((state) => ({ order: state.order.filter((id) => id !== hostId) }));
    };
  }, [hostId, eligible, fallback]);
  return useOtterHosts((state) => eligible && state.order[state.order.length - 1] === hostId);
}

/** The person used this composer: the otter moves to it. */
export function activateOtterHost(hostId: string): void {
  const { order } = useOtterHosts.getState();
  if (!order.includes(hostId) || order[order.length - 1] === hostId) return;
  moveToFront(hostId);
}

/** The hosts on screen now, the otter's last (a snapshot; renders nothing). */
export function otterHostOrder(): readonly string[] {
  return useOtterHosts.getState().order;
}

export function resetOtterHostsForTests(): void {
  useOtterHosts.setState({ order: [] });
}

// ---- Shown at all (#proj-assistant:#21) ---------------------------------------
//
// Two switches decide whether the otter lies on any composer or page: the
// account's "Show Ottie on every page" (permanent, every device), and the
// shortcut's hide (for now: this tab, until the shortcut shows it again or
// the tab closes). Off in either, no host registers, so nothing keeps room.

const HIDDEN_FOR_NOW_KEY = "raft.assistantOtter.hiddenForNow";

function readHiddenForNow(): boolean {
  try {
    return typeof sessionStorage !== "undefined" && sessionStorage.getItem(HIDDEN_FOR_NOW_KEY) === "1";
  } catch {
    return false;
  }
}

const useOtterHiddenForNowStore = create<{ hidden: boolean }>(() => ({ hidden: readHiddenForNow() }));

export function setOtterHiddenForNow(hidden: boolean): void {
  useOtterHiddenForNowStore.setState({ hidden });
  try {
    if (hidden) sessionStorage.setItem(HIDDEN_FOR_NOW_KEY, "1");
    else sessionStorage.removeItem(HIDDEN_FOR_NOW_KEY);
  } catch {
    // Storage blocked: the hide still holds until the page reloads.
  }
}

export function isOtterHiddenForNow(): boolean {
  return useOtterHiddenForNowStore.getState().hidden;
}

export function useOtterHiddenForNow(): boolean {
  return useOtterHiddenForNowStore((state) => state.hidden);
}

/** The account's switch: on unless the person turned it off (absent from an older server = on). */
export const useOtterVisibleSetting = useOtterVisiblePref;

/** Whether the otter may show at all: the account's switch is on and the shortcut hasn't hidden it. */
export function useOtterShown(): boolean {
  const visible = useOtterVisibleSetting();
  const hiddenForNow = useOtterHiddenForNow();
  return visible && !hiddenForNow;
}

export function resetOtterHiddenForNowForTests(): void {
  setOtterHiddenForNow(false);
}

// ---- What it shows -------------------------------------------------------------

/**
 * - `away`: paused by an admin, or its agent is offline;
 * - `confirm`: an action card from it in the owner's DM waits for the owner;
 * - `new`: unread messages in that DM;
 * - `working`: its agent is thinking or working;
 * - `idle`: none of these.
 */
export type OtterMood = "idle" | "working" | "new" | "confirm" | "away";

/** Highest first: a pause outranks everything, a card to confirm outranks a plain unread. */
export function otterMood(input: { paused: boolean; activity: AgentActivity; unread: boolean; confirm: boolean }): OtterMood {
  if (input.paused) return "away";
  if (input.confirm) return "confirm";
  if (input.unread) return "new";
  if (input.activity === "thinking" || input.activity === "working") return "working";
  if (input.activity === "offline") return "away";
  return "idle";
}

const UNRESOLVED_CARD_STATES = new Set(["prepared", "reconfirm_required"]);
const cardScan = new WeakMap<readonly Message[], { agentId: string; waiting: boolean }>();

/**
 * Whether the assistant's own action card in these messages still waits for
 * an answer. Reads the messages the client holds for the DM: until its
 * window is loaded (the panel was opened once this session), a waiting card
 * shows as `new` through the unread count instead.
 */
export function hasWaitingActionCard(messages: readonly Message[] | undefined, agentId: string): boolean {
  if (!messages) return false;
  const cached = cardScan.get(messages);
  if (cached && cached.agentId === agentId) return cached.waiting;
  const waiting = messages.some((message) => {
    if (message.senderType !== "agent" || message.senderId !== agentId) return false;
    const meta = message.actionMetadata as { kind?: string; state?: unknown } | null | undefined;
    return meta?.kind === "action-card" && typeof meta.state === "string" && UNRESOLVED_CARD_STATES.has(meta.state);
  });
  cardScan.set(messages, { agentId, waiting });
  return waiting;
}

export function useAssistantOtterMood(assistant: AssistantRecord): OtterMood {
  const { agentId, dmChannelId } = assistant;
  const paused = useAssistantPause(agentId) !== null;
  const { activity } = useAgentDisplayState(agentId);
  const unread = useMessageStore((state) => (dmChannelId ? (state.unreadCounts[dmChannelId] ?? 0) > 0 : false));
  const confirm = useMessageStore((state) => (dmChannelId ? hasWaitingActionCard(state.channelMessages[dmChannelId], agentId) : false));
  return otterMood({ paused, activity, unread, confirm });
}
