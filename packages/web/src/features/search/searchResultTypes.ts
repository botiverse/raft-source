import type { resolveMessageSenderMemberFromList } from "../../utils/messageSenderMember";
import type { DelegatedByWire } from "../../components/message/delegatedMessage";
import type { AppSearchHit } from "./AppSearchGroupSection";
import type { SearchEntityResult as SearchEntityRecord } from "./searchEntities";
import { OVERLAY_ALL_RESULTS_KEY } from "./searchConstants";

export type SelectableSearchResult =
  | { key: string; kind: "entity"; result: SearchEntityRecord }
  | { key: string; kind: "appHit"; hit: AppSearchHit }
  | { key: string; kind: "message"; result: MessageSearchResult }
  | { key: string; kind: "allResults" };

export const OVERLAY_ALL_RESULTS_ROW: SelectableSearchResult = { key: OVERLAY_ALL_RESULTS_KEY, kind: "allResults" };

export function isSelectableRow(row: SelectableSearchResult | null): row is SelectableSearchResult {
  return row !== null;
}

export interface MessageSearchResult {
  id: string;
  channelId: string;
  threadId: string | null;
  parentMessageId: string | null;
  parentMessageContent: string | null;
  parentChannelId: string;
  parentChannelName: string;
  parentChannelType: "channel" | "private" | "joint" | "dm" | "thread";
  parentChannelArchivedAt: string | null;
  senderId: string;
  senderType: "user" | "agent" | "external_projection";
  senderName: string;
  senderAvatarUrl: string | null;
  externalMessage?: unknown;
  channelName: string;
  /** `task`: a hit in a task's own conversation (task v2); its parent channel
   *  is the task's channel and it has no parent message. */
  channelType: "channel" | "private" | "joint" | "dm" | "thread" | "task";
  channelArchivedAt: string | null;
  /** Task v2, task conversation hits: the task the conversation belongs to. */
  taskId?: string | null;
  taskNumber?: number | null;
  taskTitle?: string | null;
  content: string;
  snippet: string;
  createdAt: string;
  /** RFC 077: the assistant that sent it for its sender; absent from older servers. */
  delegatedBy?: DelegatedByWire | null;
  /** RFC 077: its owner retracted it (content is the placeholder); absent from older servers. */
  retracted?: boolean;
}

export interface SenderFilterOption {
  key: string;
  id: string;
  type: "user" | "agent";
  label: string;
  handle: string;
  isSelf?: boolean;
  avatarUrl?: string | null;
  email?: string | null;
}

export type SearchSenderMember = ReturnType<typeof resolveMessageSenderMemberFromList>;
