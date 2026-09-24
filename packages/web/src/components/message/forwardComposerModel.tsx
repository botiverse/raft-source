import { useCallback, useReducer, useRef } from "react";
import { GitBranch, Hash, Lock } from "lucide-react";
import type { IntlShape } from "react-intl";
import api from "../../api/client";
import type { Channel } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import AvatarSlot from "../ui/AvatarSlot";

export const MAX_FORWARD_DESTINATIONS = 10;
export type MobileForwardStep = "targets" | "preview" | "detail";
export type JoinActionStatus = "idle" | "joining";

export function targetLabel(channel: Channel) {
  if (channel.type === "dm") return `@${channel.peerDisplayName || channel.peerName || channel.name}`;
  return `#${channel.name}`;
}

export function targetPickerLabel(channel: Channel) {
  return channel.type === "dm" ? targetLabel(channel) : channel.name;
}

export function targetIcon(channel: Channel) {
  if (channel.type === "dm" && channel.peerType === "agent") {
    return <AvatarSlot context="compact-list" type="agent" agentAvatarUrl={channel.peerAvatarUrl ?? null} />;
  }
  if (channel.type === "dm") {
    return (
      <AvatarSlot
        context="compact-list"
        type="human"
        humanAvatarUrl={channel.peerAvatarUrl ?? null}
        gravatarHash={channel.peerGravatarHash ?? null}
        humanPlaceholder={!channel.peerAvatarUrl && !channel.peerGravatarHash}
      />
    );
  }
  if (channel.type === "joint") return <GitBranch size={14} />;
  if (channel.type === "private") return <Lock size={14} />;
  return <Hash size={14} />;
}

export function canForwardToTarget(channel: Channel): boolean {
  if (channel.archivedAt || channel.type === "thread") return false;
  if (channel.type === "dm") return true;
  if (channel.type === "joint" && channel.jointBillingLocked === true) return false;
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
    || targetLabel(target).toLowerCase().includes(lowerQuery)
    || target.name.toLowerCase().includes(lowerQuery)
    || (target.peerName ?? "").toLowerCase().includes(lowerQuery)
    || (target.peerDisplayName ?? "").toLowerCase().includes(lowerQuery);

  return [...channelTargets, ...dmTargets]
    .filter(matches)
    .sort((a, b) => {
      const aTime = timestampMs(channelActivity[a.id]) || timestampMs(a.createdAt);
      const bTime = timestampMs(channelActivity[b.id]) || timestampMs(b.createdAt);
      if (aTime !== bTime) return bTime - aTime;
      const labelResult = targetLabel(a).localeCompare(targetLabel(b), undefined, { sensitivity: "base", numeric: true });
      return labelResult || a.id.localeCompare(b.id);
    });
}

export type ForwardSearchTarget = {
  type: "channel" | "dm" | "human" | "agent";
  channelType: "channel" | "private" | "joint" | "dm" | null;
  id: string;
  title: string;
  subtitle: string;
  avatarUrl: string | null;
  channelId: string | null;
  joined: boolean | null;
  dmExists: boolean | null;
  canForwardNow: boolean;
  requiredAction: "join_channel" | "create_dm" | null;
};

export type SelectedDestination = {
  key: string;
  label: string;
  localTarget?: Channel;
  searchTarget?: ForwardSearchTarget;
  resolvedChannelId?: string;
};

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

function searchTargetChannelType(target: ForwardSearchTarget): Channel["type"] {
  if (target.type === "dm" || target.type === "human" || target.type === "agent") return "dm";
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
    case "forwarded_source_not_supported": return formatMessage({ id: "message.forwardComposer.forwardedSourceUnsupported" });
    case "unsupported_source_message":
    case "unsupported_source": return formatMessage({ id: "message.forwardComposer.unsupportedSource" });
    case "cross_server_source": return formatMessage({ id: "message.forwardComposer.crossServerSource" });
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
