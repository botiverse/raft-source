import { memo, useCallback, useEffect, useMemo, useRef, useState, Children } from "react";
import type { ChangeEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode, TouchEvent } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Copy, MessageSquare, MessageCirclePlus, MessageCircleOff, Download, ClipboardCheck, Play, Pause, Volume2, CheckCircle, RotateCcw, Link, Bookmark, BookmarkMinus, Languages, AlertTriangle, Plus, Eye, Music, ExternalLink } from "lucide-react";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger, Skeleton } from "raft-ui";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import { useStore } from "zustand";
import {
  messageReactionActorsDiscussion,
  messageRef as canonicalMessageRef,
  TOPBAR_OVERFLOW_FEATURE_FLAG_KEY,
} from "@botiverse/raft-shared";
import type {
  ActionCardMetadata,
  ReactionActorRef,
} from "@botiverse/raft-shared";
import { useMessageStore } from "../../store/messageStore";
import type { Message, MessageAttachment, MessageMention } from "../../store/messageStore";
import { ActionCard } from "../actions/ActionCard";
import { useAuthStore } from "../../store/authStore";
import type { Channel } from "../../store/channelStore";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import type { ServerMember } from "../../store/serverStore";
import type { ChannelHuman } from "../../hooks/useChannelMembers";
import { useChannelStore } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";

import { useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";
import { StatusBadge } from "../task/StatusBadge";
// Parked with its render site below — see the note there.
// import TaskChipList from "../task/TaskChipList";
import { useThreadStore } from "../../store/threadStore";
import type { OpenThreadRequest, ThreadSummary } from "../../store/threadStore";
import { hasInlineThreadReplySurface, InlineThreadReplies } from "./InlineThreadReplies";
import { useSavedStore } from "../../store/savedStore";
import { useSelectionStore } from "../../store/selectionStore";
import { useAppNavigate, buildMessagePermalink } from "../../hooks/useAppNavigate";
import { useProfileStore } from "../../store/profileStore";
import { setCachedAgentProfile } from "../profile/profileFallbackCache";
import { useServerStore } from "../../store/serverStore";
import { useTranslationStore } from "../../store/translationStore";
import type { PreferredTranslationDisplay, TranslationEntry } from "../../store/translationStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import { getMessageBodyFontSizeClass, useAppearanceStore } from "../../store/appearanceStore";
import api from "../../api/client";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import type { LightboxCommentContext } from "../../store/imageLightboxStore";
import {
  createRaftBareTaskRefRegex,
  createRaftChannelRefRegex,
  createRaftChannelThreadRefRegex,
  createRaftDmThreadRefRegex,
  createRaftMessageRefRegex,
  createRaftStructuredUserRefRegex,
  createRaftUserRefRegex,
  formatRaftRefTarget,
  parseRaftRefTarget,
  replaceOutsideMarkdownCode,
  parseRaftPermalink,
} from "@botiverse/raft-shared";
import type {
  RaftRefTarget,
} from "@botiverse/raft-shared";
import QuotedMessagePermalinkPreview from "./QuotedMessagePermalinkPreview";
import {
  extractFirstQuotedMessagePermalink,
  matchesUnavailableQuotedPermalink,
} from "./quotedMessagePermalink";
import MentionLink from "./MentionLink";
import { MSG_REF_CHIP } from "./messageRefChip";
import { ReferenceChip } from "./ReferenceChip";
import ProfilePreviewCardContent from "./ProfilePreviewCardContent";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { agentModelLabel, useShowAgentModelName } from "../../utils/agentModelName";
import StatusDot from "../ui/StatusDot";
import type { StatusDotProps } from "../ui/StatusDot";
import { formatActivityText } from "../../utils/activity";
import { formatFileSizeBytes } from "../../utils/fileSizePresentation";
import AvatarSlot from "../ui/AvatarSlot";
import ContextMenuDivider from "../ui/ContextMenuDivider";
import MenuItem from "../ui/MenuItem";
import DismissBackdrop from "../ui/DismissBackdrop";
import CheckMarker from "../ui/CheckMarker";
import Spinner from "../ui/Spinner";
import { isAudioPreviewAttachment, isDiffPatchAttachment, isDocumentPreviewAttachment, isVideoPreviewAttachment } from "./attachmentPreview";
import type { DiffAttachmentPreview, DocumentAttachmentPreview } from "./attachmentPreview";
import MarkdownContent from "../markdown/MarkdownContent";
import { MessageReadReceiptScopeProvider } from "./messageReadReceiptScope";
import type { MessageReadReceiptScope } from "./messageReadReceiptScope";
import { projectReadReceipt } from "../../store/readReceiptDomain";
import { useReadReceiptStore } from "../../store/readReceiptStore";
import { buildLegacyTaskWindowUrl, buildThreadWindowUrl, openPanelInNewTab } from "../../utils/openPanelInNewTab";
import { MarkdownCode } from "../markdown/MarkdownContent";
import { fetchAttachmentPreviewSummary } from "./attachmentPreviewSummaryCache";
import { fetchInlineAttachmentUrls } from "./inlineAttachmentUrlCache";
import { openDocumentPreview } from "./openDocumentPreview";
import { openMediaPreview } from "./openMediaPreview";
import { useMediaPreviewStore } from "../../store/mediaPreviewStore";
import { useDocumentPreviewStore } from "../../store/documentPreviewStore";
import { DOCUMENT_PREVIEW_LABEL_ID, INLINE_AUDIO_PREVIEW_CARD_CLASS } from "./attachmentPreviewSurfaces";
import { parseTimestampLabel, setPendingVideoSeek } from "./attachmentCommentAnchors";
import { useAttachmentCommentsEnabled } from "./useAttachmentCommentsEnabled";
import {
  READ_RECEIPTS_FEATURE_FLAG_KEY,
  SYNC_CORE_MESSAGES_FLAG_KEY,
  useServerFeatureFlag,
} from "../../store/serverFeatureFlags";
import {
  isCanonicalMessageReaction,
  isLegacyMessageReaction,
  messageReactionParentScopeKey,
  applyMessageReactionsForV2Ingress,
  isMessageV2IngressSoleApplyEligible,
} from "../../store/normalizedMessageReactions";
import type { SyncScopeKey } from "@botiverse/raft-shared";
import {
  reactionReadModelStore,
  selectReactionActors,
  selectReactionViewerOverlay,
} from "../../store/reactionReadModels";
import { setMessageReaction } from "../../store/reactionCommandFacade";
import {
  applyReactionViewerSnapshotForCurrentPrincipal,
  hydrateReactionViewerSnapshot,
} from "../../store/reactionViewerReadModel";
import { AttachmentCommentRefChip } from "./AttachmentCommentRefChip";
import { shouldShowGroupedMessageHeader } from "./messageGrouping";
import type { MessageGroupState } from "./messageGrouping";
import { MessageHoverToolbar } from "./MessageHoverToolbar";
import { AttachmentChip } from "./AttachmentChip";
import { getHumanDepartureLabel } from "../member/humanMembershipStatus";
import {
  buildImageInlineFallbackKey,
  getImageGalleryPreviewSrc,
  isOptimisticAttachment,
  isPreviewableImageAttachment,
  removeImageInlineFallbackUrl,
  retainImageInlineFallbackUrls,
  setImageInlineFallbackUrl,
  shouldRenderImageAsAttachmentChip,
  splitImageInlineFallbackKey,
} from "./urlImageFallback";
import { ThreadRepliesBadge } from "./ThreadRepliesBadge";
import CollapsibleMessageContent from "./CollapsibleMessageContent";

import { formatReminderReceiptContentTitle, formatReminderReceiptTime, formatReminderReceiptTooltip, splitReminderReceiptFireAtTokens } from "../../utils/reminderReceiptTime";
import { imageGalleryBackgroundClass } from "../../utils/imagePreviewStyles";
import { resolveMessageSenderMember } from "../../utils/messageSenderMember";
import { isRaftUploadedHumanAvatarUrl } from "../../utils/humanAvatar";
import type { TimeFormatOptions } from "../../utils/timeFormatting";
import {
  buildThreadRefHandoffPath,
  captureThreadRouteAuthorityGuard,
  findThreadRefParentChannel,
  resolveThreadTargetByShortId,
} from "../../utils/threadRefNavigation";
import type {
  ThreadRefIntent,
  ThreadRouteTarget,
} from "../../utils/threadRefNavigation";
import { escapeUserRawHtmlForMessageMarkdown, messageMarkdownSanitizeSchema } from "./messageMarkdownSecurity";
import { highlightThreadSearchMarkdownFragments, normalizeThreadSearchQuery } from "./threadSearch";
import { QUICK_REACTION_EMOJIS } from "./reactionConstants";
import ReactionGlyph from "./ReactionGlyph";
import { useFloatingOverlayPosition } from "../ui/useFloatingOverlayPosition";
import { placeTouchMessageContextMenu } from "./messageContextMenuPosition";
import { isForwardedBundleMetadata } from "./ForwardedBundleCard";
import type { ForwardedBundleAttachmentSnapshot, ForwardedBundleItem } from "./ForwardedBundleCard";
import ForwardedBundleRouteCard from "./ForwardedBundleRouteCard";
import { openConversationAgentActivity, openConversationAgentProfile } from "../../utils/profilePanelUrl";
import { formatMemberRole } from "../../utils/memberRoleLabel";
import { dispatchSenderMentionInsert } from "./senderMentionInsert";

const REACTION_PICKER_EVENT = "raft:message-reaction-picker-open";
const REACTION_PICKER_WIDTH = 224;
const REACTION_PICKER_HEIGHT = 42;
const REACTION_PICKER_VIEWPORT_MARGIN = 8;
const QUICK_REACTION_GLYPH_SIZE = 18;
const SENDER_AVATAR_LONG_PRESS_MS = 500;
const SENDER_AVATAR_LONG_PRESS_MOVE_TOLERANCE_PX = 10;
const THREAD_SEARCH_FRAGMENT_HIGHLIGHT_CLASS =
  "bg-soft-signal/70 text-inherit [font:inherit]";

function ThreadSearchFragmentHighlight({ children }: { children?: ReactNode }) {
  return (
    <mark
      data-testid="thread-search-fragment-highlight"
      className={THREAD_SEARCH_FRAGMENT_HIGHLIGHT_CLASS}
    >
      {children}
    </mark>
  );
}

function highlightThreadSearchInlineCode(
  children: ReactNode,
  query: string | undefined,
): ReactNode {
  const normalizedQuery = normalizeThreadSearchQuery(query ?? "");
  if (!normalizedQuery) return children;

  return Children.map(children, (child) => {
    if (typeof child !== "string") return child;

    const lowerText = child.toLocaleLowerCase();
    const fragments: ReactNode[] = [];
    let cursor = 0;
    let matchIndex = lowerText.indexOf(normalizedQuery);
    while (matchIndex !== -1) {
      fragments.push(child.slice(cursor, matchIndex));
      const matchEnd = matchIndex + normalizedQuery.length;
      fragments.push(
        <ThreadSearchFragmentHighlight key={`${matchIndex}:${matchEnd}`}>
          {child.slice(matchIndex, matchEnd)}
        </ThreadSearchFragmentHighlight>,
      );
      cursor = matchEnd;
      matchIndex = lowerText.indexOf(normalizedQuery, cursor);
    }
    fragments.push(child.slice(cursor));
    return fragments;
  });
}

function buildOptimisticReactionMessage(
  message: Message,
  emoji: string,
  alreadyReacted: boolean,
  viewerUserId: string,
  viewerReactionName: string,
  unknownReactorName: string,
): Message {
  const reactions = message.reactions ?? [];
  if (!reactions.every(isLegacyMessageReaction)) return message;
  const existingIndex = reactions.findIndex((reaction) => reaction.emoji === emoji);

  if (alreadyReacted) {
    if (existingIndex < 0) return message;
    const existing = reactions[existingIndex];
    const nextReactorIds: string[] = [];
    const nextReactorNames: string[] = [];

    existing.reactorIds.forEach((reactorId, index) => {
      if (reactorId === viewerUserId) return;
      nextReactorIds.push(reactorId);
      nextReactorNames.push(existing.reactorNames[index] ?? unknownReactorName);
    });

    const nextReaction = {
      ...existing,
      count: nextReactorIds.length,
      reactorIds: nextReactorIds,
      reactorNames: nextReactorNames,
    };
    const nextReactions = reactions.map((reaction, index) => (
      index === existingIndex ? nextReaction : reaction
    ));
    return { ...message, reactions: nextReactions };
  }

  if (existingIndex >= 0) {
    const existing = reactions[existingIndex];
    if (existing.reactorIds.includes(viewerUserId)) return message;
    const nextReaction = {
      ...existing,
      count: existing.count + 1,
      reactorIds: [...existing.reactorIds, viewerUserId],
      reactorNames: [...existing.reactorNames, viewerReactionName],
    };
    const nextReactions = reactions.map((reaction, index) => (
      index === existingIndex ? nextReaction : reaction
    ));
    return { ...message, reactions: nextReactions };
  }

  return {
    ...message,
    reactions: [
      ...reactions,
      {
        emoji,
        count: 1,
        reactorIds: [viewerUserId],
        reactorNames: [viewerReactionName],
      },
    ],
  };
}

function buildOptimisticNormalizedReactionMessage(
  message: Message,
  emoji: string,
  alreadyReacted: boolean,
): Message {
  const reactions = message.reactions ?? [];
  if (!reactions.every(isCanonicalMessageReaction)) return message;
  const existingIndex = reactions.findIndex((reaction) => reaction.emoji === emoji);

  if (existingIndex < 0) {
    if (alreadyReacted) return message;
    return {
      ...message,
      reactions: [...reactions, { emoji, count: 1, previewK: [] }],
    };
  }

  const existing = reactions[existingIndex]!;
  const nextCount = Math.max(0, existing.count + (alreadyReacted ? -1 : 1));
  return {
    ...message,
    reactions: reactions.map((reaction, index) => (
      index === existingIndex ? { ...reaction, count: nextCount } : reaction
    )),
  };
}

function replaceReactionForEmoji(
  message: Message,
  source: Message,
  emoji: string,
): Message {
  const sourceReaction = (source.reactions ?? []).find((reaction) => reaction.emoji === emoji);
  const reactions = message.reactions ?? [];

  if (!sourceReaction) {
    return { ...message, reactions: reactions.filter((reaction) => reaction.emoji !== emoji) };
  }

  if (reactions.some((reaction) => reaction.emoji === emoji)) {
    return {
      ...message,
      reactions: reactions.map((reaction) => reaction.emoji === emoji ? sourceReaction : reaction),
    };
  }

  return { ...message, reactions: [...reactions, sourceReaction] };
}

function mergeReactionResponsePreservingPending(
  currentMessage: Message,
  serverMessage: Message,
  pendingEmojis: Set<string>,
): Message {
  if (pendingEmojis.size === 0) return serverMessage;

  let merged = serverMessage;
  for (const emoji of pendingEmojis) {
    merged = replaceReactionForEmoji(merged, currentMessage, emoji);
  }
  return merged;
}

function ReactionCount({ count }: { count: number }) {
  const previousCountRef = useRef(count);
  const [animationKey, setAnimationKey] = useState(0);

  // animation-key bump pattern: functional updater bumps an internal counter
  // (NOT derived from count — it's a change-event counter used to retrigger
  // CSS animation on key change). `previousCountRef` guard ensures only real
  // count transitions bump. The rule's "compute during render" suggestion
  // cannot express this (the key is animation state, not derived data).
  useEffect(() => {
    if (previousCountRef.current === count) return;
    previousCountRef.current = count;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setAnimationKey((key) => key + 1);
  }, [count]);

  return (
    <span
      key={animationKey}
      className={`font-mono tabular-nums ${animationKey > 0 ? "reaction-count-bump" : ""}`}
    >
      {count}
    </span>
  );
}

type MessageImageAttachment = NonNullable<Message["attachments"]>[number];
type ImageAspectKind = "wide" | "tall" | "normal";
const SINGLE_IMAGE_MAX_WIDTH = 416;
const SINGLE_IMAGE_MAX_HEIGHT = 288;

export interface ImageGalleryRow {
  attachments: MessageImageAttachment[];
  gridClass: string;
  heightClass: string;
}

export function classifyImageAspect(att: Pick<MessageImageAttachment, "width" | "height">): ImageAspectKind {
  if (!att.width || !att.height || att.width <= 0 || att.height <= 0) return "normal";
  const ratio = att.width / att.height;
  if (ratio >= 2.2) return "wide";
  if (ratio <= 0.55) return "tall";
  return "normal";
}

function getImageGalleryRowClasses(attachments: MessageImageAttachment[]): Omit<ImageGalleryRow, "attachments"> {
  if (attachments.length <= 1) {
    return { gridClass: "grid-cols-1", heightClass: "h-32 sm:h-36" };
  }
  if (attachments.length === 2) {
    return { gridClass: "grid-cols-2", heightClass: "h-32 sm:h-36" };
  }
  return { gridClass: "grid-cols-2 md:grid-cols-3", heightClass: "h-28 sm:h-32" };
}

export function buildImageGalleryRows(attachments: MessageImageAttachment[]): ImageGalleryRow[] {
  if (attachments.length <= 1) {
    return attachments.length === 0 ? [] : [{ attachments, ...getImageGalleryRowClasses(attachments) }];
  }

  const rows: ImageGalleryRow[] = [];
  let buffer: MessageImageAttachment[] = [];

  const pushBufferedRows = () => {
    if (buffer.length === 0) return;
    const chunkSize = buffer.length === 4 ? 2 : 3;
    for (let i = 0; i < buffer.length; i += chunkSize) {
      const rowAttachments = buffer.slice(i, i + chunkSize);
      rows.push({ attachments: rowAttachments, ...getImageGalleryRowClasses(rowAttachments) });
    }
    buffer = [];
  };

  for (const attachment of attachments) {
    if (classifyImageAspect(attachment) === "wide") {
      pushBufferedRows();
      rows.push({ attachments: [attachment], ...getImageGalleryRowClasses([attachment]) });
      continue;
    }
    buffer.push(attachment);
  }

  pushBufferedRows();
  return rows;
}

function getImageGalleryFitClass(att: MessageImageAttachment): string {
  return classifyImageAspect(att) === "normal" ? "object-cover" : "object-contain";
}

function getSingleImageReserveStyle(att: MessageImageAttachment) {
  if (!att.width || !att.height || att.width <= 0 || att.height <= 0) {
    return { width: "min(11rem, 100%)", aspectRatio: "4 / 3" };
  }

  const scale = Math.min(SINGLE_IMAGE_MAX_WIDTH / att.width, SINGLE_IMAGE_MAX_HEIGHT / att.height, 1);
  const reservedWidth = Math.max(1, Math.round(att.width * scale));
  return { width: `min(${reservedWidth}px, 100%)`, aspectRatio: `${att.width} / ${att.height}` };
}

export interface MentionEntry {
  displayName: string;
  type: "agent" | "user";
  id: string;
  agent?: Agent;
}

// External-origin text has no Raft mention authority. Keep this shared empty
// map referentially stable so MessageMarkdownBody remains memo-friendly while
// raw provider handles such as `@owner` stay plain text in the Human UI.
const EXTERNAL_MESSAGE_MENTION_MAP = new Map<string, MentionEntry>();

/** Build a lookup map of all mentionable names → display info */
export function buildMentionMap(
  agents: Agent[],
  humans: ServerMember[],
  channelAgents: Agent[] = [],
  channelHumans: ChannelHuman[] = [],
): Map<string, MentionEntry> {
  const map = new Map<string, MentionEntry>();
  for (const agent of [...agents, ...channelAgents]) {
    map.set(agent.name, {
      displayName: agent.displayName || agent.name,
      type: "agent",
      id: agent.id,
      agent,
    });
  }
  for (const human of humans) {
    map.set(human.name, {
      displayName: human.displayName || human.name,
      type: "user",
      id: human.userId,
    });
  }
  for (const human of channelHumans) {
    map.set(human.name, {
      displayName: human.displayName || human.name,
      type: "user",
      id: human.id,
    });
  }
  return map;
}

function buildStructuredMentionMap(mentions: MessageMention[] | undefined): Map<string, MentionEntry> {
  const map = new Map<string, MentionEntry>();
  for (const mention of mentions ?? []) {
    const name = mention.name.trim();
    if (!name) continue;
    map.set(name, {
      displayName: name,
      type: mention.type,
      id: mention.id,
    });
  }
  return map;
}

const mentionIdentityMapCache = new WeakMap<Map<string, MentionEntry>, Map<string, MentionEntry>>();

function buildMentionIdentityMap(mentionMap: Map<string, MentionEntry>): Map<string, MentionEntry> {
  const cached = mentionIdentityMapCache.get(mentionMap);
  if (cached) return cached;
  const map = new Map<string, MentionEntry>();
  for (const entry of mentionMap.values()) {
    map.set(`${entry.type}:${entry.id}`, entry);
  }
  mentionIdentityMapCache.set(mentionMap, map);
  return map;
}

function escapeMessageHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeMessageHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function makeRaftRefAnchor(target: RaftRefTarget, label: string): string {
  const rawTarget = formatRaftRefTarget(target);
  return `<a data-raft-ref-kind="${target.kind}" data-raft-ref-target="${escapeMessageHtmlAttribute(rawTarget)}">${escapeMessageHtmlText(label)}</a>`;
}

function replaceRaftRefMarkdownWithPlaceholders(source: string, placeholders: string[]): string {
  return replaceOutsideMarkdownCode(source, (chunk) => {
    let processed = chunk.replace(/\\<([^<>\n]+)>/g, (match, rawTarget: string) => {
      if (!parseRaftRefTarget(rawTarget)) return match;
      const index = placeholders.length;
      placeholders.push(`&lt;${escapeMessageHtmlText(rawTarget)}&gt;`);
      return `\x00RAFTREF${index}\x00`;
    });

    processed = processed.replace(
      /\[((?:\\.|[^\]\\])*)\]\(<([^<>\n]+)>\)/g,
      (match, label: string, rawTarget: string) => {
        const target = parseRaftRefTarget(rawTarget);
        if (!target) return match;
        const index = placeholders.length;
        placeholders.push(makeRaftRefAnchor(target, label.replace(/\\([[\]])/g, "$1")));
        return `\x00RAFTREF${index}\x00`;
      },
    );

    processed = processed.replace(/(^|[^\\])<([^<>\n]+)>/g, (match, prefix: string, rawTarget: string) => {
      const target = parseRaftRefTarget(rawTarget);
      if (!target) return match;
      const index = placeholders.length;
      const label = formatRaftRefTarget(target);
      placeholders.push(makeRaftRefAnchor(target, label));
      return `${prefix}\x00RAFTREF${index}\x00`;
    });

    processed = processed.replace(
      createRaftMessageRefRegex(),
      (match, channelName: string, threadParentShortId: string | undefined, messageId: string) => {
        const target = parseRaftRefTarget(
          threadParentShortId
            ? `#${channelName}:${threadParentShortId} msg=${messageId}`
            : `#${channelName} msg=${messageId}`,
        );
        if (!target) return match;
        const index = placeholders.length;
        placeholders.push(makeRaftRefAnchor(target, formatRaftRefTarget(target)));
        return `\x00RAFTREF${index}\x00`;
      },
    );

    return processed;
  });
}

function restoreRaftRefPlaceholders(source: string, placeholders: string[]): string {
  // oxlint-disable-next-line no-control-regex -- NUL (\u0000) is an intentional private sentinel wrapping placeholder tokens; it never appears in user markdown, so matching it is safe and deliberate
  return source.replace(/\x00RAFTREF(\d+)\x00/g, (_match, idx) => placeholders[Number(idx)] ?? "");
}

function getRaftRefProp(node: any, prop: string): string | undefined {
  const value = node?.properties?.[prop] ?? node?.properties?.[`data-${prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`];
  return typeof value === "string" ? value : undefined;
}

/**
 * Repair a common generated-Markdown shape such as
 * `- **Registration: **203 users`.
 *
 * CommonMark does not allow the whitespace immediately before `**` to close
 * the strong span, so it renders both delimiter pairs literally. Move that
 * whitespace just outside the closing delimiter without changing the visible
 * text. Callers protect code spans/blocks before invoking this helper so code
 * samples remain byte-for-byte untouched.
 */
function normalizeGeneratedStrongClosingWhitespace(source: string): string {
  return source.replace(
    /(^|[^\\])\*\*([^*\n]*?\S)([ \t]+)\*\*/g,
    (_match, prefix: string, content: string, whitespace: string) =>
      `${prefix}**${content}**${whitespace}`,
  );
}

/** Render message content as Markdown with @mention and #channel highlighting */
function renderContent(
  content: string,
  channels: Channel[],
  mentionMap: Map<string, MentionEntry>,
  structuredMentionMap: Map<string, MentionEntry>,
  onNavigateChannel: (channel: Channel) => void,
  onNavigateDm: (channel: Channel) => void,
  onNavigateAgent: (agentId: string) => void,
  onNavigateHuman: (userId: string) => void,
  onNavigateComputer: (machineId: string) => void,
  onOpenThread?: (intent: ThreadRefIntent) => void | Promise<void>,
  resolvingThreadRefKey?: string | null,
  onOpenTaskRef?: (taskNumber: number) => void,
  onOpenMessageRef?: (channel: Channel, messageId: string, threadParentShortId: string | null) => void | Promise<void>,
  onOpenPermalink?: (href: string) => void,
  currentServerSlug?: string,
  refAuthorityServerSlug?: string,
  threadRefAuthorityUnavailable = false,
  knownTaskNumbers?: Set<number>,
  timeFormatOptions: TimeFormatOptions = {},
  threadSearchHighlightQuery?: string,
  formatMessage?: IntlShape["formatMessage"],
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>,
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>,
  unavailableQuotedPermalinkUrl?: string | null,
) {
  let mentionIdentityMap: Map<string, MentionEntry> | null = null;
  const resolveMentionByIdentity = (type: "agent" | "user", id: string) => {
    mentionIdentityMap ??= buildMentionIdentityMap(mentionMap);
    return mentionIdentityMap.get(`${type}:${id}`);
  };
  // Pre-process blockquotes: insert blank line after quote blocks so non-quoted
  // lines don't get absorbed as "lazy continuation" (standard markdown behavior)
  let processed = content.replace(
    /(^|\n)(>.*?)(\n)(?!>|\n)/g,
    "$1$2\n$3"
  );

  // Protect code regions from mention/channel replacement.
  // Fenced code blocks (```...```) and inline code (`...`) are replaced with
  // null-byte placeholders so @mention and #channel regexes skip them.
  const codePlaceholders: string[] = [];
  const protectCode = (s: string) => {
    // Fenced code blocks first (greedy across lines)
    s = s.replace(/```[\s\S]*?```/g, (match) => {
      const idx = codePlaceholders.length;
      codePlaceholders.push(match);
      return `\x00CODE${idx}\x00`;
    });
    // Then inline code (backticks — handles `` double backtick `` too)
    s = s.replace(/``[^`]+``|`[^`]+`/g, (match) => {
      const idx = codePlaceholders.length;
      codePlaceholders.push(match);
      return `\x00CODE${idx}\x00`;
    });
    return s;
  };
  const restoreCode = (s: string) =>
    // oxlint-disable-next-line no-control-regex -- NUL (\u0000) is an intentional private sentinel wrapping placeholder tokens; it never appears in user markdown, so matching it is safe and deliberate
    s.replace(/\x00CODE(\d+)\x00/g, (_m, idx) => codePlaceholders[Number(idx)]);

  // Convert literal \n sequences to actual newlines so markdown/remark-breaks
  // can handle them. This is needed because some LLM outputs contain escaped
  // newlines instead of real ones. Code blocks are already protected above.
  processed = protectCode(processed);
  processed = processed.replace(/\\n/g, "\n");
  processed = normalizeGeneratedStrongClosingWhitespace(processed);
  const raftRefPlaceholders: string[] = [];
  processed = replaceRaftRefMarkdownWithPlaceholders(processed, raftRefPlaceholders);
  processed = escapeUserRawHtmlForMessageMarkdown(processed);

  const mentionPlaceholders: string[] = [];
  const storeMentionPlaceholder = (name: string, entry: MentionEntry) => {
    const safeName = name.replace(/"/g, "&quot;");
    const resolvedMention = resolveMentionByIdentity(entry.type, entry.id);
    const visibleLabel = resolvedMention?.displayName
      ? `@${resolvedMention.displayName}`
      : `@${name}`;
    const index = mentionPlaceholders.length;
    mentionPlaceholders.push(
      `<a data-mention="${safeName}" data-mention-type="${entry.type}" data-mention-id="${entry.id}">${escapeMessageHtmlText(visibleLabel)}</a>`,
    );
    return `\x00MENTION${index}\x00`;
  };

  // A selected mention is an identity-backed entity, not a fresh username
  // guess. Keep it mentionable after left-boundary edits such as
  // `草案@Mona`; the exact right boundary still prevents a stale `@Mona`
  // entity from claiming the longer text `@Mona继续`.
  for (const [name, entry] of structuredMentionMap) {
    const selectedMentionRegex = createRaftStructuredUserRefRegex(name);
    if (!selectedMentionRegex) continue;
    processed = processed.replace(selectedMentionRegex, () => storeMentionPlaceholder(name, entry));
  }

  // Free text still uses the conservative grammar so emails/package-like
  // strings never become notifications merely because a directory name
  // happens to match.
  processed = processed.replace(createRaftUserRefRegex(), (match, prefix: string, name: string) => {
    const entry = structuredMentionMap.get(name) ?? mentionMap.get(name);
    if (!entry) return match; // Not a known name — keep as plain text
    return `${prefix}${storeMentionPlaceholder(name, entry)}`;
  });

  // Pre-process thread references: #channel:shortId or dm:@peer:shortId
  // Use placeholders to avoid double-processing by the channel regex
  const threadPlaceholders: string[] = [];
  const channelNameSet = new Set(channels.map((c) => c.name.toLowerCase()));
  processed = processed.replace(createRaftChannelThreadRefRegex(), (match, chanName: string, shortId: string) => {
    if (threadRefAuthorityUnavailable) {
      const idx = threadPlaceholders.length;
      threadPlaceholders.push(`<span>${match}</span>`);
      return `\x00THREAD${idx}\x00`;
    }
    const crossServerAuthority = !!refAuthorityServerSlug
      && !!currentServerSlug
      && refAuthorityServerSlug !== currentServerSlug;
    if (!channelNameSet.has(chanName.toLowerCase()) && !crossServerAuthority) return match;
    const chan = channels.find((c) => c.name.toLowerCase() === chanName.toLowerCase() && (c.type === "channel" || c.type === "private" || c.type === "joint"));
    const html = `<a data-thread-ref="${shortId}" data-thread-parent="${crossServerAuthority ? "" : chan?.id || ""}" data-thread-parent-name="${chanName}">#${chanName}:${shortId}</a>`;
    const idx = threadPlaceholders.length;
    threadPlaceholders.push(html);
    return `\x00THREAD${idx}\x00`;
  });
  processed = processed.replace(createRaftDmThreadRefRegex(), (_match, peerName: string, shortId: string) => {
    if (threadRefAuthorityUnavailable) {
      const idx = threadPlaceholders.length;
      threadPlaceholders.push(`<span>${_match}</span>`);
      return `\x00THREAD${idx}\x00`;
    }
    const crossServerAuthority = !!refAuthorityServerSlug
      && !!currentServerSlug
      && refAuthorityServerSlug !== currentServerSlug;
    const dm = channels.find(
      (c) => c.type === "dm" && (c.peerName?.toLowerCase() === peerName.toLowerCase() || c.name.toLowerCase() === peerName.toLowerCase())
    );
    if (!dm && !crossServerAuthority) return _match;
    const html = `<a data-thread-ref="${shortId}" data-thread-parent="${crossServerAuthority ? "" : dm?.id || ""}" data-thread-parent-name="${crossServerAuthority ? peerName : dm?.name || peerName}" data-thread-parent-type="dm">dm:@${peerName}:${shortId}</a>`;
    const idx = threadPlaceholders.length;
    threadPlaceholders.push(html);
    return `\x00THREAD${idx}\x00`;
  });

  // Pre-process task references: "task #205" always links; bare "#205" only if it's a known task
  const taskPlaceholders: string[] = [];
  processed = processed.replace(createRaftBareTaskRefRegex(), (match, prefix: string, taskKeyword: string | undefined, taskNumber: string) => {
    const hasExplicitPrefix = !!taskKeyword;
    const isKnownTask = knownTaskNumbers?.has(Number(taskNumber));
    if (!hasExplicitPrefix && !isKnownTask) return match;
    const html = `<a data-task-ref="${taskNumber}">#${taskNumber}</a>`;
    const idx = taskPlaceholders.length;
    taskPlaceholders.push(html);
    return `${prefix}${taskKeyword ?? ""}\x00TASK${idx}\x00`;
  });

  // Pre-process #channel references: only replace if name matches a known channel
  processed = processed.replace(createRaftChannelRefRegex(), (match, name: string) => {
    if (!channelNameSet.has(name.toLowerCase())) return match; // Not a known channel — keep as plain text
    return `<a data-channel="${name}">#${name}</a>`;
  });

  // Restore task/thread placeholders, then code placeholders
  // oxlint-disable-next-line no-control-regex -- NUL (\u0000) is an intentional private sentinel wrapping placeholder tokens; it never appears in user markdown, so matching it is safe and deliberate
  processed = processed.replace(/\x00TASK(\d+)\x00/g, (_m, idx) => taskPlaceholders[Number(idx)]);
  // oxlint-disable-next-line no-control-regex -- NUL (\u0000) is an intentional private sentinel wrapping placeholder tokens; it never appears in user markdown, so matching it is safe and deliberate
  processed = processed.replace(/\x00THREAD(\d+)\x00/g, (_m, idx) => threadPlaceholders[Number(idx)]);
  processed = restoreRaftRefPlaceholders(processed, raftRefPlaceholders);
  // oxlint-disable-next-line no-control-regex -- NUL is an internal placeholder delimiter removed before rendering
  processed = processed.replace(/\x00MENTION(\d+)\x00/g, (_m, idx) => mentionPlaceholders[Number(idx)] ?? "");
  processed = highlightThreadSearchMarkdownFragments(processed, threadSearchHighlightQuery ?? "");
  processed = restoreCode(processed);

  // Chat body shares its visual styling (code blocks, lists, headings, table,
  // etc.) with attachment preview via BASE_MARKDOWN_COMPONENTS in
  // MarkdownContent. We override only the elements that need chat-specific
  // behavior — `a` (mentions / channel refs / task refs / thread refs /
  // raft permalinks) and `span` (reminder receipts).
  // stdrc 2026-05-08 #proj-uiux:6110c1ce (task #137).
  return (
    <MarkdownContent
      source={processed}
      density="compact"
      enableMermaid
      rehypePlugins={[rehypeRaw, [rehypeSanitize, messageMarkdownSanitizeSchema]]}
      components={{
        code: ({ children, className }) => (
          <MarkdownCode className={className}>
            {className
              ? children
              : highlightThreadSearchInlineCode(children, threadSearchHighlightQuery)}
          </MarkdownCode>
        ),
        // Links — handle @mention, #channel, and regular URLs
        a: ({ href, children, node }) => {
          const raftRefTarget = getRaftRefProp(node, "dataRaftRefTarget");
          if (raftRefTarget) {
            const target = parseRaftRefTarget(raftRefTarget);
            if (!target) return <span>{children}</span>;

            if (target.kind === "user") {
              const entry = structuredMentionMap.get(target.name) ?? mentionMap.get(target.name);
              if (!entry) return <span>{children}</span>;
              return (
                <MentionLink
                  mentionType={entry.type}
                  mentionId={entry.id}
                  fallbackLabel={target.name}
                  fallbackAgent={entry.type === "agent" ? channelParticipantAgentsById?.get(entry.id) : undefined}
                  fallbackMember={entry.type === "user" ? channelParticipantMembersById?.get(entry.id) : undefined}
                  onNavigate={() =>
                    entry.type === "agent" ? onNavigateAgent(entry.id) : onNavigateHuman(entry.id)
                  }
                >
                  {children}
                </MentionLink>
              );
            }

            if (target.kind === "computer") {
              return (
                <a
                  data-testid={`computer-reference-${target.machineId}`}
                  href="#"
                  onClick={(event) => {
                    event.preventDefault();
                    onNavigateComputer(target.machineId);
                  }}
                  className={`${MSG_REF_CHIP} bg-brutal-cyan/30 text-black cursor-default hover:bg-brutal-cyan/60`}
                >
                  {children}
                </a>
              );
            }

            if (target.kind === "app") {
              return (
                <span
                  data-testid={`app-reference-${target.appId}`}
                  className={`${MSG_REF_CHIP} bg-soft-signal/40 text-black`}
                  title={formatMessage?.({ id: "message.messageItem.appReferenceOnly" })}
                >
                  {children}
                </span>
              );
            }

            if (target.kind === "channel" || target.kind === "channel-thread" || target.kind === "message") {
              const crossServerAuthority = !!refAuthorityServerSlug
                && !!currentServerSlug
                && refAuthorityServerSlug !== currentServerSlug;
              const channel = channels.find(
                (entry) =>
                  entry.name.toLowerCase() === target.channelName.toLowerCase() &&
                  (entry.type === "channel" || entry.type === "private" || entry.type === "joint"),
              );
              const crossServerThreadTarget = crossServerAuthority
                && (target.kind === "channel-thread" || (target.kind === "message" && !!target.threadParentShortId));
              if (!channel && !crossServerThreadTarget) return <span>{children}</span>;

              if (target.kind === "channel") {
                if (!channel) return <span>{children}</span>;
                return (
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigateChannel(channel);
                    }}
                    className={`${MSG_REF_CHIP} bg-brutal-pink/30 text-black cursor-default hover:bg-brutal-pink/60`}
                  >
                    {children}
                  </a>
                );
              }

              if (target.kind === "channel-thread") {
                if (threadRefAuthorityUnavailable) return <span>{children}</span>;
                if (!onOpenThread) return <span>{children}</span>;
                const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
                if (!routeServerSlug) return <span>{children}</span>;
                const parentChannelId = crossServerAuthority ? null : channel?.id ?? null;
                const threadRefKey = `${routeServerSlug}:${target.channelName.toLowerCase()}:${target.threadShortId.toLowerCase()}`;
                const isResolvingThreadRef = resolvingThreadRefKey === threadRefKey;
                return (
                  <a
                    href="#"
                    aria-busy={isResolvingThreadRef}
                    onClick={(e) => {
                      e.preventDefault();
                      if (isResolvingThreadRef) return;
                      void onOpenThread({
                        serverSlug: routeServerSlug,
                        parentChannelName: target.channelName,
                        parentChannelId,
                        shortId: target.threadShortId,
                      });
                    }}
                    className={`${MSG_REF_CHIP} bg-brutal-cyan/30 text-black ${isResolvingThreadRef ? "cursor-wait opacity-80" : "cursor-default hover:bg-brutal-cyan/60"}`}
                  >
                    <span>{children}</span>
                    {isResolvingThreadRef ? (
                      <Spinner size="xs" className="ml-1 align-[-1px]" />
                    ) : null}
                  </a>
                );
              }

              if (target.threadParentShortId && onOpenThread) {
                if (threadRefAuthorityUnavailable) return <span>{children}</span>;
                const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
                if (!routeServerSlug) return <span>{children}</span>;
                return (
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      void onOpenThread({
                        serverSlug: routeServerSlug,
                        parentChannelName: target.channelName,
                        parentChannelId: crossServerAuthority ? null : channel?.id ?? null,
                        shortId: target.threadParentShortId!,
                        focusedMessageId: target.messageId,
                      });
                    }}
                    className={`${MSG_REF_CHIP} bg-soft-signal/40 text-black cursor-default hover:bg-soft-signal`}
                  >
                    {children}
                  </a>
                );
              }

              if (!onOpenMessageRef) return <span>{children}</span>;
              if (!channel) return <span>{children}</span>;
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void onOpenMessageRef?.(channel, target.messageId, target.threadParentShortId);
                  }}
                  className={`${MSG_REF_CHIP} bg-soft-signal/40 text-black cursor-default hover:bg-soft-signal`}
                >
                  {children}
                </a>
              );
            }

            if (target.kind === "dm" || target.kind === "dm-thread") {
              const crossServerAuthority = !!refAuthorityServerSlug
                && !!currentServerSlug
                && refAuthorityServerSlug !== currentServerSlug;
              const dm = channels.find(
                (entry) =>
                  entry.type === "dm" &&
                  (entry.peerName?.toLowerCase() === target.peerName.toLowerCase() ||
                    entry.name.toLowerCase() === target.peerName.toLowerCase()),
              );
              if (!dm && !(crossServerAuthority && target.kind === "dm-thread")) return <span>{children}</span>;
              if (target.kind === "dm") {
                if (!dm) return <span>{children}</span>;
                return (
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      onNavigateDm(dm);
                    }}
                    className={`${MSG_REF_CHIP} bg-brutal-pink/30 text-black cursor-default hover:bg-brutal-pink/60`}
                  >
                    {children}
                  </a>
                );
              }
              if (!onOpenThread) return <span>{children}</span>;
              if (threadRefAuthorityUnavailable) return <span>{children}</span>;
              const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
              if (!routeServerSlug) return <span>{children}</span>;
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    void onOpenThread({
                      serverSlug: routeServerSlug,
                      parentChannelName: crossServerAuthority ? target.peerName : dm!.name,
                      parentChannelType: "dm",
                      parentChannelId: crossServerAuthority ? null : dm!.id,
                      shortId: target.threadShortId,
                    });
                  }}
                  className={`${MSG_REF_CHIP} bg-brutal-cyan/30 text-black cursor-default hover:bg-brutal-cyan/60`}
                >
                  {children}
                </a>
              );
            }

            if (target.kind === "task" && onOpenTaskRef) {
              return (
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenTaskRef(target.taskNumber);
                  }}
                  className={`${MSG_REF_CHIP} bg-soft-signal/40 text-black cursor-default hover:bg-soft-signal`}
                >
                  {children}
                </a>
              );
            }

            return <span>{children}</span>;
          }

          // @mention → clickable, navigates to agent or human detail
          const mentionName = node?.properties?.dataMention as string | undefined;
          if (mentionName) {
            const mentionType = node?.properties?.dataMentionType as string | undefined;
            const mentionId = node?.properties?.dataMentionId as string | undefined;

            if (!mentionId || (mentionType !== "agent" && mentionType !== "user")) {
              return (
                <span className="font-bold text-black underline decoration-black/30 decoration-2 underline-offset-2 select-text">
                  {children}
                </span>
              );
            }

            return (
              <MentionLink
                mentionType={mentionType}
                mentionId={mentionId}
                fallbackLabel={mentionName}
                fallbackAgent={mentionType === "agent" ? channelParticipantAgentsById?.get(mentionId) : undefined}
                fallbackMember={mentionType === "user" ? channelParticipantMembersById?.get(mentionId) : undefined}
                onNavigate={() =>
                  mentionType === "agent" ? onNavigateAgent(mentionId) : onNavigateHuman(mentionId)
                }
              >
                {children}
              </MentionLink>
            );
          }
          // Thread reference → clickable, opens thread panel
          const threadRef = node?.properties?.dataThreadRef as string | undefined;
          if (threadRef && onOpenThread) {
            if (threadRefAuthorityUnavailable) return <span>{children}</span>;
            const parentId = node?.properties?.dataThreadParent as string | undefined;
            const parentName = node?.properties?.dataThreadParentName as string | undefined;
            const parentType = node?.properties?.dataThreadParentType === "dm" ? "dm" : "channel";
            const routeServerSlug = refAuthorityServerSlug ?? currentServerSlug;
            const crossServerAuthority = !!refAuthorityServerSlug
              && !!currentServerSlug
              && refAuthorityServerSlug !== currentServerSlug;
            if (!routeServerSlug || !parentName || (!parentId && !crossServerAuthority)) {
              return (
                <span className={`${MSG_REF_CHIP} bg-brutal-cyan/30 text-black opacity-60`}>
                  {children}
                </span>
              );
            }
            const threadRefKey = `${routeServerSlug}:${parentName.toLowerCase()}:${threadRef.toLowerCase()}`;
            const isResolvingThreadRef = resolvingThreadRefKey === threadRefKey;
            return (
              <a
                href="#"
                aria-busy={isResolvingThreadRef}
                onClick={(e) => {
                  e.preventDefault();
                  if (isResolvingThreadRef) return;
                  void onOpenThread({
                    serverSlug: routeServerSlug,
                    parentChannelName: parentName,
                    parentChannelType: parentType,
                    parentChannelId: crossServerAuthority ? null : parentId,
                    shortId: threadRef,
                  });
                }}
                className={`${MSG_REF_CHIP} bg-brutal-cyan/30 text-black ${isResolvingThreadRef ? "cursor-wait opacity-80" : "cursor-default hover:bg-brutal-cyan/60"}`}
              >
                <span>{children}</span>
                {isResolvingThreadRef ? (
                  <Spinner size="xs" className="ml-1 align-[-1px]" />
                ) : null}
              </a>
            );
          }
          // #channel → clickable, navigates to channel
          const channelName = node?.properties?.dataChannel as string | undefined;
          if (channelName) {
            const channel = channels.find(
              (c) => c.name.toLowerCase() === channelName.toLowerCase() && (c.type === "channel" || c.type === "private" || c.type === "joint")
            );
            if (!channel) {
              return (
                <span className={`${MSG_REF_CHIP} bg-brutal-pink/30 text-black opacity-60`}>
                  {children}
                </span>
              );
            }
            return (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onNavigateChannel(channel);
                }}
                className={`${MSG_REF_CHIP} bg-brutal-pink/30 text-black cursor-default hover:bg-brutal-pink/60`}
              >
                {children}
              </a>
            );
          }
          // #205 → clickable, resolves a task in the current channel context
          const taskRef = node?.properties?.dataTaskRef as string | undefined;
          if (taskRef && onOpenTaskRef) {
            const taskNumber = Number(taskRef);
            if (!Number.isInteger(taskNumber) || taskNumber <= 0) {
              return (
                <span className={`${MSG_REF_CHIP} bg-soft-signal/30 text-black opacity-60`}>
                  {children}
                </span>
              );
            }
            return (
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  onOpenTaskRef(taskNumber);
                }}
                className={`${MSG_REF_CHIP} bg-soft-signal/40 text-black cursor-default hover:bg-soft-signal`}
              >
                {children}
              </a>
            );
          }
          const raftPermalink = href
            ? parseRaftPermalink(
                href,
                typeof window !== "undefined" ? window.location.hostname : undefined
              )
            : null;
          if (href && raftPermalink) {
            const quotedMessageUnavailable = matchesUnavailableQuotedPermalink(
              href,
              unavailableQuotedPermalinkUrl,
              typeof window !== "undefined" ? window.location.hostname : undefined,
            );
            const channel = channels.find((entry) => entry.id === raftPermalink.channelId);
            const channelLabel = quotedMessageUnavailable
              ? (formatMessage
                ? formatMessage({ id: "message.messageItem.unavailableLinkedMessage" })
                : "Unavailable linked message")
              : channel
              ? channel.type === "dm"
                ? `@${channel.peerDisplayName || channel.peerName || channel.name}`
                : `#${channel.name}`
              : (formatMessage
                ? formatMessage({ id: "message.messageItem.linkedMessageFallback" })
                : "linked message");
            const isCurrentServer = !currentServerSlug || raftPermalink.serverSlug === currentServerSlug;

            return (
              <ReferenceChip
                as={quotedMessageUnavailable ? "span" : "a"}
                href={quotedMessageUnavailable ? undefined : href}
                onClick={quotedMessageUnavailable ? undefined : (e) => {
                  e.preventDefault();
                  if (isCurrentServer) {
                    onOpenPermalink?.(href);
                    return;
                  }
                  window.open(href, "_blank", "noopener,noreferrer");
                }}
                title={quotedMessageUnavailable ? undefined : href}
                icon={Link}
                colorClass={
                  isCurrentServer
                    ? "bg-soft-signal/40 text-black hover:bg-soft-signal"
                    : "bg-white text-blue-700 hover:bg-black/5"
                }
                label={channelLabel}
                trailing={quotedMessageUnavailable ? undefined : (
                  <span className="text-[10px] font-normal leading-none text-black/50">msg</span>
                )}
              />
            );
          }
          return (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-700 underline decoration-2 underline-offset-2 hover:text-brutal-pink select-text"
            >
              {children}
            </a>
          );
        },
        // Reminder-receipt span: when ReactMarkdown sees `<span data-reminder-fire-at="...">...</span>`
        // (rehypeRaw + sanitize lets that data attribute through), re-render
        // with a humanized fire time + tooltip. Other `<span>`s pass through
        // unchanged.
        span: ({ children, node, ...props }) => {
          const reminderFireAt = (node?.properties?.dataReminderFireAt
            || node?.properties?.["data-reminder-fire-at"]) as string | undefined;
          if (reminderFireAt) {
            return (
              <span
                {...props}
                title={formatReminderReceiptTooltip(reminderFireAt, timeFormatOptions)}
              >
                {formatMessage
                  ? formatReminderReceiptTime(reminderFireAt, formatMessage, new Date(), timeFormatOptions)
                  : reminderFireAt}
              </span>
            );
          }
          return <span {...props}>{children}</span>;
        },
        mark: ({ children }) => (
          <ThreadSearchFragmentHighlight>{children}</ThreadSearchFragmentHighlight>
        ),
      }}
    />
  );
}

function isPreviewableHtmlAttachment(att: NonNullable<Message["attachments"]>[number]): boolean {
  const mimeType = att.mimeType.split(";")[0]?.trim().toLowerCase();
  return mimeType === "text/html" || /\.html?$/i.test(att.filename);
}

function isPreviewableDocumentAttachment(att: NonNullable<Message["attachments"]>[number]): boolean {
  return isDocumentPreviewAttachment(att);
}

function isPreviewableVideoAttachment(att: NonNullable<Message["attachments"]>[number]): boolean {
  return isVideoPreviewAttachment(att);
}

function isPreviewableAudioAttachment(att: NonNullable<Message["attachments"]>[number]): boolean {
  return isAudioPreviewAttachment(att);
}

interface DocumentAttachmentPreviewState {
  preview: DocumentAttachmentPreview;
  truncated: boolean;
}

const EMPTY_IMAGE_INLINE_FALLBACK_URLS: Record<string, string> = {};

function ImageInlineFallbackLoader({
  fallbackKey,
  children,
}: {
  fallbackKey: string;
  children: (fallbackUrls: Record<string, string>) => ReactNode;
}) {
  // The parent seam must keep empty keys off this state/effect-bearing path.
  // Stryker disable next-line all: this invariant is the oracle for mutations of that parent seam.
  if (!fallbackKey) throw new Error("ImageInlineFallbackLoader requires a non-empty fallback key");
  const [fallbackUrls, setFallbackUrls] = useState<Record<string, string>>({});

  // Stryker disable all: this fetch lifecycle moved unchanged from MessageItem;
  // its URL/error semantics remain covered by the existing fallback contracts.
  // CDN thumbnails are the preferred inline source. When a normal image lacks
  // one (for example, CDN previews disabled/unavailable), use the authenticated
  // attachment URL so image messages still render inline instead of degrading
  // permanently to a file chip.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    const attachmentIds = splitImageInlineFallbackKey(fallbackKey);
    let cancelled = false;
    const controller = new AbortController();
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setFallbackUrls((current) => retainImageInlineFallbackUrls(current, attachmentIds));

    // One request for the whole gallery instead of one per image.
    void fetchInlineAttachmentUrls(attachmentIds)
      .then((urls) => {
        if (cancelled) return;
        for (const attachmentId of attachmentIds) {
          const url = urls.get(attachmentId);
          setFallbackUrls((current) => url
            ? setImageInlineFallbackUrl(current, attachmentId, url)
            : removeImageInlineFallbackUrl(current, attachmentId));
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [fallbackKey]);
  // Stryker restore all

  return children(fallbackUrls);
}

function renderWithImageInlineFallback(
  fallbackKey: string,
  children: (fallbackUrls: Record<string, string>) => ReactNode,
) {
  if (!fallbackKey) return children(EMPTY_IMAGE_INLINE_FALLBACK_URLS);
  return <ImageInlineFallbackLoader fallbackKey={fallbackKey}>{children}</ImageInlineFallbackLoader>;
}

export function AttachmentMetaText({
  label,
  sizeBytes,
}: {
  label: string;
  sizeBytes?: number;
}) {
  const { formatMessage } = useIntl();
  return (
    <span
      data-message-affordance="attachment-meta"
      className="inline-flex min-w-0 max-w-full flex-1 items-center gap-1.5"
    >
      <span data-message-affordance="attachment-meta-label" className="min-w-0 flex-1 truncate">{label}</span>
      {sizeBytes && sizeBytes > 0 ? (
        <>
          <span className="shrink-0 text-black/35">·</span>
          <span data-message-affordance="attachment-meta-size" className="shrink-0">{formatFileSizeBytes(sizeBytes, formatMessage)}</span>
        </>
      ) : null}
    </span>
  );
}

function DiffPatchStatsLine({ preview }: { preview: DiffAttachmentPreview | null }) {
  const { formatMessage } = useIntl();
  if (!preview) {
    return <span className="text-black/70">{formatMessage({ id: "message.messageItem.diffPreview" })}</span>;
  }

  const { files, hunks, additions, deletions } = preview.stats;

  return (
    <>
      <span className="text-black/70">{formatMessage({ id: "message.messageItem.diffStats" }, { fileCount: files, hunkCount: hunks })}</span>
      <span className="text-[#1f883d]">+{additions}</span>
      <span className="text-[#cf222e]">-{deletions}</span>
    </>
  );
}

function DocumentPreviewSummaryLine({ preview }: { preview: DocumentAttachmentPreviewState | null }) {
  const { formatMessage } = useIntl();
  if (!preview) {
    return <span className="min-w-0 truncate text-black/70">{formatMessage({ id: "message.messageItem.documentPreview" })}</span>;
  }

  if (preview.preview.kind === "csv") {
    const id = preview.truncated
      ? "message.messageItem.documentSummaryFirst"
      : "message.messageItem.documentSummaryPreview";
    return <span className="min-w-0 truncate text-black/70">{formatMessage({ id }, { rowCount: preview.preview.rows.length, columnCount: preview.preview.columnCount })}</span>;
  }
  if (preview.preview.kind === "markdown") {
    return <span className="min-w-0 truncate text-black/70">{formatMessage({ id: "message.messageItem.markdownDocument" })}</span>;
  }
  if (preview.preview.kind === "text") {
    return <span className="min-w-0 truncate text-black/70">{formatMessage({ id: "message.messageItem.plainTextDocument" })}</span>;
  }
  if (preview.preview.kind === "xlsx") {
    return <span className="min-w-0 truncate text-black/70">{formatMessage({ id: "message.messageItem.xlsxDocument" })}</span>;
  }
  return <span className="min-w-0 truncate text-black/70">{formatMessage({ id: "message.messageItem.pdfDocument" })}</span>;
}

// Locale-aware document-preview label for attachment card metadata. The modal
// header intentionally shows only the filename and actions.

function AttachmentCard({
  attachment,
  isOptimistic,
  isHtml,
  isImage,
  isVideo,
  isAudio,
  isHtmlLoading,
  onClick,
  onDownload,
}: {
  attachment: NonNullable<Message["attachments"]>[number];
  isOptimistic: boolean;
  isHtml: boolean;
  isImage: boolean;
  isVideo: boolean;
  isAudio: boolean;
  isHtmlLoading: boolean;
  onClick: () => void;
  onDownload: () => void;
}) {
  const { formatMessage } = useIntl();
  const [diffPreview, setDiffPreview] = useState<DiffAttachmentPreview | null>(null);
  const [documentPreview, setDocumentPreview] = useState<DocumentAttachmentPreviewState | null>(null);
  const isDiffPatch = isDiffPatchAttachment(attachment);
  const isDocumentPreview = isPreviewableDocumentAttachment(attachment);

  // Async-loader: reset previews + fetch new ones when `attachment.id` or
  // preview-type flags change. Same FP family as Cluster 2's
  // ChannelFilesPanel / QuotedMessagePermalinkPreview async-loaders.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    if ((!isDiffPatch && !isDocumentPreview) || isOptimistic) {
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setDiffPreview(null);
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setDocumentPreview(null);
      return;
    }
    void fetchAttachmentPreviewSummary(attachment.id)
      .then((data) => {
        if (cancelled || !data) return;
        if (data.status === "ok" && data.data.kind === "diff") {
          setDiffPreview(data.data);
          setDocumentPreview(null);
          return;
        }
        if (data.status === "ok" && (data.data.kind === "csv" || data.data.kind === "xlsx" || data.data.kind === "markdown" || data.data.kind === "pdf" || data.data.kind === "text")) {
          setDocumentPreview({ preview: data.data, truncated: data.truncated === true });
          setDiffPreview(null);
          return;
        }
        setDiffPreview(null);
        setDocumentPreview(null);
      })
      .catch(() => {
        if (!cancelled) {
          setDiffPreview(null);
          setDocumentPreview(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [attachment.id, isDiffPatch, isDocumentPreview, isOptimistic]);

  if (isDiffPatch) {
    return (
      <AttachmentChip
        attachment={attachment}
        variant="compact"
        isOptimistic={isOptimistic}
        onClick={onDownload}
        affordance="download"
        meta={<AttachmentMetaText label={attachment.mimeType || formatMessage({ id: "message.messageItem.metaPatch" })} sizeBytes={attachment.sizeBytes} />}
        summary={<DiffPatchStatsLine preview={diffPreview} />}
      />
    );
  }

  if (isDocumentPreview) {
    return (
      <AttachmentChip
        attachment={attachment}
        variant="compact"
        isOptimistic={isOptimistic}
        loading={isHtmlLoading}
        loadingLabel={formatMessage({ id: "message.messageItem.openingPreview" })}
        onClick={onClick}
        affordance="preview"
        affordanceName="document-preview"
        meta={<AttachmentMetaText label={documentPreview ? formatMessage({ id: DOCUMENT_PREVIEW_LABEL_ID[documentPreview.preview.kind] }) : attachment.mimeType || formatMessage({ id: "message.messageItem.metaDocument" })} sizeBytes={attachment.sizeBytes} />}
        summary={<DocumentPreviewSummaryLine preview={documentPreview} />}
      />
    );
  }

  // Stryker disable next-line ConditionalExpression,LogicalOperator: shared card branch matrix predates audio; this PR's audio branch is covered by audioAttachmentPreview.behavior.test.tsx.
  const primaryIsPreview = isImage || isHtml || isVideo || isAudio;
  // Stryker disable next-line ConditionalExpression: audio/non-preview click behavior is covered by audioAttachmentPreview.behavior.test.tsx; legacy image/html/video branches are covered elsewhere.
  const primaryOnClick = primaryIsPreview ? onClick : onDownload;
  // Stryker disable next-line ConditionalExpression,StringLiteral: visual affordance labels for legacy branches are source-pinned; audio/file behavior is covered by DOM tests.
  const primaryAffordance = primaryIsPreview ? "preview" : "download";
  // Stryker disable next-line ConditionalExpression,StringLiteral: data-affordance names are source/query contracts; audio/file names are additionally covered by DOM tests.
  const primaryAffordanceName = isHtml ? "html-preview" : isImage ? "image-preview" : isVideo ? "video-preview" : isAudio ? "audio-preview" : "file-download";
  // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: meta copy for legacy preview types is source-pinned; audio/file copy is covered by DOM tests.
  const primaryMetaLabel = isHtml ? formatMessage({ id: "message.messageItem.htmlPreview" }) : isVideo ? formatMessage({ id: "message.messageItem.videoPreview" }) : isAudio ? formatMessage({ id: "message.messageItem.audioPreview" }) : attachment.mimeType || formatMessage({ id: "message.messageItem.metaFile" });

  return (
    <AttachmentChip
      attachment={attachment}
      variant="wide"
      isOptimistic={isOptimistic}
      loading={isHtmlLoading}
      loadingLabel={formatMessage({ id: "message.messageItem.openingPreview" })}
      onClick={primaryOnClick}
      affordance={primaryAffordance}
      affordanceName={primaryAffordanceName}
      icon={isVideo ? <Play size={16} className="text-black/70" /> : isAudio ? <Music size={16} className="text-black/70" /> : undefined}
      meta={<AttachmentMetaText label={primaryMetaLabel} sizeBytes={attachment.sizeBytes} />}
      secondaryDownload={isAudio ? { onClick: onDownload, label: formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename }), affordanceName: "audio-download" } : undefined}
    />
  );
}

function InlineVideoAttachmentCard({
  attachment,
  isOptimistic,
  onOpenPreview,
  onDownload,
}: {
  attachment: NonNullable<Message["attachments"]>[number];
  isOptimistic: boolean;
  onOpenPreview: () => void;
  onDownload: () => void;
}) {
  const { formatMessage } = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const inlineUrl = attachment.localPreviewUrl ?? fetchedUrl;

  const loadInlineVideoUrl = useCallback(() => {
    if (inlineUrl || isOptimistic || requestRef.current) return;
    setLoadingUrl(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const request = api.get(`/attachments/${attachment.id}/url?disposition=inline`, { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setFetchedUrl(data.url);
        setLoadFailed(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error("Failed to load inline video attachment URL:", err);
        setLoadFailed(true);
      })
      .finally(() => {
        if (requestRef.current === request) {
          requestRef.current = null;
        }
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        if (!controller.signal.aborted) {
          setLoadingUrl(false);
        }
      });
    requestRef.current = request;
  }, [attachment.id, inlineUrl, isOptimistic]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || isOptimistic) return;
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      loadInlineVideoUrl();
      return () => {
        abortRef.current?.abort();
      };
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          loadInlineVideoUrl();
        } else {
          videoRef.current?.pause();
        }
      },
      { rootMargin: "160px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      abortRef.current?.abort();
    };
  }, [attachment.id, isOptimistic, loadInlineVideoUrl]);

  return (
    <div
      ref={containerRef}
      data-message-affordance="inline-video-preview"
      className="group/video relative w-full max-w-[min(28rem,calc(100vw-7rem))] overflow-hidden border-2 border-black bg-black text-left"
      title={attachment.filename}
    >
      <div className="relative aspect-video w-full bg-black">
        {inlineUrl && !loadFailed ? (
          <>
            <video
              ref={videoRef}
              title={formatMessage({ id: "message.messageItem.videoAttachmentTitle" }, { filename: attachment.filename })}
              src={inlineUrl}
              controls
              playsInline
              preload="metadata"
              className="block h-full w-full bg-black object-contain"
              onError={() => setLoadFailed(true)}
            />
          </>
        ) : (
          <button
            type="button"
            onClick={loadFailed ? onDownload : undefined}
            className={`flex h-full w-full items-center justify-center bg-black text-white ${loadFailed ? "hover:bg-black/90" : "cursor-default"}`}
            aria-label={loadFailed ? formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename }) : formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}
          >
            {isOptimistic || loadingUrl ? (
              <Spinner size="md" variant="inverse" />
            ) : loadFailed ? (
              <div className="flex max-w-[16rem] flex-col items-center gap-2 px-4 text-center text-xs font-bold">
                <AlertTriangle size={24} />
                <span>{formatMessage({ id: "message.messageItem.codecWarning" })}</span>
                <span className="inline-flex items-center gap-1 text-white/75">
                  <Download size={13} />
                  {formatMessage({ id: "message.messageItem.downloadToView" })}
                </span>
              </div>
            ) : (
              <Play size={32} className="text-white/80" />
            )}
          </button>
        )}
        {!isOptimistic && (
          <button
            type="button"
            onClick={onOpenPreview}
            title={formatMessage({ id: "message.messageItem.openInPreview" }, { filename: attachment.filename })}
            className="absolute right-1.5 top-1.5 flex size-6 items-center justify-center border border-black bg-white/80 text-black/60 hover:bg-white hover:text-black"
            aria-label={formatMessage({ id: "message.messageItem.openInPreview" }, { filename: attachment.filename })}
            data-message-affordance="inline-video-expand"
          >
            <Eye size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function formatAudioTimestamp(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function InlineAudioPlayer({
  filename,
  url,
  onError,
}: {
  filename: string;
  url: string;
  onError: () => void;
}) {
  const { formatMessage } = useIntl();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const durationKnown = duration > 0;
  const boundedCurrentTime = durationKnown ? Math.min(currentTime, duration) : currentTime;
  const progress = durationKnown ? Math.max(0, Math.min(100, (boundedCurrentTime / duration) * 100)) : 0;
  const volumeProgress = Math.round(volume * 100);
  const currentTimeLabel = formatAudioTimestamp(boundedCurrentTime);
  const durationLabel = formatAudioTimestamp(duration);
  const timeLabel = `${currentTimeLabel} / ${durationLabel}`;

  const syncMediaState = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime || 0);
    setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
    setPlaying(!audio.paused && !audio.ended);
  }, []);

  const handleTogglePlayback = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }
    setPlaying(true);
    try {
      const playResult = audio.play();
      void playResult.catch(() => setPlaying(false));
    } catch {
      setPlaying(false);
    }
  }, [playing]);

  const handleSeek = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(event.currentTarget.value);
    if (!Number.isFinite(nextTime)) return;
    const audio = audioRef.current;
    const boundedTime = durationKnown ? Math.max(0, Math.min(duration, nextTime)) : 0;
    if (audio) audio.currentTime = boundedTime;
    setCurrentTime(boundedTime);
  }, [duration, durationKnown]);

  const handleVolumeChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextVolume = Number(event.currentTarget.value);
    if (!Number.isFinite(nextVolume)) return;
    const boundedVolume = Math.max(0, Math.min(1, nextVolume));
    const audio = audioRef.current;
    if (audio) audio.volume = boundedVolume;
    setVolume(boundedVolume);
  }, []);

  return (
    <div data-message-affordance="inline-audio-player" className="w-full border border-black bg-brutal-cream p-2">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          data-message-affordance="audio-play-toggle"
          aria-label={formatMessage({ id: playing ? "message.messageItem.pauseAudio" : "message.messageItem.playAudio" }, { filename })}
          className="flex size-7 shrink-0 items-center justify-center border border-black bg-white text-black transition-colors hover:bg-soft-signal focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
          onClick={handleTogglePlayback}
        >
          {playing ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
        </button>
        <div className="relative h-7 min-w-0 flex-1">
          <input
            type="range"
            data-message-affordance="audio-seek"
            aria-label={formatMessage({ id: "message.messageItem.seekAudio" }, { filename })}
            aria-valuetext={timeLabel}
            min={0}
            max={durationKnown ? duration : 1}
            step={0.1}
            value={durationKnown ? boundedCurrentTime : 0}
            disabled={!durationKnown}
            className="peer absolute inset-0 z-10 h-7 w-full opacity-0"
            onChange={handleSeek}
          />
          <div
            data-message-affordance="audio-seek-rail"
            className="pointer-events-none absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 border border-black bg-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black"
            aria-hidden="true"
          >
            <div className="h-full bg-brutal-cyan" style={{ width: `${progress}%` }} />
          </div>
          <span
            data-message-affordance="audio-seek-thumb"
            className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 border border-black bg-white peer-focus-visible:bg-soft-signal peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-black"
            style={{ left: `${progress}%` }}
            aria-hidden="true"
          />
        </div>
        <div data-message-affordance="audio-time" className="w-[4.75rem] shrink-0 text-right font-mono text-[11px] font-bold tabular-nums text-black/60">
          {timeLabel}
        </div>
      </div>
      <div data-message-affordance="audio-volume-control" className="mt-1.5 flex items-center gap-2 pl-9">
        <Volume2 size={13} className="shrink-0 text-black/60" aria-hidden="true" />
        <div className="relative h-6 min-w-0 flex-1">
          <input
            type="range"
            data-message-affordance="audio-volume"
            aria-label={formatMessage({ id: "message.messageItem.audioVolume" }, { filename })}
            aria-valuetext={`${volumeProgress}%`}
            min={0}
            max={1}
            step={0.05}
            value={volume}
            className="peer absolute inset-0 z-10 h-6 w-full opacity-0"
            onChange={handleVolumeChange}
          />
          <div
            data-message-affordance="audio-volume-rail"
            className="pointer-events-none absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 border border-black bg-white peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-black"
            aria-hidden="true"
          >
            <div className="h-full bg-soft-signal" style={{ width: `${volumeProgress}%` }} />
          </div>
          <span
            data-message-affordance="audio-volume-thumb"
            className="pointer-events-none absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 border border-black bg-white peer-focus-visible:bg-soft-signal peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-black"
            style={{ left: `${volumeProgress}%` }}
            aria-hidden="true"
          />
        </div>
      </div>
      <audio
        ref={audioRef}
        title={formatMessage({ id: "message.messageItem.audioPreviewTitle" }, { filename })}
        src={url}
        preload="metadata"
        className="hidden"
        onLoadedMetadata={syncMediaState}
        onDurationChange={syncMediaState}
        onTimeUpdate={syncMediaState}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={onError}
      />
    </div>
  );
}

function InlineAudioAttachmentCard({
  attachment,
  isOptimistic,
  onDownload,
}: {
  attachment: NonNullable<Message["attachments"]>[number];
  isOptimistic: boolean;
  onDownload: () => void;
}) {
  const { formatMessage } = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<Promise<void> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [fetchedUrl, setFetchedUrl] = useState<string | null>(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const inlineUrl = attachment.localPreviewUrl ?? fetchedUrl;

  const loadInlineAudioUrl = useCallback(() => {
    if (inlineUrl || isOptimistic || requestRef.current) return;
    setLoadingUrl(true);
    const controller = new AbortController();
    abortRef.current = controller;
    const request = api.get(`/attachments/${attachment.id}/url?disposition=inline`, { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setFetchedUrl(data.url);
        setLoadFailed(false);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        console.error("Failed to load inline audio attachment URL:", err);
        setLoadFailed(true);
      })
      .finally(() => {
        if (requestRef.current === request) {
          requestRef.current = null;
        }
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
        if (!controller.signal.aborted) {
          setLoadingUrl(false);
        }
      });
    requestRef.current = request;
  }, [attachment.id, inlineUrl, isOptimistic]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || isOptimistic) return;
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      loadInlineAudioUrl();
      return () => {
        abortRef.current?.abort();
      };
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          loadInlineAudioUrl();
        }
      },
      { rootMargin: "160px 0px" },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      abortRef.current?.abort();
    };
  }, [attachment.id, isOptimistic, loadInlineAudioUrl]);

  const downloadButton = (
    <button
      type="button"
      data-message-affordance="audio-download"
      aria-label={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename })}
      title={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename })}
      className="flex size-7 items-center justify-center border border-black bg-white text-black/60 hover:bg-soft-signal hover:text-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDownload();
      }}
    >
      <Download size={14} />
    </button>
  );

  return (
    <div
      ref={containerRef}
      data-message-affordance="inline-audio-preview"
      className="w-full max-w-xl"
    >
      {inlineUrl && !loadFailed ? (
        <div className={INLINE_AUDIO_PREVIEW_CARD_CLASS}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center border-2 border-black bg-soft-signal">
                <Music size={16} className="text-black" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-black" title={attachment.filename}>{attachment.filename}</div>
                <div className="text-xs font-bold text-black/50">{formatMessage({ id: "message.messageItem.audioFile" })}</div>
              </div>
            </div>
            {downloadButton}
          </div>
          <InlineAudioPlayer
            key={inlineUrl}
            filename={attachment.filename}
            url={inlineUrl}
            onError={() => setLoadFailed(true)}
          />
        </div>
      ) : (
        <div className={INLINE_AUDIO_PREVIEW_CARD_CLASS}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex size-8 shrink-0 items-center justify-center border-2 border-black bg-soft-signal">
                <Music size={16} className="text-black" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-bold text-black" title={attachment.filename}>{attachment.filename}</div>
                <div className="text-xs font-bold text-black/50">{formatMessage({ id: "message.messageItem.audioFile" })}</div>
              </div>
            </div>
            {!isOptimistic && !loadFailed ? downloadButton : null}
          </div>
          <button
            type="button"
            className={`flex h-10 w-full items-center justify-center border border-black bg-brutal-cream text-xs font-bold text-black/70 ${loadFailed ? "hover:bg-soft-signal" : "cursor-default"}`}
            onClick={loadFailed ? onDownload : undefined}
            aria-label={loadFailed ? formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename }) : formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}
          >
            {isOptimistic || loadingUrl ? (
              <span className="inline-flex items-center gap-2">
                <Spinner size="xs" />
                {formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}
              </span>
            ) : loadFailed ? (
              <span className="inline-flex items-center gap-1.5">
                <Download size={13} />
                {formatMessage({ id: "message.messageItem.downloadToView" })}
              </span>
            ) : (
              <span>{formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}



// Lets renderer-specific layers inside the preview (e.g. the HTML comment
// overlay) see the shell's comment mode and push captured anchors into the
// composer without the generic shell knowing any renderer internals.








// Per-attachment host-message context handed to the image lightbox so its
// comments panel can resolve the review conversation (F10, task #10).
// DORMANT: image comments are descoped (cindyz 6/11) — no caller passes
// this until image region anchors get their own design. The lightbox side
// stays wired and renders no affordance without contexts.
// oxlint-disable-next-line no-unused-vars
function buildLightboxCommentContexts(
  images: MessageAttachment[],
  message: Message,
): Record<string, LightboxCommentContext> {
  const contexts: Record<string, LightboxCommentContext> = {};
  for (const img of images) {
    contexts[img.id] = {
      parentMessage: {
        id: message.id,
        channelId: message.channelId,
        senderId: message.senderId,
        senderType: message.senderType,
      },
    };
  }
  return contexts;
}

interface MessageItemProps {
  message: Message;
  mentionMap: Map<string, MentionEntry>;
  channels: Channel[];
  previewSenderAgent?: Agent;
  previewSenderMember?: ServerMember;
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>;
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>;
  threadSummary?: ThreadSummary;
  parentChannelId?: string;
  parentMessageId?: string;
  hideThreadActions?: boolean;
  showThreadFollowAction?: boolean;
  linkedTask?: Task;
  senderAvatarTestId?: string;
  mentionComposerChannelId?: string;
  /**
   * The local collection that owns this rendered message. Thread responses do
   * not carry conversationContext on every HTTP/update shape, so callers that
   * know the collection must pass it instead of reconstructing scope from the
   * message payload.
   */
  reactionParentScopeKey?: SyncScopeKey;
  /** Mutation authority for this rendered channel/thread. Readable messages
   * may still be non-interactive when the viewer is not a member. */
  canReact?: boolean;
  onBeforeOpenThread?: () => void;
  onOpenThread?: (request: OpenThreadRequest) => void;
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  threadSearchHighlightQuery?: string;
  threadSearchActive?: boolean;
  /**
   * Consecutive-same-sender grouping state (task #44). When a message continues
   * the previous sender's group, avatar + name are hidden and the timestamp
   * moves to a hover gutter. Optional — surfaces that don't compute grouping
   * (thread / DM panels) omit it and keep the full header.
   */
  groupState?: MessageGroupState;
}

// Isolated subscriber — only re-renders when this agent's activity changes.
function AgentStatusDot({
  agentId,
  fallbackAgent,
  className,
  ...rest
}: {
  agentId: string;
  fallbackAgent?: Pick<Agent, "status"> | null;
} & Omit<StatusDotProps, "activity" | "external" | "tone">) {
  const { formatMessage } = useIntl();
  const displayState = useAgentDisplayState(agentId, fallbackAgent);
  const activityText = formatActivityText(
    formatMessage,
    displayState.activity,
    displayState.activityDetail,
    displayState.activityDetailKind,
  );
  return (
    <StatusDot
      activity={displayState.activity}
      external={displayState.isExternal}
      title={activityText}
      className={className}
      {...rest}
    />
  );
}

// Isolates hover-card state so opening the card doesn't re-render the whole MessageItem.
// Stryker disable all: sender preview-card composition is covered by the existing sender-resolution contracts plus manual visual validation; this migration batch is not adding new hover DOM tests.
function MessageSenderAvatar({
  showAgent,
  showExternal,
  isDeactivatedAgent,
  senderId,
  agentAvatarUrl,
  avatarUrl,
  gravatarHash,
  email,
  hoverAgent,
  hoverMember,
  externalAvatarUrl,
  externalInitials,
  testId,
  onNavigateAgent,
  onNavigateAgentActivity,
  onNavigateHuman,
  onContextMenu,
  onLongPressMention,
}: {
  showAgent: boolean;
  showExternal: boolean;
  isDeactivatedAgent: boolean;
  senderId: string;
  agentAvatarUrl: string | null;
  avatarUrl: string | null;
  gravatarHash: string | undefined;
  email?: string | null;
  hoverAgent?: Agent | null;
  hoverMember?: ServerMember | null;
  externalAvatarUrl?: string | null;
  externalInitials?: string | null;
  testId?: string;
  onNavigateAgent: (id: string) => void;
  onNavigateAgentActivity: (id: string) => void;
  onNavigateHuman: (id: string) => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  onLongPressMention?: () => void;
}) {
  const previewActionsRef = useRef<{ close: () => void; unmount: () => void } | null>(null);
  const longPressStartedAtRef = useRef<number | null>(null);
  const longPressStartPointRef = useRef<{ x: number; y: number } | null>(null);
  const longPressArmedRef = useRef(false);
  const longPressFiredRef = useRef(false);
  const [avatarPressed, setAvatarPressed] = useState(false);
  const mentionType = showAgent ? "agent" : "user";
  const onClickAgent = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    previewActionsRef.current?.close();
    onNavigateAgent(senderId);
  };
  // Same close-before-navigate rule as onClickAgent above: the hover card must
  // be dismissed before we move, or it stays floating over the destination.
  const onOpenAgentActivity = (agentId: string) => {
    previewActionsRef.current?.close();
    onNavigateAgentActivity(agentId);
  };
  const onClickHuman = () => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    previewActionsRef.current?.close();
    onNavigateHuman(senderId);
  };
  const handleAvatarTouchStart = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    setAvatarPressed(true);
    if (!onLongPressMention) return;
    event.stopPropagation();
    const touch = event.touches[0];
    longPressStartPointRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    longPressStartedAtRef.current = event.timeStamp;
    longPressArmedRef.current = true;
    longPressFiredRef.current = false;
  }, [onLongPressMention]);
  const handleAvatarPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (
      onLongPressMention
      && event.pointerType === "touch"
      && document.activeElement?.tagName === "TEXTAREA"
    ) {
      // PointerDown is cancelable on mobile browsers; TouchStart listeners may
      // be passive. Prevent the avatar button from stealing composer focus so
      // an already-open keyboard remains open through the long press.
      event.preventDefault();
    }
  }, [onLongPressMention]);
  const handleAvatarTouchMove = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    if (!longPressArmedRef.current) return;
    event.stopPropagation();
    const start = longPressStartPointRef.current;
    const touch = event.touches[0];
    if (start && touch) {
      const deltaX = touch.clientX - start.x;
      const deltaY = touch.clientY - start.y;
      if (deltaX * deltaX + deltaY * deltaY <= SENDER_AVATAR_LONG_PRESS_MOVE_TOLERANCE_PX ** 2) {
        return;
      }
    }
    setAvatarPressed(false);
    longPressArmedRef.current = false;
    longPressStartedAtRef.current = null;
    longPressStartPointRef.current = null;
  }, []);
  const handleAvatarTouchEnd = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    setAvatarPressed(false);
    if (!longPressArmedRef.current) return;
    event.stopPropagation();
    const startedAt = longPressStartedAtRef.current;
    longPressArmedRef.current = false;
    longPressStartedAtRef.current = null;
    longPressStartPointRef.current = null;
    longPressFiredRef.current = startedAt !== null && event.timeStamp - startedAt >= SENDER_AVATAR_LONG_PRESS_MS;
    if (!longPressFiredRef.current || !onLongPressMention) return;
    event.preventDefault();
    previewActionsRef.current?.close();
    onLongPressMention();
  }, [onLongPressMention]);
  const handleAvatarTouchCancel = useCallback((event: TouchEvent<HTMLButtonElement>) => {
    setAvatarPressed(false);
    event.stopPropagation();
    longPressArmedRef.current = false;
    longPressFiredRef.current = false;
    longPressStartedAtRef.current = null;
    longPressStartPointRef.current = null;
  }, []);
  const handleAvatarContextMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    if (longPressArmedRef.current || longPressFiredRef.current) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onContextMenu?.(event);
  }, [onContextMenu]);
  const humanAvatarSource = isRaftUploadedHumanAvatarUrl(avatarUrl)
    ? "uploaded"
    : gravatarHash
      ? "gravatar-hash"
      : email
        ? "email-fallback"
        : "placeholder";
  if (showExternal) {
    return (
      <div
        className="mt-0.5 shrink-0 self-start"
        data-testid={testId}
        data-avatar-kind="external"
        data-avatar-source={externalAvatarUrl ? "external-avatar" : "placeholder"}
      >
        <AvatarSlot
          context="panel-header"
          type="app"
          appAvatarUrl={externalAvatarUrl}
          appInitials={externalInitials}
        />
      </div>
    );
  }
  // Unified wrapper structure for both agent + human paths so the avatar
  // top sits at the same vertical offset regardless of sender kind. Was:
  // agent had an extra wrapping <div relative> (for AgentStatusDot's
  // absolute positioning) which inherited inline-block baseline alignment
  // and pushed the inner button down by ~11px. human had only the bare
  // button. Net effect: agent avatar drifted noticeably below human
  // avatar across an otherwise identical message row. (#wg-theme:7470ca2a
  // stdrc 2026-05-11.)
  //
  // Now both kinds render `<button>` as the avatar wrapper. Agent activity is
  // composed inside raft-ui AvatarBadge, so there is still no extra wrapper or
  // inline-block baseline drift.
  //
  // `mt-1` (was `mt-0.5`) pushes the avatar's top border down to the
  // visible cap-top of the sender-name first line, not the bare line-box
  // top. With text-sm + leading-5, the rendered cap-top of the first line
  // is roughly 4–5px below the line-box top, so a 4px `mt` keeps the
  // avatar's outer border visually flush with the first line of text
  // rather than floating above it. Per stdrc: "头像的上面要留一些空间，
  // 使得头像的顶部边框与其右边第一行内容的顶部保持对齐."
  if (showAgent) {
    return (
      <PreviewCard actionsRef={previewActionsRef}>
        <PreviewCardTrigger
          delay={200}
          closeDelay={120}
          render={
            <button
              type="button"
              onClick={onClickAgent}
              onContextMenu={handleAvatarContextMenu}
              onPointerDown={handleAvatarPointerDown}
              onTouchStart={handleAvatarTouchStart}
              onTouchMove={handleAvatarTouchMove}
              onTouchEnd={handleAvatarTouchEnd}
              onTouchCancel={handleAvatarTouchCancel}
              data-testid={testId}
              data-avatar-kind="agent"
              data-avatar-source={agentAvatarUrl ? "agent-avatar" : "placeholder"}
              data-avatar-pressed={avatarPressed ? "true" : "false"}
              className={`relative mt-0.5 shrink-0 self-start transition-[filter,transform] duration-75 hover:brightness-90 ${avatarPressed ? "scale-90 brightness-75" : ""}`}
            >
              <AvatarSlot
                context="panel-header"
                type="agent"
                agentAvatarUrl={agentAvatarUrl}
                badge={!isDeactivatedAgent ? (
                  <AgentStatusDot agentId={senderId} fallbackAgent={hoverAgent} />
                ) : undefined}
                className={isDeactivatedAgent ? "grayscale opacity-60" : ""}
              />
            </button>
          }
        />
        <PreviewCardContent sideOffset={6} collisionPadding={6} className="w-[280px]">
          <ProfilePreviewCardContent
            mentionType={mentionType}
            mentionId={senderId}
            fallbackAgent={hoverAgent}
            onOpenAgentActivity={onOpenAgentActivity}
          />
        </PreviewCardContent>
      </PreviewCard>
    );
  }
  return (
    <PreviewCard actionsRef={previewActionsRef}>
      <PreviewCardTrigger
        delay={200}
        closeDelay={120}
        render={
          <button
            type="button"
          onClick={onClickHuman}
          onContextMenu={handleAvatarContextMenu}
          onPointerDown={handleAvatarPointerDown}
            onTouchStart={handleAvatarTouchStart}
            onTouchMove={handleAvatarTouchMove}
            onTouchEnd={handleAvatarTouchEnd}
            onTouchCancel={handleAvatarTouchCancel}
            data-testid={testId}
            data-avatar-kind="human"
            data-avatar-source={humanAvatarSource}
            data-avatar-pressed={avatarPressed ? "true" : "false"}
            data-avatar-has-uploaded={isRaftUploadedHumanAvatarUrl(avatarUrl) ? "true" : "false"}
            data-avatar-has-gravatar-hash={gravatarHash ? "true" : "false"}
            data-avatar-has-email-fallback={email ? "true" : "false"}
            className={`mt-0.5 shrink-0 self-start transition-[filter,transform] duration-75 hover:brightness-90 ${avatarPressed ? "scale-90 brightness-75" : ""}`}
          >
            <AvatarSlot
              context="panel-header"
              type="human"
              humanAvatarUrl={avatarUrl}
              gravatarHash={gravatarHash}
              email={email}
            />
          </button>
        }
      />
      <PreviewCardContent sideOffset={6} collisionPadding={6} className="w-[280px]">
        <ProfilePreviewCardContent mentionType={mentionType} mentionId={senderId} fallbackMember={hoverMember} />
      </PreviewCardContent>
    </PreviewCard>
  );
}

// Returns a stable semantic `action` so the click handler never depends on the
// (now localized) label text — comparing a localized label to "Retry" would
// misroute the action under zh.
function translationIndicatorText(
  entry: TranslationEntry,
  showOriginal: boolean,
  formatMessage: IntlShape["formatMessage"],
) {
  if (hasUsableTranslatedContent(entry)) {
    return showOriginal
      ? { label: formatMessage({ id: "message.messageItem.showTranslation" }), message: "", title: formatMessage({ id: "message.messageItem.showTranslationTitle" }), tone: "normal" as const, action: "toggle" as const }
      : { label: formatMessage({ id: "message.messageItem.showOriginal" }), message: "", title: formatMessage({ id: "message.messageItem.showOriginalTitle" }), tone: "normal" as const, action: "toggle" as const };
  }
  if (entry.status === "pending") {
    return { label: "", message: formatMessage({ id: "message.messageItem.translating" }), title: formatMessage({ id: "message.messageItem.translatingTitle" }), tone: "pending" as const, action: "toggle" as const };
  }
  return { label: formatMessage({ id: "message.messageItem.translationRetry" }), message: formatMessage({ id: "message.messageItem.translationUnavailable" }), title: formatMessage({ id: "message.messageItem.translationUnavailable" }), tone: "failed" as const, action: "retry" as const };
}

function hasUsableTranslatedContent(entry: TranslationEntry | undefined) {
  return entry?.status === "translated"
    && typeof entry.translatedContent === "string"
    && entry.translatedContent.trim().length > 0;
}

function shouldRenderTranslationIndicator(entry: TranslationEntry) {
  return hasUsableTranslatedContent(entry)
    || entry.status === "pending"
    || entry.status === "failed";
}

function TranslationIndicator({
  entry,
  onToggleOriginal,
  onRetry,
  onUpgrade,
  showOriginal,
}: {
  entry: TranslationEntry;
  onToggleOriginal: () => void;
  onRetry: () => void;
  onUpgrade: () => void;
  showOriginal: boolean;
}) {
  const { formatMessage } = useIntl();
  if (!shouldRenderTranslationIndicator(entry)) return null;
  const text = translationIndicatorText(entry, showOriginal, formatMessage);
  const Icon = text.tone === "failed" ? AlertTriangle : Languages;
  // onUpgrade retained for API compatibility; no translation entry currently
  // maps to an upgrade action (the former "Upgrade" label branch was dead).
  void onUpgrade;
  const handleAction = text.action === "retry" ? onRetry : onToggleOriginal;
  const action = text.label
    ? (
      <button
        type="button"
        onClick={handleAction}
        className={`font-bold underline decoration-black/40 underline-offset-2 hover:decoration-black ${
          text.tone === "failed" ? "text-brutal-orange" : ""
        }`}
        title={text.title}
        aria-label={text.label || text.title}
      >
        {text.label}
      </button>
    )
    : null;

  return (
    <div
      className={`inline-flex items-center gap-1.5 text-[11px] font-mono ${
        text.tone === "failed" ? "text-brutal-orange" : "text-black/45"
      }`}
      data-testid={`message-translation-indicator-${entry.messageId}`}
      title={action ? undefined : text.title}
    >
      <Icon size={12} className={text.tone === "pending" ? "animate-pulse" : ""} />
      {text.message && <span>{text.message}</span>}
      {text.message && action && <span aria-hidden>·</span>}
      {action}
    </div>
  );
}

interface MessageMarkdownBodyProps {
  content: string;
  channels: Channel[];
  mentionMap: Map<string, MentionEntry>;
  structuredMentionMap: Map<string, MentionEntry>;
  onNavigateChannel: (channel: Channel) => void;
  onNavigateDm: (channel: Channel) => void;
  onNavigateAgent: (agentId: string) => void;
  onNavigateHuman: (userId: string) => void;
  onNavigateComputer: (machineId: string) => void;
  onOpenThread?: (intent: ThreadRefIntent) => void | Promise<void>;
  resolvingThreadRefKey?: string | null;
  onOpenTask?: (taskNumber: number) => void;
  onOpenMessage?: (channel: Channel, messageId: string, threadParentShortId: string | null) => void | Promise<void>;
  onOpenPermalink?: (href: string) => void;
  serverSlug?: string;
  refAuthorityServerSlug?: string;
  threadRefAuthorityUnavailable?: boolean;
  knownTaskNumbers?: Set<number>;
  timeFormatOptions: TimeFormatOptions;
  threadSearchHighlightQuery?: string;
  /** #693 per-@mentioned-agent read badge. Primitives only, so the memo above
   *  still short-circuits — an object prop would defeat it. */
  readReceiptChannelId: string;
  readReceiptMessageSeq: number | undefined;
  readReceiptEnabled: boolean;
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>;
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>;
  unavailableQuotedPermalinkUrl?: string | null;
}

// Memoized markdown body. `renderContent` runs the full markdown preprocessing
// + react-markdown parse, which the 2026-06-06 prod CPU trace showed to be ~33%
// of main-thread JS in the message list. Wrapping it in a memo'd component lets
// it skip that work whenever the parent MessageItem re-renders WITHOUT a change
// to the actual markdown inputs — provided callers pass referentially-stable
// props (the navigate/open handlers are now useCallback'd and useAppNavigate is
// memoized). #wg-frontend-perf.
const MessageMarkdownBody = memo(function MessageMarkdownBody(props: MessageMarkdownBodyProps) {
  const { formatMessage } = useIntl();
  const readReceiptScope = useMemo<MessageReadReceiptScope>(() => ({
    channelId: props.readReceiptChannelId,
    messageSeq: props.readReceiptMessageSeq,
    enabled: props.readReceiptEnabled,
  }), [props.readReceiptChannelId, props.readReceiptMessageSeq, props.readReceiptEnabled]);
  const body = renderContent(
    props.content,
    props.channels,
    props.mentionMap,
    props.structuredMentionMap,
    props.onNavigateChannel,
    props.onNavigateDm,
    props.onNavigateAgent,
    props.onNavigateHuman,
    props.onNavigateComputer,
    props.onOpenThread,
    props.resolvingThreadRefKey,
    props.onOpenTask,
    props.onOpenMessage,
    props.onOpenPermalink,
    props.serverSlug,
    props.refAuthorityServerSlug,
    props.threadRefAuthorityUnavailable,
    props.knownTaskNumbers,
    props.timeFormatOptions,
    props.threadSearchHighlightQuery,
    formatMessage,
    props.channelParticipantAgentsById,
    props.channelParticipantMembersById,
    props.unavailableQuotedPermalinkUrl,
  );
  return (
    <MessageReadReceiptScopeProvider value={readReceiptScope}>
      {body}
    </MessageReadReceiptScopeProvider>
  );
});

// Persistent thread-ref notice is keyed (not a formatted string) so it
// re-localizes on a language switch while still displayed.
type ThreadRefNoticeKey =
  | "message.messageItem.threadServerUnknown"
  | "message.messageItem.threadUnavailable"
  | "message.messageItem.sourceUnavailable";

/** `#` is markup, not translatable copy. */
function taskNumberSigil(taskNumber: number): string {
  return `#${taskNumber}`;
}

const MessageItem = memo(function MessageItem({ message, mentionMap, channels, previewSenderAgent, previewSenderMember, channelParticipantAgentsById, channelParticipantMembersById, threadSummary, parentChannelId, parentMessageId, hideThreadActions, showThreadFollowAction, linkedTask, senderAvatarTestId, mentionComposerChannelId, reactionParentScopeKey, canReact = true, onBeforeOpenThread, onOpenThread, onOpenProfile, threadSearchHighlightQuery, threadSearchActive, groupState }: MessageItemProps) {
  // Feature flag gate: outside enabled scope, NO comment
  // affordance renders — preview comments context, re: chips, chip counts.
  const commentsEnabled = useAttachmentCommentsEnabled();
  const isHighlightedInChannel = useMessageStore((s) => s.highlightedMessageId === message.id);
  // A thread reply permalink owns highlight chrome only inside that thread.
  // The same store focus must never color a stale channel row when another
  // thread opens while the channel URL still carries its old `msg=` anchor.
  const isHighlightedInThread = useThreadStore(
    (s) => Boolean(parentMessageId) && s.focusedMessageId === message.id,
  );
  const isHighlighted = isHighlightedInChannel || isHighlightedInThread || !!threadSearchActive;
  const isAgent = message.senderType === "agent";
  const isExternal = message.senderType === "external_projection";
  const isSystem = message.messageType === "system";
  const humanDepartureLabel = isAgent || isExternal
    ? null
    : getHumanDepartureLabel(message.senderMembershipStatus);
  const structuredMentionMap = useMemo(() => buildStructuredMentionMap(message.mentions), [message.mentions]);
  const effectiveMentionMap = isExternal ? EXTERNAL_MESSAGE_MENTION_MAP : mentionMap;
  const effectiveStructuredMentionMap = isExternal ? EXTERNAL_MESSAGE_MENTION_MAP : structuredMentionMap;
  const { formatMessageTime, formatClock, formatMediumDateTime, options: timeFormatOptions } = useTimeFormatter();
  const intl = useIntl();
  const { formatMessage } = intl;
  // Render reads formatMessage directly; effects/handlers read
  // formatMessageRef.current so a locale switch never re-runs them.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const time = formatMessageTime(message.createdAt);
  // Bare HH:MM clock for the continuation-row hover gutter (task #44); the
  // full `time` above ("Yesterday 3:04") is too wide for the narrow gutter.
  // Fixed-width clock in the gutter (stdrc); full date+time in the tooltip. Both
  // go through the shared time formatter so no raw browser time API lives here.
  const gutterClock = formatClock(message.createdAt);
  const gutterFullTimestamp = formatMediumDateTime(message.createdAt);
  // Grouping defaults: surfaces that don't pass groupState (thread/DM panels)
  // keep the full header — avatar + name always shown, timestamp inline.
  const viewer = useAuthStore((s) => s.user);
  const currentUser = viewer;
  const storeSenderAgent = useAgentStore((s) =>
    message.senderType === "agent"
      ? s.agents.find((agent) => agent.id === message.senderId)
      : undefined
  );
  const storeSenderMember = useServerStore((s) =>
    message.senderType === "user"
      ? s.members.find((member) => member.userId === message.senderId)
      : undefined
  );
  const currentUserServerRole = useServerStore((s) => s.current?.role);
  // The server agent directory is the live identity source. Channel/member
  // previews are relation snapshots and can outlive an avatar/profile update;
  // keep them only as a cold-start / cross-server fallback.
  const senderAgent = storeSenderAgent ?? previewSenderAgent;
  // Desktop-only, opt-in: a model label next to an agent sender's name.
  const showAgentModelNameOption = useShowAgentModelName();
  const agentModelLabelText = showAgentModelNameOption ? agentModelLabel(senderAgent) : null;
  const senderMember = useMemo(() => {
    if (previewSenderMember) return previewSenderMember;
    const memberById = new Map<string, ServerMember>();
    if (storeSenderMember) memberById.set(storeSenderMember.userId, storeSenderMember);
    return resolveMessageSenderMember(message, memberById, currentUser, currentUserServerRole);
  }, [currentUser, currentUserServerRole, message, previewSenderMember, storeSenderMember]);
  const isDeactivatedAgent = isAgent && !!senderAgent?.deletedAt;
  const viewerUserId = viewer?.id ?? null;
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const normalizedMessageV2FlagEnabled = useServerFeatureFlag(
    SYNC_CORE_MESSAGES_FLAG_KEY,
    { prefetch: false },
  ).enabled;
  const normalizedMessageV2Enabled = normalizedMessageV2FlagEnabled
    && isMessageV2IngressSoleApplyEligible(message);
  const reactionViewerOverlay = useStore(
    reactionReadModelStore,
    (state) => state.viewerOverlay,
  );
  const reactionViewerCompleteMessages = useStore(
    reactionReadModelStore,
    (state) => state.viewerCompleteMessages,
  );
  const reactionActorCache = useStore(
    reactionReadModelStore,
    (state) => state.actorCache,
  );
  const readReceiptsEnabled = useServerFeatureFlag(
    READ_RECEIPTS_FEATURE_FLAG_KEY,
    { prefetch: false },
  ).enabled;
  // #693: the aggregate footer "Read" chip is REMOVED. It collapsed every peer
  // into one boolean, so a message with no @agent at all still showed "Read"
  // once any un-mentioned agent had read the channel, and large-channel summary
  // scopes produced it too — both contradicting the per-@mentioned-agent
  // contract. Read state is now shown only on each @mentioned agent's own
  // mention (see MentionLink + messageReadReceiptScope).
  // #693: the per-@mentioned-agent badge shares the SAME visibility rule as the
  // legacy chip (only this message's human sender sees it) but is independent
  // of `isReadByPeer`, which collapses human+agent peers.
  const agentReadBadgesEnabled =
    message.senderType === "user"
    && viewerUserId === message.senderId
    && readReceiptsEnabled;
  // #693 follow-up: a DM has no @mention to hang the per-agent badge on, so
  // removing the legacy footer chip left DMs with NO read indicator at all.
  // Restored here, but scoped to DMs only — that is exactly where the chip was
  // never ambiguous: a DM has ONE exposed peer, so "read" cannot silently mean
  // "some unrelated agent read it", which is why it had to go in channels.
  // The `channels` prop carries ONLY non-DM channels: the store keeps DMs in a
  // separate `dmChannels` collection and ChatPanel passes `s.channels`. Deriving
  // DM-ness from the prop therefore reads false for every real DM, so the chip
  // could never render outside a test that hand-builds the prop. Ask the store,
  // which is the actual authority for both collections.
  const isDmSurface = useChannelStore(
    (state) =>
      state.dmChannels.some((candidate) => candidate.id === message.channelId)
      || state.channels.some(
        (candidate) => candidate.id === message.channelId && candidate.type === "dm",
      ),
  );
  const dmReadReceiptScope = useReadReceiptStore(
    (state) => state.scopes[message.channelId],
  );
  const showDmReadReceipt = agentReadBadgesEnabled
    && isDmSurface
    && projectReadReceipt(dmReadReceiptScope, message.seq ?? undefined).read;
  const viewerReactionName = viewer?.displayName || viewer?.name || viewer?.email || formatMessage({ id: "message.messageItem.reactorYou" });

  const serverSlug = useServerStore((s) => s.current?.slug);
  const referenceSurfaceChannelId = parentChannelId || message.channelId;
  const topbarOverflowEnabled = useServerFeatureFlag(TOPBAR_OVERFLOW_FEATURE_FLAG_KEY).enabled;
  // task #187 collapse-long-messages: per-user, per-channel server-persisted
  // pref. OFF = long messages on this surface always render fully expanded
  // (CollapsibleMessageContent behaves as if disabled). The feature flag is a
  // rollback boundary, so persisted flag-on preferences are ignored while it
  // is off and the legacy always-collapse behavior wins. Missing hydration
  // likewise defaults to collapsing — the server default.
  const storedCollapseLongMessages = useChannelStore(
    (state) =>
      (state.channels.find((candidate) => candidate.id === referenceSurfaceChannelId)
        ?? state.dmChannels.find((candidate) => candidate.id === referenceSurfaceChannelId))
        ?.collapseLongMessages ?? true,
  );
  const collapseLongMessages = topbarOverflowEnabled ? storedCollapseLongMessages : true;
  const isJointReferenceSurface = channels.some(
    (channel) => channel.id === referenceSurfaceChannelId && channel.type === "joint",
  );
  const storeSenderKnownOnCurrentServer = !!storeSenderAgent || !!storeSenderMember;
  const previewRefAuthorityServerSlug = previewSenderAgent?.serverSlug
    ?? previewSenderMember?.serverSlug
    ?? undefined;
  const previewSenderKnownOnCurrentServer = (!!serverId && previewSenderAgent?.serverId === serverId)
    || (!!serverId && previewSenderMember?.serverId === serverId)
    || (!!serverSlug && previewRefAuthorityServerSlug === serverSlug);
  const senderKnownOnCurrentServer = message.senderId === viewerUserId
    || storeSenderKnownOnCurrentServer
    || previewSenderKnownOnCurrentServer;
  const explicitRefAuthorityServerSlug = senderKnownOnCurrentServer
    ? serverSlug
    : previewRefAuthorityServerSlug;
  const threadRefAuthorityUnavailable = isJointReferenceSurface
    && !explicitRefAuthorityServerSlug
    && !senderKnownOnCurrentServer;
  const refAuthorityServerSlug = explicitRefAuthorityServerSlug
    ?? (threadRefAuthorityUnavailable ? undefined : serverSlug);
  // dmChannels is stable across inbound-message activity bumps now that
  // `lastMessageAt` lives in the `channelActivity` slice (not the channel
  // objects), so this per-row subscription no longer re-renders on every message.
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const requestTransientFocus = useMessageStore((s) => s.requestTransientFocus);
  const nav = useAppNavigate();
  const translationSettings = useTranslationStore((s) => s.settings);
  const translationEntry = useTranslationStore((s) => s.entries[message.id]);
  const requestTranslations = useTranslationStore((s) => s.requestTranslations);
  const retryTranslation = useTranslationStore((s) => s.retryMessage);
  const setTranslationShowOriginal = useTranslationStore((s) => s.setShowOriginal);
  const messageBodyFontSize = useAppearanceStore((s) => s.messageBodyFontSize);
  const messageBodyFontSizeClass = getMessageBodyFontSizeClass(messageBodyFontSize);
  const actionMetadata = message.actionMetadata as { kind?: string } | null | undefined;
  const isActionCardMessage = actionMetadata?.kind === "action-card";
  const translationTargetLanguage = translationSettings.available && translationSettings.preferredTranslationMode !== "off"
    ? translationSettings.effectiveLanguage
    : null;
  const isOwnHumanMessage = message.senderType === "user" && viewerUserId === message.senderId;
  const translationEligible =
    !isSystem &&
    !!translationTargetLanguage &&
    (translationSettings.preferredTranslationMode === "manual" || !isOwnHumanMessage);
  const currentTranslationEntry =
    translationEntry &&
    translationEntry.targetLanguage === translationTargetLanguage &&
    (!translationEntry.originalContent || translationEntry.originalContent === message.content)
      ? translationEntry
      : undefined;
  const activeTranslationEntry = translationEligible ? currentTranslationEntry : undefined;
  const activeTranslationHasContent = hasUsableTranslatedContent(activeTranslationEntry);
  const manualTranslationPending = activeTranslationEntry?.status === "pending";
  const showManualTranslationAction =
    translationSettings.preferredTranslationMode === "manual"
    && translationEligible
    && message.content.trim().length > 0
    && !isActionCardMessage
    && !activeTranslationHasContent
    && activeTranslationEntry?.status !== "failed";
  const activeTranslationDisplay: PreferredTranslationDisplay = activeTranslationEntry?.showOriginal === true
    ? "original"
    : activeTranslationEntry?.showOriginal === false
      ? translationSettings.preferredTranslationDisplay === "original"
        ? "translated"
        : translationSettings.preferredTranslationDisplay
      : translationSettings.preferredTranslationDisplay;
  const activeTranslationShowOriginal = activeTranslationDisplay === "original";
  const isTranslationPending =
    translationEligible &&
    translationSettings.preferredTranslationMode === "auto" &&
    !activeTranslationShowOriginal &&
    (
      activeTranslationEntry?.status === "pending" ||
      (!activeTranslationEntry && translationSettings.preferredTranslationMode === "auto")
    );
  const translatedContent =
    activeTranslationHasContent &&
    activeTranslationDisplay !== "original"
      ? activeTranslationEntry?.translatedContent ?? null
      : null;
  const showBilingualOriginal =
    !!translatedContent &&
    activeTranslationDisplay === "bilingual" &&
    !!message.content;
  const visibleMessageContent = translatedContent ?? message.content ?? "";
  const forwardedBundleMetadata = isForwardedBundleMetadata(actionMetadata) ? actionMetadata : null;
  const forwardedItemCount = Array.isArray(forwardedBundleMetadata?.forwardedItems)
    ? forwardedBundleMetadata.forwardedItems.length
    : 0;
  const generatedForwardContent = forwardedBundleMetadata
    ? `Forwarded ${forwardedItemCount} message${forwardedItemCount === 1 ? "" : "s"}`
    : null;
  const forwardedBundleBodyContent = forwardedBundleMetadata
    && visibleMessageContent.trim() === generatedForwardContent
    ? ""
    : visibleMessageContent;
  const currentHostname = typeof window !== "undefined" ? window.location.hostname : undefined;
  const quotedPermalink = useMemo(
    () => extractFirstQuotedMessagePermalink(message.content, currentHostname, serverSlug),
    [currentHostname, message.content, serverSlug],
  );
  const [unavailableQuotedPermalinkUrl, setUnavailableQuotedPermalinkUrl] = useState<string | null>(null);
  const quotedPermalinkUnavailable = quotedPermalink?.rawUrl === unavailableQuotedPermalinkUrl;
  const handleQuotedPermalinkUnavailable = useCallback(() => {
    if (quotedPermalink) setUnavailableQuotedPermalinkUrl(quotedPermalink.rawUrl);
  }, [quotedPermalink]);
  // Stable so they don't break the memoized markdown body (renderContent) below.
  const handleNavigateAgent = useCallback((agentId: string) => {
    const knownAgent = senderAgent?.id === agentId
      ? senderAgent
      : [...mentionMap.values()].find((entry) => entry.type === "agent" && entry.id === agentId)?.agent;
    if (knownAgent) setCachedAgentProfile(serverId, knownAgent);
    if (onOpenProfile) {
      onOpenProfile("agent", agentId);
      return;
    }
    openConversationAgentProfile(useProfileStore.getState().openProfile, agentId, {
      openSource: parentMessageId ? "thread" : "channel",
    });
  }, [mentionMap, onOpenProfile, parentMessageId, senderAgent, serverId]);

  // Opens the SAME profile panel as clicking the mention, just landing on the
  // activity tab. Deliberately not a route change to /agent/:id — every other
  // mention interaction opens the panel and stays in the channel, and diverging
  // here would make one affordance in the card behave unlike its siblings.
  const handleNavigateAgentActivity = useCallback((agentId: string) => {
    const knownAgent = senderAgent?.id === agentId
      ? senderAgent
      : [...mentionMap.values()].find((entry) => entry.type === "agent" && entry.id === agentId)?.agent;
    if (knownAgent) setCachedAgentProfile(serverId, knownAgent);
    openConversationAgentActivity(useProfileStore.getState().openProfile, agentId, {
      openSource: parentMessageId ? "thread" : "channel",
    });
  }, [mentionMap, parentMessageId, senderAgent, serverId]);

  const handleNavigateHuman = useCallback((userId: string) => {
    if (onOpenProfile) {
      onOpenProfile("human", userId);
      return;
    }
    useProfileStore.getState().openProfile("human", userId, {
      openSource: parentMessageId ? "thread" : "channel",
    });
  }, [onOpenProfile, parentMessageId]);

  const handleNavigateComputer = useCallback((machineId: string) => {
    const computer = useMachineStore.getState().machines.find((machine) => machine.id === machineId && machine.isComputer);
    if (computer) nav.toComputer(machineId);
  }, [nav]);

  const handleNavigateChannel = useCallback((channel: Channel) => {
    nav.toChannel(channel.id);
  }, [nav]);

  const handleNavigateDm = useCallback((channel: Channel) => {
    nav.toDm(channel.id);
  }, [nav]);

  // Look up agent's avatar
  const agentAvatarUrl = senderAgent?.avatarUrl ?? null;
  const humanAvatarUrl = senderMember?.avatarUrl ?? null;
  const externalAvatarUrl = message.externalAuthor?.avatarUrl ?? null;
  const senderAgentDmChannel = isAgent
    ? dmChannels.find((channel) => channel.peerType === "agent" && channel.peerId === message.senderId)
    : null;
  const senderEmailForAvatar =
    !isAgent && currentUser?.id === message.senderId && !senderMember?.gravatarHash
      ? currentUser.email
      : null;

  // Sender subtitle: agent description or human description (fallback to role)
  const senderDisplayName = isExternal
    ? message.externalAuthor?.displayName || message.senderName || formatMessage({ id: "message.author.externalFallback" })
    : isAgent
      ? senderAgent?.displayName || senderAgentDmChannel?.peerDisplayName || senderAgent?.name || message.senderName || formatMessage({ id: "message.messageItem.senderAgentFallback" })
      : message.senderName || formatMessage({ id: "message.messageItem.senderUserFallback" });
  const senderSubtitle = isExternal
    ? message.externalAuthor?.provider ?? null
    : isAgent
      ? senderAgent?.description || message.senderDescription || null
      : senderMember?.description || message.senderDescription || formatMemberRole(senderMember?.role ?? "", formatMessage) || null;
  const senderMention = useMemo<MessageMention | null>(() => {
    if (isExternal) return null;
    const name = isAgent ? senderAgent?.name : senderMember?.name;
    if (!name || isDeactivatedAgent || humanDepartureLabel) return null;
    return {
      type: isAgent ? "agent" : "user",
      id: message.senderId,
      name,
    };
  }, [humanDepartureLabel, isAgent, isDeactivatedAgent, isExternal, message.senderId, senderAgent?.name, senderMember?.name]);
  const senderMentionChannelId = mentionComposerChannelId ?? message.channelId;
  const insertSenderMention = useCallback(() => {
    if (!senderMention) return;
    dispatchSenderMentionInsert({
      channelId: senderMentionChannelId,
      mention: senderMention,
    });
  }, [senderMention, senderMentionChannelId]);
  const handleSenderNameMention = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    insertSenderMention();
  }, [insertSenderMention]);
  const storeOpenThread = useThreadStore((s) => s.openThread);
  const openThread = useCallback((request: OpenThreadRequest) => {
    if (onOpenThread) {
      onOpenThread(request);
      return Promise.resolve();
    }
    return storeOpenThread(request);
  }, [onOpenThread, storeOpenThread]);
  const closeThread = useThreadStore((s) => s.closeThread);
  const followedThreads = useThreadStore((s) => s.followedThreads);
  const followThread = useThreadStore((s) => s.followThread);
  const unfollowThread = useThreadStore((s) => s.unfollowThread);
  const openParentMessageId = useThreadStore((s) => s.openParentMessageId);
  const openParentChannelId = useThreadStore((s) => s.openParentChannelId);

  // Select mode (multi-select share). Subscribed early because handleMobileTap
  // below intercepts clicks when scoped here.
  //
  // Two scopes:
  //  - Channel mode (selection.threadRootId === null): top-level rows in
  //    `channelId` are selectable — that's `!parentMessageId` rows whose
  //    `message.channelId === selection.channelId`.
  //  - Thread mode (selection.threadRootId !== null): the parent message
  //    rendered inside ThreadPanel AND its thread replies (rendered with
  //    `parentMessageId === threadRootId`) are selectable. The parent may
  //    share an id with the channel timeline row, but that row must not show
  //    thread-local selection chrome.
  const selectionActive = useSelectionStore((s) => s.isActive);
  const selectionChannelId = useSelectionStore((s) => s.channelId);
  const selectionThreadRootId = useSelectionStore((s) => s.threadRootId);
  // Stryker disable all: thread/channel selection scope is pinned by the
  // selection behavior and source-contract tests; individual boolean rewrites
  // here create equivalent DOM states for the mutation oracle.
  const selectionScopedHere =
    selectionActive &&
    (selectionThreadRootId === null
      ? !parentMessageId && selectionChannelId === message.channelId
      : (hideThreadActions && message.id === selectionThreadRootId) ||
        parentMessageId === selectionThreadRootId);
  const isSelected = useSelectionStore((s) => s.selectedIds.has(message.id));
  const isPreviousGroupedMessageSelected = useSelectionStore((s) =>
    groupState?.previousMessageId
      ? s.selectedIds.has(groupState.previousMessageId)
      : false,
  );
  const toggleSelection = useSelectionStore((s) => s.toggle);
  const enterSelection = useSelectionStore((s) => s.enter);
  const enterThreadSelection = useSelectionStore((s) => s.enterThread);
  const isSelectedAsThreadParent =
    !parentMessageId &&
    !hideThreadActions &&
    !(selectionActive && selectionThreadRootId === message.id) &&
    message.id === openParentMessageId &&
    message.channelId === openParentChannelId;
  const showSelectedGroupedHeader = shouldShowGroupedMessageHeader(
    groupState,
    selectionScopedHere,
    isSelected,
    isPreviousGroupedMessageSelected,
  );
  // Stryker restore all
  const openLegacyTask = useLegacyTaskPanelStore((s) => s.openLegacyTask);
  const closeProfile = useProfileStore((s) => s.closeProfile);
  const canShowThreadFollowAction = !hideThreadActions || !!showThreadFollowAction;
  const messageRef = useRef<HTMLDivElement | null>(null);
  const messageBodyRef = useRef<HTMLDivElement | null>(null);
  // Stryker disable all: React effect wiring delegates branch decisions to
  // behavior-tested helpers; source contracts pin the API endpoint and render
  // use sites while the focused mutation oracle avoids full MessageItem DOM.
  const imageFallbackKey = useMemo(() => buildImageInlineFallbackKey(message.attachments), [message.attachments]);
  // Stryker restore all

  const followedThread = canShowThreadFollowAction
    ? followedThreads.find((thread) => thread.parentMessageId === message.id)
    : null;
  const hasThreadConversation = !!threadSummary?.threadChannelId || (threadSummary?.replyCount ?? 0) > 0 || !!followedThread;
  const threadUnreadCount = threadSummary?.unreadCount ?? 0;
  const firstUnreadThreadMessageId = threadUnreadCount > 0 ? threadSummary?.firstUnreadMessageId ?? null : null;
  const threadDraftChannelId = !hideThreadActions
    ? threadSummary?.threadChannelId ?? followedThread?.threadChannelId ?? null
    : null;
  const hasThreadDraft = useMessageStore((s) =>
    threadDraftChannelId ? !!s.drafts[threadDraftChannelId]?.trim() : false
  );
  // Stryker disable all: thread reply badge visibility is pre-existing; ThreadRepliesBadge owns the rendered states.
  const threadReplyCount = threadSummary?.replyCount ?? 0;

  // Inline reply previews are the default thread surface.
  //
  // PER-KEY selector, deliberately. `replyScopes` is replaced whenever ANY thread
  // takes a reply, but the reducer keeps every untouched scope reference-identical,
  // so this selector's RESULT is unchanged for other messages and zustand skips the
  // re-render. Subscribing to the map itself (or to threadStore wholesale, which is
  // what ChatPanel does with `summaries` — hence the separate map) would re-render
  // every message in the channel on every reply in any thread: the #4434 regression.
  const replyScope = useThreadStore((s) => s.replyScopes[message.id]);
  const hasThreadReplies = threadReplyCount > 0;
  const inlineReplySurfaceReplacesBadge =
    !!replyScope &&
    hasInlineThreadReplySurface(replyScope.replies, replyScope.replyCount);
  const shouldShowThreadRepliesBadge =
    (hasThreadReplies || hasThreadDraft) && !hideThreadActions && !inlineReplySurfaceReplacesBadge;
  const hasThreadFooterMetadata = shouldShowThreadRepliesBadge;
  // Stryker restore all

  // Stryker disable all: both thread opener payloads are source-contract pinned and
  // behavior-covered through the workspace host; dependency-array deletion is not
  // a meaningful one-shot click mutation.
  const handleReplyInThread = useCallback(() => {
    onBeforeOpenThread?.();
    // A thread action is an explicit navigation to the conversation surface.
    // If a profile is currently covering the channel, dismiss it first so the
    // reply opens in the normal Channel + Thread shell rather than leaving the
    // profile mounted as the newer right-panel surface.
    closeProfile();
    const chId = parentChannelId || message.channelId;
    // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
    openThread({
      parentChannelId: chId,
      parentMessageId: message.id,
      initialThreadChannelId: threadDraftChannelId,
    });
  }, [closeProfile, message.channelId, message.id, onBeforeOpenThread, openThread, parentChannelId, threadDraftChannelId]);

  const handleOpenThreadReplies = useCallback(() => {
    onBeforeOpenThread?.();
    // Keep the reply badge/inline preview path consistent with the explicit
    // "Reply in thread" action above when Profile is open over the Channel.
    closeProfile();
    const chId = parentChannelId || message.channelId;
    // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
    openThread({
      parentChannelId: chId,
      parentMessageId: message.id,
      focusedMessageId: firstUnreadThreadMessageId,
      initialThreadChannelId: threadDraftChannelId,
    });
  }, [closeProfile, firstUnreadThreadMessageId, message.channelId, message.id, onBeforeOpenThread, openThread, parentChannelId, threadDraftChannelId]);
  // Stryker restore all

  // Scoped attachment comment (cindyz 6/11): clicking the `re:` chip jumps to
  // the message the attachment lives on. Reuses the same source→nav shape the
  // Files tab uses, keyed off commentRef.hostSource (server enrichment). Tiered:
  // when the host is in the currently-open channel, a local transient focus
  // (scroll + highlight, no URL churn — the common "point at it" case); cross
  // channel/DM/thread goes through the message-level permalink route.
  const handleJumpToCommentHost = useCallback(() => {
    const ref = message.commentRef;
    if (!ref?.hostMessageId || !ref.hostSource) return; // unresolvable → no jump (never a wrong one)
    const { hostSource, hostMessageId } = ref;
    if (ref.anchorLabel) {
      const seekTime = parseTimestampLabel(ref.anchorLabel);
      if (seekTime !== null) {
        setPendingVideoSeek(ref.attachmentId, seekTime);
        const tryAutoOpen = (n: number) => {
          const el = document.getElementById(`message-${hostMessageId}`);
          const btn = el?.querySelector('[data-message-affordance="video-preview"]')?.closest("button");
          if (btn) { btn.click(); return; }
          if (n < 10) setTimeout(() => tryAutoOpen(n + 1), 200);
        };
        setTimeout(() => tryAutoOpen(0), 100);
      }
    }
    // Host top-level message is itself a thread root → open that thread expanded,
    // landing on the root message (cindyz #32), rather than locating it in the
    // closed-state channel. Takes precedence over the surface-local paths below.
    if (hostSource.rootThreadChannelId) {
      // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
      void openThread({
        parentChannelId: hostSource.channelId,
        parentMessageId: hostMessageId,
        focusedMessageId: hostMessageId,
      });
      return;
    }
    // Same surface as this row → local focus, no URL churn. The local branch
    // must be surface-aware, not just channel-aware: parentMessageId tells
    // ChatPanel (absent → consumes requestTransientFocus) apart from a
    // ThreadPanel reply (present → consumes openThread focus), and each ignores
    // the other's signal (Dozy review, PR #2799).
    if (!parentMessageId && hostSource.type === "channel" && hostSource.channelId === parentChannelId) {
      requestTransientFocus(hostSource.channelId, hostMessageId);
      return;
    }
    // Stryker disable next-line ConditionalExpression: surface-aware same-thread guard is covered by navigation source contracts outside the DOM mutation corpus.
    if (parentMessageId && hostSource.type === "thread" && hostSource.parentMessageId === parentMessageId) {
      // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
      void openThread({
        parentChannelId: hostSource.channelId,
        parentMessageId: hostSource.parentMessageId,
        focusedMessageId: hostMessageId,
      });
      return;
    }
    // Cross surface → message-level permalink route (Files tab source→nav shape).
    if (hostSource.type === "thread" && hostSource.parentMessageId) {
      nav.toThreadMessage(hostSource.channelId, hostSource.parentMessageId, hostMessageId, hostSource.routeKind);
    } else if (hostSource.routeKind === "dm") {
      nav.toDmMessage(hostSource.channelId, hostMessageId);
    } else {
      nav.toMessage(hostSource.channelId, hostMessageId);
    }
  }, [message.commentRef, parentChannelId, parentMessageId, requestTransientFocus, openThread, nav]);

  // On mobile (no hover), tapping a message opens its thread.
  // When select mode is active for this message's channel, single-click (any
  // device) toggles selection instead and we suppress the thread-open path.
  const handleMobileTap = useCallback((e: MouseEvent) => {
    if (selectionScopedHere) {
      const target = e.target as HTMLElement;
      // Allow links/buttons inside selected rows to still work
      if (target.closest("a, button")) return;
      e.preventDefault();
      toggleSelection(message.id);
      return;
    }
    if (hideThreadActions) return;
    // Don't open thread if long-press context menu just fired
    if (longPressFired.current) return;
    // Only on touch devices (no hover capability)
    if (window.matchMedia("(hover: hover)").matches) return;
    // Don't intercept clicks on interactive elements (links, buttons, code blocks, images)
    const target = e.target as HTMLElement;
    if (target.closest("a, button, pre, code, img")) return;
    handleReplyInThread();
  }, [hideThreadActions, handleReplyInThread, selectionScopedHere, toggleSelection, message.id]);

  const [resolvingThreadRefKey, setResolvingThreadRefKey] = useState<string | null>(null);
  // Store the message KEY (not a formatted string) so the notice re-localizes
  // on a language switch while it is still on screen.
  const [threadRefNotice, setThreadRefNotice] = useState<ThreadRefNoticeKey | null>(null);
  const threadRefNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearThreadRefNoticeTimer = useCallback(() => {
    if (threadRefNoticeTimerRef.current) {
      clearTimeout(threadRefNoticeTimerRef.current);
      threadRefNoticeTimerRef.current = null;
    }
  }, []);

  const showThreadRefNotice = useCallback((notice: ThreadRefNoticeKey) => {
    clearThreadRefNoticeTimer();
    setThreadRefNotice(notice);
    threadRefNoticeTimerRef.current = setTimeout(() => {
      setThreadRefNotice(null);
      threadRefNoticeTimerRef.current = null;
    }, 4000);
  }, [clearThreadRefNoticeTimer]);

  useEffect(() => () => clearThreadRefNoticeTimer(), [clearThreadRefNoticeTimer]);

  const navigableChannels = useMemo(
    () => [...channels, ...dmChannels.filter((dm) => !channels.some((channel) => channel.id === dm.id))],
    [channels, dmChannels],
  );
  const taskSurfaceChannel = useMemo(
    () => navigableChannels.find((channel) => channel.id === (parentChannelId || message.channelId)),
    [message.channelId, navigableChannels, parentChannelId],
  );
  const supportsMessageTasks = taskSurfaceChannel !== undefined && taskSurfaceChannel.type !== "thread";

  const handleOpenThreadRef = useCallback(async (intent: ThreadRefIntent) => {
    const threadRefKey = `${intent.serverSlug}:${intent.parentChannelName.toLowerCase()}:${intent.shortId.toLowerCase()}`;
    clearThreadRefNoticeTimer();
    setThreadRefNotice(null);

    if (threadRefAuthorityUnavailable) {
      showThreadRefNotice("message.messageItem.threadServerUnknown");
      return;
    }

    if (!serverSlug || intent.serverSlug !== serverSlug) {
      window.location.assign(buildThreadRefHandoffPath(intent));
      return;
    }

    const parentChannel = findThreadRefParentChannel(intent, serverSlug, navigableChannels);
    if (!parentChannel) {
      showThreadRefNotice("message.messageItem.threadUnavailable");
      return;
    }
    const isRequestAuthorityCurrent = captureThreadRouteAuthorityGuard(serverSlug, () => {
      const currentAuthority = useServerStore.getState();
      return {
        serverSlug: currentAuthority.current?.slug,
        serverEpoch: currentAuthority.serverEpoch,
      };
    });
    setResolvingThreadRefKey(threadRefKey);

    let threadTarget: ThreadRouteTarget | null = null;
    try {
      threadTarget = await resolveThreadTargetByShortId({
        serverSlug,
        parentChannelId: parentChannel.id,
        shortId: intent.shortId,
        summaries: useThreadStore.getState().summaries,
        followedThreads: useThreadStore.getState().followedThreads,
        loadContext: async (channelId, targetShortId) => {
          const { data } = await api.get<{
            targetMessageId?: string | null;
            canonicalTarget?: {
              kind?: string;
              channelId?: string;
              messageId?: string;
              threadParentMessageId?: string;
              threadChannelId?: string | null;
            } | null;
          }>(
            `/messages/context/${targetShortId}`,
            { params: { channelId } },
          );
          return data;
        },
      });
    } finally {
      setResolvingThreadRefKey((current) => current === threadRefKey ? null : current);
    }

    if (!isRequestAuthorityCurrent()) return;
    if (threadTarget) {
      if (parentChannel?.type === "dm") {
        nav.toDmMessage(threadTarget.parentChannelId, threadTarget.parentMessageId);
      } else {
        nav.toMessage(threadTarget.parentChannelId, threadTarget.parentMessageId);
      }
      if (!isRequestAuthorityCurrent()) return;
      void openThread({
        ...threadTarget,
        focusedMessageId: intent.focusedMessageId ?? threadTarget.focusedMessageId,
      });
      return;
    }
    showThreadRefNotice("message.messageItem.threadUnavailable");
  }, [clearThreadRefNoticeTimer, nav, navigableChannels, openThread, serverSlug, showThreadRefNotice, threadRefAuthorityUnavailable]);

  // Stryker disable all: message-ref navigation dependency-array rewrites are
  // equivalent in the static mutation oracle; behavior coverage exercises the
  // thread and non-thread navigation branches directly.
  const handleOpenMessageRef = useCallback(async (targetChannel: Channel, messageId: string, threadParentShortId: string | null) => {
    if (threadParentShortId) {
      if (!serverSlug) return;
      await handleOpenThreadRef({
        serverSlug,
        parentChannelName: targetChannel.name,
        parentChannelType: targetChannel.type === "dm" ? "dm" : "channel",
        parentChannelId: targetChannel.id,
        shortId: threadParentShortId,
        focusedMessageId: messageId,
      });
      return;
    }
    if (targetChannel.type === "dm") {
      nav.toDmMessage(targetChannel.id, messageId);
    } else {
      nav.toMessage(targetChannel.id, messageId);
    }
  }, [handleOpenThreadRef, nav, serverSlug]);
  // Stryker restore all

  // Stryker disable all: forwarded-source navigation is covered by source-label
  // behavior tests; the mutation runner's mocked navigation/API setup leaves
  // several defensive unavailable-source branches observationally equivalent.
  const handleOpenForwardedSource = useCallback(async (item: ForwardedBundleItem) => {
    const sourceMessageId = item.sourceMessageId;
    const sourceTarget = item.sourceTargetSnapshot;
    if (!sourceMessageId || item.provenanceState === "original_unavailable") return;
    if (!sourceTarget || sourceTarget.type === "dm" || sourceTarget.labelVisibility !== "public") return;

    if (sourceTarget.type === "thread" && item.sourceThreadId && item.parentChannelId) {
      const parentChannel = navigableChannels.find((channel) => channel.id === item.parentChannelId);
      if (!parentChannel || parentChannel.type === "dm") return;
      try {
        const { data } = await api.get<{
          canonicalTarget?: {
            kind?: string;
            messageId?: string;
            threadParentMessageId?: string;
            threadChannelId?: string | null;
          };
        }>(`/messages/context/${sourceMessageId}`, { params: { channelId: item.parentChannelId } });
        const target = data.canonicalTarget;
        if (target?.kind === "thread" && target.threadParentMessageId) {
          nav.toMessage(item.parentChannelId, target.threadParentMessageId);
          void openThread({
            parentChannelId: item.parentChannelId,
            parentMessageId: target.threadParentMessageId,
            focusedMessageId: target.messageId ?? sourceMessageId,
            initialThreadChannelId: target.threadChannelId ?? item.sourceThreadId,
          });
          return;
        }
        if (!target) {
          nav.toMessage(item.parentChannelId, sourceMessageId);
          void openThread({
            parentChannelId: item.parentChannelId,
            parentMessageId: sourceMessageId,
            focusedMessageId: sourceMessageId,
            initialThreadChannelId: item.sourceThreadId,
          });
          return;
        }
      } catch {
        showThreadRefNotice("message.messageItem.sourceUnavailable");
        return;
      }
      showThreadRefNotice("message.messageItem.sourceUnavailable");
      return;
    }

    if (!item.sourceTargetId) return;
    const sourceChannel = navigableChannels.find((channel) => channel.id === item.sourceTargetId);
    if (!sourceChannel || sourceChannel.type === "dm") return;
    await handleOpenMessageRef(sourceChannel, sourceMessageId, null);
  }, [handleOpenMessageRef, nav, navigableChannels, openThread, showThreadRefNotice]);
  // Stryker restore all

  // Save / unsave message
  const isSaved = useSavedStore((s) => s.savedIds.has(message.id));

  const handleToggleSave = useCallback(() => {
    if (isSaved) {
      useSavedStore.getState().unsaveMessage(message.id);
    } else {
      useSavedStore.getState().saveMessage(message.id);
    }
  }, [isSaved, message.id]);

  // Context menu for "Convert to task"
  const [ctxMenu, setCtxMenu] = useState<{ anchorX: number; anchorY: number; x: number; y: number; source: "pointer" | "touch" } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  // iOS can emit a synthetic mousedown/click pair after long-press touchend.
  // Keep a short-lived portal shield mounted so neither event reaches the
  // outside-click overlay and closes the menu as soon as the finger lifts.
  const [ctxMenuClickShielded, setCtxMenuClickShielded] = useState(false);
  const ctxMenuShieldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleManualTranslate = useCallback(() => {
    if (!showManualTranslationAction || manualTranslationPending || !translationTargetLanguage) return;
    setCtxMenu(null);
    void requestTranslations([message], {
      targetLanguage: translationTargetLanguage,
      viewerUserId,
      force: true,
    });
  }, [
    manualTranslationPending,
    message,
    requestTranslations,
    showManualTranslationAction,
    translationTargetLanguage,
    viewerUserId,
  ]);
  const convertMessage = useTaskStore((s) => s.convertMessage);
  const channelTasks = useTaskStore((s) => s.tasks);

  // Parked with TaskChipList: grouping the channel's tasks by message id is
  // what feeds the list, and it comes back when the list does.
  // const messageTasks = useMemo(
  //   () => channelTasks.filter((t) => t.messageId === message.id)
  //     .sort((a, b) => a.taskNumber - b.taskNumber),
  //   [channelTasks, message.id],
  // );

  // A task with no host message cannot use the thread-backed modal, so it
  // falls back to the legacy panel (@stdrc msg=1561f8fc). Everything reaching
  // this list has a host message by construction, but routing on the fact
  // rather than the assumption keeps the two paths honest.

  const serverTasks = useTaskStore((s) => s.serverTasks);
  const knownTaskNumbers = useMemo(() => {
    const nums = new Set<number>();
    for (const t of channelTasks) nums.add(t.taskNumber);
    for (const t of serverTasks) nums.add(t.taskNumber);
    return nums;
  }, [channelTasks, serverTasks]);
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const [converting, setConverting] = useState(false);
  const pendingReactionEmojisRef = useRef<Set<string>>(new Set());
  const pendingReactionTargetsRef = useRef<Map<string, boolean>>(new Map());
  const reactionFailureFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reactionFailureEmoji, setReactionFailureEmoji] = useState<string | null>(null);
  const [reactionPicker, setReactionPicker] = useState<{ x: number; y: number } | null>(null);
  const reactionPickerCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [senderCtxMenu, setSenderCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const senderHandleText = senderMention ? `@${senderMention.name}` : null;

  const handleSenderContextMenu = (e: MouseEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu(null);
    setReactionPicker(null);
    setSenderCtxMenu({
      x: e.clientX,
      y: e.clientY,
    });
  };
  const closeSenderCtxMenu = setSenderCtxMenu.bind(null, null);

  const handleOpenThreadFromContextMenu = useCallback(() => {
    setCtxMenu(null);
    handleReplyInThread();
  }, [handleReplyInThread]);
  const handleOpenThreadInNewTab = useCallback(() => {
    setCtxMenu(null);
    const channelId = parentChannelId || message.channelId;
    const routeKind = navigableChannels.find((channel) => channel.id === channelId)?.type === "dm" ? "dm" : "channel";
    if (!serverSlug) return;
    openPanelInNewTab(buildThreadWindowUrl(
      { pathname: window.location.pathname, search: window.location.search, origin: window.location.origin },
      { serverSlug, parentChannelId: channelId, parentMessageId: message.id, parentChannelType: routeKind },
    ));
  }, [message.channelId, message.id, navigableChannels, parentChannelId, serverSlug]);
  const handleOpenLinkedTaskInNewTab = useCallback(() => {
    if (!linkedTask || !serverSlug) return;
    setCtxMenu(null);
    const routeKind = navigableChannels.find((channel) => channel.id === linkedTask.channelId)?.type === "dm" ? "dm" : "channel";
    const url = linkedTask.messageId
      ? buildThreadWindowUrl(
        { pathname: window.location.pathname, search: window.location.search, origin: window.location.origin },
        { serverSlug, parentChannelId: linkedTask.channelId, parentMessageId: linkedTask.messageId, parentChannelType: routeKind },
        "task",
      )
      : buildLegacyTaskWindowUrl(
        { pathname: window.location.pathname, search: window.location.search, origin: window.location.origin },
        { serverSlug, channelId: linkedTask.channelId, taskId: linkedTask.id, channelType: routeKind },
      );
    openPanelInNewTab(url);
  }, [linkedTask, navigableChannels, serverSlug]);
  const [reactionPopover, setReactionPopover] = useState<{
    emoji: string;
    visibleNames: string[];
    hiddenCount: number;
    x: number;
    y: number;
  } | null>(null);
  const documentPreviewLoadingId = useDocumentPreviewStore((state) => state.loadingId);
  const mediaPreviewLoadingId = useMediaPreviewStore((state) => state.loadingId);
  const htmlPreviewLoadingId = mediaPreviewLoadingId;
  const videoPreviewLoadingId = mediaPreviewLoadingId;

  const positionReactionPickerFromRect = useCallback((rect: DOMRect) => {
    if (reactionPickerCloseTimerRef.current) {
      clearTimeout(reactionPickerCloseTimerRef.current);
      reactionPickerCloseTimerRef.current = null;
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const minLeft = REACTION_PICKER_VIEWPORT_MARGIN;
    const maxLeft = Math.max(minLeft, viewportWidth - REACTION_PICKER_WIDTH - REACTION_PICKER_VIEWPORT_MARGIN);
    const desiredLeft = rect.right - REACTION_PICKER_WIDTH;
    const belowTop = rect.bottom + 4;
    const maxTop = Math.max(REACTION_PICKER_VIEWPORT_MARGIN, viewportHeight - REACTION_PICKER_HEIGHT - REACTION_PICKER_VIEWPORT_MARGIN);
    const desiredTop = belowTop > maxTop && rect.top > REACTION_PICKER_HEIGHT + REACTION_PICKER_VIEWPORT_MARGIN
      ? rect.top - REACTION_PICKER_HEIGHT - 4
      : belowTop;

    window.dispatchEvent(new CustomEvent(REACTION_PICKER_EVENT, { detail: { messageId: message.id } }));
    setReactionPicker({
      x: Math.min(Math.max(desiredLeft, minLeft), maxLeft),
      y: Math.min(Math.max(desiredTop, REACTION_PICKER_VIEWPORT_MARGIN), maxTop),
    });
  }, [message.id]);

  const handleContextMenu = useCallback((e: MouseEvent) => {
    if (isSystem) return;
    // React portal events bubble through the component tree even though their
    // DOM target lives outside this message. A modal menu's backdrop owns that
    // interaction; treating it as a message right-click/long-press reopens this
    // context menu after the child overlay dismisses.
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    // If the right-click landed on an external link, defer to the browser's
    // native context menu (Open in new tab / Copy link address) instead of our
    // message menu — the user is targeting the link, not the message. Scoped to
    // external links (`target="_blank"`, per the markdown / message-body link
    // renderers) so internal ref chips (@mention / #channel / task / thread /
    // permalink) keep the message menu. Do NOT preventDefault here so the native
    // menu can appear. (artin task #489)
    if (e.target instanceof Element && e.target.closest('a[target="_blank"]')) {
      return;
    }
    // Once select mode is active, a second right-click should not re-open the
    // context menu — the user is in a focused selection task and the menu's
    // "Share messages…" / "Copy link" entries either duplicate their current
    // state or would derail the flow. Still preventDefault so the browser's
    // native menu also stays out of the way.
    if (selectionActive) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    setCtxMenu({
      anchorX: e.clientX,
      anchorY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      source: "pointer",
    });
    setReactionPicker(null);
  }, [isSystem, selectionActive]);

  // Long-press to open context menu on mobile
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (isSystem) return;
    // A child overlay may portal its backdrop to document.body. React still
    // bubbles that touch through MessageItem, but DOM containment is the
    // ownership boundary: only touches physically inside the row may arm the
    // message long-press timer.
    if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
    const target = e.target;
    if (target.closest("[data-message-selectable='true']")) return;
    // Parity with handleContextMenu: once select mode is active, long-press
    // should not re-open the context menu either. Mobile users toggle
    // selection by tapping rows in select mode; the popup menu here would
    // only get in the way.
    if (selectionActive) return;
    longPressFired.current = false;
    const touch = e.touches[0];
    const x = touch.clientX;
    const y = touch.clientY;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setCtxMenu(placeTouchMessageContextMenu({ x, y }));
      setReactionPicker(null);
      setCtxMenuClickShielded(true);
      if (ctxMenuShieldTimerRef.current) clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = setTimeout(() => {
        setCtxMenuClickShielded(false);
        ctxMenuShieldTimerRef.current = null;
      }, 600);
    }, 500);
  }, [isSystem, selectionActive]);

  useEffect(() => () => {
    if (ctxMenuShieldTimerRef.current) {
      clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    if (longPressFired.current) {
      // Prevent synthetic click from closing the menu
      e.preventDefault();
    }
  }, []);

  const handleTouchMove = useCallback(() => {
    // Cancel long press if finger moves (scrolling)
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Selection-quote v0 (#proj-chat task #32). Which composer the Quote lands
  // in — mirrors the "Share messages…" routing exactly so a thread reply
  // quotes into the thread composer, a thread parent rendered in ThreadPanel
  // quotes into that thread, and a channel-timeline row quotes into the
  // channel composer.
  const quoteComposerChannelId = useMemo(() => {
    if (parentMessageId) return message.channelId; // thread reply → thread channel
    if (hideThreadActions && message.threadId) return message.threadId; // parent in ThreadPanel
    return parentChannelId || message.channelId; // channel timeline
  }, [parentMessageId, hideThreadActions, message.threadId, parentChannelId, message.channelId]);

  const handleConvertToTask = useCallback(async () => {
    setCtxMenu(null);
    setConverting(true);
    try {
      await convertMessage(message.id);
    } catch (err) {
      console.error("Failed to convert message to task:", err);
    } finally {
      setConverting(false);
    }
  }, [convertMessage, message.id]);

  const openLinkedTask = useCallback(() => {
    if (!linkedTask) return;
    if (linkedTask.messageId) {
      // Declares intent rather than leaving the host to infer it: the thread icon
    // on this same message opens the replies in the side panel, and only the
    // badge means "open the task". Inferring from "is the parent a task" cannot
    // tell those apart — which is how the thread icon started opening a modal.
    void openThread({
      parentChannelId: linkedTask.channelId,
      parentMessageId: linkedTask.messageId,
      intent: "task",
    });
      return;
    }
    openLegacyTask(linkedTask);
  }, [linkedTask, openThread, openLegacyTask]);

  const handleToggleTaskDone = useCallback(async () => {
    if (!linkedTask) return;
    setCtxMenu(null);
    const nextStatus = linkedTask.status === "done" ? "todo" : "done";
    try {
      await updateTaskStatus(linkedTask.channelId, linkedTask.id, nextStatus);
    } catch (err) {
      console.error("Failed to update task status:", err);
    }
  }, [linkedTask, updateTaskStatus]);

  const handleFollowThread = useCallback(async () => {
    setCtxMenu(null);
    try {
      await followThread(message.id);
    } catch (err) {
      console.error("Failed to follow thread:", err);
    }
  }, [followThread, message.id]);

  const handleUnfollowThread = useCallback(async () => {
    if (!followedThread) return;
    setCtxMenu(null);
    try {
      await unfollowThread(followedThread.threadChannelId);
    } catch (err) {
      console.error("Failed to unfollow thread:", err);
    }
  }, [followedThread, unfollowThread]);

  const reactions = useMemo(() => message.reactions ?? [], [message.reactions]);
  const visibleReactions = useMemo(
    () => reactions.filter((reaction) => reaction.count > 0),
    [reactions],
  );
  const readReactionActors = useCallback((
    reaction: NonNullable<Message["reactions"]>[number],
  ): readonly ReactionActorRef[] => {
    if (isLegacyMessageReaction(reaction)) {
      return reaction.reactorIds.map((id, index) => ({
        id,
        displayName: reaction.reactorNames[index] ?? formatMessageRef.current({ id: "message.messageItem.reactorUnknown" }),
      }));
    }
    if (!serverId || !viewerUserId) return reaction.previewK;
    const discussion = messageReactionActorsDiscussion(
      canonicalMessageRef(serverId, message.id),
      reaction.emoji,
      reactionParentScopeKey ?? messageReactionParentScopeKey(serverId, message),
    );
    const cached = selectReactionActors(reactionActorCache, viewerUserId, discussion);
    return cached.status === "loaded" ? cached.entry.actors : reaction.previewK;
  }, [message, reactionActorCache, reactionParentScopeKey, serverId, viewerUserId]);

  const hasCurrentUserReaction = useCallback((emoji: string) => {
    if (!viewerUserId) return false;
    if (normalizedMessageV2Enabled && serverId) {
      const overlay = selectReactionViewerOverlay(
        reactionViewerOverlay,
        reactionViewerCompleteMessages,
        viewerUserId,
        serverId,
        message.id,
        emoji,
      );
      return overlay.status === "loaded" && overlay.reactedByMe;
    }
    return reactions.some((reaction) => (
      reaction.emoji === emoji
      && isLegacyMessageReaction(reaction)
      && reaction.reactorIds.includes(viewerUserId)
    ));
  }, [
    message.id,
    normalizedMessageV2Enabled,
    reactionViewerCompleteMessages,
    reactionViewerOverlay,
    reactions,
    serverId,
    viewerUserId,
  ]);

  useEffect(() => {
    if (!normalizedMessageV2Enabled || !serverId || !viewerUserId) return;
    const needsHydrate = visibleReactions.some((reaction) => (
      selectReactionViewerOverlay(
        reactionViewerOverlay,
        reactionViewerCompleteMessages,
        viewerUserId,
        serverId,
        message.id,
        reaction.emoji,
      ).status === "unknown"
    ));
    if (!needsHydrate) return;
    void hydrateReactionViewerSnapshot({
      principalId: viewerUserId,
      serverId,
      messageId: message.id,
    }).catch((error) => {
      console.error("Failed to hydrate reaction viewer state:", error);
    });
  }, [
    message.id,
    normalizedMessageV2Enabled,
    reactionViewerCompleteMessages,
    reactionViewerOverlay,
    serverId,
    viewerUserId,
    visibleReactions,
  ]);

  const handleToggleReaction = useCallback(async (emoji: string) => {
    if (
      !viewerUserId
      || !serverId
      || isSystem
      || !canReact
      || pendingReactionEmojisRef.current.has(emoji)
    ) return;
    const alreadyReacted = hasCurrentUserReaction(emoji);
    const nextReacted = !alreadyReacted;
    const previousMessage = message;
    const previousOverlay = normalizedMessageV2Enabled
      ? reactionReadModelStore.getState().readViewerOverlay(
          viewerUserId,
          serverId,
          message.id,
          emoji,
        )
      : null;
    const getCurrentMessage = () => (
      useMessageStore.getState().channelMessages[message.channelId]?.find((cached) => cached.id === message.id)
      ?? message
    );
    const optimisticMessage = normalizedMessageV2Enabled
      ? buildOptimisticNormalizedReactionMessage(message, emoji, alreadyReacted)
      : buildOptimisticReactionMessage(
          message,
          emoji,
          alreadyReacted,
          viewerUserId,
          viewerReactionName,
          formatMessage({ id: "message.author.unknown" }),
        );
    pendingReactionEmojisRef.current.add(emoji);
    pendingReactionTargetsRef.current.set(emoji, nextReacted);
    if (normalizedMessageV2Enabled) {
      reactionReadModelStore.getState().applyViewerReactionPatch(
        viewerUserId,
        serverId,
        message.id,
        emoji,
        nextReacted,
      );
    }
    useMessageStore.getState().updateMessage(optimisticMessage);
    try {
      const response = await setMessageReaction({
        serverId,
        messageId: message.id,
        emoji,
        active: nextReacted,
      });
      pendingReactionEmojisRef.current.delete(emoji);
      pendingReactionTargetsRef.current.delete(emoji);
      const currentMessage = getCurrentMessage();
      const { reactionViewer, ...normalizedAckMessage } = response;
      if (normalizedMessageV2FlagEnabled && reactionViewer) {
        applyReactionViewerSnapshotForCurrentPrincipal(reactionViewer, viewerUserId);
      }
      const projectedAckMessage = normalizedMessageV2FlagEnabled
        ? applyMessageReactionsForV2Ingress(normalizedAckMessage, {
            serverId,
            principalId: viewerUserId,
            source: "receiver-private",
            viewerUserId,
          })
        : response;
      const normalizedResponseMessage = normalizedMessageV2Enabled
        && !isMessageV2IngressSoleApplyEligible(projectedAckMessage)
        ? currentMessage
        : projectedAckMessage;
      if (normalizedMessageV2FlagEnabled) {
        for (const [pendingEmoji, pendingActive] of pendingReactionTargetsRef.current) {
          reactionReadModelStore.getState().applyViewerReactionPatch(
            viewerUserId,
            serverId,
            message.id,
            pendingEmoji,
            pendingActive,
          );
        }
      }
      const reconciledMessage = mergeReactionResponsePreservingPending(
        currentMessage,
        normalizedResponseMessage,
        pendingReactionEmojisRef.current,
      );
      useMessageStore.getState().updateMessage(reconciledMessage);
    } catch (err) {
      console.error("Failed to toggle reaction:", err);
      pendingReactionEmojisRef.current.delete(emoji);
      pendingReactionTargetsRef.current.delete(emoji);
      const currentMessage = getCurrentMessage();
      useMessageStore.getState().updateMessage(replaceReactionForEmoji(currentMessage, previousMessage, emoji));
      if (normalizedMessageV2Enabled) {
        if (previousOverlay?.status === "loaded") {
          reactionReadModelStore.getState().applyViewerReactionPatch(
            viewerUserId,
            serverId,
            message.id,
            emoji,
            previousOverlay.reactedByMe,
          );
        } else {
          reactionReadModelStore.getState().clearViewerReactionPatch(
            viewerUserId,
            serverId,
            message.id,
            emoji,
          );
        }
      }
      setReactionFailureEmoji(emoji);
      if (reactionFailureFlashTimerRef.current) {
        clearTimeout(reactionFailureFlashTimerRef.current);
      }
      reactionFailureFlashTimerRef.current = setTimeout(() => {
        setReactionFailureEmoji(null);
        reactionFailureFlashTimerRef.current = null;
      }, 400);
    } finally {
      pendingReactionEmojisRef.current.delete(emoji);
      pendingReactionTargetsRef.current.delete(emoji);
    }
  }, [
    formatMessage,
    canReact,
    hasCurrentUserReaction,
    isSystem,
    message,
    normalizedMessageV2Enabled,
    normalizedMessageV2FlagEnabled,
    serverId,
    viewerReactionName,
    viewerUserId,
  ]);

  useEffect(() => () => {
    if (reactionFailureFlashTimerRef.current) {
      clearTimeout(reactionFailureFlashTimerRef.current);
      reactionFailureFlashTimerRef.current = null;
    }
  }, []);

  const clearReactionPickerCloseTimer = useCallback(() => {
    if (reactionPickerCloseTimerRef.current) {
      clearTimeout(reactionPickerCloseTimerRef.current);
      reactionPickerCloseTimerRef.current = null;
    }
  }, []);

  const closeReactionPicker = useCallback(() => {
    clearReactionPickerCloseTimer();
    setReactionPicker(null);
  }, [clearReactionPickerCloseTimer]);

  const scheduleReactionPickerClose = useCallback(() => {
    clearReactionPickerCloseTimer();
    reactionPickerCloseTimerRef.current = setTimeout(() => {
      setReactionPicker(null);
      reactionPickerCloseTimerRef.current = null;
    }, 120);
  }, [clearReactionPickerCloseTimer]);

  const isReactionPickerBoundaryTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return !!messageRef.current?.contains(target) || !!target.closest("[data-message-affordance='reaction-picker']");
  }, []);

  const openReactionPicker = useCallback((target: HTMLElement) => {
    positionReactionPickerFromRect(target.getBoundingClientRect());
  }, [positionReactionPickerFromRect]);

  const handleQuickReactionClick = useCallback((emoji: string) => {
    closeReactionPicker();
    setCtxMenu(null);
    setCtxMenuClickShielded(false);
    if (ctxMenuShieldTimerRef.current) {
      clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = null;
    }
    void handleToggleReaction(emoji);
  }, [closeReactionPicker, handleToggleReaction]);

  useEffect(() => {
    const handlePeerPickerOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string }>).detail;
      if (detail?.messageId !== message.id) closeReactionPicker();
    };
    window.addEventListener(REACTION_PICKER_EVENT, handlePeerPickerOpen);
    return () => window.removeEventListener(REACTION_PICKER_EVENT, handlePeerPickerOpen);
  }, [closeReactionPicker, message.id]);

  useEffect(() => {
    if (!reactionPicker) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-message-affordance='reaction'], [data-message-affordance='reaction-picker']")) return;
      closeReactionPicker();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeReactionPicker();
    };
    const handleViewportChange = () => {
      closeReactionPicker();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    // keydown-global-exempt: capture-phase reaction-picker escape, runs before background so focus-on-open not needed
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [closeReactionPicker, reactionPicker]);

  useEffect(() => () => clearReactionPickerCloseTimer(), [clearReactionPickerCloseTimer]);

  const handleReactionPickerBoundaryEnter = useCallback(() => {
    clearReactionPickerCloseTimer();
  }, [clearReactionPickerCloseTimer]);

  const handleReactionPickerBoundaryLeave = useCallback((event: MouseEvent) => {
    if (!reactionPicker) return;
    if (isReactionPickerBoundaryTarget(event.relatedTarget)) return;
    scheduleReactionPickerClose();
  }, [isReactionPickerBoundaryTarget, reactionPicker, scheduleReactionPickerClose]);

  const showReactionPopover = useCallback((
    reaction: NonNullable<Message["reactions"]>[number],
    target: HTMLElement,
  ) => {
    const rect = target.getBoundingClientRect();
    const actors = readReactionActors(reaction);
    const currentViewerReacted = hasCurrentUserReaction(reaction.emoji);
    const reactorNames = currentViewerReacted && viewerUserId
      ? [
        formatMessageRef.current({ id: "message.messageItem.reactorYou" }),
        ...actors.filter((actor) => actor.id !== viewerUserId).map((actor) => actor.displayName),
      ]
      : actors.map((actor) => actor.displayName);
    const visibleNames = reactorNames.slice(0, 5);
    const hiddenCount = Math.max(0, reaction.count - visibleNames.length);

    setReactionPopover({
      emoji: reaction.emoji,
      visibleNames,
      hiddenCount,
      x: rect.left,
      y: rect.bottom + 4,
    });
  }, [hasCurrentUserReaction, readReactionActors, viewerUserId]);

  const hideReactionPopover = useCallback(() => {
    setReactionPopover(null);
  }, []);

  const handleCopyLink = useCallback(() => {
    if (!serverSlug) return;
    const channelForLink = parentChannelId || message.channelId;
    const routeKind = navigableChannels.find((channel) => channel.id === channelForLink)?.type === "dm" ? "dm" : "channel";
    const url = buildMessagePermalink(serverSlug, channelForLink, message.id, {
      routeKind,
      threadParentMessageId: parentMessageId ?? null,
    });
    navigator.clipboard.writeText(url).then(() => {
      setCtxMenu(null);
    });
  }, [serverSlug, parentChannelId, parentMessageId, message.channelId, message.id, navigableChannels]);

  const handleOpenPermalink = useCallback((href: string) => {
    const permalink = parseRaftPermalink(href, currentHostname);
    if (!permalink) {
      window.open(href, "_blank", "noopener,noreferrer");
      return;
    }

    if (serverSlug && permalink.serverSlug === serverSlug) {
      if (permalink.threadParentMessageId) {
        nav.toThreadMessage(
          permalink.channelId,
          permalink.threadParentMessageId,
          permalink.messageId,
          permalink.routeKind,
        );
      } else if (permalink.routeKind === "dm") {
        nav.toDmMessage(permalink.channelId, permalink.messageId);
      } else {
        nav.toMessage(permalink.channelId, permalink.messageId);
      }
      return;
    }

    window.location.href = href;
  }, [currentHostname, nav, serverSlug]);

  const handleOpenQuotedPermalink = useCallback((permalink: ReturnType<typeof parseRaftPermalink>) => {
    if (!permalink) return;

    if (permalink.threadParentMessageId) {
      if (permalink.routeKind === "dm") {
        nav.toDm(permalink.channelId);
      } else {
        nav.toChannel(permalink.channelId);
      }
      // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
      openThread({
        parentChannelId: permalink.channelId,
        parentMessageId: permalink.threadParentMessageId,
        focusedMessageId: permalink.messageId,
      });
      return;
    }

    requestTransientFocus(permalink.channelId, permalink.messageId);
    if (permalink.routeKind === "dm") {
      nav.toDm(permalink.channelId);
    } else {
      nav.toChannel(permalink.channelId);
    }
  }, [nav, openThread, requestTransientFocus]);

  const handleOpenTaskRef = useCallback(async (taskNumber: number) => {
    const taskContextChannelId = parentChannelId || message.channelId;
    try {
      const { data } = await api.get(`/tasks/channel/${taskContextChannelId}/number/${taskNumber}`);
      const task = (data as { task: Task }).task;
      closeProfile();
      if (task.isLegacy) {
        closeThread();
        nav.toChannel(task.channelId, { chatTab: "tasks" });
        openLegacyTask(task);
        return;
      }
      // Stryker disable next-line ObjectLiteral: typed thread payload shape is covered by openThread payload/source contracts.
      void openThread({ parentChannelId: task.channelId, parentMessageId: task.messageId, intent: "task" });
    } catch (err) {
      console.error(`Failed to resolve task #${taskNumber}:`, err);
    }
  }, [closeProfile, closeThread, message.channelId, nav, openLegacyTask, openThread, parentChannelId]);

  const handleDownloadAttachment = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    try {
      const { data } = await api.get(`/attachments/${attachment.id}/url?disposition=attachment`);
      const link = document.createElement("a");
      link.href = data.url;
      link.download = attachment.filename;
      link.rel = "noopener";
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
    } catch {
      // noop: keep attachment card interactive for retry
    }
  }, []);

  const handleOpenHtmlPreview = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    await openMediaPreview("html", attachment, {
      commentContext: { parentMessage: { id: message.id, channelId: message.channelId, senderId: message.senderId, senderType: message.senderType } },
    });
  }, [message.id, message.channelId, message.senderId, message.senderType]);

  const handleOpenVideoPreview = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    await openMediaPreview("video", attachment, {
      commentContext: { parentMessage: { id: message.id, channelId: message.channelId, senderId: message.senderId, senderType: message.senderType } },
    });
  }, [message.id, message.channelId, message.senderId, message.senderType]);

  // Stryker disable all: audio open/loading/fallback behavior is covered by audioAttachmentPreview.behavior.test.tsx; remaining handler mutants are stale-concurrent/dependency glue.
  const handleOpenAudioPreview = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    await openMediaPreview("audio", attachment, {
      commentContext: { parentMessage: { id: message.id, channelId: message.channelId, senderId: message.senderId, senderType: message.senderType } },
      onFallbackDownload: handleDownloadAttachment,
    });
  }, [handleDownloadAttachment, message.id, message.channelId, message.senderId, message.senderType]);
  // Stryker restore all

  const handleOpenDocumentPreview = useCallback(async (attachment: NonNullable<Message["attachments"]>[number]) => {
    // The shared opener owns fetching and the modal; MessageItem only supplies
    // the one thing it uniquely has — the host message for comments.
    await openDocumentPreview(attachment, {
      commentContext: { parentMessage: { id: message.id, channelId: message.channelId, senderId: message.senderId, senderType: message.senderType } },
      onFallbackDownload: handleDownloadAttachment,
    });
  }, [handleDownloadAttachment, message.id, message.channelId, message.senderId, message.senderType]);

  const handleOpenForwardedAttachment = useCallback((snapshot: ForwardedBundleAttachmentSnapshot) => {
    if (!snapshot.id) return;
    const attachment: NonNullable<Message["attachments"]>[number] = {
      id: snapshot.id,
      filename: snapshot.filename,
      mimeType: snapshot.mimeType || "application/octet-stream",
      sizeBytes: snapshot.sizeBytes ?? 0,
      width: snapshot.width ?? null,
      height: snapshot.height ?? null,
      thumbnailUrl: null,
    };
    if (isPreviewableImageAttachment(attachment)) {
      useImageLightboxStore.getState().open([attachment], 0);
    } else if (isPreviewableHtmlAttachment(attachment)) {
      void handleOpenHtmlPreview(attachment);
    } else if (isPreviewableVideoAttachment(attachment)) {
      void handleOpenVideoPreview(attachment);
    } else if (isPreviewableAudioAttachment(attachment)) {
      void handleOpenAudioPreview(attachment);
    } else if (isPreviewableDocumentAttachment(attachment)) {
      void handleOpenDocumentPreview(attachment);
    } else {
      void handleDownloadAttachment(attachment);
    }
  }, [handleDownloadAttachment, handleOpenAudioPreview, handleOpenDocumentPreview, handleOpenHtmlPreview, handleOpenVideoPreview]);


  // Close context menu on click outside
  const handleCloseCtx = useCallback(() => {
    setCtxMenu(null);
    closeReactionPicker();
    setCtxMenuClickShielded(false);
    if (ctxMenuShieldTimerRef.current) {
      clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = null;
    }
  }, [closeReactionPicker]);

  useEffect(() => {
    if (!ctxMenu) return;
    const handleViewportChange = () => handleCloseCtx();
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [ctxMenu, handleCloseCtx]);

  const updateCtxMenuPosition = useCallback((position: { x: number; y: number }) => {
    setCtxMenu((current) => {
      if (!current) return current;
      if (current.x === position.x && current.y === position.y) return current;
      return { ...current, x: position.x, y: position.y };
    });
  }, []);

  useFloatingOverlayPosition({
    open: Boolean(ctxMenu),
    anchor: ctxMenu ? { x: ctxMenu.anchorX, y: ctxMenu.anchorY } : null,
    floatingRef: ctxMenuRef,
    onPositionChange: updateCtxMenuPosition,
  });

  // System messages: centered, compact, no avatar.
  // Title content is summarized server-side; clamp to a single line as a
  // defense-in-depth so any unexpectedly long body still renders on one line.
  if (isSystem) {
    const systemContentParts = splitReminderReceiptFireAtTokens(message.content);
    const systemContentTitle = formatReminderReceiptContentTitle(message.content, timeFormatOptions);
    return (
      <div className="flex items-center justify-center gap-2 py-1.5 px-2 mb-1 min-w-0">
        <span className="text-xs text-black/40 font-mono whitespace-nowrap shrink-0">{time}</span>
        <span className="text-xs text-black/50 truncate min-w-0" title={systemContentTitle}>
          {systemContentParts.map((part, index) => (
            part.type === "reminderFireAt" ? (
              <span key={`${part.value}-${index}`} title={formatReminderReceiptTooltip(part.value, timeFormatOptions)}>
                {formatReminderReceiptTime(part.value, formatMessage, new Date(), timeFormatOptions)}
              </span>
            ) : (
              part.value
            )
          ))}
        </span>
      </div>
    );
  }

  return (
    <>
    <div
      ref={messageRef}
      id={`message-${message.id}`}
      onClick={handleMobileTap}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
      onMouseEnter={handleReactionPickerBoundaryEnter}
      onMouseLeave={handleReactionPickerBoundaryLeave}
      className={`group/message relative flex h-fit gap-3 py-1 ${showSelectedGroupedHeader ? "mt-1.5 min-h-[3rem]" : ""} px-2 ${
        isHighlighted
          ? "border-2 border-black bg-brutal-cyan/25 shadow-brutal mb-1"
          : ctxMenu || reactionPicker
          ? "border-2 border-black bg-white mb-1"
          : isSelectedAsThreadParent
          ? "border-2 border-black bg-white mb-1"
          : selectionScopedHere
          ? "border-2 border-transparent hover:bg-white active:bg-white mb-1"
          : "border-2 border-transparent hover:border-black hover:bg-white active:border-black active:bg-white mb-1"
      }`}
    >
      {selectionScopedHere && (
        <CheckMarker
          // v1.5 (huxijin 2026-05-01): was `self-center`, which dropped the
          // circle into the vertical middle of the row. On long messages
          // this sits far below the viewport's top edge and users lose
          // track of which message they're toggling. Pin to the top row
          // (`self-start`) at avatar height so the indicator is always
          // visible alongside the sender name.
          checked={isSelected}
          shape="circle"
          size="lg"
          tone="yellow-fill"
          className="self-start mt-1.5"
          data-testid={`message-select-circle-${message.id}`}
        />
      )}
      {/* Hover action toolbar — the "骑线按钮组" pill. Extracted into its own
          component (stdrc). */}
      <MessageHoverToolbar
        isSaved={isSaved}
        reactionActive={!!reactionPicker}
        hideThreadActions={hideThreadActions}
        isSystem={isSystem}
        canReact={canReact}
        onReplyInThread={handleReplyInThread}
        onReactionClick={(e) => {
          e.stopPropagation();
          setCtxMenu(null);
          if (reactionPicker) {
            closeReactionPicker();
          } else {
            openReactionPicker(e.currentTarget);
          }
        }}
        onToggleSave={handleToggleSave}
      />
      {showSelectedGroupedHeader ? (
        <MessageSenderAvatar
          showAgent={isAgent && !!senderAgent}
          showExternal={isExternal}
          isDeactivatedAgent={isDeactivatedAgent}
          senderId={message.senderId}
          agentAvatarUrl={agentAvatarUrl}
          avatarUrl={humanAvatarUrl}
          gravatarHash={senderMember?.gravatarHash}
          email={senderEmailForAvatar}
          hoverAgent={senderAgent}
          hoverMember={senderMember}
          externalAvatarUrl={externalAvatarUrl}
          externalInitials={senderDisplayName}
          testId={senderAvatarTestId}
          onNavigateAgent={handleNavigateAgent}
                onNavigateAgentActivity={handleNavigateAgentActivity}
          onNavigateHuman={handleNavigateHuman}
          onContextMenu={handleSenderContextMenu}
          onLongPressMention={senderMention ? insertSenderMention : undefined}
        />
      ) : (
        // Continuation row (task #44): reserve the avatar column so the body
        // stays aligned with grouped rows above, and show this message's clock
        // (HH:MM) in that gutter — every message keeps a visible timestamp
        // (stdrc), aligned in a consistent left column instead of the header.
        <div className="relative w-9 shrink-0 self-stretch">
          <span
            title={gutterFullTimestamp}
            // No transition — the time reveals instantly on hover, like the row
            // border (stdrc: 时间不要动画呈现，跟边框一样立即出现).
            className="absolute right-1 top-1 select-none font-mono text-[10px] leading-none tabular-nums text-black/0 group-hover/message:text-black/40"
          >
            {gutterClock}
          </span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        {groupState?.showName === false && !showSelectedGroupedHeader ? null : (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden pr-24">
          {senderMention ? (
            <button
              type="button"
              onClick={handleSenderNameMention}
              onContextMenu={handleSenderContextMenu}
              className="min-w-0 shrink-0 [cursor:pointer] truncate text-sm font-bold text-black hover:underline hover:decoration-2 hover:underline-offset-2"
              title={formatMessage({ id: "message.messageItem.mentionSender" }, { name: senderMention.name })}
              data-testid={`message-sender-mention-${message.id}`}
            >
              {senderDisplayName}
            </button>
          ) : (
            <span
              className="min-w-0 shrink-0 truncate text-sm font-bold text-black"
              onContextMenu={handleSenderContextMenu}
            >
              {senderDisplayName}
            </span>
          )}
          {agentModelLabelText && (
            <span
              className="shrink-0 whitespace-nowrap font-mono text-[11px] leading-none text-black/40"
              title={agentModelLabelText}
              data-testid={`message-sender-model-${message.id}`}
            >
              {agentModelLabelText}
            </span>
          )}
          {isDeactivatedAgent && (
            <span className="inline-flex shrink-0 items-center whitespace-nowrap px-1.5 py-0.5 text-[10px] font-bold uppercase border border-black bg-gray-300 text-black/60">
              {formatMessage({ id: "message.messageItem.deletedBadge" })}
            </span>
          )}
          {humanDepartureLabel && (
            <span className="inline-flex shrink-0 items-center whitespace-nowrap px-1.5 py-0.5 text-[10px] font-bold uppercase border border-black bg-gray-300 text-black/60">
              {humanDepartureLabel}
            </span>
          )}
          {senderSubtitle && (
            <span className="min-w-0 truncate text-xs text-black/40 font-mono" title={senderSubtitle}>
              {senderSubtitle}
            </span>
          )}
          <span className="shrink-0 text-xs text-black/40 font-mono whitespace-nowrap">{time}</span>
          {converting && (
            <span className="text-[10px] font-bold text-black/40">{formatMessage({ id: "message.messageItem.converting" })}</span>
          )}
          </div>
        )}
        <AttachmentCommentRefChip
          commentRef={message.commentRef}
          commentsEnabled={commentsEnabled}
          onJumpToHost={handleJumpToCommentHost}
          bodyFontSizeClass={messageBodyFontSizeClass}
        />
        <CollapsibleMessageContent
          key={message.id}
          messageId={message.id}
          measurementKey={message.randomId ?? message.id}
          measureBeforePaint={message.id.startsWith("optimistic-")}
          disabled={isActionCardMessage || !!forwardedBundleMetadata || !collapseLongMessages}
        >
        <div
          ref={messageBodyRef}
          data-message-selectable="true"
          data-message-id={message.id}
          data-quote-channel-id={quoteComposerChannelId}
          data-message-font-size={messageBodyFontSize}
          className={`${messageBodyFontSizeClass} text-black break-words select-text [&_*]:select-text`}
          style={{ userSelect: "text", WebkitUserSelect: "text" }}
        >
          {(() => {
            // Operation card (B-mode): the message body IS the card. Skip
            // markdown rendering and inline the structured card from
            // `actionMetadata`.
            if (isActionCardMessage) {
              return (
                <ActionCard
                  messageId={message.id}
                  metadata={message.actionMetadata as ActionCardMetadata}
                  channelId={message.channelId}
                />
              );
            }
            if (isTranslationPending) {
              return (
                <Skeleton
                  variant="line"
                  className="inline-block w-44 max-w-full align-middle"
                  data-testid={`message-translation-placeholder-${message.id}`}
                />
              );
            }
            return (
              <MessageMarkdownBody
                readReceiptChannelId={message.channelId}
                readReceiptMessageSeq={message.seq}
                readReceiptEnabled={agentReadBadgesEnabled}
                content={forwardedBundleBodyContent}
                channels={navigableChannels}
                mentionMap={effectiveMentionMap}
                structuredMentionMap={effectiveStructuredMentionMap}
                channelParticipantAgentsById={channelParticipantAgentsById}
                channelParticipantMembersById={channelParticipantMembersById}
                unavailableQuotedPermalinkUrl={unavailableQuotedPermalinkUrl}
                onNavigateChannel={handleNavigateChannel}
                onNavigateDm={handleNavigateDm}
                onNavigateAgent={handleNavigateAgent}
                onNavigateHuman={handleNavigateHuman}
                onNavigateComputer={handleNavigateComputer}
                onOpenThread={handleOpenThreadRef}
                resolvingThreadRefKey={resolvingThreadRefKey}
                onOpenTask={handleOpenTaskRef}
                onOpenMessage={handleOpenMessageRef}
                onOpenPermalink={handleOpenPermalink}
                serverSlug={serverSlug}
                refAuthorityServerSlug={refAuthorityServerSlug}
                threadRefAuthorityUnavailable={threadRefAuthorityUnavailable}
                knownTaskNumbers={knownTaskNumbers}
                timeFormatOptions={timeFormatOptions}
                threadSearchHighlightQuery={threadSearchHighlightQuery}
              />
            );
          })()}
        </div>
        {showBilingualOriginal ? (
          <div
            className="mt-1.5 border-l-2 border-black/20 pl-2 text-black/70"
            data-testid={`message-translation-bilingual-original-${message.id}`}
          >
            <div className="mb-0.5 text-[10px] font-bold uppercase tracking-normal text-black/40">{formatMessage({ id: "message.messageItem.bilingualOriginal" })}</div>
            <div className={`${messageBodyFontSizeClass} break-words select-text [&_*]:select-text`}>
              <MessageMarkdownBody
                readReceiptChannelId={message.channelId}
                readReceiptMessageSeq={message.seq}
                readReceiptEnabled={agentReadBadgesEnabled}
                content={message.content}
                channels={navigableChannels}
                mentionMap={effectiveMentionMap}
                structuredMentionMap={effectiveStructuredMentionMap}
                channelParticipantAgentsById={channelParticipantAgentsById}
                channelParticipantMembersById={channelParticipantMembersById}
                unavailableQuotedPermalinkUrl={unavailableQuotedPermalinkUrl}
                onNavigateChannel={handleNavigateChannel}
                onNavigateDm={handleNavigateDm}
                onNavigateAgent={handleNavigateAgent}
                onNavigateHuman={handleNavigateHuman}
                onNavigateComputer={handleNavigateComputer}
                onOpenThread={handleOpenThreadRef}
                resolvingThreadRefKey={resolvingThreadRefKey}
                onOpenTask={handleOpenTaskRef}
                onOpenMessage={handleOpenMessageRef}
                onOpenPermalink={handleOpenPermalink}
                serverSlug={serverSlug}
                refAuthorityServerSlug={refAuthorityServerSlug}
                threadRefAuthorityUnavailable={threadRefAuthorityUnavailable}
                knownTaskNumbers={knownTaskNumbers}
                timeFormatOptions={timeFormatOptions}
                threadSearchHighlightQuery={threadSearchHighlightQuery}
              />
            </div>
          </div>
        ) : null}
        {forwardedBundleMetadata ? (
          <div className="mt-1.5">
            <ForwardedBundleRouteCard
              messageId={message.id}
              metadata={forwardedBundleMetadata}
              onOpenSource={handleOpenForwardedSource}
              onOpenAttachment={handleOpenForwardedAttachment}
            />
          </div>
        ) : null}
        {quotedPermalink && !quotedPermalinkUnavailable ? (
          <div className="mt-1.5">
            <QuotedMessagePermalinkPreview
              permalink={quotedPermalink.parsed}
              onOpen={handleOpenQuotedPermalink}
              onUnavailable={handleQuotedPermalinkUnavailable}
            />
          </div>
        ) : null}
        {threadRefNotice ? (
          <div className="mt-1 inline-flex max-w-full border border-black bg-soft-signal/40 px-2 py-1 text-xs font-bold text-black/70">
            {formatMessage({ id: threadRefNotice })}
          </div>
        ) : null}
        </CollapsibleMessageContent>
        {/* Attached files */}
        {!forwardedBundleMetadata && message.attachments && message.attachments.length > 0 && (() => {
          return renderWithImageInlineFallback(imageFallbackKey, (imageFallbackUrls) => {
            // Stryker disable all: pre-existing attachment classification moved under the fallback seam.
            if (!message.attachments) return null;
            const imageAttachments = message.attachments.filter((att) => isPreviewableImageAttachment(att));
            const lightboxImages = imageAttachments.filter((att) => !isOptimisticAttachment(att));
            const renderedImages = imageAttachments.filter((att) => !!getImageGalleryPreviewSrc(att, imageFallbackUrls));
            const imageRows = buildImageGalleryRows(renderedImages);
            const videoAttachments = message.attachments.filter((att) => isPreviewableVideoAttachment(att));
            const audioAttachments = message.attachments.filter((att) => isPreviewableAudioAttachment(att));
            const otherAttachments = message.attachments.filter((att) => {
              if (!isPreviewableImageAttachment(att)) return true;
              return shouldRenderImageAsAttachmentChip(att, imageFallbackUrls);
            }).filter((att) => !isPreviewableVideoAttachment(att) && !isPreviewableAudioAttachment(att));
            // Stryker restore all

          return (
            <div className="mt-1 space-y-2">
              {imageRows.length > 0 && (
                <div className="max-w-[min(22rem,calc(100vw-7rem))] space-y-2 md:max-w-[28rem]">
                  {imageRows.map((row, rowIndex) => (
                    <div
                      key={`${row.attachments.map((att) => att.id).join("-")}-${rowIndex}`}
                      className={`grid gap-2 ${row.gridClass}`}
                    >
                      {row.attachments.map((att) => {
                        const previewSrc = getImageGalleryPreviewSrc(att, imageFallbackUrls);
                        if (!previewSrc) return null;
                        const isOptimistic = isOptimisticAttachment(att);
                        const imageIndex = lightboxImages.findIndex((img) => img.id === att.id);
                        const handleOpenImage = () => {
                          if (!isOptimistic && imageIndex >= 0) {
                            // Image comments are descoped for now (cindyz
                            // 6/11): no comment contexts → the lightbox
                            // renders no comment affordance. Re-enable by
                            // passing buildLightboxCommentContexts(...) when
                            // image region anchors get designed.
                            useImageLightboxStore.getState().open(lightboxImages, imageIndex);
                          }
                        };
                        const handleDownloadImage = (event: MouseEvent<HTMLButtonElement>) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void handleDownloadAttachment(att);
                        };
                        const isSingleImage = renderedImages.length === 1;
                        const fitClass = getImageGalleryFitClass(att);
                        const imageBackgroundClass = fitClass === "object-contain" ? imageGalleryBackgroundClass : "";
                        const imageReserveStyle = isSingleImage ? getSingleImageReserveStyle(att) : undefined;
                        return (
                          <div
                            key={att.id}
                            className={`group/img relative overflow-hidden border-2 border-black text-left ${
                              isSingleImage ? "inline-block w-fit max-w-[26rem] justify-self-start" : row.heightClass
                            } bg-brutal-cream/60 ${isOptimistic ? "opacity-70" : "hover:brightness-95"}`}
                            style={imageReserveStyle}
                            title={att.filename}
                          >
                            <img
                              src={previewSrc}
                              alt={att.filename}
                              data-select-screenshot-attachment-id={att.id}
                              data-select-screenshot-attachment-width={att.width ?? undefined}
                              data-select-screenshot-attachment-height={att.height ?? undefined}
                              className={
                                isSingleImage
                                  ? `block h-full w-full object-contain ${imageGalleryBackgroundClass}`
                                  : `block h-full w-full ${fitClass} ${imageBackgroundClass}`
                              }
                              width={att.width ?? undefined}
                              height={att.height ?? undefined}
                              loading="lazy"
                            />
                            {isOptimistic && (
                              <div className="absolute inset-0 flex items-center justify-center">
                                <Spinner size="md" variant="inverse" />
                              </div>
                            )}
                            {!isOptimistic && (
                              <button
                                type="button"
                                onClick={handleOpenImage}
                                className="absolute inset-0 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-black"
                                aria-label={formatMessage({ id: "message.messageItem.previewFile" }, { filename: att.filename })}
                              />
                            )}
                            {!isOptimistic && (
                              <button
                                type="button"
                                onClick={handleDownloadImage}
                                data-message-affordance="image-download"
                                className="absolute bottom-1 right-1 z-10 hidden size-6 items-center justify-center border border-black bg-white/80 text-black/50 group-hover/img:flex hover:text-black focus:flex focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black"
                                aria-label={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: att.filename })}
                              >
                                <Download size={12} />
                              </button>
                            )}

                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              )}
              {videoAttachments.length > 0 && (
                <div className="space-y-2">
                  {videoAttachments.map((att) => {
                    const isOptimistic = isOptimisticAttachment(att);
                    const handleDownload = async () => {
                      await handleDownloadAttachment(att);
                    };
                    return (
                      <InlineVideoAttachmentCard
                        key={att.id}
                        attachment={att}
                        isOptimistic={isOptimistic}
                        onOpenPreview={() => {
                          if (!isOptimistic) void handleOpenVideoPreview(att);
                        }}
                        onDownload={handleDownload}
                      />
                    );
                  })}
                </div>
              )}
              {audioAttachments.length > 0 && (
                <div className="space-y-2">
                  {audioAttachments.map((att) => {
                    const isOptimistic = isOptimisticAttachment(att);
                    const handleDownload = async () => {
                      await handleDownloadAttachment(att);
                    };
                    return (
                      <InlineAudioAttachmentCard
                        key={att.id}
                        attachment={att}
                        isOptimistic={isOptimistic}
                        onDownload={handleDownload}
                      />
                    );
                  })}
                </div>
              )}
              {otherAttachments.length > 0 && (
                <div className="flex max-w-[22.5rem] flex-wrap items-start gap-2">
                  {otherAttachments.map((att) => {
                    const isImage = isPreviewableImageAttachment(att);
                    const isHtml = isPreviewableHtmlAttachment(att);
                    const isVideo = isPreviewableVideoAttachment(att);
                    const isDocument = isPreviewableDocumentAttachment(att);
                    const isOptimistic = isOptimisticAttachment(att);
                    const isHtmlLoading = htmlPreviewLoadingId === att.id || videoPreviewLoadingId === att.id || documentPreviewLoadingId === att.id;
                    const handleClick = () => {
                      if (isImage && !isOptimistic) {
                        const imageIndex = lightboxImages.findIndex((img) => img.id === att.id);
                        // No comment contexts: image comments descoped (cindyz 6/11).
                        useImageLightboxStore.getState().open(lightboxImages, imageIndex >= 0 ? imageIndex : 0);
                      } else if (isHtml && !isOptimistic) {
                        void handleOpenHtmlPreview(att);
                      } else if (isVideo && !isOptimistic) {
                        void handleOpenVideoPreview(att);
                      } else {
                        // Stryker disable next-line ConditionalExpression,LogicalOperator,BooleanLiteral,BlockStatement: unchanged document-preview branch is covered by document preview contracts.
                        if (isDocument && !isOptimistic) {
                          void handleOpenDocumentPreview(att);
                        }
                      }
                    };
                    const handleDownload = async () => {
                      await handleDownloadAttachment(att);
                    };
                    return (
                      <AttachmentCard
                        key={att.id}
                        attachment={att}
                        isOptimistic={isOptimistic}
                        isHtml={isHtml}
                        isImage={isImage}
                        isVideo={isVideo}
                        isAudio={false}
                        isHtmlLoading={isHtmlLoading}
                        onClick={handleClick}
                        onDownload={handleDownload}
                      />
                    );
                  })}
                </div>
              )}
	            </div>
	          );
	          });
	        })()}
        {activeTranslationEntry && shouldRenderTranslationIndicator(activeTranslationEntry) ? (
	          <div className="mt-0">
	            <TranslationIndicator
	              entry={activeTranslationEntry}
	              showOriginal={activeTranslationShowOriginal}
	              onToggleOriginal={() => setTranslationShowOriginal(message.id, !activeTranslationShowOriginal)}
	              onRetry={() => {
	                if (!translationTargetLanguage) return;
	                void retryTranslation(message, { targetLanguage: translationTargetLanguage, viewerUserId });
	              }}
	              onUpgrade={() => nav.toSettings("server")}
	            />
	          </div>
	        ) : null}
        {/* Footer metadata/actions — below translation status and the full message content block. */}
        {(
          // Stryker disable all: footer badge visibility/editability behavior is pre-existing; this PR only swaps Badge chrome to raft-ui.
          linkedTask ||
          isSaved ||
          showDmReadReceipt ||
          visibleReactions.length > 0 ||
          hasThreadFooterMetadata
          // Stryker restore all
        ) ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {linkedTask && (() => {
              const fullLabel = linkedTask.claimedByName ? `task #${linkedTask.taskNumber} @${linkedTask.claimedByName}` : `task #${linkedTask.taskNumber}`;
              const assignee = linkedTask.claimedByName ? (
                <span className="min-w-0 truncate">@{linkedTask.claimedByName}</span>
              ) : null;
              // Source of truth: STATUS_BADGE_CONFIG in taskStatusUi.ts.
              // Before this dedup, the below-content variant had its own
              // inline 4-entry config (no `closed`) and silently fell
              // through to todo styling for closed tasks — see
              // #proj-uiux:c697be7a (task #141). PR #1464 (task #145)
              // separately swapped closed from brutal-red to brutal-stone;
              // both fixes converge in STATUS_BADGE_CONFIG.
              //
              // Placement contract: task status is footer metadata, not sender
              // identity. Keep it below content alongside replies instead of
              // crowding the message header.
              // Stryker disable next-line all: editability behavior is pre-existing; this PR only swaps badge chrome.
              // The badge is a REFERENCE to the task, so it does the two things
              // a reference does: identify it and open it. It used to double as
              // an inline status dropdown, which made the same pixel mean
              // "change status" here and "open the task" everywhere else.
              // Status editing lives in the modal's Properties region; quick
              // completion stays on the message context menu. (@stdrc)
              return (
                <button
                  type="button"
                  onClick={openLinkedTask}
                  className="inline-flex min-w-0 max-w-full items-center overflow-hidden whitespace-nowrap"
                  title={fullLabel}
                  aria-label={formatMessage({ id: "task.chip.openAria" }, { taskNumber: linkedTask.taskNumber, title: linkedTask.title })}
                  data-message-affordance="open-linked-task"
                >
                  <StatusBadge
                    status={linkedTask.status}
                    data-testid="message-task-badge"
                    data-task-status={linkedTask.status}
                  >
                    <span className="shrink-0">{taskNumberSigil(linkedTask.taskNumber)}</span>
                    {assignee}
                  </StatusBadge>
                </button>
              );
            })()}
            {isSaved ? (
              <button
                type="button"
                className="inline-flex h-5 min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap border border-black bg-brutal-orange/15 px-1.5 text-[10px] font-bold leading-none text-black transition-[filter] duration-100 hover:brightness-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-black"
                data-message-affordance="saved-badge"
                title={formatMessage({ id: "message.messageItem.removeFromSaved" })}
                aria-label={formatMessage({ id: "message.messageItem.removeFromSaved" })}
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleSave();
                }}
              >
                <Bookmark size={10} fill="currentColor" className="shrink-0 text-brutal-orange" />
                <span className="shrink-0">{formatMessage({ id: "message.messageItem.saved" })}</span>
              </button>
            ) : null}
            {shouldShowThreadRepliesBadge ? (
              <ThreadRepliesBadge
                replyCount={threadReplyCount}
                unreadCount={threadUnreadCount}
                hasDraft={hasThreadDraft}
                onClick={handleOpenThreadReplies}
              />
            ) : null}
            {visibleReactions.map((reaction) => {
              const currentViewerReacted = hasCurrentUserReaction(reaction.emoji);
              const showFailureFlash = reactionFailureEmoji === reaction.emoji;
              const summaryNames = readReactionActors(reaction).map((actor) => actor.displayName);
              const summaryHiddenCount = Math.max(0, reaction.count - summaryNames.length);
              const reactorSummary = summaryNames.length > 0
                ? `${summaryNames.join(", ")}${summaryHiddenCount > 0 ? ` ${formatMessage({ id: "message.messageItem.reactionHiddenMore" }, { count: summaryHiddenCount })}` : ""}`
                : formatMessage({ id: "message.messageItem.reactionCount" }, { count: reaction.count });
              const reactionContent = (
                <>
                  <span className="inline-flex items-center leading-none">
                    <ReactionGlyph emoji={reaction.emoji} size={15} className="block" />
                  </span>
                  <ReactionCount count={reaction.count} />
                </>
              );
              const reactionClassName = `inline-flex h-5 min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded px-1.5 text-[12px] font-bold leading-none text-black ${
                showFailureFlash
                  ? "bg-brutal-orange/30"
                  : currentViewerReacted
                    ? "bg-brutal-pink/20"
                    : "bg-black/[0.03]"
              }`;
              return (
                <span key={reaction.emoji} className="inline-flex">
                  {canReact ? (
                    <button
                      type="button"
                      onClick={() => {
                        hideReactionPopover();
                        void handleToggleReaction(reaction.emoji);
                      }}
                      onMouseEnter={(event) => showReactionPopover(reaction, event.currentTarget)}
                      onMouseLeave={hideReactionPopover}
                      onFocus={(event) => showReactionPopover(reaction, event.currentTarget)}
                      onBlur={hideReactionPopover}
                      className={`${reactionClassName} transition-colors ${
                        currentViewerReacted ? "hover:bg-brutal-pink/30" : "hover:bg-black/[0.08]"
                      }`}
                      aria-label={formatMessage({ id: "message.messageItem.reactionAria" }, { emoji: reaction.emoji, reactors: reactorSummary })}
                    >
                      {reactionContent}
                    </button>
                  ) : (
                    <span
                      className={reactionClassName}
                      aria-label={formatMessage({ id: "message.messageItem.reactionAria" }, { emoji: reaction.emoji, reactors: reactorSummary })}
                    >
                      {reactionContent}
                    </span>
                  )}
                </span>
              );
            })}
              {!isSystem && canReact && visibleReactions.length > 0 ? (
                <span className="inline-flex md:hidden">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      hideReactionPopover();
                      setCtxMenu(null);
                      if (reactionPicker) {
                        closeReactionPicker();
                      } else {
                        openReactionPicker(event.currentTarget);
                      }
                    }}
                    className="inline-flex h-5 min-w-0 items-center justify-center rounded bg-black/[0.03] px-1.5 text-black transition-colors hover:bg-black/[0.08] active:bg-black/[0.08]"
                    title={formatMessage({ id: "message.messageItem.addReaction" })}
                    aria-label={formatMessage({ id: "message.messageItem.addReaction" })}
                    data-message-affordance="mobile-reaction-add"
                  >
                    <Plus size={13} strokeWidth={2.5} />
                  </button>
                </span>
              ) : null}
            {showDmReadReceipt ? (
              // artin: FAR RIGHT of the message row. `ml-auto` right-aligns it,
              // but alignment is not order: rendered before the reactions/thread
              // chips it still sits to their LEFT once the row has any other
              // content. It must be the last child, so it is emitted here after
              // every other footer affordance.
              <span
                className="ml-auto inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap text-[10px] font-bold leading-none text-black/45"
                data-message-affordance="read-receipt"
                title={formatMessage({ id: "message.messageItem.read" })}
                aria-label={formatMessage({ id: "message.messageItem.read" })}
              >
                <CheckCircle size={10} className="shrink-0" />
                <span>{formatMessage({ id: "message.messageItem.read" })}</span>
              </span>
            ) : null}
          </div>
        ) : null}
        {/* Inside the Thread panel the replies ARE the surface — previewing them
            on the parent is redundant (artin, #proj-message:a18243dc). */}
        {replyScope && !hideThreadActions ? (
          <InlineThreadReplies
            replies={replyScope.replies}
            replyCount={replyScope.replyCount}
            unreadCount={threadUnreadCount}
            hasDraft={hasThreadDraft}
            onOpenThread={handleOpenThreadReplies}
            channelParticipantAgentsById={channelParticipantAgentsById}
            channelParticipantMembersById={channelParticipantMembersById}
          />
        ) : null}
        {/* Parked, not dead. A message can hold exactly one task today
            (`uniqueIndex` on `tasks.message_id`) and its title is not editable
            yet, so a list of one row earns nothing over the status badge —
            @stdrc msg=9b8763dd / aa662414. Kept wired and ready because the
            endgame is many tasks per message, at which point this is the shape
            and the badge is not. Do not delete as cruft. */}
        {/* <TaskChipList tasks={messageTasks} onOpenTask={openTaskFromChip} /> */}
      </div>
    </div>
    {reactionPicker && typeof document !== "undefined" && createPortal(
      <div
        className="fixed z-[80] flex items-center gap-0.5 border-2 border-black bg-white px-1.5 py-1 shadow-soft-popover"
        data-message-affordance="reaction-picker"
        style={{
          left: reactionPicker.x,
          top: reactionPicker.y,
        }}
        onMouseEnter={handleReactionPickerBoundaryEnter}
        onMouseLeave={handleReactionPickerBoundaryLeave}
        onClick={(e) => e.stopPropagation()}
      >
        {QUICK_REACTION_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            onClick={() => handleQuickReactionClick(emoji)}
            className="flex size-7 items-center justify-center rounded bg-transparent transition-colors hover:bg-brutal-pink/20"
            title={formatMessage({ id: "message.messageItem.reactWith" }, { emoji })}
          >
            <ReactionGlyph emoji={emoji} size={QUICK_REACTION_GLYPH_SIZE} className="block" />
          </button>
        ))}
      </div>,
      document.body,
    )}
    {reactionPopover && typeof document !== "undefined" && createPortal(
        <div
        role="tooltip"
        data-message-affordance="reaction-reactors-popover"
        className="pointer-events-none fixed z-[80] max-w-[280px] border-2 border-black bg-white px-2 py-1.5 text-xs font-bold text-black"
        style={{
          left: reactionPopover.x,
          top: reactionPopover.y,
        }}
      >
        {reactionPopover.visibleNames.length > 0 ? (
          <div className="flex max-w-60 flex-wrap items-center gap-y-0.5">
            {reactionPopover.visibleNames.map((name, index) => (
              <span key={`${reactionPopover.emoji}-${index}-${name}`} className="inline-flex min-w-0 items-baseline leading-5">
                <span className="max-w-28 truncate">{name}</span>
                {index < reactionPopover.visibleNames.length - 1 || reactionPopover.hiddenCount > 0 ? (
                  <span className="shrink-0 text-black/45">, </span>
                ) : null}
              </span>
            ))}
            {reactionPopover.hiddenCount > 0 && (
              <span className="leading-5 text-black/50">{formatMessage({ id: "message.messageItem.reactionHiddenMore" }, { count: reactionPopover.hiddenCount })}</span>
            )}
          </div>
        ) : (
          <span className="block leading-5">{reactionPopover.emoji}</span>
        )}
      </div>,
      document.body,
    )}
    {ctxMenu && createPortal(
      <>
        <DismissBackdrop onDismiss={handleCloseCtx} trapContextMenu />
        {ctxMenuClickShielded && (
          // Above the dismiss backdrop (50) but below the menu (z-[60]) so
          // it absorbs the iOS phantom outside-tap without blocking menu rows.
          <DismissBackdrop onDismiss={handleCloseCtx} zIndex={55} stopPropagation />
        )}
        <div
          ref={ctxMenuRef}
          className="fixed z-[60] card-brutal overflow-hidden select-none"
          role="menu"
          aria-label={formatMessage({ id: "message.messageItem.messageContextMenu" })}
          style={{ left: ctxMenu.x, top: ctxMenu.y, maxHeight: "calc(100dvh - 16px)", overflowY: "auto" }}
        >
          <>
          {/* Reaction quick row — shown on both desktop right-click ("pointer")
              and mobile long-press ("touch") per stdrc 2026-05-14
              #proj-mobile:a8293493 msg=2cebeb18: "无论是移动端还是桌面端，其右
              键菜单和长按菜单都应该补上这个 reaction，也就是说移动端和桌面端
              的菜单保持一致". Previously gated on `ctxMenu.source === "touch"`
              (mobile-only). Visual separator below is a standalone
              `<ContextMenuDivider />` matching the other in-menu section
              dividers (CLAUDE.md "Menu dividers" token) — the row itself
              no longer carries `border-b
              border-black/20` because that produced a thinner, lighter
              line than other section dividers in the same menu (stdrc
              msg=ed2eee8c "只要一样就行，说白了就分 section"). */}
          {!isSystem && canReact && (
            <>
              <div
                className="flex h-9 items-center gap-1 bg-white px-2"
                data-message-affordance="reaction-quick-row"
              >
                {QUICK_REACTION_EMOJIS.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleQuickReactionClick(emoji);
                    }}
                    className="flex size-7 items-center justify-center rounded bg-transparent transition-colors hover:bg-brutal-pink/20 active:bg-brutal-pink/20"
                    title={formatMessage({ id: "message.messageItem.reactWith" }, { emoji })}
                    aria-label={formatMessage({ id: "message.messageItem.reactWith" }, { emoji })}
                  >
                    <ReactionGlyph emoji={emoji} size={QUICK_REACTION_GLYPH_SIZE} className="block" />
                  </button>
                ))}
              </div>
              <ContextMenuDivider />
            </>
          )}
          <MenuItem
            icon={<Link size={14} />}
            onClick={handleCopyLink}
          >
            {formatMessage({ id: "message.messageItem.copyLink" })}
          </MenuItem>
          <MenuItem
            icon={<Copy size={14} />}
            onClick={() => { navigator.clipboard.writeText(message.content).then(() => setCtxMenu(null)); }}
          >
            {formatMessage({ id: "message.messageItem.copyMarkdown" })}
          </MenuItem>
          {showManualTranslationAction ? (
            <MenuItem
              icon={<Languages size={14} />}
              onClick={handleManualTranslate}
              disabled={manualTranslationPending}
              data-testid={`message-translate-menu-item-${message.id}`}
            >
              {formatMessage({
                id: manualTranslationPending
                  ? "message.messageItem.translating"
                  : "message.messageItem.translate",
              })}
            </MenuItem>
          ) : null}
          {(() => {
            // "Select Message" — last item in the outbound-content-propagation
            // section (Copy link → Copy markdown → Select Message), in
            // ascending "weight" of what gets propagated: pointer →
            // content → multi-message render+send. Was previously
            // a standalone section above Copy link; relocated to this
            // section per stdrc 2026-05-14 #proj-mobile:a8293493
            // msg=ad3320ce ("share messages 可能应该放到 copy markdown
            // 下面，并且跟 copy markdown 在同一个 section 里面").
            //
            // Three entry points for "Select Message":
            //  1. Channel timeline (top-level row, not in a panel) → channel
            //     mode with just this message pre-selected. Auto-including
            //     thread replies here would lie about what the PNG can
            //     render (replies aren't in the DOM until the thread panel
            //     is open), so we keep the contract honest: what you see is
            //     what you share. Thread auto-include is reserved for thread
            //     mode where ThreadPanel guarantees the replies are mounted.
            //  2. Thread reply row (parentMessageId is set) → thread mode,
            //     anchored at the reply's parent, with only the clicked row
            //     selected. ThreadPanel exposes a Select all button for the
            //     full parent + replies export.
            //  3. Thread parent rendered inside ThreadPanel
            //     (`hideThreadActions` plus a non-empty `threadId` on the
            //     parent) → thread mode, anchored at this message, with only
            //     the parent selected.
            const onSelectShare = () => {
              setCtxMenu(null);
              if (parentMessageId) {
                // Thread reply row → thread mode, clicked reply only.
                const threadCh = message.channelId; // replies live in the thread channel
                enterThreadSelection(
                  threadCh,
                  parentMessageId,
                  parentChannelId || message.channelId,
                  [message.id],
                );
                return;
              }
              if (hideThreadActions && message.threadId) {
                enterThreadSelection(message.threadId, message.id, message.channelId, [message.id]);
                return;
              }
              // Channel timeline: just this message. To share a thread the
              // user opens the panel and triggers select from there.
              enterSelection(message.channelId, [message.id]);
            };
            // System messages can't be selected. Outside of those, every row
            // path resolves to one of the three modes above.
            if (isSystem) return null;
            return (
              <MenuItem
                icon={<CheckCircle size={14} />}
                onClick={onSelectShare}
              >
                {formatMessage({ id: "message.messageItem.selectMessage" })}
              </MenuItem>
            );
          })()}
          <ContextMenuDivider />
          {!hideThreadActions && (
            <MenuItem
              icon={<MessageSquare size={14} />}
              onClick={handleOpenThreadFromContextMenu}
            >
              {formatMessage({ id: "message.messageItem.openThread" })}
            </MenuItem>
          )}
          {!hideThreadActions && (
            <MenuItem
              icon={<ExternalLink size={14} />}
              onClick={handleOpenThreadInNewTab}
            >
              {formatMessage({ id: "message.messageItem.openThreadInNewWindow" })}
            </MenuItem>
          )}
          <MenuItem
            icon={isSaved ? <BookmarkMinus size={14} /> : <Bookmark size={14} />}
            onClick={() => { handleToggleSave(); setCtxMenu(null); }}
          >
            {isSaved ? formatMessage({ id: "message.messageItem.removeFromSaved" }) : formatMessage({ id: "message.messageItem.saveMessage" })}
          </MenuItem>
          {canShowThreadFollowAction && hasThreadConversation && (
            <MenuItem
              icon={followedThread ? <MessageCircleOff size={14} /> : <MessageCirclePlus size={14} />}
              onClick={followedThread ? handleUnfollowThread : handleFollowThread}
            >
              {followedThread ? formatMessage({ id: "message.messageItem.unfollowThread" }) : formatMessage({ id: "message.messageItem.followThread" })}
            </MenuItem>
          )}
          {canShowThreadFollowAction && hasThreadConversation && (
            <ContextMenuDivider />
          )}
          {!parentMessageId && supportsMessageTasks && (
            !isExternal ? (linkedTask ? (
              <>
                <MenuItem
                  icon={linkedTask.status === "done" ? <RotateCcw size={14} /> : <CheckCircle size={14} />}
                  onClick={handleToggleTaskDone}
                >
                  {linkedTask.status === "done" ? formatMessage({ id: "message.messageItem.reopenTask" }) : formatMessage({ id: "message.messageItem.markAsDone" })}
                </MenuItem>
                <MenuItem
                  icon={<ExternalLink size={14} />}
                  onClick={handleOpenLinkedTaskInNewTab}
                >
                  {formatMessage({ id: "message.messageItem.openTaskInNewTab" })}
                </MenuItem>
              </>
            ) : (
              <MenuItem
                icon={<ClipboardCheck size={14} />}
                onClick={handleConvertToTask}
              >
                {formatMessage({ id: "message.messageItem.convertToTask" })}
              </MenuItem>
            )) : null
          )}
          </>
        </div>
      </>,
      document.body
    )}
    {senderCtxMenu && createPortal(
      <>
        <DismissBackdrop onDismiss={closeSenderCtxMenu} trapContextMenu />
        <div
          className="fixed z-[60] card-brutal overflow-hidden select-none"
          role="menu"
          aria-label={formatMessage({ id: "message.messageItem.senderContextMenu" })}
          style={{ left: senderCtxMenu.x, top: senderCtxMenu.y }}
        >
          <MenuItem
            icon={<Copy size={14} />}
            onClick={() => {
              void navigator.clipboard.writeText(senderDisplayName);
              setSenderCtxMenu(null);
            }}
          >
            {formatMessage({ id: "message.messageItem.copyName" })}
          </MenuItem>
          {senderHandleText ? (
            <MenuItem
              icon={<Copy size={14} />}
              onClick={() => {
                void navigator.clipboard.writeText(senderHandleText);
                setSenderCtxMenu(null);
              }}
            >
              {formatMessage({ id: "message.messageItem.copyHandle" })}
            </MenuItem>
          ) : null}
        </div>
      </>,
      document.body
    )}
    </>
  );
});

export default MessageItem;
