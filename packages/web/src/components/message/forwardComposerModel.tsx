import { useCallback, useReducer, useRef } from "react";
import type { ReactNode } from "react";
import type { IntlShape } from "react-intl";
import { FORWARD_TOO_MANY_MESSAGES_CODE, MAX_FORWARD_DESTINATIONS, MAX_FORWARD_MESSAGES, PLAN_CONFIG } from "@botiverse/raft-shared";
import api from "../../api/client";
import type { Channel } from "../../store/channelStore";
import type { ConversationContext, Message } from "../../store/messageStore";
import { channelLabel } from "../pickers/ChannelPicker";
import { isJointChannelReadOnly } from "../../utils/jointChannelLimit";

export { MAX_FORWARD_DESTINATIONS, MAX_FORWARD_MESSAGES };
export type MobileForwardStep = "targets" | "preview" | "detail";
export type JoinActionStatus = "idle" | "joining";

export function canForwardToTarget(channel: Channel): boolean {
  if (channel.archivedAt || channel.type === "thread") return false;
  if (channel.type === "dm") return true;
  if (isJointChannelReadOnly(channel)) return false;
  return channel.joined === true;
}

export function composerSourceLabel(channel: Channel, sourceLabelText: string, hasExplicitSourceLabel: boolean) {
  if (hasExplicitSourceLabel || channel.type === "thread" || channel.type === "dm") return sourceLabelText;
  return `#${channel.name}`;
}

export function composerLabelVisibility(channel: Channel) {
  return channel.type === "channel" || channel.type === "thread" ? "public" : "restricted";
}

function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function orderForwardSourceMessages(messages: Message[], sourceChannel: Channel): Message[] {
  return messages
    .map((message, position) => ({
      message,
      position,
      isThreadParent: sourceChannel.type === "thread" && message.channelId !== sourceChannel.id,
    }))
    .sort((a, b) => {
      if (a.isThreadParent !== b.isThreadParent) return a.isThreadParent ? -1 : 1;
      const aTime = timestampMs(a.message.createdAt);
      const bTime = timestampMs(b.message.createdAt);
      if (aTime !== bTime) return aTime - bTime;
      const aSeq = typeof a.message.seq === "number" ? a.message.seq : null;
      const bSeq = typeof b.message.seq === "number" ? b.message.seq : null;
      if (aSeq !== null && bSeq !== null && aSeq !== bSeq) return aSeq - bSeq;
      if (aSeq !== null && bSeq === null) return -1;
      if (aSeq === null && bSeq !== null) return 1;
      const idResult = a.message.id.localeCompare(b.message.id);
      return idResult || a.position - b.position;
    })
    .map(({ message }) => message);
}

export function getForwardTargets(
  channelTargets: Channel[],
  dmTargets: Channel[],
  lowerQuery: string,
  channelActivity: Record<string, string | null> = {},
) {
  const matches = (target: Channel) => !lowerQuery
    || channelLabel(target).toLowerCase().includes(lowerQuery)
    || target.name.toLowerCase().includes(lowerQuery)
    || (target.peerName ?? "").toLowerCase().includes(lowerQuery)
    || (target.peerDisplayName ?? "").toLowerCase().includes(lowerQuery);

  return [...channelTargets, ...dmTargets]
    .filter(matches)
    .sort((a, b) => {
      const aTime = timestampMs(channelActivity[a.id]) || timestampMs(a.createdAt);
      const bTime = timestampMs(channelActivity[b.id]) || timestampMs(b.createdAt);
      if (aTime !== bTime) return bTime - aTime;
      const labelResult = channelLabel(a).localeCompare(channelLabel(b), undefined, { sensitivity: "base", numeric: true });
      return labelResult || a.id.localeCompare(b.id);
    });
}

export type ForwardSearchTarget = {
  /** `thread` / `task`: a thread or a task's discussion, forwarded into like a reply (rows of their own, below). */
  type: "channel" | "dm" | "human" | "agent" | "thread" | "task";
  /** A thread / task row's is `thread` / `task`; its parent channel's is `parentChannelType`. */
  channelType: "channel" | "private" | "joint" | "dm" | "thread" | "task" | null;
  /** A thread / task row's is its conversation channel's (as `channelId`), not a parent message's or a task's. */
  id: string;
  title: string;
  subtitle: string;
  avatarUrl: string | null;
  channelId: string | null;
  joined: boolean | null;
  dmExists: boolean | null;
  canForwardNow: boolean;
  requiredAction: "join_channel" | "create_dm" | null;
  /**
   * Set by a search across the reader's servers (the public Artifact page's
   * Send to conversation): the server it is in, and its name for the row.
   * Absent: the current server's, as the search answers it.
   */
  serverId?: string;
  serverName?: string;
  /**
   * A thread or task row (recent conversations, or search): the channel it is
   * in, the task's number and title, the thread's parent message's first
   * line, and, in the recent group, whether it is the one the forward was
   * opened from. Its `channelId` is the thread / task conversation's.
   */
  parentChannelId?: string | null;
  parentChannelName?: string | null;
  parentChannelType?: "channel" | "private" | "joint" | "dm" | null;
  taskNumber?: number;
  taskTitle?: string;
  parentMessagePreview?: string;
  current?: boolean;
};

/** A thread or a task discussion: a conversation inside a channel, not one of its own. */
export function isConversationTarget(target: ForwardSearchTarget): boolean {
  return target.type === "thread" || target.type === "task";
}

/** The most recent threads and tasks the picker offers (the server caps it too). */
export const FORWARD_CONVERSATION_TARGET_LIMIT = 4;

export type SelectedDestination = {
  key: string;
  label: string;
  localTarget?: Channel;
  searchTarget?: ForwardSearchTarget;
  resolvedChannelId?: string;
};

/** A chosen destination as a source sees it: its channel once known (a new DM, or a channel to join, has none yet). */
export type ForwardSelection = {
  key: string;
  label: string;
  channelId: string | null;
  kind: "channel" | "private" | "joint" | "dm";
  /** The server it is in, when a search across servers found it; absent: the current server. */
  serverId?: string;
};

/** A destination resolved for sending: its channel (joined or created), one per channel. */
export type ForwardResolved = ForwardSelection & { channelId: string; destination: Channel };

/** What a send posted in one destination. */
export type ForwardSent = {
  channelId: string;
  messageId: string;
  /** The server it was posted in, when not the current one could be: no "View in chat" for another server's. */
  serverId?: string;
  /** The posted message's conversation (a thread's or a task's), for "View in chat". */
  context?: ConversationContext;
};

/**
 * What a send did: where it posted, and the destinations it held back for
 * the person to decide first (not a failure: no error, they stay chosen),
 * with the line that says so.
 */
export type ForwardOutcome = { sent: ForwardSent[]; held: { channelIds: string[]; message: string } | null };

/** Where a source's preview is drawn: the desktop's right column, the phone's note page, or its full detail page. */
export type ForwardPreviewPlace = "desktop" | "phone" | "detail";

/**
 * What the Forward dialog forwards (#proj-workspace:#99): messages, or an
 * Artifact. The dialog owns the destinations (search, multi-select, joining,
 * new DMs), the note box and the outcome toasts; the source owns what is
 * shown and how it is delivered to each destination.
 */
export interface ForwardSource {
  title: string;
  /** Under the title: what is forwarded, from where; null: nothing (an Artifact: its preview card says what it is). */
  summary: string | null;
  sendLabel: string;
  /** The phone's detail page title; null: the preview has no "show all". */
  detailTitle: string | null;
  renderPreview: (place: ForwardPreviewPlace, openDetail: () => boolean) => ReactNode;
  /** Above the preview, after the dialog's own warnings: what the source says about the chosen destinations. */
  notices: ReactNode;
  /** Why it can't be sent now; null when it can. */
  blockedReason: string | null;
  /** Whether a joint channel destination gets the forwarded-snapshot warning (messages: yes; an Artifact says who can't see it itself). */
  warnsJoint: boolean;
  note: {
    /** The note's draft key. */
    draftKey: string;
    maxLength: number;
    /** Plain text: no @ or # picker (a note the server resolves no mentions in). */
    plainText: boolean;
  };
  /**
   * Delivers to the resolved destinations; resolves with those it posted in
   * and those it held back (the rest failed; all of them stay selected to
   * try again). Rejects with an Error whose message says why when nothing
   * could be tried.
   */
  send: (destinations: ForwardResolved[], note: string) => Promise<ForwardOutcome>;
}

export type ForwardBatchResult =
  | { destinationChannelId: string; status: "success"; message: Message }
  | { destinationChannelId: string; status: "failed"; code: string; error: string };
export type ForwardBatchResponse = { results: ForwardBatchResult[] };
export type ForwardDelivery = { message: Message; destination: Channel };

export function localSelectionKey(serverId: string, channelId: string) {
  return `channel:${serverId}:${channelId}`;
}

export function searchSelectionKey(serverId: string, target: ForwardSearchTarget) {
  return target.channelId ? localSelectionKey(serverId, target.channelId) : `${target.type}:${serverId}:${target.id}`;
}

export function searchTargetChannelType(target: ForwardSearchTarget): Channel["type"] {
  if (target.type === "dm" || target.type === "human" || target.type === "agent") return "dm";
  if (isConversationTarget(target)) return "thread";
  if (target.channelType === "private" || target.channelType === "joint") return target.channelType;
  return "channel";
}

export function fallbackDestination(target: ForwardSearchTarget, channelId: string): Channel {
  return {
    id: channelId,
    name: target.title.replace(/^[@#]/, ""),
    description: null,
    type: searchTargetChannelType(target),
    createdAt: new Date(0).toISOString(),
    joined: true,
  };
}

export function composerError(message: string) {
  return { response: { data: { error: message } } };
}

export function forwardRequestFailureMessage(
  error: unknown,
  formatMessage: IntlShape["formatMessage"],
): string {
  const code = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
  switch (code) {
    case "cross_source_bundle": return formatMessage({ id: "message.forwardComposer.crossSource" });
    case "source_not_found": return formatMessage({ id: "message.forwardComposer.sourceNotFound" });
    // A selected message aged past the Free plan's history window while the composer was open.
    case "history_limited": return formatMessage({ id: "message.forwardComposer.historyLimited" }, { days: PLAN_CONFIG.free.limits.messageHistoryDays });
    case "forwarded_source_not_supported": return formatMessage({ id: "message.forwardComposer.forwardedSourceUnsupported" });
    case "unsupported_source_message":
    case "unsupported_source": return formatMessage({ id: "message.forwardComposer.unsupportedSource" });
    case "cross_server_source": return formatMessage({ id: "message.forwardComposer.crossServerSource" });
    case FORWARD_TOO_MANY_MESSAGES_CODE: return formatMessage({ id: "message.forwardComposer.tooManyMessages" }, { max: MAX_FORWARD_MESSAGES });
    default: return formatMessage({ id: "message.forwardComposer.uncertainOutcome" });
  }
}

type SearchState = { results: ForwardSearchTarget[]; loading: boolean; failed: boolean };
type SearchAction =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "success"; targets: ForwardSearchTarget[] }
  | { type: "error" };

function searchReducer(_state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case "idle": return { results: [], loading: false, failed: false };
    case "loading": return { results: [], loading: true, failed: false };
    case "success": return { results: action.targets, loading: false, failed: false };
    case "error": return { results: [], loading: false, failed: true };
  }
}

export function useForwardSearch() {
  const [state, dispatch] = useReducer(searchReducer, { results: [], loading: false, failed: false });
  const activeRequestRef = useRef(0);
  const search = useCallback((q: string) => {
    const requestId = ++activeRequestRef.current;
    dispatch({ type: "loading" });
    api.get<{ targets: ForwardSearchTarget[] }>("/messages/forward/targets/search", { params: { q, limit: 20 } })
      .then((res) => {
        if (requestId === activeRequestRef.current) dispatch({ type: "success", targets: res.data.targets });
      })
      .catch(() => {
        if (requestId === activeRequestRef.current) dispatch({ type: "error" });
      });
  }, []);
  const reset = useCallback(() => {
    ++activeRequestRef.current;
    dispatch({ type: "idle" });
  }, []);
  return { ...state, search, reset };
}

/**
 * The destinations' search as the dialog reads it: its own (useForwardSearch,
 * the current server), or one a host injects (a search across servers).
 * `partialFailure`: some of the servers searched didn't answer; their rows are
 * missing, the rest show (a line under them says which).
 */
export type ForwardSearchHandle = ReturnType<typeof useForwardSearch> & { partialFailure?: string | null };
