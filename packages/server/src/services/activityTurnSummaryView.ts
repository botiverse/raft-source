import {
  ACTIVITY_TURN_APP_EVENTS_LIMIT,
  readActivityTurnTrigger,
  type ActivityTurnAppEventView,
  type ActivityTurnSummary,
  type ActivityTurnTrigger,
  type ActivityTurnTriggerAppEvent,
  type ActivityTurnTriggerDisplay,
} from "@botiverse/raft-shared";

/**
 * What the Activity overview may show about where a turn's waking message
 * came from. A viewer who can inspect the agent is not necessarily in the
 * private channel or DM that woke it (task #17, Tenny): then only the kind of
 * place is shown, never its name, the sender or the message.
 *
 * For one the viewer may see, the server names the place and the sender from
 * the trigger's ids (`display`), not from the producer's `target` / `sender`
 * text, which stay as sent for older web clients. A trigger whose channel or
 * message the server cannot find, or whose message is not in that channel,
 * comes back `unresolved`, with none of the producer's text.
 */
export type ActivityTurnTriggerView =
  // `appEvent`: the app event that woke the turn, when it could be resolved.
  | (ActivityTurnTrigger & { hidden?: undefined; unresolved?: undefined; appEvent?: ActivityTurnTriggerAppEvent; display?: ActivityTurnTriggerDisplay })
  | { hidden: "private_channel" | "dm"; unresolved?: undefined }
  | { unresolved: true; hidden?: undefined };

type WithTrigger = Pick<ActivityTurnSummary, "trigger">;

export type ActivityTurnSummaryView<T extends WithTrigger = ActivityTurnSummary> = Omit<T, "trigger"> & { trigger?: ActivityTurnTriggerView };

/** A channel a trigger names, as the server stores it (TurnTriggerFacts). */
export interface TurnTriggerChannelFact {
  /** "task": a task's own conversation (task v2), shown like a thread in its parent channel. */
  type: "channel" | "private" | "joint" | "dm" | "thread" | "task";
  name: string;
  /**
   * Where its messages are stored when that is another channel: a joint
   * channel's canonical channel, a joint thread's canonical thread. An agent
   * is handed a joint message with its own server's channel, so the trigger
   * names that one while the message lives here.
   */
  storageChannelId?: string;
  /** A thread's parent message (a Slack root mention is handed to the agent in the thread under it). */
  parentMessageId?: string | null;
  /** A thread's or task conversation's parent channel; null when it cannot be found. */
  parent?: { type: TurnTriggerChannelFact["type"]; name: string } | null;
  /** A DM's other member as the agent sees it, when known (looked up only for a DM trigger without a message id). */
  dmPeerName?: string;
}

/** A message a trigger names: where it was posted and its sender's handle, when it has one. */
export interface TurnTriggerMessageFact {
  channelId: string;
  senderName?: string;
}

/** What the server knows about the channels and messages a page's visible triggers name, by id. */
export interface TurnTriggerFacts {
  channels: ReadonlyMap<string, TurnTriggerChannelFact>;
  messages: ReadonlyMap<string, TurnTriggerMessageFact>;
}

/** The distinct ids a page's visible triggers name, for one batched lookup (loadTurnTriggerFacts). */
export interface TurnTriggerRefs {
  channelIds: string[];
  messageIds: string[];
  /** DM channels named by a trigger without a message id: their peer is the only name to show. */
  dmPeerChannelIds: string[];
}

/**
 * Whether the message a trigger names was posted where the trigger says, as
 * the agent was handed it: in the channel itself, in the channel's storage
 * (a joint channel or thread, including one converted to joint after the
 * turn), or as the parent of the thread it was handed in (a Slack root
 * mention).
 */
function messageBelongsTo(message: TurnTriggerMessageFact, messageId: string, channelId: string, channel: TurnTriggerChannelFact): boolean {
  return message.channelId === channelId
    || (channel.storageChannelId !== undefined && message.channelId === channel.storageChannelId)
    || (channel.type === "thread" && channel.parentMessageId === messageId);
}

/**
 * The display of a trigger from the server's own records, or null when they
 * do not bear it out: its channel is unknown, its message is unknown or
 * posted elsewhere (messageBelongsTo), or a thread's parent channel is
 * unknown.
 */
export function resolveTriggerDisplay(trigger: ActivityTurnTrigger, facts: TurnTriggerFacts): ActivityTurnTriggerDisplay | null {
  const channel = trigger.channelId ? facts.channels.get(trigger.channelId) : undefined;
  if (!channel || !trigger.channelId) return null;
  const message = trigger.messageId ? facts.messages.get(trigger.messageId) : undefined;
  if (trigger.messageId && !(message && messageBelongsTo(message, trigger.messageId, trigger.channelId, channel))) return null;
  const sender = message?.senderName ? { senderName: message.senderName } : {};
  const sub = channel.type === "thread" || channel.type === "task";
  const place = sub ? channel.parent : channel;
  if (!place) return null;
  if (place.type === "dm") {
    // The DM's peer only when no message names the sender (and only a DM's own, not a DM thread's).
    const peer = !message && channel.dmPeerName ? { peerName: channel.dmPeerName } : {};
    return { kind: "dm", ...sender, ...peer };
  }
  return { kind: sub ? "thread" : "channel", channelName: place.name, ...sender };
}

/**
 * Finished turns and the running one alike, as the viewer may see them. The
 * summaries come from readers that already keep only what a producer owns
 * (readDaemonTurnSummary for stored rows; the server folds the running turn
 * itself); the trigger is rebuilt here from its known fields
 * (readActivityTurnTrigger) because this is where its server-owned fields
 * (`hidden`, `unresolved`, `display`) are set.
 *
 * One access check per distinct channel, then one batched lookup
 * (`loadTriggerFacts`) of the channels and messages the visible triggers
 * name; a trigger the viewer cannot see is never looked up.
 */
export async function viewTurnSummaries<T extends WithTrigger>(
  summaries: readonly T[],
  canViewerAccessChannel: (channelId: string) => Promise<boolean>,
  loadTriggerFacts: (refs: TurnTriggerRefs) => Promise<TurnTriggerFacts>,
): Promise<ActivityTurnSummaryView<T>[]> {
  const access = new Map<string, boolean>();
  type Pending = { rest: Omit<T, "trigger">; trigger?: ActivityTurnTrigger; visible: boolean };
  const pending: Pending[] = [];
  for (const summary of summaries) {
    const { trigger: rawTrigger, ...rest } = summary;
    const trigger = rawTrigger === undefined ? undefined : readActivityTurnTrigger(rawTrigger);
    // App events name no channel or person (attachTriggerAppEvents names the app).
    if (!trigger || trigger.target?.startsWith("agent-event:")) {
      pending.push({ rest, trigger, visible: true });
      continue;
    }
    let allowed = false;
    if (trigger.channelId) {
      if (!access.has(trigger.channelId)) {
        access.set(trigger.channelId, await canViewerAccessChannel(trigger.channelId).catch(() => false));
      }
      allowed = access.get(trigger.channelId)!;
    }
    pending.push({ rest, trigger, visible: allowed });
  }
  const refs: TurnTriggerRefs = { channelIds: [], messageIds: [], dmPeerChannelIds: [] };
  for (const { trigger, visible } of pending) {
    if (!visible || !trigger?.channelId || trigger.target?.startsWith("agent-event:")) continue;
    refs.channelIds.push(trigger.channelId);
    if (trigger.messageId) refs.messageIds.push(trigger.messageId);
    else refs.dmPeerChannelIds.push(trigger.channelId);
  }
  const distinct = (ids: string[]) => [...new Set(ids)];
  const lookups = { channelIds: distinct(refs.channelIds), messageIds: distinct(refs.messageIds), dmPeerChannelIds: distinct(refs.dmPeerChannelIds) };
  const facts: TurnTriggerFacts = lookups.channelIds.length === 0
    ? { channels: new Map(), messages: new Map() }
    : await loadTriggerFacts(lookups);
  return pending.map(({ rest, trigger, visible }): ActivityTurnSummaryView<T> => {
    if (!trigger) return rest;
    if (trigger.target?.startsWith("agent-event:")) return { ...rest, trigger };
    if (!visible) {
      // The agent's own output may quote the conversation the viewer cannot see.
      const shown: Omit<T, "trigger"> & { lastText?: unknown } = { ...rest };
      delete shown.lastText;
      return { ...shown, trigger: { hidden: trigger.target?.startsWith("dm:") ? "dm" : "private_channel" } };
    }
    const display = resolveTriggerDisplay(trigger, facts);
    return display ? { ...rest, trigger: { ...trigger, display } } : { ...rest, trigger: { unresolved: true } };
  });
}

/** Most message ids one turn lists; the rest are only counted. */
export const TURN_SENT_MESSAGES_LIMIT = 50;
/** How far past a page's outer turn a message may still belong to it when no neighbour turn bounds it (clock skew). */
export const TURN_SENT_EDGE_MS = 60_000;

type TurnTimes = { startedAt: number; endedAt: number; lastReplyMessageId?: string };

/**
 * The span of server time each turn owns, in the order given, for placing
 * what happened on the server (messages sent, app events delivered) in turns.
 *
 * Turn times come from the daemon's clock and server times from the
 * server's, so turns split server time between them: each boundary sits
 * halfway into the idle gap, and never before the older turn's own last
 * reply (looked up in `sends`), so a few seconds of skew cannot hand a turn's
 * work to the next one. `neighbours` are the turns just outside the page:
 * they take part in the split but get no window, so something at a page edge
 * belongs to the same turn on both pages. The outermost turns reach
 * TURN_SENT_EDGE_MS past their own times. Windows are [from, to).
 */
export function turnWindows(
  summaries: readonly TurnTimes[],
  options: { neighbours?: readonly TurnTimes[]; sends?: readonly { at: number; messageId: string }[] } = {},
): Array<{ from: number; to: number }> {
  const sentAt = new Map((options.sends ?? []).map((send) => [send.messageId, send.at]));
  const replyAt = (turn: TurnTimes) => (turn.lastReplyMessageId ? sentAt.get(turn.lastReplyMessageId) : undefined);
  const turns = [
    ...summaries.map((turn, index) => ({ turn, index })),
    ...(options.neighbours ?? []).map((turn) => ({ turn, index: -1 })),
  ].sort((a, b) => a.turn.startedAt - b.turn.startedAt || a.turn.endedAt - b.turn.endedAt);
  // boundaries[k] splits turns[k] from turns[k + 1]; kept non-decreasing so
  // overlapping turn times cannot give one thing to two turns.
  const boundaries: number[] = [];
  for (let k = 0; k + 1 < turns.length; k += 1) {
    const older = turns[k]!.turn;
    const ownReply = replyAt(older);
    boundaries.push(Math.max(
      (older.endedAt + turns[k + 1]!.turn.startedAt) / 2,
      ownReply === undefined ? -Infinity : ownReply + 1,
      boundaries.at(-1) ?? -Infinity,
    ));
  }
  const windows: Array<{ from: number; to: number }> = Array.from({ length: summaries.length });
  turns.forEach(({ turn, index }, k) => {
    if (index < 0) return;
    windows[index] = {
      from: k > 0 ? boundaries[k - 1]! : turn.startedAt - TURN_SENT_EDGE_MS,
      to: k + 1 < turns.length ? boundaries[k]! : turn.endedAt + TURN_SENT_EDGE_MS,
    };
  });
  return windows;
}

/**
 * Every message a turn sent, for the overview to list (xxchan): the ones the
 * viewer can see by id, in order, and only a count of the rest, so a private
 * channel or DM the viewer is not in is never named or linked.
 *
 * Turns split server time as `turnWindows` does (an agent sends only during
 * a turn, so the idle gap between turns holds no sends). A turn whose
 * window starts at or before `listedFromMs` (the oldest send a truncated
 * query returned) gets no list and keeps the last-reply card.
 */
export async function attachTurnSentMessages<T extends TurnTimes>(
  summaries: readonly T[],
  sends: readonly { at: number; messageId: string; channelId: string }[],
  canViewerAccessChannel: (channelId: string) => Promise<boolean>,
  options: { listedFromMs?: number; neighbours?: readonly TurnTimes[] } = {},
): Promise<Array<T & { sentMessageIds?: string[]; sentMessageCount?: number; hiddenSentCount?: number }>> {
  const windows = turnWindows(summaries, { neighbours: options.neighbours, sends });
  const chronological = [...sends].sort((a, b) => a.at - b.at);
  const access = new Map<string, boolean>();
  const out: Array<T & { sentMessageIds?: string[]; sentMessageCount?: number; hiddenSentCount?: number }> = [];
  for (const [index, summary] of summaries.entries()) {
    const window = windows[index]!;
    if (options.listedFromMs !== undefined && window.from <= options.listedFromMs) {
      out.push(summary);
      continue;
    }
    const inTurn = chronological.filter((send) => send.at >= window.from && send.at < window.to);
    if (inTurn.length === 0) {
      out.push(summary);
      continue;
    }
    const visible: string[] = [];
    let hidden = 0;
    for (const send of inTurn) {
      if (!access.has(send.channelId)) access.set(send.channelId, await canViewerAccessChannel(send.channelId).catch(() => false));
      if (access.get(send.channelId)) visible.push(send.messageId);
      else hidden += 1;
    }
    out.push({
      ...summary,
      sentMessageIds: visible.slice(0, TURN_SENT_MESSAGES_LIMIT),
      sentMessageCount: visible.length,
      ...(hidden > 0 ? { hiddenSentCount: hidden } : {}),
    });
  }
  return out;
}

/**
 * The app events (Stamp PR/CI events, Reminder firings, ...) delivered to the
 * agent in each turn's window, the same windows as its sent messages
 * (`turnWindows`, with the same `neighbours` and `sends`), oldest first: the
 * first ACTIVITY_TURN_APP_EVENTS_LIMIT and the count. A turn whose window
 * starts at or before `listedFromMs` (the oldest delivery a truncated query
 * returned) gets none rather than a partial list.
 */
export function attachTurnAppEvents<T extends TurnTimes>(
  summaries: readonly T[],
  events: readonly ActivityTurnAppEventView[],
  options: { listedFromMs?: number; neighbours?: readonly TurnTimes[]; sends?: readonly { at: number; messageId: string }[] } = {},
): Array<T & { appEvents?: ActivityTurnAppEventView[]; appEventCount?: number }> {
  const windows = turnWindows(summaries, options);
  const chronological = [...events].sort((a, b) => a.deliveredAt - b.deliveredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return summaries.map((summary, index) => {
    const window = windows[index]!;
    if (options.listedFromMs !== undefined && window.from <= options.listedFromMs) return summary;
    const inTurn = chronological.filter((event) => event.deliveredAt >= window.from && event.deliveredAt < window.to);
    if (inTurn.length === 0) return summary;
    return {
      ...summary,
      // Only the fields the overview shows, whatever the caller passed in.
      appEvents: inTurn.slice(0, ACTIVITY_TURN_APP_EVENTS_LIMIT).map(({ id, appName, clientKey, logoUrl, summary: text, deliveredAt, kind }) => ({
        id, appName, clientKey, logoUrl: logoUrl ?? null, summary: text, deliveredAt, kind,
      })),
      appEventCount: inTurn.length,
    };
  });
}

/** The `<id8>` of a turn woken by an app event (`agent-event:<id8>`), or null. */
export function triggerAppEventRef(trigger: ActivityTurnTriggerView | undefined): string | null {
  if (!trigger || trigger.hidden !== undefined || trigger.unresolved) return null;
  return trigger.target?.startsWith("agent-event:") ? trigger.target.slice("agent-event:".length) : null;
}

/**
 * Names the app event that woke each turn woken by one (`trigger.appEvent`),
 * from `resolved` (by reference, see resolveAgentAppEventRefs). A reference
 * that did not resolve (pruned, ambiguous) keeps the bare trigger, which
 * reads as the generic "handling an app event".
 */
export function attachTriggerAppEvents<T extends { trigger?: ActivityTurnTriggerView }>(
  summaries: readonly T[],
  resolved: ReadonlyMap<string, ActivityTurnTriggerAppEvent>,
): T[] {
  return summaries.map((summary) => {
    const ref = triggerAppEventRef(summary.trigger);
    const appEvent = ref === null ? undefined : resolved.get(ref);
    if (!appEvent || !summary.trigger || summary.trigger.hidden !== undefined || summary.trigger.unresolved) return summary;
    return { ...summary, trigger: { ...summary.trigger, appEvent: { appName: appEvent.appName, summary: appEvent.summary } } };
  });
}
