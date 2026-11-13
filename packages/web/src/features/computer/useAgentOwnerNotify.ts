/**
 * Notify Owner to Move It for a list of other people's agents on the person's
 * computers (#triage:d10ace06): what one screen learned from its own notify
 * calls, ahead of the server's next list. Delete Account
 * (OthersAgentsOnComputers) and deleting one computer
 * (DeleteComputerDialog) each hold one; AgentOwnerNotifyActions draws it.
 */
import { currentTimeMs } from "@botiverse/raft-shared";
import { useCallback, useState } from "react";

import type { AgentOwner, NotifyAgentOwnersResult, OthersAgent } from "./othersAgentsApi";

export interface AgentOwnerNotifyState {
  /** When Raft reminded the owner, from the POST's `notified`. */
  notifiedAt: ReadonlyMap<string, string>;
  /** `rate_limited`: when the next reminder is allowed (null when the server didn't say). */
  nextAllowedAt: ReadonlyMap<string, string | null>;
  /** `no_owner`: nobody to notify after all. */
  ownerless: ReadonlySet<string>;
  /** A call in flight for these agents. */
  busy: ReadonlySet<string>;
  /** The call failed for these agents (an error, or a refusal). */
  failed: ReadonlySet<string>;
  /** `not_delivered`: the server couldn't send the reminder; it can be tried again now. */
  undelivered: ReadonlySet<string>;
}

const EMPTY: AgentOwnerNotifyState = { notifiedAt: new Map(), nextAllowedAt: new Map(), ownerless: new Set(), busy: new Set(), failed: new Set(), undelivered: new Set() };

/** The agent's owner, unless a notify call found it has none. */
export function ownerNow(state: AgentOwnerNotifyState, agent: OthersAgent): AgentOwner {
  return state.ownerless.has(agent.id) ? null : agent.owner;
}

/**
 * Still waiting out the server's once-a-day limit (shared by every route that
 * asks): the list's `ownerNextNotifyAt`, or this screen's own `rate_limited`
 * answer (an unknown time waits until the screen is opened again). `at`: when
 * the next reminder is allowed, if known.
 */
export function nextReminder(state: AgentOwnerNotifyState, agent: OthersAgent): { limited: boolean; at: string | null } {
  const now = currentTimeMs();
  if (state.nextAllowedAt.has(agent.id)) {
    const at = state.nextAllowedAt.get(agent.id) ?? null;
    if (at === null || Date.parse(at) > now) return { limited: true, at };
  }
  const fromList = agent.ownerNextNotifyAt;
  if (fromList && Date.parse(fromList) > now) return { limited: true, at: fromList };
  return { limited: false, at: null };
}

/** Whether a reminder may go to this agent's owner now. */
export function canNotifyNow(state: AgentOwnerNotifyState, agent: OthersAgent): boolean {
  return ownerNow(state, agent) !== null && !nextReminder(state, agent).limited && !state.busy.has(agent.id);
}

/**
 * `send`: the route's notify-agent-owners call. `onSettled`: a call answered
 * (read the list again, where the screen has one to read).
 */
export function useAgentOwnerNotify(send: (agentIds: string[]) => Promise<NotifyAgentOwnersResult>, onSettled?: () => void) {
  const [state, setState] = useState<AgentOwnerNotifyState>(EMPTY);

  const notify = useCallback((agentIds: string[]) => {
    if (agentIds.length === 0) return;
    const without = (set: ReadonlySet<string>) => new Set([...set].filter((id) => !agentIds.includes(id)));
    setState((current) => ({
      ...current,
      busy: new Set([...current.busy, ...agentIds]),
      failed: without(current.failed),
      undelivered: without(current.undelivered),
    }));
    send(agentIds).then((result) => {
      setState((current) => {
        const notifiedAt = new Map(current.notifiedAt);
        const nextAllowedAt = new Map(current.nextAllowedAt);
        const ownerless = new Set(current.ownerless);
        const undelivered = new Set(current.undelivered);
        for (const entry of result.notified) {
          notifiedAt.set(entry.agentId, entry.notifiedAt);
          nextAllowedAt.delete(entry.agentId);
        }
        for (const entry of result.skipped) {
          if (entry.reason === "rate_limited") nextAllowedAt.set(entry.agentId, entry.nextAllowedAt);
          else if (entry.reason === "no_owner") ownerless.add(entry.agentId);
          else if (entry.reason === "not_delivered") undelivered.add(entry.agentId);
          // not_on_your_computer: it has left; the next list drops it.
        }
        return { ...current, notifiedAt, nextAllowedAt, ownerless, undelivered, busy: without(current.busy) };
      });
      onSettled?.();
    }, () => {
      setState((current) => ({ ...current, busy: without(current.busy), failed: new Set([...current.failed, ...agentIds]) }));
    });
  }, [onSettled, send]);

  return { state, notify };
}
