import { ArtifactMessageRefs, ArtifactSavedAttachments, useArtifactAttachmentMenu } from "../../apps/artifacts";
import { channelAnnouncementNoticeLine } from "../channel/channelAnnouncementNotice";
import { trackMessageAction, messageMenuSurface } from "../../analytics/entries";
import { MessageLinkCardsProvider, useMessageLinkCards } from "./useMessageLinkCards";
import {
  InlineAudioKeepAliveContext,
  keepInlineAudioPlaying,
  resumeKeptInlineAudio,
} from "../../utils/inlineAudioKeepAlive";
import Tooltip from "../ui/Tooltip";
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, MouseEvent, PointerEvent as ReactPointerEvent, ReactNode, TouchEvent } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Copy, Download, Play, Pause, Volume2, SquareCheckBig, Link, Bookmark, BookmarkMinus, Languages, AlertTriangle, Plus, Eye, Music, Paperclip, ListChecks, SquareDashedText, RefreshCw, MessageSquareDot } from "lucide-react";
import {
  Badge,
  Button,
  Card,
  ContextMenuPopup,
  MessageAttachmentDiffAddition,
  MessageAttachmentDiffDeletion,
  MessageAttachmentDiffSummary,
  MessageAttachmentGroup,
  MessageImageGallery,
  MessageItem,
  MessageItemAvatarSlot,
  MessageItemBody,
  MessageItemContent,
  MessageItemContinuationTime,
  MessageItemFooter,
  MessageItemGutter,
  MessageItemHeader,
  MessageItemInlineStatus,
  MessageItemMeta,
  MessageItemSender,
  MessageItemSenderButton,
  MessageItemSenderGroup,
  MessageItemTime,
  MessageItemSavedIndicator,
  MessageItemTranslationAction,
  MessageItemTranslationFailedStatus,
  MessageItemTranslationOriginal,
  MessageItemTranslationOriginalLabel,
  MessageItemTranslationRetryAction,
  MessageItemTranslationStatus,
  MessageMultiSelectCheckbox,
  MessageReactionAddButton,
  MessageReactionChip,
  MessageReactionCount,
  MessageReactionGlyph,
  MessageReactionQuickRow,
  MessageReactionTooltipContent,
  MessageReactionTooltipMeta,
  MessageReactionTooltipName,
  MessageReactionTooltipNameText,
  MessageReactionTooltipNames,
  MessageReactionTooltipSeparator,
  MessageVideoPreview,
  MessageVideoPreviewAction,
  MessageVideoPreviewFailureAction,
  MessageVideoPreviewFailureContent,
  MessageVideoPreviewFailureIcon,
  MessageVideoPreviewFailureTitle,
  MessageVideoPreviewFallback,
  MessageVideoPreviewMedia,
  PopoverPopup,
  PreviewCard,
  PreviewCardContent,
  PreviewCardTrigger,
  Skeleton,
  Spinner,
  SystemMessage,
  SystemMessageContent,
  SystemMessageTime,
  TaskChip,
  TaskStatusIcon,
  Tooltip as RaftTooltip,
  TooltipTrigger,
  toast,
  buildMessageImageGalleryRows,
  MessageImageGalleryRow,
  ScrollArea,
} from "@botiverse/raft-ui";
import {
  ThreadIcon,
  FollowThreadIcon,
  UnfollowThreadIcon,
  ReopenTaskIcon,
} from "@botiverse/ricons";
import {
  MessageItemDelegatedAvatar,
  MessageItemDelegatedBy,
  MessageItemDelegatedByName,
} from "@botiverse/raft-ui/wip";
import { delegatedByOf, isRetractedMessage } from "./delegatedMessage";
import type { DelegatedBy } from "./delegatedMessage";
import { DelegatedReceiptLines } from "../../assistant/DelegatedReceiptLines";
import { delegatedReceiptsOf, joinedNotForwardedOf } from "../../assistant/delegatedReceipt";
import { WeChatConnectedNotice } from "../../assistant/WeChatConnectedNotice";
import { isWeChatConnectedNotice } from "../../assistant/wechatNotice";
import { TaskHandoffCard } from "../task/TaskHandoffCard";
import { readTaskHandoffNotice } from "../task/taskHandoffNotice";
import type { TaskHandoffReturn } from "../task/taskHandoffNotice";

// Shared across renders — never created inside a component (task #709).
import { useStore } from "zustand";
import {
  messageReactionActorsDiscussion,
  messageRef as canonicalMessageRef,
} from "@botiverse/raft-shared";
import type {
  ActionCardMetadata,
  AttachmentPreviewSummaryData,
  ExternalActorKind,
  ExternalMessageAuthorProjection,
  ReactionActorRef,
  SyncScopeKey,
  parseRaftPermalink,
} from "@botiverse/raft-shared";
import { useMessageStore } from "../../store/messageStore";
import type { Message, MessageAttachment, MessageMention } from "../../store/messageStore";
import { readHistoryLimitedError } from "../../store/hiddenHistoryStore";
import type { ContextCanonicalTarget } from "../../store/hiddenHistoryStore";
import { loadThreadRefContext } from "../../utils/threadRefContext";
import { ActionCard } from "../actions/ActionCard";
import { toRuiTaskStatus } from "../task/taskStatusUi";
import { useAuthStore } from "../../store/authStore";
import type { Channel } from "../../store/channelStore";
import { useAgentDisplayState, useAgentStore } from "../../store/agentStore";
import type { Agent } from "../../store/agentStore";
import type { ServerMember } from "../../store/serverStore";
import type { ChannelExternalMember, ChannelHuman } from "../../hooks/useChannelMembers";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";

import { useTaskStore } from "../../store/taskStore";
import type { Task } from "../../store/taskStore";
// Parked with its render site below — see the note there.
import TaskChipList from "../task/TaskChipList";
import { CreateTaskDialog } from "../task/DeferredCreateTaskDialog";
import { openTaskConversationDialog, useOpenTask } from "../task/useOpenTask";
import { isThreadFollowed, useThreadStore } from "../../store/threadStore";
import { useEnclosingThreadMarkUnread } from "./threadUnreadHold";
import { useMessageMenuMarkUnread } from "./messageMenuMarkUnread";
import { useEnclosingThreadFollowCommand } from "./threadFollowCommand";
import type { OpenThreadRequest, ThreadSummary } from "../../store/threadStore";
import type { ThreadRepliesScope } from "../../store/threadRepliesReadModel";
import { hasInlineThreadReplySurface, InlineThreadReplies } from "./InlineThreadReplies";
import { AgentReplyingHint } from "./AgentTypingLine";
import { useSavedStore } from "../../store/savedStore";
import { useSelectionStore } from "../../store/selectionStore";
import { useAppNavigate, buildMessagePermalink } from "../../hooks/useAppNavigate";
import { useProfileStore } from "../../store/profileStore";
import { setCachedAgentProfile } from "../profile/profileFallbackCache";
import { useServerStore } from "../../store/serverStore";
import { useRaftPermalinkHostnames } from "../../store/raftAppHosts";
import { useActorFallback } from "../../store/localTables/useActorFallback";
import { useTranslationStore } from "../../store/translationStore";
import type { PreferredTranslationDisplay, TranslationEntry } from "../../store/translationStore";
import { useLegacyTaskPanelStore } from "../../store/legacyTaskPanelStore";
import {
  getMessageAvatarSizeClass,
  getMessageBodyFontSizeClass,
  getMessageBodyFontSizeStyle,
  getMessageMetaSizeClass,
  getMessageNameSizeClass,
  getMessageTimeSizeClass,
  useAppearanceStore,
} from "../../store/appearanceStore";
import api from "../../api/client";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import type { LightboxCommentContext } from "../../store/imageLightboxStore";
import QuotedMessagePermalinkPreview from "./QuotedMessagePermalinkPreview";
import {
  extractFirstQuotedMessagePermalink,
} from "./quotedMessagePermalink";
import { GalleryImageItem } from "./GalleryImageItem";
import { WRAPPED_CHIP_PRESS_CLASS } from "./clickableAffordance";
import ProfilePreviewCardContent from "./DeferredProfilePreviewCardContent";
import ExternalIdentityPreviewCard from "./ExternalIdentityPreviewCard";
import { externalSenderPresentation, formatExternalProviderLabel } from "./externalIdentityPresentation";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import { TimelineRevealTime } from "./TimelineRevealTime";
import { useRefreshingMediaUrl } from "../../hooks/useRefreshingMediaUrl";
import { agentModelLabel, useShowAgentModelName } from "../../utils/agentModelName";
import { useCatalogModelLabel } from "../../store/modelLabelCatalogStore";
import AppBadge from "../agent/AppBadge";
import StatusDot from "../ui/StatusDot";
import type { StatusDotProps } from "../ui/StatusDot";
import { formatAgentDisplayStateText } from "../../utils/activity";
import AvatarSlot from "../ui/AvatarSlot";
import ContextMenuDivider from "../ui/ContextMenuDivider";
import MenuItem from "../ui/MenuItem";
import { ViewContextMenuGroup } from "../agentContextView/ViewContextMenuGroup";
import { openAgentContextViewFor } from "../agentContextView/agentContextViewState";
import DismissBackdrop from "../ui/DismissBackdrop";
import { DeferredEmojiPickerPanel as EmojiPickerPanel } from "../ui/PickerPanelDeferred";
import { isAudioPreviewAttachment, isDiffPatchAttachment, isDocumentPreviewAttachment, isVideoPreviewAttachment } from "./attachmentPreview";
import type { DiffAttachmentPreview } from "./attachmentPreview";
import { projectReadReceipt } from "../../store/readReceiptDomain";
import { useReadReceiptStore } from "../../store/readReceiptStore";
import { AgentReadFaces, AgentReadStatusLine, AgentReadSystemRow } from "./AgentReadFaces";
import { DmReadStatusLine } from "./MessageReadStatusLine";
import { selectIsDmSurface } from "../../store/channelDmSurface";
import { fetchAttachmentPreviewCardSummary } from "./attachmentPreviewSummaryCache";
import { fetchInlineAttachmentUrls } from "./inlineAttachmentUrlCache";
import { openDocumentPreview } from "./openDocumentPreview";
import { openMediaPreview } from "./openMediaPreview";
import { useMediaPreviewStore } from "../../store/mediaPreviewStore";
import { useDocumentPreviewStore } from "../../store/documentPreviewStore";
import { DOCUMENT_PREVIEW_LABEL_ID, INLINE_AUDIO_PREVIEW_CARD_CLASS } from "./attachmentPreviewLabels";
import { parseTimestampLabel, setPendingVideoSeek } from "./attachmentCommentAnchors";
import {
  TASK_V2_CONVERSATIONS_FLAG_KEY,
  useServerFeatureFlag,
} from "../../store/serverFeatureFlags";
import {
  isLegacyMessageReaction,
  messageReactionParentScopeKey,
} from "../../store/normalizedMessageReactions";
import {
  reactionReadModelStore,
  selectReactionActors,
} from "../../store/reactionReadModels";
import { setMessageReaction } from "../../store/reactionCommandFacade";
import { AttachmentCommentRefChip } from "./AttachmentCommentRefChip";
import { shouldShowGroupedMessageHeader } from "./messageGrouping";
import type { MessageGroupState } from "./messageGrouping";
import { MessageHoverToolbar } from "./MessageHoverToolbar";
import { recordReactionUsage } from "./reactionFavorite";
import { useToolbarQuickReaction } from "./useToolbarQuickReaction";
import { MessageForwardContext } from "./messageForwardContext";
import { MessageSelectIntentContext } from "./messageSelectIntent";
import { ForwardIcon } from "./messageForwardIcon";
import { MessageSelectTextDrawer } from "./MessageSelectTextDrawer";
import { getForwardableMessages } from "./forwardSelectionUtils";
import { AttachmentChip } from "./AttachmentChip";
import { AttachmentMetaText } from "./AttachmentMetaText";
import ReadOnlyMessageAttachments from "./ReadOnlyMessageAttachments";
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
import { MessageCardBody } from "./MessageCardBody";
import { readMessageCard } from "./messageCardRead";
import { formatReminderReceiptContentTitle, formatReminderReceiptTime, formatReminderReceiptTooltip, splitReminderReceiptFireAtTokens } from "../../utils/reminderReceiptTime";
import { resolveMessageSenderMember } from "../../utils/messageSenderMember";
import { humanAvatarSource as avatarSourceOf, isRaftUploadedHumanAvatarUrl } from "../../utils/humanAvatar";
import {
  buildThreadRefHandoffPath,
  captureThreadRouteAuthorityGuard,
  findThreadRefParentChannel,
  resolveThreadTargetByShortId,
  threadRefMissingParentNotice,
} from "../../utils/threadRefNavigation";
import type { ThreadRefIntent, ThreadRefMissingParentNotice, ThreadRouteTarget } from "../../utils/threadRefNavigation";
import { useSearchHitMarkStore } from "../../store/searchHitMarkStore";
import { QUICK_REACTION_EMOJIS } from "./reactionConstants";
import ReactionGlyph from "./ReactionGlyph";
import { QuickReactionButtons } from "./QuickReactionButtons";
import { useFloatingOverlayPosition } from "../ui/useFloatingOverlayPosition";
import { placeTouchMessageContextMenu } from "./messageContextMenuPosition";
import { nextMessageMenuItem } from "./messageMenuKeyboard";
import { isForwardedBundleMetadata } from "./ForwardedBundleCard";
import type { ForwardedBundleAttachmentSnapshot, ForwardedBundleItem } from "./ForwardedBundleCard";
import ForwardedBundleRouteCard from "./ForwardedBundleRouteCard";
import { openConversationAgentActivity, openConversationAgentProfile } from "../../utils/profilePanelUrl";
import { isViewerServerGuest, originServerNames } from "../../utils/memberOrigin";
import type { MemberOrigin } from "../../utils/memberOrigin";
import { AvatarOriginCorner } from "../member/MemberLabelParts";
import { useSenderOrigin } from "./useSenderOrigin";
import { taskRefKey } from "../../utils/refTarget";
import { openTaskByChannelNumber } from "../../utils/openTaskRef";
import { opensAsTaskConversation } from "../../utils/taskConversation";
import { dispatchSenderMentionInsert } from "./senderMentionInsert";
import { dismissLayerProps } from "../ui/dismissLayer";
import { consumeDismissingTouch, useMessageTouchTaps } from "./useMessageTouchTaps";
import type { MessageTapPoint } from "./useMessageTouchTaps";
import { useShortcutLayer } from "../../features/shortcuts/useShortcutLayer";
import { useDetailSlotThreadOpener } from "../layout/detailSlotThread";
import { MESSAGE_AVATAR_OFFSET } from "./composerHost";
import { MessageMarkdownBody } from "./MessageMarkdownBody";
import { useOpenRaftPermalink } from "./useOpenRaftPermalink";
import { taskNumberSigil } from "./messageMarkdownRefs";
import type { MentionEntry } from "./messageMarkdownRefs";
import { LinkCardBoundary } from "./LinkCardBoundary";

export type { MentionEntry };

// raft-ui's task status ids are kebab-case; slock's are snake_case.

// A message followed by a reply surface or badge ends flush: the body and its
// last Markdown block drop their bottom margin (a code block keeps 1px for its
// edge), so the follower sits at the rhythm the ending matrix defines. Every
// rule ends in a tag or attribute of the block itself, never a bare
// `:last-child`: WebKit tests an unanchored `> :last-child` against every
// element and then restyles whole subtrees whenever any last child changes
// (no-unanchored-structural guard).
const FOLLOWED_BODY_ENDING = [
  "group-data-[followed-by]/message:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>p:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>ul:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>ol:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>blockquote:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>h1:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>h2:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>h3:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>h4:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>h5:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>h6:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>img:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>[data-slot=separator]:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>[data-md-table]:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>[data-mermaid-status]:last-child]:mb-0",
  "group-data-[followed-by]/message:[&>:last-child>[data-code-block]:last-child]:mb-px",
  "group-data-[followed-by]/message:[&>:last-child>:last-child_li:last-child]:mb-0",
].join(" ");

const REACTION_PICKER_EVENT = "raft:message-reaction-picker-open";
// The quick bar's size, derived from what it is built from: raft-ui's
// MessageReactionQuickButton is size-9 (36px; the 34px control height with a
// mouse, so 36 is the upper bound used here), and the popup below lays the
// buttons out gap-0.5 (2px) inside px-1.5 py-1 (6px / 4px). The bar is also
// measured once it renders and pulled back inside the viewport, so a change to
// those metrics can't push the last emoji off a phone screen.
const QUICK_REACTION_BUTTON_SIZE = 36;
const REACTION_PICKER_GAP = 2;
const REACTION_PICKER_PADDING_X = 4;
const REACTION_PICKER_PADDING_Y = 4;
// The seven reactions and the button that opens every other emoji.
const QUICK_REACTION_BUTTON_COUNT = QUICK_REACTION_EMOJIS.length + 1;
export const REACTION_PICKER_WIDTH = QUICK_REACTION_BUTTON_COUNT * QUICK_REACTION_BUTTON_SIZE
  + (QUICK_REACTION_BUTTON_COUNT - 1) * REACTION_PICKER_GAP
  + 2 * REACTION_PICKER_PADDING_X;
const REACTION_PICKER_HEIGHT = QUICK_REACTION_BUTTON_SIZE + 2 * REACTION_PICKER_PADDING_Y;
export const REACTION_PICKER_VIEWPORT_MARGIN = 8;
// A double tap opens the bar at the finger: it keeps this far from the tap
// point, above it (below when there is no room above), so the finger never
// covers it and the click the browser derives from the second tap can't land
// on one of its reactions.
const REACTION_PICKER_TAP_CLEARANCE = 24;
// Defence in depth for that click: the bar's reactions ignore activation this
// long after a double tap opened it, and a press outside it that is no touch
// (the mouse events the browser derives from the taps) doesn't close it.
const REACTION_PICKER_TAP_SHIELD_MS = 400;
// The full emoji picker that Add Reaction opens from the message menu: the
// picker panel's 340px, and its 360px list under a 44px search row.
const REACTION_EMOJI_PICKER_WIDTH = 340;
const REACTION_EMOJI_PICKER_HEIGHT = 420;
const SENDER_AVATAR_LONG_PRESS_MS = 500;
const SENDER_AVATAR_LONG_PRESS_MOVE_TOLERANCE_PX = 10;


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

// A failed toggle flashes the orange-soft problem wash over either fill.
const REACTION_FAILURE_FLASH_CLASS = "bg-warning-soft data-pressed:bg-warning-soft";
// MessageReactionChip's metrics, for the inert chip of a read-only viewer.
const READ_ONLY_REACTION_CHIP_CLASS = "inline-flex h-6 min-w-0 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded-chip pl-1.5 pr-2 text-callout leading-none text-foreground";

/** The reactors of one reaction in raft-ui's reaction tooltip parts. */
function ReactionReactorsTooltipBody({
  emoji,
  visibleNames,
  hiddenCount,
}: {
  emoji: string;
  visibleNames: string[];
  hiddenCount: number;
}) {
  const { formatMessage } = useIntl();
  if (visibleNames.length === 0) return <span className="block leading-5">{emoji}</span>;
  return (
    <MessageReactionTooltipNames>
      {visibleNames.map((name, index) => (
        <MessageReactionTooltipName key={`${emoji}-${index}-${name}`}>
          <MessageReactionTooltipNameText>{name}</MessageReactionTooltipNameText>
          {index < visibleNames.length - 1 || hiddenCount > 0 ? (
            <MessageReactionTooltipSeparator className="pe-[0.3em]">,</MessageReactionTooltipSeparator>
          ) : null}
        </MessageReactionTooltipName>
      ))}
      {hiddenCount > 0 && (
        <MessageReactionTooltipMeta>{formatMessage({ id: "message.messageItem.reactionHiddenMore" }, { count: hiddenCount })}</MessageReactionTooltipMeta>
      )}
    </MessageReactionTooltipNames>
  );
}

// External-origin text has no Raft mention authority of its own: free text such
// as `@owner` stays plain in the Human UI. Only mention facts the server minted
// for the message (Slack usergroup, linked identity, typed member name) are
// highlighted, through the structured map. Keep this shared empty map
// referentially stable so MessageMarkdownBody remains memo-friendly.
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
      displayName: mention.displayName?.trim() || name,
      type: mention.type,
      id: mention.id,
    });
  }
  return map;
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

// The card renders from the summary read only: kind plus the CSV stats line.
interface DocumentAttachmentPreviewState {
  preview: Exclude<AttachmentPreviewSummaryData, { kind: "diff" }>;
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

function DiffPatchStatsLine({ preview }: { preview: DiffAttachmentPreview | null }) {
  const { formatMessage } = useIntl();
  if (!preview) {
    return <span className="text-foreground-hint">{formatMessage({ id: "message.messageItem.diffPreview" })}</span>;
  }

  const { files, hunks, additions, deletions } = preview.stats;

  return (
    <MessageAttachmentDiffSummary className="inline-flex min-w-0 items-center">
      <span className="text-foreground-hint">{formatMessage({ id: "message.messageItem.diffStats" }, { fileCount: files, hunkCount: hunks })}</span>
      <MessageAttachmentDiffAddition>+{additions}</MessageAttachmentDiffAddition>
      <MessageAttachmentDiffDeletion>-{deletions}</MessageAttachmentDiffDeletion>
    </MessageAttachmentDiffSummary>
  );
}

function DocumentPreviewSummaryLine({ preview }: { preview: DocumentAttachmentPreviewState | null }) {
  const { formatMessage } = useIntl();
  if (!preview) {
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.documentPreview" })}</span>;
  }

  if (preview.preview.kind === "csv") {
    const id = preview.truncated
      ? "message.messageItem.documentSummaryFirst"
      : "message.messageItem.documentSummaryPreview";
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id }, { rowCount: preview.preview.rowsShown, columnCount: preview.preview.columnCount })}</span>;
  }
  if (preview.preview.kind === "markdown") {
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.markdownDocument" })}</span>;
  }
  if (preview.preview.kind === "text") {
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.plainTextDocument" })}</span>;
  }
  if (preview.preview.kind === "xlsx") {
    return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.xlsxDocument" })}</span>;
  }
  return <span className="min-w-0 truncate text-foreground-hint">{formatMessage({ id: "message.messageItem.pdfDocument" })}</span>;
}

// Locale-aware document-preview label for attachment card metadata. The modal
// header intentionally shows only the filename and actions.

/** Popover click shield — module scope so it is never recreated (task #709). */
const stopClickPropagation = (event: React.MouseEvent) => {
  event.stopPropagation();
};

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
  messageId,
  conversationId,
}: {
  attachment: NonNullable<Message["attachments"]>[number];
  isOptimistic: boolean;
  isHtml: boolean;
  isImage: boolean;
  isVideo: boolean;
  isAudio: boolean;
  isHtmlLoading: boolean;
  onClick: (attachment: NonNullable<Message["attachments"]>[number]) => void;
  onDownload: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
  /** The message and conversation the attachment is in (workspace Artifacts: Save as Artifact). */
  messageId: string;
  conversationId: string;
}) {
  const { formatMessage } = useIntl();
  const handleClick = useCallback(() => onClick(attachment), [onClick, attachment]);
  const handleDownload = useCallback(() => {
    void onDownload(attachment);
  }, [onDownload, attachment]);
  // Workspace Artifacts (S5, F14a): the ⋯ with Save as Artifact while it can
  // be saved; nothing with the flag off. The "Saved as" lines go under the group.
  const artifactContext = useMemo(() => ({ messageId, conversationId, onDownload: handleDownload }), [messageId, conversationId, handleDownload]);
  const artifactMenu = useArtifactAttachmentMenu(attachment, artifactContext);

  const audioSecondaryDownload = useMemo(() => isAudio
    ? { onClick: handleDownload, label: formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename }), affordanceName: "audio-download" }
    : undefined, [isAudio, handleDownload, formatMessage, attachment.filename]);
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
    void fetchAttachmentPreviewCardSummary(attachment.id)
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
        isOptimistic={isOptimistic}
        menu={artifactMenu}
        onClick={handleDownload}
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
        isOptimistic={isOptimistic}
        menu={artifactMenu}
        loading={isHtmlLoading}
        loadingLabel={formatMessage({ id: "message.messageItem.openingPreview" })}
        onClick={handleClick}
        affordance="preview"
        affordanceName="document-preview"
        meta={<AttachmentMetaText label={documentPreview ? formatMessage({ id: DOCUMENT_PREVIEW_LABEL_ID[documentPreview.preview.kind] }) : attachment.mimeType || formatMessage({ id: "message.messageItem.metaDocument" })} sizeBytes={attachment.sizeBytes} />}
        summary={<DocumentPreviewSummaryLine preview={documentPreview} />}
      />
    );
  }

  // Stryker disable next-line ConditionalExpression,LogicalOperator: shared card branch matrix predates audio; this PR's audio branch is covered by audioAttachmentPreview.behavior.test.tsx (removed in the 2026-11 web DOM test prune).
  const primaryIsPreview = isImage || isHtml || isVideo || isAudio;
  // Stryker disable next-line ConditionalExpression: audio/non-preview click behavior is covered by audioAttachmentPreview.behavior.test.tsx (removed in the 2026-11 web DOM test prune); legacy image/html/video branches are covered elsewhere.
  const primaryOnClick = primaryIsPreview ? handleClick : handleDownload;
  // Stryker disable next-line ConditionalExpression,StringLiteral: visual affordance labels for legacy branches are source-pinned; audio/file behavior is covered by DOM tests.
  const primaryAffordance = primaryIsPreview ? "preview" : "download";
  // Stryker disable next-line ConditionalExpression,StringLiteral: data-affordance names are source/query contracts; audio/file names are additionally covered by DOM tests.
  const primaryAffordanceName = isHtml ? "html-preview" : isImage ? "image-preview" : isVideo ? "video-preview" : isAudio ? "audio-preview" : "file-download";
  // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral: meta copy for legacy preview types is source-pinned; audio/file copy is covered by DOM tests.
  const primaryMetaLabel = isHtml ? formatMessage({ id: "message.messageItem.htmlPreview" }) : isVideo ? formatMessage({ id: "message.messageItem.videoPreview" }) : isAudio ? formatMessage({ id: "message.messageItem.audioPreview" }) : attachment.mimeType || formatMessage({ id: "message.messageItem.metaFile" });

  return (
    <AttachmentChip
      attachment={attachment}
      isOptimistic={isOptimistic}
      menu={artifactMenu}
      loading={isHtmlLoading}
      loadingLabel={formatMessage({ id: "message.messageItem.openingPreview" })}
      onClick={primaryOnClick}
      affordance={primaryAffordance}
      affordanceName={primaryAffordanceName}
      meta={<AttachmentMetaText label={primaryMetaLabel} sizeBytes={attachment.sizeBytes} />}
      secondaryDownload={audioSecondaryDownload}
    />
  );
}

function ScreenshotAttachmentSummary({ attachments }: { attachments: readonly MessageAttachment[] }) {
  return (
    <div
      className="hidden"
      data-select-screenshot-attachment-summary="true"
      aria-hidden="true"
    >
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 border border-line-hairline bg-fill-muted px-2 py-1 text-caption font-bold text-foreground"
        >
          <Paperclip size={12} className="shrink-0" />
          <span className="truncate">{attachment.filename}</span>
        </span>
      ))}
    </div>
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
  onOpenPreview: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
  onDownload: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const media = useRefreshingMediaUrl({
    attachmentId: attachment.id,
    localPreviewUrl: attachment.localPreviewUrl,
    disabled: isOptimistic,
    mediaKind: "video",
  });
  const { url: inlineUrl, loading: loadingUrl, failure, load: loadInlineVideoUrl, abort: abortInlineVideoUrl } = media;

  const handleOpenPreview = useCallback(() => {
    if (!isOptimistic) void onOpenPreview(attachment);
  }, [onOpenPreview, attachment, isOptimistic]);
  const handleDownload = useCallback(() => {
    void onDownload(attachment);
  }, [onDownload, attachment]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || isOptimistic) return;
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      loadInlineVideoUrl();
      return abortInlineVideoUrl;
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
      abortInlineVideoUrl();
    };
  }, [attachment.id, isOptimistic, loadInlineVideoUrl, abortInlineVideoUrl]);

  const downloadAction = (
    <MessageVideoPreviewFailureAction
      onClick={handleDownload}
      aria-label={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename })}
    >
      <Download size={13} />
      {formatMessage({ id: "message.messageItem.downloadToView" })}
    </MessageVideoPreviewFailureAction>
  );

  return (
    <Tooltip content={attachment.filename}>
    <MessageVideoPreview
      ref={containerRef}
      data-message-affordance="inline-video-preview"
    >
      {inlineUrl && !failure ? (
        <MessageVideoPreviewMedia
          render={<video
            ref={videoRef}
            title={formatMessage({ id: "message.messageItem.videoAttachmentTitle" }, { filename: attachment.filename })}
            src={inlineUrl}
            controls
            playsInline
            preload="metadata"
            {...media.mediaEvents}
          />}
        />
      ) : (
        <MessageVideoPreviewFallback>
          {isOptimistic || loadingUrl ? (
            <Spinner size="md" variant="inverse" aria-label={formatMessage({ id: "common.loadingLabel" })} />
          ) : failure === "unsupported" ? (
            <MessageVideoPreviewFailureContent>
              <MessageVideoPreviewFailureIcon>
                <AlertTriangle size={24} />
              </MessageVideoPreviewFailureIcon>
              <MessageVideoPreviewFailureTitle>{formatMessage({ id: "message.messageItem.codecWarning" })}</MessageVideoPreviewFailureTitle>
              {downloadAction}
            </MessageVideoPreviewFailureContent>
          ) : failure === "unavailable" ? (
            <MessageVideoPreviewFailureContent>
              <MessageVideoPreviewFailureIcon>
                <AlertTriangle size={24} />
              </MessageVideoPreviewFailureIcon>
              <MessageVideoPreviewFailureTitle>{formatMessage({ id: "message.messageItem.videoLoadFailed" })}</MessageVideoPreviewFailureTitle>
              <div className="flex items-center gap-3">
                <MessageVideoPreviewFailureAction
                  onClick={media.retry}
                  aria-label={formatMessage({ id: "message.messageItem.retryVideoPreview" }, { filename: attachment.filename })}
                >
                  <RefreshCw size={13} />
                  {formatMessage({ id: "message.messageItem.videoRetry" })}
                </MessageVideoPreviewFailureAction>
                {downloadAction}
              </div>
            </MessageVideoPreviewFailureContent>
          ) : (
            <Play size={32} />
          )}
        </MessageVideoPreviewFallback>
      )}
      {!isOptimistic && (
        <Tooltip content={formatMessage({ id: "message.messageItem.openInPreview" }, { filename: attachment.filename })}>
        <MessageVideoPreviewAction
          onClick={handleOpenPreview}
          aria-label={formatMessage({ id: "message.messageItem.openInPreview" }, { filename: attachment.filename })}
          data-message-affordance="inline-video-expand"
        >
          <Eye size={12} />
        </MessageVideoPreviewAction>
        </Tooltip>
      )}
    </MessageVideoPreview>
    </Tooltip>
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
  keepAliveKey,
  mediaEvents,
}: {
  filename: string;
  url: string;
  /** Plays on while the row is unmounted (scrolled out of a virtual timeline). */
  keepAliveKey: string;
  mediaEvents: ReturnType<typeof useRefreshingMediaUrl>["mediaEvents"];
}) {
  const { formatMessage } = useIntl();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  // Scrolled out of a virtual timeline while playing, the audio plays on
  // (inlineAudioKeepAlive) until that timeline goes; back in view, this
  // player takes it over.
  const keepAliveScope = useContext(InlineAudioKeepAliveContext);
  useLayoutEffect(() => {
    const audio = audioRef.current;
    if (audio && resumeKeptInlineAudio(keepAliveScope, keepAliveKey, audio)) setPlaying(true);
    return () => keepInlineAudioPlaying(keepAliveScope, keepAliveKey, audio);
  }, [keepAliveScope, keepAliveKey]);
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
    <div data-message-affordance="inline-audio-player" className="w-full rounded-control bg-fill-muted p-2">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="default"
          size="icon-md"
          data-message-affordance="audio-play-toggle"
          aria-label={formatMessage({ id: playing ? "message.messageItem.pauseAudio" : "message.messageItem.playAudio" }, { filename })}
          onClick={handleTogglePlayback}
        >
          {playing ? <Pause fill="currentColor" /> : <Play fill="currentColor" />}
        </Button>
        <div className="relative h-8 min-w-0 flex-1">
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
            className="peer absolute inset-0 z-raised h-8 w-full opacity-0"
            onChange={handleSeek}
          />
          <div
            data-message-affordance="audio-seek-rail"
            className="pointer-events-none absolute left-0 right-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-[4px] border border-line-hairline bg-layer-card peer-focus-visible:shadow-focus"
            aria-hidden="true"
          >
            <div className="h-full bg-info" style={{ width: `${progress}%` }} />
          </div>
          <span
            data-message-affordance="audio-seek-thumb"
            className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-[1.5px] border-line-strong bg-layer-card peer-focus-visible:shadow-focus"
            style={{ left: `${progress}%` }}
            aria-hidden="true"
          />
        </div>
        <div data-message-affordance="audio-time" className="w-[4.75rem] shrink-0 text-right font-mono text-mono-meta tabular-nums text-foreground-hint">
          {timeLabel}
        </div>
      </div>
      <div data-message-affordance="audio-volume-control" className="mt-1.5 flex items-center gap-2 pl-10">
        <Volume2 size={16} className="shrink-0 text-foreground-muted" aria-hidden="true" />
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
            className="peer absolute inset-0 z-raised h-6 w-full opacity-0"
            onChange={handleVolumeChange}
          />
          <div
            data-message-affordance="audio-volume-rail"
            className="pointer-events-none absolute left-0 right-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-[3px] border border-line-hairline bg-layer-card peer-focus-visible:shadow-focus"
            aria-hidden="true"
          >
            <div className="h-full bg-foreground-muted" style={{ width: `${volumeProgress}%` }} />
          </div>
          <span
            data-message-affordance="audio-volume-thumb"
            className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-[2px] border-[1.5px] border-line-strong bg-layer-card peer-focus-visible:shadow-focus"
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
        onLoadedMetadata={(event) => {
          syncMediaState();
          mediaEvents.onLoadedMetadata(event);
        }}
        onDurationChange={syncMediaState}
        onTimeUpdate={syncMediaState}
        onPlay={() => {
          setPlaying(true);
          mediaEvents.onPlay();
        }}
        onPause={() => {
          setPlaying(false);
          mediaEvents.onPause();
        }}
        onEnded={() => setPlaying(false)}
        onError={mediaEvents.onError}
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
  onDownload: (attachment: NonNullable<Message["attachments"]>[number]) => void | Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const media = useRefreshingMediaUrl({
    attachmentId: attachment.id,
    localPreviewUrl: attachment.localPreviewUrl,
    disabled: isOptimistic,
    mediaKind: "audio",
  });
  const { url: inlineUrl, loading: loadingUrl, load: loadInlineAudioUrl, abort: abortInlineAudioUrl } = media;
  const loadFailed = media.failure !== null;

  const handleDownload = useCallback(() => {
    void onDownload(attachment);
  }, [onDownload, attachment]);
  // The card's own download: it must not also open the attachment under it.
  const handleDownloadClick = useCallback((event: MouseEvent) => {
    event.preventDefault(); event.stopPropagation(); handleDownload();
  }, [handleDownload]);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || isOptimistic) return;
    if (typeof window === "undefined" || !("IntersectionObserver" in window)) {
      loadInlineAudioUrl();
      return abortInlineAudioUrl;
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
      abortInlineAudioUrl();
    };
  }, [attachment.id, isOptimistic, loadInlineAudioUrl, abortInlineAudioUrl]);

  const downloadButton = (
    <Tooltip content={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename })}>
    <Button
      variant="ghost"
      size="icon-md"
      data-message-affordance="audio-download"
      aria-label={formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename })}
      onClick={handleDownloadClick}
    >
      <Download />
    </Button>
    </Tooltip>
  );

  return (
    <div
      ref={containerRef}
      data-message-affordance="inline-audio-preview"
      className="w-full max-w-xl"
    >
      {inlineUrl && !loadFailed ? (
        <Card className={INLINE_AUDIO_PREVIEW_CARD_CLASS}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-chip bg-fill-muted text-foreground-muted">
                <Music size={18} className="text-current" />
              </div>
              <div className="min-w-0">
                <Tooltip content={attachment.filename}><div className="truncate text-callout font-semibold text-foreground">{attachment.filename}</div></Tooltip>
                <div className="font-mono text-mono-meta text-foreground-hint">{formatMessage({ id: "message.messageItem.audioFile" })}</div>
              </div>
            </div>
            {downloadButton}
          </div>
          <InlineAudioPlayer
            key={inlineUrl}
            filename={attachment.filename}
            url={inlineUrl}
            keepAliveKey={attachment.id}
            mediaEvents={media.mediaEvents}
          />
        </Card>
      ) : (
        <Card className={INLINE_AUDIO_PREVIEW_CARD_CLASS}>
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-chip bg-fill-muted text-foreground-muted">
                <Music size={18} className="text-current" />
              </div>
              <div className="min-w-0">
                <Tooltip content={attachment.filename}><div className="truncate text-callout font-semibold text-foreground">{attachment.filename}</div></Tooltip>
                <div className="font-mono text-mono-meta text-foreground-hint">{formatMessage({ id: "message.messageItem.audioFile" })}</div>
              </div>
            </div>
            {!isOptimistic && !loadFailed ? downloadButton : null}
          </div>
          {/* A full-width ghost Button at md on the muted well: the label is
              a control's (text-control); only the failed state is pressable. */}
          <Button
            type="button"
            variant="ghost"
            size="md"
            className={`w-full min-w-0 overflow-hidden bg-fill-muted text-foreground-muted *:max-w-full *:min-w-0 ${loadFailed ? "hover:bg-fill-muted hover:overlay-medium active:bg-fill-muted active:overlay-medium" : "cursor-default hover:bg-fill-muted active:bg-fill-muted"}`}
            onClick={loadFailed ? handleDownload : undefined}
            aria-label={loadFailed ? formatMessage({ id: "message.messageItem.downloadFile" }, { filename: attachment.filename }) : formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}
          >
            {isOptimistic || loadingUrl ? (
              <>
                <Spinner size="xs" aria-label={formatMessage({ id: "common.loadingLabel" })} />
                <span className="truncate">{formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}</span>
              </>
            ) : loadFailed ? (
              <>
                <Download aria-hidden />
                {formatMessage({ id: "message.messageItem.downloadToView" })}
              </>
            ) : (
              <span className="truncate">{formatMessage({ id: "message.messageItem.loadingFile" }, { filename: attachment.filename })}</span>
            )}
          </Button>
        </Card>
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

export interface ReadOnlySenderProjection {
  displayName: string;
  /** Stable public @handle. Absent while web and server versions roll. */
  handle?: string | null;
  avatarUrl: string | null;
  description: string | null;
}

interface MessageItemProps {
  message: Message;
  mentionMap: Map<string, MentionEntry>;
  channels: Channel[];
  previewSenderAgent?: Agent;
  previewSenderMember?: ServerMember;
  channelParticipantAgentsById?: ReadonlyMap<string, Agent>;
  channelParticipantMembersById?: ReadonlyMap<string, ServerMember>;
  channelParticipantExternalsById?: ReadonlyMap<string, ChannelExternalMember>;
  threadSummary?: ThreadSummary;
  parentChannelId?: string;
  parentMessageId?: string;
  hideThreadActions?: boolean;
  showThreadFollowAction?: boolean;
  linkedTask?: Task;
  /** Every task linked to this message, by task number. With two or more the
   *  footer chip gives way to the TaskChipList (task v2, behind its flag). */
  linkedTasks?: readonly Task[];
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
  /** Render the canonical message row for a narrow, anonymous/read-only DTO. */
  readOnlyProjection?: boolean;
  /** Extra classes for the row root — per-theme alignment offsets (e.g. the
   *  avatar/header-icon-column correction) live at the callsite. */
  className?: string;
  /** Display-only identity from a narrow public DTO. It never grants profile
   * navigation, mention authority, or access to a member/agent store row. */
  readOnlySender?: ReadOnlySenderProjection;
  /** Read-only projection: the inline reply preview, supplied by the host page
   *  because a read-only page has no thread store to read it from. */
  readOnlyReplyScope?: ThreadRepliesScope;
  onReadOnlyNavigateChannel?: (channel: Channel) => void;
  onBeforeOpenThread?: () => void;
  onOpenThread?: (request: OpenThreadRequest) => void;
  onOpenProfile?: (kind: "agent" | "human", id: string) => void;
  threadSearchHighlightQuery?: string;
  threadSearchActive?: boolean;
  /**
   * Shows the located highlight (states.md#located) now: the message a jump
   * took someone to, while its list's `useLocated` on that jump is on (the
   * channel's, ChatPanel; a thread's, ThreadPanel, from the focus its surface
   * owns, the side thread's or the task modal's). The list holds it, not the
   * row, so a row that scrolls out and back in after it has run stays unlit.
   */
  located?: boolean;
  /**
   * Consecutive-same-sender grouping state (task #44). When a message continues
   * the previous sender's group, avatar + name are hidden and the timestamp
   * moves to a hover gutter. Optional — surfaces that don't compute grouping
   * (thread / DM panels) omit it and keep the full header.
   */
  groupState?: MessageGroupState;
  /**
   * Rhythm marker (messageGrouping.followedByFor): the kind of row that
   * follows this one. The root carries it as `data-followed-by`, and the
   * body, attachments and footer drop their trailing margin under it
   * (FOLLOWED_BODY_ENDING) so the follower sits on the row rhythm.
   */
  followedBy?: "compact" | "group";
  /**
   * #693 DM read status (artin, option C): set by ChatPanel on the LAST message
   * of a DM at the live edge. The status line renders below this message only
   * when it is also the viewer's own message and the peer has read it.
   */
  showDmReadStatus?: boolean;
  /** Agent read progress: your latest message at the live edge, set by the
   *  timeline. Its agents' read line takes the DM status line's slot. */
  showAgentReadStatus?: boolean;
  /** Agent read progress is on in this conversation: the faces of the agents
   *  that last read this message end its body (raft-ui MessageItemTrailing),
   *  on the last line, with no column of their own. */
  agentReadFaces?: boolean;
  /** A task hand-off card (an assignment line with a reason): when the task
   *  came back to whoever handed it off, set by the task conversation's
   *  timeline (taskHandoffReturns). */
  taskHandoffReturn?: TaskHandoffReturn | null;
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
  const intl = useIntl();
  const displayState = useAgentDisplayState(agentId, fallbackAgent);
  const activityText = formatAgentDisplayStateText(intl, displayState);
  return (
    <StatusDot
      activity={displayState.activity}
      external={displayState.isExternal && !displayState.isOnline}
      title={activityText}
      className={className}
      {...rest}
    />
  );
}

// Isolates hover-card state so opening the card doesn't re-render the whole MessageItem.
// Stryker disable all: sender preview-card composition is covered by the existing sender-resolution contracts plus manual visual validation; this migration batch is not adding new hover DOM tests.
/**
 * RFC 077, DS Identity and presence › Sent by an assistant: the assistant's
 * face on the owner's avatar. Decoration only (raft-ui hides it from
 * assistive technology); the words say who sent it. A deleted assistant shows
 * the default face, grayed and faded.
 */
function DelegatedFace({ delegatedBy }: { delegatedBy: DelegatedBy }) {
  return (
    <MessageItemDelegatedAvatar deleted={delegatedBy.deleted} data-testid="message-delegated-face">
      <AvatarSlot context="delegated-face" type="agent" agentAvatarUrl={delegatedBy.deleted ? null : delegatedBy.avatarUrl} />
    </MessageItemDelegatedAvatar>
  );
}

/**
 * "sent by Friday" after the sender, or "(sent by Friday)" at the end of a
 * continuation; "sent by a deleted assistant" once it is gone, with no name
 * part, so none of it truncates. The words come from the catalog; raft-ui
 * lays them out.
 */
function DelegatedByLabel({ delegatedBy, inBody = false, messageId }: { delegatedBy: DelegatedBy; inBody?: boolean; messageId: string }) {
  const { formatMessage } = useIntl();
  const testId = `message-delegated-by-${messageId}`;
  if (delegatedBy.deleted) {
    return (
      <MessageItemDelegatedBy data-testid={testId}>
        {formatMessage({ id: inBody ? "message.delegated.sentByDeletedInBody" : "message.delegated.sentByDeleted" })}
      </MessageItemDelegatedBy>
    );
  }
  return (
    <MessageItemDelegatedBy data-testid={testId}>
      {formatMessage(
        { id: inBody ? "message.delegated.sentByInBody" : "message.delegated.sentBy" },
        { name: <MessageItemDelegatedByName key="name">{delegatedBy.name}</MessageItemDelegatedByName> },
      )}
    </MessageItemDelegatedBy>
  );
}

function MessageSenderAvatar({
  showAgent,
  showExternal,
  externalAnonymous,
  isDeactivatedAgent,
  senderId,
  agentAvatarUrl,
  avatarUrl,
  hoverAgent,
  hoverMember,
  readOnlySender,
  externalAvatarUrl,
  externalDisplayName,
  externalProvider,
  externalWorkspaceName,
  externalActorKind,
  externalProfileDisplayName,
  externalProfileAvatarUrl,
  externalAppName,
  testId,
  onNavigateAgent,
  onNavigateAgentActivity,
  onNavigateHuman,
  onNavigateExternal,
  onContextMenu,
  onLongPressMention,
  delegatedBy = null,
  origin,
}: {
  showAgent: boolean;
  showExternal: boolean;
  externalAnonymous?: boolean;
  isDeactivatedAgent: boolean;
  senderId: string;
  agentAvatarUrl: string | null;
  avatarUrl: string | null;
  hoverAgent?: Agent | null;
  hoverMember?: ServerMember | null;
  readOnlySender?: ReadOnlySenderProjection;
  externalAvatarUrl?: string | null;
  externalDisplayName: string;
  externalProvider?: string | null;
  externalWorkspaceName?: string | null;
  externalActorKind?: ExternalActorKind | null;
  externalProfileDisplayName?: string | null;
  externalProfileAvatarUrl?: string | null;
  externalAppName?: string | null;
  testId?: string;
  onNavigateAgent: (id: string) => void;
  onNavigateAgentActivity: (id: string) => void;
  onNavigateHuman: (id: string) => void;
  onNavigateExternal: () => void;
  onContextMenu?: (event: MouseEvent<HTMLButtonElement>) => void;
  onLongPressMention?: () => void;
  /** RFC 077: the assistant that sent this person's message; its face goes on the corner. */
  delegatedBy?: DelegatedBy | null;
  /** Another server's sender: its server's tile goes on the avatar's top-left corner, its ribbon on the card. */
  origin: MemberOrigin;
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
  const onOpenAgentActivity = useCallback((agentId: string) => {
    previewActionsRef.current?.close();
    onNavigateAgentActivity(agentId);
  }, [onNavigateAgentActivity]);
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
  const humanAvatarSource = avatarSourceOf(avatarUrl);
  if (showExternal) {
    if (externalAnonymous) return <span data-testid={testId} aria-label={externalDisplayName}>
      <AvatarSlot context="message-row" type="app" appInitials={externalDisplayName} />
    </span>;
    return (
      <ExternalIdentityPreviewCard
        displayName={externalDisplayName}
        provider={externalProvider}
        workspaceName={externalWorkspaceName}
        actorKind={externalActorKind}
        avatarUrl={externalAvatarUrl}
        profileDisplayName={externalProfileDisplayName}
        profileAvatarUrl={externalProfileAvatarUrl}
        appName={externalAppName}
        testId={testId}
        onNavigate={onNavigateExternal}
      />
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
              className={`relative ${MESSAGE_AVATAR_OFFSET} shrink-0 self-start transition-[filter,transform] duration-75 hover:brightness-90 ${avatarPressed ? "scale-90 brightness-75" : ""}`}
            >
              <AvatarSlot
                context="message-row"
                type="agent"
                agentAvatarUrl={agentAvatarUrl}
                badge={!isDeactivatedAgent ? (
                  <AgentStatusDot agentId={senderId} fallbackAgent={hoverAgent} />
                ) : undefined}
                className={isDeactivatedAgent ? "grayscale opacity-dimmed" : ""}
                corner={<AvatarOriginCorner origin={origin} />}
              />
            </button>
          }
        />
        <PreviewCardContent sideOffset={6} collisionPadding={6}>
          <ProfilePreviewCardContent
            mentionType={mentionType}
            mentionId={senderId}
            fallbackAgent={hoverAgent}
            readOnlyProfile={readOnlySender}
            onOpenAgentActivity={onOpenAgentActivity}
            origin={origin}
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
            className={`${MESSAGE_AVATAR_OFFSET} shrink-0 self-start transition-[filter,transform] duration-75 hover:brightness-90 ${avatarPressed ? "scale-90 brightness-75" : ""}`}
          >
            <AvatarSlot
              context="message-row"
              type="human"
              humanAvatarUrl={avatarUrl}
              corner={<>{delegatedBy ? <DelegatedFace delegatedBy={delegatedBy} /> : null}<AvatarOriginCorner origin={origin} /></>}
            />
          </button>
        }
      />
      <PreviewCardContent sideOffset={6} collisionPadding={6}>
        <ProfilePreviewCardContent mentionType={mentionType} mentionId={senderId} fallbackMember={hoverMember} readOnlyProfile={readOnlySender} origin={origin} />
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
  const ActionComponent = text.action === "retry" ? MessageItemTranslationRetryAction : MessageItemTranslationAction;
  const action = text.label
    ? (
      <Tooltip content={text.title}>
      <ActionComponent
        onClick={handleAction}
        aria-label={text.label || text.title}
      >
        {text.label}
      </ActionComponent>
      </Tooltip>
    )
    : null;

  const StatusWrapper = text.tone === "failed" ? MessageItemTranslationFailedStatus : MessageItemTranslationStatus;
  const indicator = (
    <StatusWrapper
      data-testid={`message-translation-indicator-${entry.messageId}`}
      data-select-screenshot-transient-state={text.tone === "pending" || text.tone === "failed" ? "true" : undefined}
      data-message-affordance="translation-status"
    >
      <Icon size={12} className={text.tone === "pending" ? "animate-pulse" : ""} />
      {text.message && <span>{text.message}</span>}
      {text.message && action && <span aria-hidden>·</span>}
      {action}
    </StatusWrapper>
  );

  return action ? indicator : <Tooltip content={text.title}>{indicator}</Tooltip>;
}

// Persistent thread-ref notice is keyed (not a formatted string) so it
// re-localizes on a language switch while still displayed.
type ThreadRefNoticeKey =
  | "message.messageItem.threadServerUnknown"
  | ThreadRefMissingParentNotice
  | "message.messageItem.sourceUnavailable";

/** Task-assignee handle inside the footer task badge. One shared JSX node
 *  keeps the file's audited `@` literal count at one —
 *  scripts/i18n-literal-baseline.json audits exactly one. Inline task refs
 *  do NOT render the assignee (task #1252): the badge must not fabricate an
 *  `@` into the sender's sentence. */
function taskAssigneeHandle(claimedByName: string) {
  return <span className="min-w-0 truncate">@{claimedByName}</span>;
}

const ignoreReadOnlyProjectionNavigation = () => undefined;

const ConnectedMessageItem = memo(function ConnectedMessageItem({ message: rawMessage, mentionMap, channels, previewSenderAgent, previewSenderMember, channelParticipantAgentsById, channelParticipantMembersById, channelParticipantExternalsById, threadSummary, parentChannelId, parentMessageId, hideThreadActions, showThreadFollowAction, linkedTask: linkedTaskProp, linkedTasks, senderAvatarTestId, mentionComposerChannelId, reactionParentScopeKey, canReact: canReactProp = true, readOnlyProjection = false, readOnlySender, readOnlyReplyScope, onReadOnlyNavigateChannel, onBeforeOpenThread, onOpenThread, onOpenProfile, threadSearchHighlightQuery, threadSearchActive, located = false, groupState, followedBy, showDmReadStatus = false, showAgentReadStatus = false, agentReadFaces = false, taskHandoffReturn = null, className }: MessageItemProps) {
  // RFC 077: a retracted message (sent by an assistant, taken back by its
  // owner) is a single non-interactive record: its sender, time, delegated
  // marks and thread replies stay; its words, attachments, link previews,
  // quotes, reactions, hover actions and menus go. Everything below reads the
  // emptied message, so none of them can render from the stored row.
  const retracted = isRetractedMessage(rawMessage);
  const message = useMemo(
    () => (retracted ? { ...rawMessage, content: "", attachments: [], reactions: [] } : rawMessage),
    [rawMessage, retracted],
  );
  const canReact = canReactProp && !retracted;
  const actionable = !readOnlyProjection && !retracted;
  // Task v2 (the caller passes linkedTasks only with the flag on): every task
  // linked to the message renders as the list under it, one included — old
  // tasks whose title is the message itself too (@stdrc). Without it, the
  // single footer chip and its quick actions stay.
  const linkedTaskList = linkedTasks && linkedTasks.length > 0 ? linkedTasks : null;
  const linkedTask = linkedTaskList ? undefined : linkedTaskProp;
  // The located highlight (design/foundations/states.md#located) is decided
  // by the list the row is in (`located`): a channel jump by ChatPanel, a
  // thread jump by ThreadPanel. A reply in a thread never takes the channel's
  // jump, so a stale channel `msg=` anchor can't color it.
  const isLocated = located;
  // While thread search is open, its current match is selected content: held
  // cyan while the search is open, not a 2s located highlight.
  const isThreadSearchMatch = !!threadSearchActive;
  const isHighlighted = isLocated || isThreadSearchMatch;
  // Opened from a search result: the query's words are marked in this one
  // message while its conversation stays open (searchHitMarkStore).
  const searchHitQuery = useSearchHitMarkStore((s) => (
    !readOnlyProjection && s.mark?.messageId === message.id ? s.mark.query : undefined
  ));
  const isAgent = message.senderType === "agent";
  const isExternal = message.senderType === "external_projection";
  // RFC 077: sent by the sender's assistant for them, and retracted by them.
  const delegatedByRaw = (message as { delegatedBy?: unknown }).delegatedBy;
  const delegatedBy = useMemo(
    () => (message.senderType === "user" ? delegatedByOf({ delegatedBy: delegatedByRaw }) : null),
    [message.senderType, delegatedByRaw],
  );
  const isSystem = message.messageType === "system";
  const humanDepartureLabel = isAgent || isExternal
    ? null
    : getHumanDepartureLabel(message.senderMembershipStatus);
  const structuredMentionMap = useMemo(() => buildStructuredMentionMap(message.mentions), [message.mentions]);
  // A read-only projection has no member directory: its only mention facts are
  // the display-only ones carried on the message, which also supply the label.
  const effectiveMentionMap = readOnlyProjection
    ? structuredMentionMap
    : isExternal ? EXTERNAL_MESSAGE_MENTION_MAP : mentionMap;
  const effectiveStructuredMentionMap = structuredMentionMap;
  const { formatMessageTime, formatGutterClock, formatMediumDateTime, options: timeFormatOptions } = useTimeFormatter();
  const intl = useIntl();
  const { formatMessage } = intl;
  // Render reads formatMessage directly; effects/handlers read
  // formatMessageRef.current so a locale switch never re-runs them.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const time = formatMessageTime(message.createdAt);
  // Hour and minute only for the continuation-row hover gutter: the full
  // `time` ("Yesterday 3:04") and an AM/PM time like "06:35 PM" are too wide for the
  // 35px gutter. Full date+time in the tooltip. Both go through the shared
  // time formatter so no raw browser time API lives here.
  const gutterClock = formatGutterClock(message.createdAt);
  const gutterFullTimestamp = formatMediumDateTime(message.createdAt);
  // The machine-readable moment for the message's <time> elements (task #115).
  const sentAtIso = useMemo(() => {
    const date = new Date(message.createdAt);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }, [message.createdAt]);
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
  // Subscribe per row: this component is memoized, so a catalog that arrives
  // after the first message render must still update the name (task #700).
  // Subscribe per row: this component is memoized, so a catalog that arrives
  // after the first message render must still update the name (task #700).
  const catalogModelLabelText = useCatalogModelLabel(
    senderAgent?.machineId,
    senderAgent?.runtime,
    senderAgent?.model,
  );
  // A hosted agent's runtime/model are the "External agent" placeholders; name the hosting instead.
  const hostedModelLabelText = senderAgent?.hostedRuntime
    ? intl.formatMessage({ id: "message.agentModel.hosted" })
    : null;
  // A personal assistant has no runtime chip (DS Terminology › assistant): its
  // description, "Personal assistant of @owner", already says what it is, as
  // the sidebar does.
  const isPersonalAssistantSender = Boolean(senderAgent?.assistantOwnerUserId);
  // An App bot runs no model: its stored model is the column default, not
  // something it uses. It carries the App badge instead, as on its sidebar
  // row and profile card.
  const isAppBotSender = Boolean(senderAgent?.managedByAppInstallId);
  const senderMember = useMemo(() => {
    if (previewSenderMember) return previewSenderMember;
    const memberById = new Map<string, ServerMember>();
    if (storeSenderMember) memberById.set(storeSenderMember.userId, storeSenderMember);
    return resolveMessageSenderMember(message, memberById, currentUser, currentUserServerRole);
  }, [currentUser, currentUserServerRole, message, previewSenderMember, storeSenderMember]);
  // A joint channel's other server: neither the directory nor this
  // channel's roster names them, so their face comes from the actors table
  // (filled by `/actors/resolve`), and an agent still reads as an agent.
  // Only joint surfaces ask: elsewhere a sender is this server's. A sender the
  // directory knows (deleted ones too) never takes the table's row.
  const jointSurfaceChannel = channels.find(
    (channel) => channel.id === (parentChannelId || message.channelId) && channel.type === "joint",
  );
  const onJointSurface = jointSurfaceChannel !== undefined;
  const senderActor = useActorFallback(
    onJointSurface && !readOnlyProjection && !isSystem && message.senderId && message.senderId !== "system"
      && (isAgent ? !senderAgent : message.senderType === "user" && !senderMember)
      ? { kind: isAgent ? "agent" : "human", id: message.senderId }
      : null,
  );
  // Member labels (#wg-rbac:#46): a sender from another server carries that
  // server's tile on the avatar, and none of this server's facts.
  const senderOrigin = useSenderOrigin(
    isAgent ? senderAgent : senderMember,
    senderActor?.homeServerId,
    jointSurfaceChannel?.jointServers,
    readOnlyProjection || isSystem || message.senderType === "external_projection",
  );
  // The model follows the name of this server's agents only, whatever the
  // appearance setting says: another server's agent never shows one.
  const agentModelLabelText = showAgentModelNameOption && !isPersonalAssistantSender && !isAppBotSender && !senderOrigin.external
    ? hostedModelLabelText ?? catalogModelLabelText ?? agentModelLabel(senderAgent)
    : null;
  const isDeactivatedAgent = isAgent && !!senderAgent?.deletedAt;
  const viewerUserId = viewer?.id ?? null;
  const serverId = useServerStore((s) => s.current?.id ?? null);

  const reactionActorCache = useStore(
    reactionReadModelStore,
    (state) => state.actorCache,
  );
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
    && viewerUserId === message.senderId;
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
  // A DM thread reply carries the thread's channelId; its DM is the parent.
  const dmSurfaceChannelId = parentChannelId || message.channelId;
  const isDmSurface = useChannelStore((state) => selectIsDmSurface(state, dmSurfaceChannelId));
  const dmReadReceiptScope = useReadReceiptStore(
    (state) => state.scopes[message.channelId],
  );
  // artin (option C): one status line under the DM's last message, never a
  // per-message footer chip. A chip in the footer created the footer row the
  // moment the peer read the message, so every read message grew ~26px, and
  // the watermark made it repeat on every earlier message too.
  const showDmReadReceipt = showDmReadStatus
    && agentReadBadgesEnabled
    && isDmSurface
    && projectReadReceipt(dmReadReceiptScope, message.seq ?? undefined).read;
  const viewerReactionName = viewer?.displayName || viewer?.name || viewer?.email || formatMessage({ id: "message.messageItem.reactorYou" });

  const serverSlug = useServerStore((s) => s.current?.slug);
  const referenceSurfaceChannelId = parentChannelId || message.channelId;
  // task #187 collapse-long-messages: per-user, per-channel server-persisted
  // pref. OFF = long messages on this surface always render fully expanded
  // (CollapsibleMessageContent behaves as if disabled). Missing hydration
  // defaults to OFF — the server default.
  const storedCollapseLongMessages = useChannelStore(
    (state) =>
      findStoredChannel(state, referenceSurfaceChannelId)?.collapseLongMessages ?? false,
  );
  const collapseLongMessages = storedCollapseLongMessages;
  const isJointReferenceSurface = onJointSurface;
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
  const loungeChannels = useChannelStore((s) => s.loungeChannels);
  const requestTransientFocus = useMessageStore((s) => s.requestTransientFocus);
  const nav = useAppNavigate();
  const translationSettings = useTranslationStore((s) => s.settings);
  const translationEntry = useTranslationStore((s) => s.entries[message.id]);
  const requestTranslations = useTranslationStore((s) => s.requestTranslations);
  const retryTranslation = useTranslationStore((s) => s.retryMessage);
  const setTranslationShowOriginal = useTranslationStore((s) => s.setShowOriginal);
  const messageBodyFontSize = useAppearanceStore((s) => s.messageBodyFontSize);
  const showSenderDescription = useAppearanceStore((s) => s.showSenderDescription); // Settings › Appearance
  const messageBodyFontSizeClass = getMessageBodyFontSizeClass(messageBodyFontSize);
  const messageNameSizeClass = getMessageNameSizeClass(messageBodyFontSize);
  const messageMetaSizeClass = getMessageMetaSizeClass(messageBodyFontSize);
  const messageTimeSizeClass = getMessageTimeSizeClass(messageBodyFontSize);
  const messageBodyFontSizeStyle = useMemo(() => ({
    ...getMessageBodyFontSizeStyle(messageBodyFontSize),
    userSelect: "text" as const,
    WebkitUserSelect: "text" as const,
  }), [messageBodyFontSize]);
  const imagePreviewAttachments = useMemo(
    () => (message.attachments ?? []).filter((att) => isPreviewableImageAttachment(att)),
    [message.attachments],
  );
  const lightboxImages = useMemo(
    () => imagePreviewAttachments.filter((att) => !isOptimisticAttachment(att)),
    [imagePreviewAttachments],
  );
  const actionMetadata = message.actionMetadata as { kind?: string } | null | undefined;
  const isActionCardMessage = actionMetadata?.kind === "action-card";
  const messageCard = readMessageCard(message.actionMetadata); // RFC 082: a card the shared schema reads, else null (draw `content`).
  const translationTargetLanguage = translationSettings.available && translationSettings.preferredTranslationMode !== "off"
    ? translationSettings.effectiveLanguage
    : null;
  const isOwnHumanMessage = message.senderType === "user" && viewerUserId === message.senderId;
  const translationEligible =
    !isSystem && !messageCard &&
    // A retracted message has no words of the sender's left to translate.
    !retracted &&
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
  const handleToggleTranslationOriginal = useCallback(() => {
    setTranslationShowOriginal(message.id, !activeTranslationShowOriginal);
  }, [setTranslationShowOriginal, message.id, activeTranslationShowOriginal]);
  const handleRetryTranslation = useCallback(() => {
    if (!translationTargetLanguage) return;
    void retryTranslation(message, { targetLanguage: translationTargetLanguage, viewerUserId });
  }, [translationTargetLanguage, retryTranslation, message, viewerUserId]);
  const handleUpgradePlan = useCallback(() => {
    nav.toSettings("server");
  }, [nav]);
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
  const permalinkHostnames = useRaftPermalinkHostnames();
  const quotedPermalink = useMemo(
    () => extractFirstQuotedMessagePermalink(message.content, permalinkHostnames, serverSlug),
    [permalinkHostnames, message.content, serverSlug],
  );
  const [unavailableQuotedPermalinkUrl, setUnavailableQuotedPermalinkUrl] = useState<string | null>(null);
  const quotedPermalinkUnavailable = quotedPermalink?.rawUrl === unavailableQuotedPermalinkUrl;
  // By its URL: the same quote found again (the server's app hosts arriving)
  // keeps its handler, so its preview is not read again.
  const quotedPermalinkUrl = quotedPermalink?.rawUrl ?? null;
  const handleQuotedPermalinkUnavailable = useCallback(() => {
    if (quotedPermalinkUrl) setUnavailableQuotedPermalinkUrl(quotedPermalinkUrl);
  }, [quotedPermalinkUrl]);
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
    if (onOpenProfile) onOpenProfile("agent", agentId); // its owner's panel (the task dialog): the profile
    else openConversationAgentActivity(useProfileStore.getState().openProfile, agentId, { openSource: parentMessageId ? "thread" : "channel" });
  }, [mentionMap, onOpenProfile, parentMessageId, senderAgent, serverId]);

  const handleNavigateHuman = useCallback((userId: string) => {
    if (onOpenProfile) {
      onOpenProfile("human", userId);
      return;
    }
    // The channel (a thread's parent) names the person's servers on their profile.
    useProfileStore.getState().openProfile("human", userId, {
      openSource: parentMessageId ? "thread" : "channel",
      channelId: parentChannelId || message.channelId,
    });
  }, [message.channelId, onOpenProfile, parentChannelId, parentMessageId]);

  const handleNavigateExternal = useCallback(() => {
    const profile = message.externalAuthor;
    if (!profile || profile.identityKind === "anonymous") return;
    useProfileStore.getState().openExternalProfile(message.id, profile, {
      channelId: message.channelId,
      openSource: parentMessageId ? "thread" : "channel",
    });
  }, [message.channelId, message.externalAuthor, message.id, parentMessageId]);

  const handleNavigateExternalMention = useCallback((profile: ExternalMessageAuthorProjection) => {
    // Thread panels pass the thread's channelId, but the Slack binding lives
    // on the parent channel — use the same parent-first lookup the avatar
    // path uses so refresh/back restores the right channel.
    const channelId = parentChannelId || message.channelId;
    useProfileStore.getState().openExternalProfile(profile.projectionId, profile, {
      channelId,
      openSource: parentMessageId ? "thread" : "channel",
      isMention: true,
    });
  }, [message.channelId, parentChannelId, parentMessageId]);

  const handleNavigateChannel = useCallback((channel: Channel) => {
    nav.toChannel(channel.id);
  }, [nav]);

  const handleNavigateDm = useCallback((channel: Channel) => {
    nav.toDm(channel.id);
  }, [nav]);

  // Look up agent's avatar
  const agentAvatarUrl = readOnlyProjection
    ? readOnlySender?.avatarUrl ?? null
    : senderAgent ? senderAgent.avatarUrl ?? null : senderActor?.avatarUrl ?? null;
  const humanAvatarUrl = readOnlyProjection
    ? readOnlySender?.avatarUrl ?? null
    : senderMember ? senderMember.avatarUrl ?? null : senderActor?.avatarUrl ?? null;
  const externalPresentation = externalSenderPresentation(message.externalAuthor);
  const externalAvatarUrl = readOnlyProjection ? null : externalPresentation.avatarUrl;
  const senderAgentDmChannel = isAgent
    ? dmChannels.find((channel) => channel.peerType === "agent" && channel.peerId === message.senderId)
    : null;

  // Sender subtitle: a projection's description, an external provider, or this server's Guest
  const senderDisplayName = readOnlyProjection
    ? readOnlySender?.displayName || message.senderName || formatMessage({ id: "message.messageItem.senderUserFallback" })
    : isExternal
      ? message.externalAuthor?.profileFallback === "unresolved"
        ? formatMessage({ id: "message.author.slackUnresolved" }, { id: message.externalAuthor.externalActorId })
        : externalPresentation.displayName || message.senderName || formatMessage({ id: "message.author.externalFallback" })
      : isAgent
        ? senderAgent?.displayName || senderAgentDmChannel?.peerDisplayName || senderAgent?.name || senderActor?.displayName || senderActor?.name || message.senderName || formatMessage({ id: "message.messageItem.senderAgentFallback" })
        : message.senderName || formatMessage({ id: "message.messageItem.senderUserFallback" });
  // Member labels (#wg-rbac:#46): the author row says who this is and whether
  // they are from outside. A server role is the hover card's; the one role
  // written here is this server's Guest.
  const humanSenderRoleLabel = !isAgent && !isExternal && !readOnlyProjection && isViewerServerGuest(senderMember?.role, senderOrigin)
    ? formatMessage({ id: "member.detail.roleGuest" })
    : null;
  // The description follows the name (and its label) for people and agents,
  // this server's or another's (cindyz, #triage:4eb8046c). Another server's
  // agent is in no directory here and its joint roster row carries none, so
  // the message's own senderDescription is the fallback; whitespace is none.
  const senderDescriptionText = !isExternal && !readOnlyProjection && showSenderDescription
    ? ((isAgent ? senderAgent?.description : senderMember?.description)?.trim() || message.senderDescription?.trim() || null)
    : null;
  const senderSubtitle = readOnlyProjection
    ? (showSenderDescription ? readOnlySender?.description ?? null : null)
    : isExternal
      ? formatExternalProviderLabel(message.externalAuthor?.provider, formatMessage)
      : humanSenderRoleLabel;
  const senderSubtitleIsHumanRoleLabel = humanSenderRoleLabel !== null && senderSubtitle === humanSenderRoleLabel;
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
  // message_action_selected: a reply inside a thread vs a top-level row.
  const inThread = Boolean(parentMessageId);
  const handleSenderNameMention = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    trackMessageAction("mention_sender", "sender_name", inThread);
    insertSenderMention();
  }, [inThread, insertSenderMention]);
  const storeOpenThread = useThreadStore((s) => s.openThread);
  const openThread = useCallback((request: OpenThreadRequest) => {
    if (onOpenThread) {
      onOpenThread(request);
      return Promise.resolve();
    }
    return storeOpenThread(request);
  }, [onOpenThread, storeOpenThread]);
  const closeThread = useThreadStore((s) => s.closeThread);
  // Per-row answers, so a change to another thread does not re-render this row.
  const threadFollowedInStore = useThreadStore((s) => isThreadFollowed(s, message.id));
  const followedListThreadChannelId = useThreadStore((s) =>
    s.followedThreads.find((thread) => thread.parentMessageId === message.id)?.threadChannelId ?? null);
  const followThread = useThreadStore((s) => s.followThread);
  const unfollowThread = useThreadStore((s) => s.unfollowThread);
  // Subscribe to this row's own answer, not the raw ids: every rendered row
  // mounts this component, so selecting the ids re-rendered the whole list on
  // each thread open/close. A boolean only changes for the old and new parent.
  const isOpenThreadParent = useThreadStore((s) =>
    s.openParentMessageId === message.id && s.openParentChannelId === message.channelId);

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
  // The surface answers a row's select intent with its timeline's order
  // (messageSelectIntent.ts); a row never reads the list itself.
  const selectIntent = useContext(MessageSelectIntentContext);
  const enterSelection = useSelectionStore((s) => s.enter);
  const enterThreadSelection = useSelectionStore((s) => s.enterThread);
  const isSelectedAsThreadParent =
    !parentMessageId &&
    !hideThreadActions &&
    !(selectionActive && selectionThreadRootId === message.id) &&
    isOpenThreadParent;
  const showSelectedGroupedHeader = shouldShowGroupedMessageHeader(
    groupState,
    selectionScopedHere,
    isSelected,
    isPreviousGroupedMessageSelected,
  );
  // Stryker restore all
  const openLegacyTask = useLegacyTaskPanelStore((s) => s.openLegacyTask);
  const closeProfile = useProfileStore((s) => s.closeProfile);
  const canShowThreadFollowAction = !readOnlyProjection && (!hideThreadActions || !!showThreadFollowAction);
  const messageRef = useRef<HTMLDivElement | null>(null);
  const messageBodyRef = useRef<HTMLDivElement | null>(null);
  // Link cards for the links in the text: App links (protocol v3.2.3
  // addendum 5) and first-party objects (Artifacts), one hook for both, read
  // once the body is in view; shown as chips by the Markdown links below, and
  // the Artifacts again as the cards under the text, from the same answers.
  // Ordinary chat and thread messages only (docs/development/app-link-previews.md).
  const linkCards = useMessageLinkCards({
    messageId: message.id,
    content: message.content,
    conversationId: message.channelId,
    enabled: !readOnlyProjection && !forwardedBundleMetadata,
    target: messageBodyRef,
  });
  // Stryker disable all: React effect wiring delegates branch decisions to
  // behavior-tested helpers; source contracts pin the API endpoint and render
  // use sites while the focused mutation oracle avoids full MessageItem DOM.
  const imageFallbackKey = useMemo(() => buildImageInlineFallbackKey(message.attachments), [message.attachments]);
  // Stryker restore all

  const threadFollowed = canShowThreadFollowAction && threadFollowedInStore;
  const followedThreadChannelId = threadFollowed
    ? threadSummary?.threadChannelId ?? followedListThreadChannelId
    : null;
  const hasThreadConversation = !!threadSummary?.threadChannelId || (threadSummary?.replyCount ?? 0) > 0 || threadFollowed;
  // In a thread panel: the thread's own Follow / Unfollow (its header ⋯'s),
  // beside Mark Thread as Unread on every message; null elsewhere. The
  // thread's parent then shows it there only, not also as its own thread's.
  const enclosingThreadFollow = useEnclosingThreadFollowCommand();
  const enclosingThreadFollowCommand = readOnlyProjection ? null : enclosingThreadFollow;
  const showOwnThreadFollowAction = canShowThreadFollowAction && hasThreadConversation && !enclosingThreadFollowCommand;
  const threadUnreadCount = threadSummary?.unreadCount ?? 0;
  const firstUnreadThreadMessageId = threadUnreadCount > 0 ? threadSummary?.firstUnreadMessageId ?? null : null;
  const threadDraftChannelId = !hideThreadActions
    ? threadSummary?.threadChannelId ?? followedThreadChannelId ?? null
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
  const storedReplyScope = useThreadStore((s) => s.replyScopes[message.id]);
  const replyScope = readOnlyProjection ? readOnlyReplyScope : storedReplyScope;
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

  const [resolvingThreadRefKey, setResolvingThreadRefKey] = useState<string | null>(null);

  // Transient ref-open failures surface through the standard RUI toast — the
  // same component MainLayout uses for the identical message — instead of a
  // hand-rolled inline box.
  const showThreadRefNotice = useCallback((notice: ThreadRefNoticeKey) => {
    toast.error(formatMessageRef.current({ id: notice }));
  }, []);

  // Every conversation a link or ref here can reach: channels, DMs and agents' Lounges (in neither list).
  const navigableChannels = useMemo(() => {
    const listed = new Set(channels.map((channel) => channel.id));
    return [...channels, ...[...dmChannels, ...loungeChannels].filter((row) => !listed.has(row.id))];
  }, [channels, dmChannels, loungeChannels]);
  const findNavigableChannel = useCallback((id: string | null | undefined) => findStoredChannel({ channels, dmChannels, loungeChannels }, id), [channels, dmChannels, loungeChannels]);
  const taskSurfaceChannel = useMemo(() => findNavigableChannel(parentChannelId || message.channelId), [findNavigableChannel, message.channelId, parentChannelId]);
  const supportsMessageTasks = taskSurfaceChannel !== undefined && taskSurfaceChannel.type !== "thread";

  const openInDetailSlot = useDetailSlotThreadOpener();
  const handleOpenThreadRef = useCallback(async (intent: ThreadRefIntent) => {
    const threadRefKey = `${intent.serverSlug}:${intent.parentChannelName.toLowerCase()}:${intent.shortId.toLowerCase()}`;

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
      showThreadRefNotice(threadRefMissingParentNotice(intent, serverSlug, navigableChannels));
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
        // A thread whose first message is behind the plan's history window
        // still opens: on its history paywall (task #8, frames 6b, 7).
        loadContext: loadThreadRefContext,
      });
    } finally {
      setResolvingThreadRefKey((current) => current === threadRefKey ? null : current);
    }

    if (!isRequestAuthorityCurrent()) return;
    if (threadTarget) {
      const target = { ...threadTarget, focusedMessageId: intent.focusedMessageId ?? threadTarget.focusedMessageId };
      // In Activity's or Search's detail slot it takes the slot's place (detailSlotThread.ts).
      if (openInDetailSlot?.(target)) return;
      if (parentChannel?.type === "dm") nav.toDmMessage(threadTarget.parentChannelId, threadTarget.parentMessageId);
      else nav.toMessage(threadTarget.parentChannelId, threadTarget.parentMessageId);
      if (!isRequestAuthorityCurrent()) return;
      void openThread(target);
      return;
    }
    showThreadRefNotice("message.messageItem.threadUnavailable");
  }, [nav, navigableChannels, openInDetailSlot, openThread, serverSlug, showThreadRefNotice, threadRefAuthorityUnavailable]);

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
      const parentChannel = findNavigableChannel(item.parentChannelId);
      if (!parentChannel || parentChannel.type === "dm") return;
      try {
        let data: { canonicalTarget?: ContextCanonicalTarget | null };
        try {
          ({ data } = await api.get<{ canonicalTarget?: ContextCanonicalTarget | null }>(`/messages/context/${sourceMessageId}`, { params: { channelId: item.parentChannelId } }));
        } catch (error) {
          // A source behind the plan's history window still opens, on the
          // thread's paywall centered on it (task #8, frame 9).
          const hidden = readHistoryLimitedError(error);
          if (!hidden) throw error;
          data = hidden;
        }
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
    const sourceChannel = findNavigableChannel(item.sourceTargetId);
    if (!sourceChannel || sourceChannel.type === "dm") return;
    await handleOpenMessageRef(sourceChannel, sourceMessageId, null);
  }, [findNavigableChannel, handleOpenMessageRef, nav, openThread, showThreadRefNotice]);
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

  const handleSavedIndicatorClick = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    handleToggleSave();
  }, [handleToggleSave]);

  // Context menu for "Convert to task"
  const [ctxMenu, setCtxMenu] = useState<{ anchorX: number; anchorY: number; x: number; y: number; source: "pointer" | "touch"; fromToolbar?: boolean } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  /** An action chosen in the message menu, recorded with how the menu was opened. */
  const trackFromMenu = useCallback((action: Parameters<typeof trackMessageAction>[0]) => {
    trackMessageAction(action, ctxMenu ? messageMenuSurface(ctxMenu) : "context_menu", inThread);
  }, [ctxMenu, inThread]);
  // Set when the toolbar's More button opened the menu from the keyboard:
  // focus moves into the menu, and Escape hands it back to this button.
  const ctxMenuReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  // iOS can emit a synthetic mousedown/click pair after long-press touchend.
  // Keep a short-lived portal shield mounted so neither event reaches the
  // outside-click overlay and closes the menu as soon as the finger lifts.
  const [ctxMenuClickShielded, setCtxMenuClickShielded] = useState(false);
  // Every emoji, opened by Add Reaction (`smile-plus`) at the end of the
  // menu's quick reactions; it opens where the menu was.
  // `focusSearch`: opened from the keyboard, so focus goes to its search field.
  const [emojiPickerAt, setEmojiPickerAt] = useState<{ x: number; y: number; focusSearch: boolean } | null>(null);
  // Where Escape gives focus back when the picker was opened from the keyboard.
  const emojiPickerReturnFocusRef = useRef<HTMLElement | null>(null);
  const ctxMenuShieldTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleManualTranslate = useCallback(() => {
    if (!showManualTranslationAction || manualTranslationPending || !translationTargetLanguage) return;
    trackFromMenu("translate");
    setCtxMenu(null);
    void requestTranslations([message], {
      targetLanguage: translationTargetLanguage,
      viewerUserId,
      force: true,
    });
  }, [
    trackFromMenu,
    manualTranslationPending,
    message,
    requestTranslations,
    showManualTranslationAction,
    translationTargetLanguage,
    viewerUserId,
  ]);
  const convertMessage = useTaskStore((s) => s.convertMessage);
  const channelTasks = useTaskStore((s) => s.tasks);


  // A task with no host message cannot use the thread-backed modal, so it
  // falls back to the legacy panel (@stdrc msg=1561f8fc). Everything reaching
  // this list has a host message by construction, but routing on the fact
  // rather than the assumption keeps the two paths honest.

  const serverTasks = useTaskStore((s) => s.serverTasks);
  // Task #662: full task payloads for inline task refs, keyed by (channel,
  // number) — task numbers repeat across channels, so a number-only key let
  // a ref's badge show another channel's task. A ref is "known" when its key
  // is here. Channel tasks win over the server cache for the same task.
  const taskByChannelNumber = useMemo(() => {
    const map = new Map<string, Task>();
    for (const t of serverTasks) map.set(taskRefKey(t.channelId, t.taskNumber), t);
    for (const t of channelTasks) map.set(taskRefKey(t.channelId, t.taskNumber), t);
    // The message's own linked task is always the freshest source for a ref
    // in that message's body.
    if (linkedTask) map.set(taskRefKey(linkedTask.channelId, linkedTask.taskNumber), linkedTask);
    return map;
  }, [channelTasks, serverTasks, linkedTask]);
  const taskContextChannelId = parentChannelId || message.channelId;
  const updateTaskStatus = useTaskStore((s) => s.updateTaskStatus);
  const [converting, setConverting] = useState(false);
  const pendingReactionEmojisRef = useRef<Set<string>>(new Set());
  const reactionFailureFlashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [reactionFailureEmoji, setReactionFailureEmoji] = useState<string | null>(null);
  const [reactionPicker, setReactionPicker] = useState<{ x: number; y: number } | null>(null);
  const reactionPickerRef = useRef<HTMLDivElement | null>(null);
  // Keep the rendered bar inside the viewport even if its real width differs
  // from REACTION_PICKER_WIDTH (see the metrics above).
  useLayoutEffect(() => {
    const element = reactionPickerRef.current;
    if (!reactionPicker || !element) return;
    const { width, height } = element.getBoundingClientRect();
    if (width === 0) return;
    const margin = REACTION_PICKER_VIEWPORT_MARGIN;
    const x = Math.max(margin, Math.min(reactionPicker.x, window.innerWidth - width - margin));
    const y = Math.max(margin, Math.min(reactionPicker.y, window.innerHeight - height - margin));
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    if (x !== reactionPicker.x || y !== reactionPicker.y) setReactionPicker({ x, y });
  }, [reactionPicker]);
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
  const closeSenderCtxMenu = useCallback(() => setSenderCtxMenu(null), []);

  const handleOpenThreadFromContextMenu = useCallback(() => {
    trackFromMenu("reply_in_thread");
    setCtxMenu(null);
    handleReplyInThread();
  }, [handleReplyInThread, trackFromMenu]);
  // Forward this message straight from its row (task #35). Only messages the
  // composer accepts get the entry: not system rows, action cards or bundles.
  const forwardMessage = useContext(MessageForwardContext);
  const canForwardThisMessage = !!forwardMessage && getForwardableMessages([message]).messages.length === 1;
  // The toolbar's More opens this context menu; system rows have none, and
  // select mode suppresses it.
  const canOpenMenuFromToolbar = !isSystem && !selectionActive;
  const handleForward = useCallback((event?: MouseEvent) => {
    event?.stopPropagation();
    trackMessageAction("forward", ctxMenu ? messageMenuSurface(ctxMenu) : "hover_toolbar", inThread);
    setCtxMenu(null);
    forwardMessage?.(message);
  }, [ctxMenu, forwardMessage, inThread, message]);
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
    reactionPickerTapOpenedAtRef.current = Number.NEGATIVE_INFINITY;
    setReactionPicker({
      x: Math.min(Math.max(desiredLeft, minLeft), maxLeft),
      y: Math.min(Math.max(desiredTop, REACTION_PICKER_VIEWPORT_MARGIN), maxTop),
    });
  }, [message.id]);

  // When a double tap opened the bar (see REACTION_PICKER_TAP_SHIELD_MS); minus
  // infinity when the bar opened from a button.
  const reactionPickerTapOpenedAtRef = useRef(Number.NEGATIVE_INFINITY);
  const positionReactionPickerAtTap = useCallback((point: MessageTapPoint) => {
    if (reactionPickerCloseTimerRef.current) {
      clearTimeout(reactionPickerCloseTimerRef.current);
      reactionPickerCloseTimerRef.current = null;
    }
    const margin = REACTION_PICKER_VIEWPORT_MARGIN;
    const maxLeft = Math.max(margin, window.innerWidth - REACTION_PICKER_WIDTH - margin);
    const aboveTop = point.y - REACTION_PICKER_TAP_CLEARANCE - REACTION_PICKER_HEIGHT;
    const belowTop = point.y + REACTION_PICKER_TAP_CLEARANCE;
    const roomBelow = belowTop + REACTION_PICKER_HEIGHT <= window.innerHeight - margin;
    window.dispatchEvent(new CustomEvent(REACTION_PICKER_EVENT, { detail: { messageId: message.id } }));
    reactionPickerTapOpenedAtRef.current = Date.now();
    setReactionPicker({
      x: Math.min(Math.max(point.x - REACTION_PICKER_WIDTH / 2, margin), maxLeft),
      y: aboveTop >= margin || !roomBelow ? Math.max(aboveTop, margin) : belowTop,
    });
  }, [message.id]);

  // Long-press to open context menu on mobile
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  // Where the current touch started; null when no finger is down on this row.
  const touchPointRef = useRef<{ x: number; y: number } | null>(null);

  const openTouchContextMenu = useCallback((point: { x: number; y: number }) => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressFired.current = true;
    trackMessageAction("open_menu", "long_press", inThread);
    setCtxMenu(placeTouchMessageContextMenu(point));
    setReactionPicker(null);
    setCtxMenuClickShielded(true);
    if (ctxMenuShieldTimerRef.current) clearTimeout(ctxMenuShieldTimerRef.current);
    ctxMenuShieldTimerRef.current = setTimeout(() => {
      setCtxMenuClickShielded(false);
      ctxMenuShieldTimerRef.current = null;
    }, 600);
  }, [inThread]);

  // Taps on a touch screen (raft-design states.md "Taps on a touch screen",
  // stdrc 2026-10-29): a tap opens the thread (nothing inside a thread), a
  // double tap opens the quick-reaction bar at the message, never a reaction
  // by itself. Select mode keeps its own tap, below. The bar opens at the
  // finger, not the row: a row taller than the screen would clamp it under
  // the finger.
  const openQuickReactionsAtTap = useCallback((point: MessageTapPoint) => {
    setCtxMenu(null);
    positionReactionPickerAtTap(point);
  }, [positionReactionPickerAtTap]);
  const readLongPressFired = useCallback(() => longPressFired.current, []);
  const touchTaps = useMessageTouchTaps({
    rowRef: messageRef,
    enabled: actionable && !isSystem && !selectionActive,
    onTap: hideThreadActions ? null : handleReplyInThread,
    onDoubleTap: canReact && !isSystem ? openQuickReactionsAtTap : null,
    longPressFired: readLongPressFired,
  });
  const { ownsClick: touchTapsOwnClick } = touchTaps;

  // When select mode is active for this message's channel, single-click (any
  // device) toggles selection instead and we suppress the thread-open path.
  // A click the browser derived from a touch belongs to the taps above. Any
  // other click on a device without hover (a screen reader's activation)
  // opens the thread at once.
  const selectThisMessage = useCallback((range: boolean) => {
    if (selectIntent) selectIntent.select(message.id, { range });
    else if (range) useSelectionStore.getState().selectRange([message.id], message.id);
    else toggleSelection(message.id);
  }, [message.id, selectIntent, toggleSelection]);
  // In select mode the whole row is the selection target: a click anywhere in
  // it (its links, thread and task cards, images, avatar) toggles it, or with
  // Shift takes the range from the anchor, and never opens what it landed on.
  // Capture phase: preventDefault stops a link's navigation, and
  // stopPropagation is needed too, because the row's buttons (thread card,
  // task chip, image, avatar) act in their own onClick, which preventDefault
  // does not stop. Portaled children (this row's menus) are not in the row's
  // DOM and keep their clicks.
  const handleSelectClickCapture = useCallback((e: MouseEvent) => {
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    // The release of a long-press that opened the selection menu.
    if (longPressFired.current) {
      longPressFired.current = false;
      return;
    }
    selectThisMessage(e.shiftKey);
  }, [selectThisMessage]);
  // Shift+mousedown would extend the browser's text selection across every
  // row up to here; in select mode Shift+click is a range of messages.
  const handleSelectMouseDown = useCallback((e: MouseEvent) => {
    if (e.shiftKey) e.preventDefault();
  }, []);
  // A middle-click on a link would open it in a new tab: in select mode the
  // row is the target, so it does nothing.
  const handleSelectAuxClickCapture = useCallback((e: MouseEvent) => {
    if (!(e.target instanceof Node) || !e.currentTarget.contains(e.target)) return;
    e.preventDefault();
  }, []);
  // A mouse or pen press is a new gesture: a touch long-press before it must
  // not swallow its click (the flag is otherwise reset only by a touch).
  const touchTapsPointerDown = touchTaps.handlers.onPointerDown;
  const handleRowPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") longPressFired.current = false;
    touchTapsPointerDown?.(e);
  }, [touchTapsPointerDown]);

  const handleMobileTap = useCallback((e: MouseEvent) => {
    // Select mode's click is the capture handler's.
    if (selectionScopedHere) return;
    if (touchTapsOwnClick()) return;
    if (hideThreadActions) return;
    // Don't open thread if long-press context menu just fired
    if (longPressFired.current) return;
    // Only on touch devices (no hover capability); jsdom suites without a
    // matchMedia stub are treated as touch (the target filter below still
    // exempts interactive elements, so the guard stays behavior-neutral).
    if (typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches) return;
    // Don't intercept clicks on interactive elements (links, buttons, code blocks, images)
    const target = e.target as HTMLElement;
    if (target.closest("a, button, pre, code, img")) return;
    handleReplyInThread();
  }, [hideThreadActions, handleReplyInThread, selectionScopedHere, touchTapsOwnClick]);

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
    // Android Chrome also fires contextmenu for a touch long-press (task #50).
    // While a finger is down, the touch path owns the gesture: open the touch
    // menu now if the timer has not fired yet (Android's 400ms can beat our
    // 500ms), and never a second, pointer-placed one.
    if (touchPointRef.current) {
      if (!longPressFired.current) openTouchContextMenu(touchPointRef.current);
      return;
    }
    trackMessageAction("open_menu", "context_menu", inThread);
    setCtxMenu({
      anchorX: e.clientX,
      anchorY: e.clientY,
      x: e.clientX,
      y: e.clientY,
      source: "pointer",
    });
    setReactionPicker(null);
  }, [inThread, isSystem, selectionActive, openTouchContextMenu]);

  // The hover toolbar's shortcuts (message_action_selected surface hover_toolbar).
  const handleToolbarReplyInThread = useCallback(() => {
    trackMessageAction("reply_in_thread", "hover_toolbar", inThread);
    handleReplyInThread();
  }, [handleReplyInThread, inThread]);
  const handleToolbarToggleSave = useCallback(() => {
    trackMessageAction(isSaved ? "unsave" : "save", "hover_toolbar", inThread);
    handleToggleSave();
  }, [handleToggleSave, inThread, isSaved]);

  // The hover toolbar's More button opens the same menu under itself.
  const handleOpenMenuFromToolbar = useCallback((e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const anchor = { x: rect.left, y: rect.bottom + 4 };
    // detail 0: activated with Enter/Space rather than a pointer click.
    ctxMenuReturnFocusRef.current = e.detail === 0 ? e.currentTarget : null;
    trackMessageAction("open_menu", "toolbar_menu", inThread);
    setCtxMenu({ anchorX: anchor.x, anchorY: anchor.y, x: anchor.x, y: anchor.y, source: "pointer", fromToolbar: true });
    setReactionPicker(null);
  }, [inThread]);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (isSystem) return;
    // A child overlay may portal its backdrop to document.body. React still
    // bubbles that touch through MessageItem, but DOM containment is the
    // ownership boundary: only touches physically inside the row may arm the
    // message long-press timer.
    if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
    // External links keep the browser's link menu, matching handleContextMenu.
    if (e.target.closest('a[target="_blank"]')) return;
    // Parity with handleContextMenu: once select mode is active, long-press
    // should not re-open the context menu either. Mobile users toggle
    // selection by tapping rows in select mode; the popup menu here would
    // only get in the way.
    // Every touch starts a new gesture, including one that opens no menu: a
    // long-press before it must not swallow this tap's click.
    longPressFired.current = false;
    if (selectionActive) return;
    const touch = e.touches[0];
    const point = { x: touch.clientX, y: touch.clientY };
    touchPointRef.current = point;
    longPressTimer.current = setTimeout(() => openTouchContextMenu(point), 500);
  }, [isSystem, selectionActive, openTouchContextMenu]);

  useEffect(() => () => {
    if (ctxMenuShieldTimerRef.current) {
      clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback((e: TouchEvent) => {
    touchPointRef.current = null;
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
    touchPointRef.current = null;
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  // Selection-quote v0 (#proj-chat task #32). Which composer the Quote lands
  // in — mirrors the "Share messages…" routing exactly so a thread reply
  // quotes into the thread composer, a thread parent rendered in ThreadPanel
  // quotes into that thread, and a channel-timeline row quotes into the
  // channel composer. A surface naming its composer wins: task replies have no
  // parent message or threadId, so inference would pick the channel composer.
  const quoteComposerChannelId = useMemo(() => {
    if (mentionComposerChannelId) return mentionComposerChannelId;
    if (parentMessageId) return message.channelId; // thread reply → thread channel
    if (hideThreadActions && message.threadId) return message.threadId; // parent in ThreadPanel
    return parentChannelId || message.channelId; // channel timeline
  }, [mentionComposerChannelId, parentMessageId, hideThreadActions, message.threadId, parentChannelId, message.channelId]);

  const handleConvertToTask = useCallback(async () => {
    trackFromMenu("convert_to_task");
    setCtxMenu(null);
    setConverting(true);
    try {
      await convertMessage(message.id);
    } catch (err) {
      console.error("Failed to convert message to task:", err);
    } finally {
      setConverting(false);
    }
  }, [convertMessage, message.id, trackFromMenu]);

  const openTaskFromList = useOpenTask();
  // Task v2: a task is created FROM a message (it hangs under it; several may),
  // never "converted" from it (@stdrc).
  const taskV2 = useServerFeatureFlag(TASK_V2_CONVERSATIONS_FLAG_KEY).enabled;
  const [createFromMessageOpen, setCreateFromMessageOpen] = useState(false);
  const openCreateFromMessage = useCallback(() => {
    trackFromMenu("create_task");
    setCtxMenu(null);
    setCreateFromMessageOpen(true);
  }, [trackFromMenu]);
  const closeCreateFromMessage = useCallback(() => setCreateFromMessageOpen(false), []);
  const createFromMessageSource = useMemo(
    () => ({ id: message.id, senderName: senderDisplayName, text: message.content }),
    [message.id, message.content, senderDisplayName],
  );

  const openLinkedTask = useCallback(() => {
    if (!linkedTask) return;
    if (opensAsTaskConversation(linkedTask, taskV2)) {
      // Task v2: the task's own conversation, not its message's thread — for
      // a task made the v2 way whatever the flag says.
      openTaskConversationDialog(linkedTask);
      return;
    }
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
  }, [linkedTask, openThread, openLegacyTask, taskV2]);

  const handleToggleTaskDone = useCallback(async () => {
    if (!linkedTask) return;
    trackFromMenu(linkedTask.status === "done" ? "task_reopen" : "task_done");
    setCtxMenu(null);
    const nextStatus = linkedTask.status === "done" ? "todo" : "done";
    try {
      await updateTaskStatus(linkedTask.channelId, linkedTask.id, nextStatus);
    } catch (err) {
      console.error("Failed to update task status:", err);
    }
  }, [linkedTask, trackFromMenu, updateTaskStatus]);

  const handleFollowThread = useCallback(async () => {
    trackFromMenu("follow_thread");
    setCtxMenu(null);
    try {
      await followThread(message.id);
    } catch (err) {
      console.error("Failed to follow thread:", err);
    }
  }, [followThread, message.id, trackFromMenu]);

  const handleUnfollowThread = useCallback(async () => {
    if (!followedThreadChannelId) return;
    trackFromMenu("unfollow_thread");
    setCtxMenu(null);
    try {
      await unfollowThread(followedThreadChannelId);
    } catch (err) {
      console.error("Failed to unfollow thread:", err);
    }
  }, [followedThreadChannelId, trackFromMenu, unfollowThread]);

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

    return reactions.some((reaction) => (
      reaction.emoji === emoji
      && isLegacyMessageReaction(reaction)
      && reaction.reactorIds.includes(viewerUserId)
    ));
  }, [
    reactions,
    viewerUserId,
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
    const previousMessage = message;
    const getCurrentMessage = () => (
      useMessageStore.getState().channelMessages[message.channelId]?.find((cached) => cached.id === message.id)
      ?? message
    );
    const optimisticMessage = buildOptimisticReactionMessage(
      message,
      emoji,
      alreadyReacted,
      viewerUserId,
      viewerReactionName,
      formatMessage({ id: "message.author.unknown" }),
    );
    pendingReactionEmojisRef.current.add(emoji);

    useMessageStore.getState().updateMessage(optimisticMessage);
    try {
      const response = await setMessageReaction({
        serverId,
        messageId: message.id,
        emoji,
        active: !alreadyReacted,
      });
      pendingReactionEmojisRef.current.delete(emoji);
      // Every reaction added counts toward the toolbar button's emoji.
      if (!alreadyReacted) recordReactionUsage(viewerUserId, emoji);
      const currentMessage = getCurrentMessage();
      const reconciledMessage = mergeReactionResponsePreservingPending(
        currentMessage,
        response,
        pendingReactionEmojisRef.current,
      );
      useMessageStore.getState().updateMessage(reconciledMessage);
    } catch (err) {
      console.error("Failed to toggle reaction:", err);
      pendingReactionEmojisRef.current.delete(emoji);
      const currentMessage = getCurrentMessage();
      useMessageStore.getState().updateMessage(replaceReactionForEmoji(currentMessage, previousMessage, emoji));

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
    }
  }, [
    formatMessage,
    canReact,
    hasCurrentUserReaction,
    isSystem,
    message,
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

  const handleReactionClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setCtxMenu(null);
    if (reactionPicker) {
      closeReactionPicker();
    } else {
      trackMessageAction("open_reaction_picker", "hover_toolbar", inThread);
      openReactionPicker(e.currentTarget as HTMLElement);
    }
  }, [inThread, reactionPicker, closeReactionPicker, openReactionPicker]);

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

  // Every emoji, where the menu or the reaction bar was, kept inside the
  // window like the menu itself. Shared by the menu's Add Reaction and the
  // bar's (the one reaction bar, QuickReactionButtons).
  const openEmojiPickerAt = useCallback((at: { x: number; y: number } | null, fromKeyboard: boolean) => {
    if (!at || typeof window === "undefined") return;
    const margin = REACTION_PICKER_VIEWPORT_MARGIN;
    const width = Math.min(REACTION_EMOJI_PICKER_WIDTH, window.innerWidth - 2 * margin);
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    const maxY = Math.max(margin, window.innerHeight - REACTION_EMOJI_PICKER_HEIGHT - margin);
    setEmojiPickerAt({ x: Math.min(Math.max(at.x, margin), maxX), y: Math.min(Math.max(at.y, margin), maxY), focusSearch: fromKeyboard });
  }, []);
  // Add Reaction in the message menu.
  const handleOpenEmojiPickerFromMenu = useCallback((event: MouseEvent<HTMLElement>) => {
    const at = ctxMenu;
    trackFromMenu("open_reaction_picker");
    // detail 0: chosen with Enter or Space, not a pointer. Then focus goes to
    // the picker's search field, and Escape hands it back to where the menu
    // came from: the toolbar's More button when it opened the menu from the
    // keyboard, else the message row (as the menu's own Escape does).
    const fromKeyboard = event.detail === 0;
    emojiPickerReturnFocusRef.current = fromKeyboard ? (ctxMenuReturnFocusRef.current ?? messageRef.current) : null;
    ctxMenuReturnFocusRef.current = null;
    setCtxMenu(null);
    setCtxMenuClickShielded(false);
    if (ctxMenuShieldTimerRef.current) {
      clearTimeout(ctxMenuShieldTimerRef.current);
      ctxMenuShieldTimerRef.current = null;
    }
    openEmojiPickerAt(at, fromKeyboard);
  }, [ctxMenu, openEmojiPickerAt, trackFromMenu]);
  // Add Reaction at the end of the reaction bar.
  const handleOpenEmojiPickerFromBar = useCallback((event: MouseEvent<HTMLElement>) => {
    // The click the browser derives from the double tap that opened the bar.
    if (Date.now() - reactionPickerTapOpenedAtRef.current < REACTION_PICKER_TAP_SHIELD_MS) return;
    const at = reactionPicker;
    trackMessageAction("open_reaction_picker", "hover_toolbar", inThread);
    const fromKeyboard = event.detail === 0;
    emojiPickerReturnFocusRef.current = fromKeyboard ? messageRef.current : null;
    closeReactionPicker();
    openEmojiPickerAt(at, fromKeyboard);
  }, [closeReactionPicker, inThread, openEmojiPickerAt, reactionPicker]);
  const closeEmojiPicker = useCallback(() => {
    emojiPickerReturnFocusRef.current = null;
    setEmojiPickerAt(null);
  }, []);
  const emojiPickerStyle = useMemo(
    () => (emojiPickerAt ? { left: emojiPickerAt.x, top: emojiPickerAt.y } : undefined),
    [emojiPickerAt],
  );
  const handleEmojiPickerChoose = useCallback((emojiData: { emoji: string }) => {
    emojiPickerReturnFocusRef.current = null;
    setEmojiPickerAt(null);
    void handleToggleReaction(emojiData.emoji);
  }, [handleToggleReaction]);
  // Esc closes the reaction emoji picker (a layer while open); focus goes back to the message row, which takes it
  // only from script (tabIndex -1), as a located message does (raft-ui MessageItem, focus ring).
  useShortcutLayer("menu", !!emojiPickerAt, { ignoreDefaultPrevented: true, onEscape: () => {
    const returnFocus = emojiPickerReturnFocusRef.current;
    emojiPickerReturnFocusRef.current = null;
    setEmojiPickerAt(null);
    if (returnFocus && !returnFocus.hasAttribute("tabindex")) returnFocus.setAttribute("tabindex", "-1");
    returnFocus?.focus({ preventScroll: true });
  } });

  // The hover toolbar's reaction button (useToolbarQuickReaction): a click
  // toggles the favorite as its chip does; resting on it opens the reaction bar.
  const { quickReaction, rowHandlers: quickReactionRowHandlers } = useToolbarQuickReaction(viewerUserId, !!reactionPicker || !!ctxMenu || !!emojiPickerAt);
  const handleToolbarQuickReact = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    trackMessageAction("react_quick", "hover_toolbar", inThread);
    handleQuickReactionClick(quickReaction);
  }, [handleQuickReactionClick, inThread, quickReaction]);
  const handleToolbarReactionHoverOpen = useCallback((button: HTMLButtonElement) => {
    setCtxMenu(null);
    trackMessageAction("open_reaction_picker", "hover_toolbar", inThread);
    openReactionPicker(button);
  }, [inThread, openReactionPicker]);
  // The reaction buttons carry their emoji, so one stable handler serves each list.
  const handleReactionChipClick = useCallback((event: MouseEvent<HTMLElement>) => {
    const emoji = event.currentTarget.dataset.reactionEmoji;
    if (emoji) void handleToggleReaction(emoji);
  }, [handleToggleReaction]);
  const handleMenuQuickReactionClick = useCallback((event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    const emoji = event.currentTarget.dataset.reactionEmoji;
    if (!emoji) return;
    trackFromMenu("react_quick");
    handleQuickReactionClick(emoji);
  }, [handleQuickReactionClick, trackFromMenu]);
  const handleQuickReactionButtonClick = useCallback((event: MouseEvent<HTMLElement>) => {
    // The click the browser derives from the double tap that opened the bar.
    if (Date.now() - reactionPickerTapOpenedAtRef.current < REACTION_PICKER_TAP_SHIELD_MS) return;
    const emoji = event.currentTarget.dataset.reactionEmoji;
    if (emoji) handleQuickReactionClick(emoji);
  }, [handleQuickReactionClick]);
  const handleMobileReactionAddClick = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    setCtxMenu(null);
    if (reactionPicker) {
      closeReactionPicker();
    } else {
      openReactionPicker(event.currentTarget);
    }
  }, [closeReactionPicker, openReactionPicker, reactionPicker]);

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
      // Right after a double tap opened the bar, only a finger closes it.
      if (event.pointerType !== "touch" && Date.now() - reactionPickerTapOpenedAtRef.current < REACTION_PICKER_TAP_SHIELD_MS) return;
      // A finger outside the bar only closes it: no tap on the message, link
      // or composer under it. A mouse press keeps its own action.
      consumeDismissingTouch(event);
      closeReactionPicker();
    };
    const handleViewportChange = () => {
      closeReactionPicker();
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [closeReactionPicker, reactionPicker]);
  // Esc closes the reaction bar: a capture-phase layer, before the background hears it.
  useShortcutLayer("menu", !!reactionPicker, { phase: "capture", ignoreDefaultPrevented: true, onEscape: () => { closeReactionPicker(); } });

  useEffect(() => () => clearReactionPickerCloseTimer(), [clearReactionPickerCloseTimer]);

  const handleReactionPickerBoundaryEnter = useCallback(() => {
    clearReactionPickerCloseTimer();
  }, [clearReactionPickerCloseTimer]);

  const handleReactionPickerBoundaryLeave = useCallback((event: MouseEvent) => {
    if (!reactionPicker) return;
    // A double tap opened the bar: no mouse hovered it open, so no mouse
    // leaving closes it. The mouse events the browser derives from the taps,
    // or its fake mouse move after the layout changes, would otherwise close
    // it 120ms later with no further input. A press outside, a scroll or
    // Escape still does.
    if (Number.isFinite(reactionPickerTapOpenedAtRef.current)) return;
    if (isReactionPickerBoundaryTarget(event.relatedTarget)) return;
    scheduleReactionPickerClose();
  }, [isReactionPickerBoundaryTarget, reactionPicker, scheduleReactionPickerClose]);

  // The reactors tooltip: you first (when you reacted), then up to five
  // names, then "+N more" for the rest of the count.
  const reactionReactorNames = (reaction: NonNullable<Message["reactions"]>[number]) => {
    const actors = readReactionActors(reaction);
    const reactorNames = hasCurrentUserReaction(reaction.emoji) && viewerUserId
      ? [
        formatMessage({ id: "message.messageItem.reactorYou" }),
        ...actors.filter((actor) => actor.id !== viewerUserId).map((actor) => actor.displayName),
      ]
      : actors.map((actor) => actor.displayName);
    const visibleNames = reactorNames.slice(0, 5);
    return { visibleNames, hiddenCount: Math.max(0, reaction.count - visibleNames.length) };
  };

  const handleCopyLink = useCallback(() => {
    if (!serverSlug) return;
    trackFromMenu("copy_link");
    const channelForLink = parentChannelId || message.channelId;
    const routeKind = findNavigableChannel(channelForLink)?.type === "dm" ? "dm" : "channel";
    const url = buildMessagePermalink(serverSlug, channelForLink, message.id, {
      routeKind,
      threadParentMessageId: parentMessageId ?? null,
    });
    navigator.clipboard.writeText(url).then(() => {
      setCtxMenu(null);
    });
  }, [trackFromMenu, serverSlug, parentChannelId, parentMessageId, message.channelId, message.id, findNavigableChannel]);

  const handleOpenPermalink = useOpenRaftPermalink();

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

  // `channelId` is the channel the ref resolved in (`#proj:#7` → #proj);
  // legacy refs resolve in the conversation being read.
  const handleOpenTaskRef = useCallback((taskNumber: number, channelId?: string) => openTaskByChannelNumber({
    closeProfile,
    closeThread,
    toChannelTasks: (taskChannelId) => nav.toChannel(taskChannelId, { chatTab: "tasks" }),
    openLegacyTask,
    openThread,
    openTaskConversation: openTaskConversationDialog,
    taskV2Enabled: taskV2,
  }, channelId ?? taskContextChannelId, taskNumber), [closeProfile, closeThread, nav, openLegacyTask, openThread, taskContextChannelId, taskV2]);

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

  // Stryker disable all: audio open/loading/fallback behavior is covered by audioAttachmentPreview.behavior.test.tsx (removed in the 2026-11 web DOM test prune); remaining handler mutants are stale-concurrent/dependency glue.
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

  // Single stable open handler for the "other attachments" cards — the
  // image/html/video/document branching used to live in per-item closures.
  const handleOpenAttachmentCard = useCallback((att: NonNullable<Message["attachments"]>[number]) => {
    const isOptimistic = isOptimisticAttachment(att);
    if (isPreviewableImageAttachment(att) && !isOptimistic) {
      const imageIndex = lightboxImages.findIndex((img) => img.id === att.id);
      // No comment contexts: image comments descoped (cindyz 6/11).
      useImageLightboxStore.getState().open(lightboxImages, imageIndex >= 0 ? imageIndex : 0);
      return;
    }
    if (isPreviewableHtmlAttachment(att) && !isOptimistic) {
      void handleOpenHtmlPreview(att);
      return;
    }
    if (isPreviewableVideoAttachment(att) && !isOptimistic) {
      void handleOpenVideoPreview(att);
      return;
    }
    if (isPreviewableDocumentAttachment(att) && !isOptimistic) {
      void handleOpenDocumentPreview(att);
    }
  }, [lightboxImages, handleOpenHtmlPreview, handleOpenVideoPreview, handleOpenDocumentPreview]);

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

  const reactionPickerPopupStyle = useMemo(() => reactionPicker
    ? { left: reactionPicker.x, top: reactionPicker.y }
    : undefined, [reactionPicker]);
  const ctxMenuPopupStyle = useMemo(() => ctxMenu
    ? { left: ctxMenu.x, top: ctxMenu.y, maxHeight: "calc(100dvh - 16px)" }
    : undefined, [ctxMenu]);
  const senderCtxMenuPopupStyle = useMemo(() => senderCtxMenu
    ? { left: senderCtxMenu.x, top: senderCtxMenu.y }
    : undefined, [senderCtxMenu]);
  // View Context: the context behind an agent's message, beside its conversation (a phone: a page).
  const handleViewContextFromMenu = useCallback(() => {
    setCtxMenu(null);
    openAgentContextViewFor({
      agentId: message.senderId,
      messageId: message.id,
      agentName: senderDisplayName,
      agentAvatarUrl: agentAvatarUrl ?? null,
      content: message.content,
      createdAt: message.createdAt,
      conversationId: message.channelId,
      hostChannelId: parentChannelId || message.channelId,
    });
  }, [agentAvatarUrl, message.channelId, message.content, message.createdAt, message.id, message.senderId, parentChannelId, senderDisplayName]);
  const handleSaveFromMenu = useCallback(() => {
    trackFromMenu(isSaved ? "unsave" : "save");
    handleToggleSave();
    setCtxMenu(null);
  }, [handleToggleSave, isSaved, trackFromMenu]);
  // In a thread panel: the thread's own Mark as Unread (its header ⋯'s; the
  // whole thread, as the server marks it). In a channel's or DM's list: the
  // conversation's, and the message's own thread's when it is followed.
  const enclosingThreadMarkUnread = useEnclosingThreadMarkUnread();
  const menuMarkUnread = useMessageMenuMarkUnread({
    conversationId: dmSurfaceChannelId,
    topLevel: !readOnlyProjection && !parentMessageId,
    followedThreadChannelId,
    threadOpen: isOpenThreadParent,
  });
  const markThreadUnread = enclosingThreadMarkUnread ?? menuMarkUnread.markThreadUnread;
  const { markConversationUnread } = menuMarkUnread;
  const handleMarkConversationUnreadFromMenu = useCallback(() => {
    markConversationUnread?.();
    setCtxMenu(null);
  }, [markConversationUnread]);
  // Context-menu "keep going" section: Reply / Follow Thread / Mark Thread
  // as Unread / task action (cindyz, #wg-thread-unread: the thread's own
  // actions sit with Reply). Its divider renders only when one of them does.
  const showThreadTaskSection = !hideThreadActions
    || showOwnThreadFollowAction
    || !!enclosingThreadFollowCommand
    || !!markThreadUnread
    || (!parentMessageId && supportsMessageTasks && !isExternal);
  const handleMarkThreadUnreadFromMenu = useCallback(() => {
    markThreadUnread?.();
    setCtxMenu(null);
  }, [markThreadUnread]);
  const handleEnclosingThreadFollowFromMenu = useCallback(() => {
    if (!enclosingThreadFollowCommand) return;
    trackFromMenu(enclosingThreadFollowCommand.followed ? "unfollow_thread" : "follow_thread");
    enclosingThreadFollowCommand.onFollowAction();
    setCtxMenu(null);
  }, [enclosingThreadFollowCommand, trackFromMenu]);
  const handleCopySenderDisplayName = useCallback(() => {
    trackMessageAction("copy_sender_name", "sender_menu", inThread);
    void navigator.clipboard.writeText(senderDisplayName);
    setSenderCtxMenu(null);
  }, [inThread, senderDisplayName]);
  const handleCopySenderHandle = useCallback(() => {
    if (!senderHandleText) return;
    trackMessageAction("copy_sender_handle", "sender_menu", inThread);
    void navigator.clipboard.writeText(senderHandleText);
    setSenderCtxMenu(null);
  }, [inThread, senderHandleText]);
  const handleCopyMarkdown = useCallback(() => {
    trackFromMenu("copy_markdown");
    void navigator.clipboard.writeText(message.content).then(() => setCtxMenu(null));
  }, [message.content, trackFromMenu]);
  // "Select Text" (touch menu only): a bottom sheet with the message's text,
  // natively selectable, since the touch row itself is not (index.css
  // [data-touch-menu]). Mounted from the tap until its close animation ends.
  const [selectTextSheet, setSelectTextSheet] = useState<"closed" | "open" | "closing">("closed");
  const canSelectText = !isSystem && message.content.trim().length > 0;
  const handleOpenSelectText = useCallback(() => {
    trackFromMenu("select_text");
    setCtxMenu(null);
    setSelectTextSheet("open");
  }, [trackFromMenu]);
  const handleCloseSelectText = useCallback(() => setSelectTextSheet("closing"), []);
  const handleSelectTextClosed = useCallback(() => setSelectTextSheet("closed"), []);
  // "Select Message" (image-share) — the three entry modes (channel timeline,
  // thread reply row, thread parent in ThreadPanel) select only what is
  // mounted; the contract stays "what you see is what you share".
  const handleSelectShare = useCallback(() => {
    trackFromMenu("select");
    setCtxMenu(null);
    // A text selection left in the conversation would read as selected
    // messages once the rows are selection targets.
    window.getSelection()?.removeAllRanges();
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
    // Channel timeline: just this message. To share a thread the user opens
    // the panel and triggers select from there.
    enterSelection(message.channelId, [message.id]);
  }, [trackFromMenu, parentMessageId, parentChannelId, message.channelId, message.threadId, message.id, hideThreadActions, enterThreadSelection, enterSelection]);
  // The message menu is for outside select mode: one open when select mode
  // starts or ends here closes.
  const ctxMenuSelectionScopeRef = useRef(selectionScopedHere);
  useEffect(() => {
    if (ctxMenuSelectionScopeRef.current === selectionScopedHere) return;
    ctxMenuSelectionScopeRef.current = selectionScopedHere;
    setCtxMenu(null);
  }, [selectionScopedHere]);

  useEffect(() => {
    if (!ctxMenu) return;
    const handleViewportChange = (event: Event) => {
      if (event.target instanceof Node && ctxMenuRef.current?.contains(event.target)) return; // its own ScrollArea scrolled
      handleCloseCtx();
    };
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

  const ctxMenuOpen = Boolean(ctxMenu);
  useEffect(() => {
    if (!ctxMenuOpen) return;
    if (ctxMenuReturnFocusRef.current) {
      ctxMenuRef.current?.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus();
    }
  }, [ctxMenuOpen]);
  // The message context menu is a layer while open: Esc closes it (focus back to where it was opened from), and its
  // other keys move through its items.
  useShortcutLayer("menu", ctxMenuOpen, { ignoreDefaultPrevented: true, onEscape: () => {
    const returnFocus = ctxMenuReturnFocusRef.current;
    ctxMenuReturnFocusRef.current = null;
    handleCloseCtx();
    returnFocus?.focus();
  }, onKey: (event) => {
      // Arrow keys, Home and End move through the menu's items, the quick
      // reactions included, as in raft-ui's ContextMenu (raft-design
      // dropdown-menu.md, Accessibility): Up and Down go row by row, Left and
      // Right along the reactions. The first arrow key focuses the first item.
      const menu = ctxMenuRef.current;
      if (!menu) return;
      const nav = nextMessageMenuItem(menu, document.activeElement, event.key);
      if (!nav) return;
      event.preventDefault();
      nav.focus();
      return true;
  } });

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
    // A system line has no body to end: its read faces sit beside it.
    const withAgentReadFaces = (row: ReactNode) => (
      agentReadFaces ? <AgentReadSystemRow messageId={message.id}>{row}</AgentReadSystemRow> : row
    );
    // RFC 077: Raft's receipt for a message the assistant sent as its owner
    // is a card with the place, the message and Retract, not an event line;
    // so is the WeChat connected notice, with Disconnect WeChat.
    const delegatedReceipts = delegatedReceiptsOf(message.actionMetadata);
    const wechatNotice = isWeChatConnectedNotice(message);
    // A task handed to someone with a reason is a card with the reason as its
    // body, not the one-line notice (the line's text stays the record).
    const taskHandoff = readTaskHandoffNotice(message);
    if (taskHandoff) {
      return withAgentReadFaces(
        <MessageItem id={`message-${message.id}`} compact>
          <MessageItemGutter />
          <MessageItemContent>
            <TaskHandoffCard message={message} notice={taskHandoff} returned={taskHandoffReturn} time={time} />
          </MessageItemContent>
          <TimelineRevealTime dateTime={sentAtIso}>{gutterClock}</TimelineRevealTime>
        </MessageItem>
      );
    }
    if (wechatNotice || delegatedReceipts.length > 0 || joinedNotForwardedOf(message.actionMetadata).length > 0) {
      // Its own row, its left edge on the text column like the messages
      // around it (DS Identity and presence › Sent by an assistant).
      return withAgentReadFaces(
        <MessageItem id={`message-${message.id}`} compact>
          <MessageItemGutter />
          <MessageItemContent>
            {wechatNotice
              ? <WeChatConnectedNotice message={message} time={time} />
              : <DelegatedReceiptLines message={message} receipts={delegatedReceipts} time={time} />}
          </MessageItemContent>
          <TimelineRevealTime dateTime={sentAtIso}>{gutterClock}</TimelineRevealTime>
        </MessageItem>
      );
    }
    // A channel announcement's set, replace or remove line, in the reader's language (its text is the English record).
    const systemText = channelAnnouncementNoticeLine(message.actionMetadata, formatMessage) ?? message.content;
    const systemContentParts = splitReminderReceiptFireAtTokens(systemText);
    const systemContentTitle = formatReminderReceiptContentTitle(systemText, timeFormatOptions);
    return withAgentReadFaces(
      <SystemMessage id={`message-${message.id}`} className="pe-[calc((--spacing(4))+var(--message-rail-inset,0px))]">
        <SystemMessageTime>{time}</SystemMessageTime>
        {/* One line, truncated; the whole text is the line's native title (DS
            System message), beside the hover-only Tooltip. */}
        <SystemMessageContent title={systemContentTitle}>
          <Tooltip content={systemContentTitle}>
          <span className="block truncate">
          {systemContentParts.map((part, index) => (
            part.type === "reminderFireAt" ? (
              <Tooltip key={`${part.value}-${index}`} content={formatReminderReceiptTooltip(part.value, timeFormatOptions)}>
              <span>
                {formatReminderReceiptTime(part.value, formatMessage, new Date(), timeFormatOptions)}
              </span>
              </Tooltip>
            ) : (
              part.value
            )
          ))}
          </span>
          </Tooltip>
        </SystemMessageContent>
      </SystemMessage>
    );
  }

  return (
    <>
    <MessageItem
      ref={messageRef}
      id={`message-${message.id}`}
      onClick={actionable ? handleMobileTap : undefined}
      onClickCapture={actionable && selectionScopedHere ? handleSelectClickCapture : undefined}
      onMouseDown={actionable && selectionScopedHere ? handleSelectMouseDown : undefined}
      onAuxClickCapture={actionable && selectionScopedHere ? handleSelectAuxClickCapture : undefined}
      onContextMenu={actionable ? handleContextMenu : undefined}
      onTouchStart={actionable ? handleTouchStart : undefined}
      onTouchEnd={actionable ? handleTouchEnd : undefined}
      onTouchMove={actionable ? handleTouchMove : undefined}
      onTouchCancel={actionable ? handleTouchMove : undefined}
      onPointerDown={actionable ? handleRowPointerDown : undefined}
      onPointerMove={actionable ? touchTaps.handlers.onPointerMove : undefined}
      onPointerUp={actionable ? touchTaps.handlers.onPointerUp : undefined}
      onPointerCancel={actionable ? touchTaps.handlers.onPointerCancel : undefined}
      // index.css: on touch, a long-press here opens the message menu, so the
      // row's text is not selectable. Read-only rows have no menu and keep it.
      data-touch-menu={actionable ? "true" : undefined}
      onMouseEnter={handleReactionPickerBoundaryEnter}
      onMouseLeave={handleReactionPickerBoundaryLeave}
      {...(actionable ? quickReactionRowHandlers : null)}
      compact={!showSelectedGroupedHeader}
      data-popup-open={ctxMenu || reactionPicker ? "" : undefined}
      data-tap-pending={touchTaps.pressed ? "" : undefined}
      data-selected={isSelectedAsThreadParent || isSelected ? "true" : undefined}
      data-selection-active={selectionScopedHere ? "true" : undefined}
      data-highlighted={isHighlighted ? "true" : undefined}
      data-followed-by={followedBy}
      // raft-ui paints and fades the located highlight. The current thread
      // search match is painted through the row's own fill variable, the one
      // raft-ui's search match sets, so it is one fill (and the delegated
      // face's ring matches it), and it doesn't change on hover. An open menu
      // or picker needs nothing here: rui's data-popup-open state tints the
      // row the same way hover does (task #694). A tap waiting for a possible
      // second one shows the press at once: raft-ui's row has no press, so it
      // is painted here, in the medium tier (raft-design states.md, Hover and
      // press).
      located={isLocated}
      className={`${isThreadSearchMatch
 ? "[--mi-row-fill:var(--info-soft)] hover:[--mi-row-fill:var(--info-soft)]"
 : ""} ${touchTaps.pressed
 ? "[--mi-row-fill:var(--fill-medium)]"
 : ""} ${getMessageAvatarSizeClass(messageBodyFontSize)} pe-[calc((--spacing(2))+var(--message-rail-inset,0px))] ${className ?? ""}`.trim()}
    >
      {selectionScopedHere && actionable && (
        <MessageMultiSelectCheckbox
          // v1.5 (huxijin 2026-05-01): was `self-center`, which dropped the
          // circle into the vertical middle of the row. On long messages
          // this sits far below the viewport's top edge and users lose
          // track of which message they're toggling. Pin to the top row
          // (`self-start`) at avatar height so the indicator is always
          // visible alongside the sender name.
          checked={isSelected}
          aria-hidden="true"
          tabIndex={-1}
          className="pointer-events-none self-start mt-1.5"
          data-testid={`message-select-circle-${message.id}`}
        />
      )}
      {/* Hover action toolbar — the "骑线按钮组" pill. Extracted into its own
          component (stdrc). */}
      {/* Not in select mode: the row is a selection target there, and the
          actions on the selection live in its bottom toolbar. */}
      {actionable && !selectionScopedHere ? <MessageHoverToolbar
        isSaved={isSaved}
        reactionActive={!!reactionPicker}
        quickReaction={quickReaction}
        quickReacted={hasCurrentUserReaction(quickReaction)}
        hideThreadActions={hideThreadActions}
        isSystem={isSystem}
        canReact={canReact}
        onReplyInThread={handleToolbarReplyInThread}
        onReactionClick={handleReactionClick}
        onQuickReact={handleToolbarQuickReact}
        onReactionHoverOpen={handleToolbarReactionHoverOpen}
        onToggleSave={handleToolbarToggleSave}
        onForward={canForwardThisMessage ? handleForward : undefined}
        onMore={canOpenMenuFromToolbar ? handleOpenMenuFromToolbar : undefined}
        moreActive={!!ctxMenu?.fromToolbar}
      /> : null}
      {showSelectedGroupedHeader ? (
        <MessageItemGutter>
          {/* flex + items-start: the slot is otherwise a block box whose lone
              inline-block avatar button baseline-aligns; the agent avatar's
              status-dot badge drops that baseline and sinks the agent avatar
              ~9px below the human one. Flex items are blockified, so both
              kinds sit at margin-top only. (rui#305 may later move this into
              the recipe; the override stays harmless.) */}
          <MessageItemAvatarSlot className="flex items-start">
            <MessageSenderAvatar
          showAgent={isAgent && (!!senderAgent || !!readOnlySender || !!senderActor)}
          showExternal={isExternal}
          externalAnonymous={message.externalAuthor?.identityKind === "anonymous"}
          isDeactivatedAgent={isDeactivatedAgent}
          senderId={message.senderId}
          agentAvatarUrl={agentAvatarUrl}
          avatarUrl={humanAvatarUrl}
          hoverAgent={readOnlyProjection ? undefined : senderAgent}
          hoverMember={readOnlyProjection ? undefined : senderMember}
          readOnlySender={readOnlyProjection ? readOnlySender : undefined}
          externalAvatarUrl={externalAvatarUrl}
          externalDisplayName={senderDisplayName}
          externalProvider={isExternal ? message.externalAuthor?.provider ?? null : null}
          externalWorkspaceName={isExternal ? message.externalAuthor?.workspaceName ?? null : null}
          externalActorKind={isExternal ? message.externalAuthor?.actorKind ?? null : null}
          externalProfileDisplayName={isExternal ? message.externalAuthor?.profileDisplayName : undefined}
          externalProfileAvatarUrl={isExternal ? message.externalAuthor?.profileAvatarUrl : undefined}
          externalAppName={isExternal ? message.externalAuthor?.appName : undefined}
          testId={senderAvatarTestId}
          onNavigateAgent={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateAgent}
          onNavigateAgentActivity={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateAgentActivity}
          onNavigateHuman={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateHuman}
          onNavigateExternal={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateExternal}
          onContextMenu={readOnlyProjection ? undefined : handleSenderContextMenu}
          onLongPressMention={!readOnlyProjection && senderMention ? insertSenderMention : undefined}
          delegatedBy={delegatedBy}
          origin={senderOrigin}
            />
          </MessageItemAvatarSlot>
        </MessageItemGutter>
      ) : (
        // Continuation row (task #44): reserve the avatar column so the body
        // stays aligned with grouped rows above, and show this message's clock
        // (HH:MM) in that gutter — every message keeps a visible timestamp
        // (stdrc), aligned in a consistent left column instead of the header.
        <MessageItemGutter>
          <Tooltip content={gutterFullTimestamp}>
          <MessageItemContinuationTime
            dateTime={sentAtIso}
            data-gutter-time=""
            // No transition — the time reveals instantly on hover, like the row
            // border (stdrc: 时间不要动画呈现，跟边框一样立即出现). The DS
            // treatment (Space Mono 12, ink-3 on row hover) is the recipe's.
          >
            {gutterClock}
          </MessageItemContinuationTime>
          </Tooltip>
        </MessageItemGutter>
      )}
      <MessageItemContent>
        {groupState?.showName === false && !showSelectedGroupedHeader ? null : (
          <MessageItemHeader>
          {/* The name, notes and time stand on the name's baseline
              (raft-design alignment.md, "Text of different sizes on one
              line"): raft-ui's MessageItemHeader and MessageItemSenderGroup
              align that way. The size classes carry each style's line
              height from its tokens (appearanceStore). */}
          {/* Left cluster: name · [model · badges · description]. Space is
              given up in this order: description, then model, then name
              (Artea, task #743). The name never shrinks while the tail has
              room; it only truncates at max-w-full when it alone is wider than
              the cluster. The tail is a nested flex box so the name gets NO
              share of the shrink — a weighted shrink (shrink vs shrink-[999])
              still shaves a sub-pixel off the name and shows "C…". The time
              and status stay OUTSIDE the cluster, so a narrow panel can never
              clip them. */}
          <MessageItemSenderGroup>
          {senderMention ? (
            <Tooltip content={formatMessage({ id: "message.messageItem.mentionSender" }, { name: senderMention.name })}>
            <MessageItemSenderButton
              className={`max-w-full shrink-0 ${messageNameSizeClass}`}
              onClick={handleSenderNameMention}
              onContextMenu={readOnlyProjection ? undefined : handleSenderContextMenu}
              data-testid={`message-sender-mention-${message.id}`}
            >
              {senderDisplayName}
            </MessageItemSenderButton>
            </Tooltip>
          ) : (
            <MessageItemSender
              className={`${isExternal && message.externalAuthor?.actorKind === "bot" ? "max-w-[45%] min-w-0 shrink" : "max-w-full shrink-0"} ${messageNameSizeClass}`}
              onContextMenu={readOnlyProjection ? undefined : handleSenderContextMenu}
            >
              {senderDisplayName}
            </MessageItemSender>
          )}
          {/* Member labels (#wg-rbac:#46): the avatar's server tile is
              decoration; where the sender is from is read here, after the name. */}
          {senderOrigin.servers.length > 0 ? (
            <span className="sr-only" data-testid={`message-sender-origin-${message.id}`}>
              {formatMessage({ id: "message.profilePreview.fromServers" }, { servers: originServerNames(senderOrigin) })}
            </span>
          ) : null}
          <span data-testid={`message-sender-tail-${message.id}`} className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
          {(isAppBotSender || (!readOnlyProjection && isExternal && message.externalAuthor?.actorKind === "bot")) && (
            <AppBadge truncateLabel={isExternal} className={isExternal ? "max-w-24 sm:max-w-52 min-w-12 shrink overflow-hidden" : "shrink-0"} appName={isAppBotSender ? senderAgent?.managedByApp?.name : message.externalAuthor?.appName} botName={senderDisplayName} />
          )}
          {agentModelLabelText && (
            <Tooltip content={agentModelLabelText}>
            <MessageItemMeta
              render={<span />}
              className={`min-w-0 max-w-full shrink-0 truncate ${messageMetaSizeClass}`}
              data-testid={`message-sender-model-${message.id}`}
            >
              {agentModelLabelText}
            </MessageItemMeta>
            </Tooltip>
          )}
          {isDeactivatedAgent && (
            <Badge appearance="soft" variant="muted">
              {formatMessage({ id: "message.messageItem.deletedBadge" })}
            </Badge>
          )}
          {humanDepartureLabel && (
            <Badge appearance="soft" variant="muted">
              {humanDepartureLabel}
            </Badge>
          )}
          {senderSubtitle && (
            <Tooltip content={senderSubtitle}>
            <MessageItemMeta
              render={<span />}
              className={`min-w-0 ${(isExternal && message.externalAuthor?.actorKind === "bot") || senderDescriptionText ? "shrink-0" : "shrink"} truncate ${messageMetaSizeClass}`}
              data-select-screenshot-human-role={senderSubtitleIsHumanRoleLabel ? "true" : undefined}
            >
              {senderSubtitle}
            </MessageItemMeta>
            </Tooltip>
          )}
          {senderDescriptionText && (
            <Tooltip content={senderDescriptionText}>
            <MessageItemMeta
              render={<span />}
              className={`min-w-0 shrink truncate ${messageMetaSizeClass}`}
              data-testid={`message-sender-description-${message.id}`}
            >
              {senderDescriptionText}
            </MessageItemMeta>
            </Tooltip>
          )}
          </span>
          </MessageItemSenderGroup>
          {delegatedBy ? <DelegatedByLabel delegatedBy={delegatedBy} messageId={message.id} /> : null}
          {/* The time follows the sender cluster (task #115). The header keeps
              no room for the hover toolbar (raft-ui 0.23): while the toolbar
              shows, it may cover the end of a line long enough to reach the
              corner, which fades out under it; hovering never reflows the
              line. Its tooltip carries the full date and time. */}
          <Tooltip content={gutterFullTimestamp}>
          <MessageItemTime dateTime={sentAtIso} className={messageTimeSizeClass}>{time}</MessageItemTime>
          </Tooltip>
          {converting && (
            <MessageItemInlineStatus render={<span />}>
              {formatMessage({ id: "message.messageItem.converting" })}
            </MessageItemInlineStatus>
          )}
          </MessageItemHeader>
        )}
        <AttachmentCommentRefChip
          commentRef={message.commentRef}
          onJumpToHost={handleJumpToCommentHost}
          bodyFontSizeClass={messageBodyFontSizeClass}
        />
        <MessageLinkCardsProvider value={linkCards.links} blocks={linkCards.blocks} blocksIn={showBilingualOriginal ? message.content : visibleMessageContent}>
        <CollapsibleMessageContent
          key={message.id}
          messageId={message.id}
          measurementKey={message.randomId ?? message.id}
          measureBeforePaint={message.id.startsWith("optimistic-")}
          disabled={isActionCardMessage || !!messageCard || !!forwardedBundleMetadata || !collapseLongMessages}
        >
        <MessageItemBody
          ref={messageBodyRef}
          data-message-selectable={retracted ? undefined : "true"}
          data-message-id={message.id}
          data-quote-channel-id={quoteComposerChannelId}
          data-message-font-size={messageBodyFontSize}
          className={`${messageBodyFontSizeClass}${followedBy && !inlineReplySurfaceReplacesBadge ? ` ${FOLLOWED_BODY_ENDING}` : ""}`}
          style={messageBodyFontSizeStyle}
        >
          {(() => {
            // RFC 077: a retracted message keeps its place; its body is the
            // muted placeholder, like an unavailable quote, never body text.
            if (retracted) {
              return (
                <span className="text-foreground-hint" data-testid={`message-retracted-${message.id}`}>
                  {formatMessage({ id: "message.delegated.retracted" })}
                </span>
              );
            }
            // Operation card (B-mode): the message body IS the card. Skip
            // markdown rendering and inline the structured card from
            // `actionMetadata`.
            if (isActionCardMessage) {
              return (
                <ActionCard
                  messageId={message.id}
                  metadata={message.actionMetadata as ActionCardMetadata}
                  channelId={message.channelId}
                  parentChannelId={parentChannelId || undefined}
                />
              );
            }
            if (messageCard) return <MessageCardBody read={messageCard} />;
            if (isTranslationPending) {
              return (
                <Skeleton
                  variant="line"
                  className="inline-block w-44 max-w-full align-middle"
                  data-testid={`message-translation-placeholder-${message.id}`}
                  data-select-screenshot-transient-state="true"
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
                channelParticipantExternalsById={channelParticipantExternalsById}
                unavailableQuotedPermalinkUrl={unavailableQuotedPermalinkUrl}
                onNavigateChannel={readOnlyProjection ? onReadOnlyNavigateChannel ?? ignoreReadOnlyProjectionNavigation : handleNavigateChannel}
                onNavigateDm={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateDm}
                onNavigateAgent={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateAgent}
                onNavigateHuman={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateHuman}
                onNavigateExternal={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateExternalMention}
                onOpenThread={readOnlyProjection ? undefined : handleOpenThreadRef}
                resolvingThreadRefKey={resolvingThreadRefKey}
                onOpenTask={readOnlyProjection ? undefined : handleOpenTaskRef}
                onOpenMessage={readOnlyProjection ? undefined : handleOpenMessageRef}
                onOpenPermalink={readOnlyProjection ? undefined : handleOpenPermalink}
                serverSlug={serverSlug}
                refAuthorityServerSlug={refAuthorityServerSlug}
                threadRefAuthorityUnavailable={readOnlyProjection || threadRefAuthorityUnavailable}
                taskContextChannelId={taskContextChannelId}
                taskByChannelNumber={taskByChannelNumber}
                timeFormatOptions={timeFormatOptions}
                threadSearchHighlightQuery={threadSearchHighlightQuery}
                searchHitQuery={searchHitQuery}
                mentionsDisplayOnly={readOnlyProjection}
              />
            );
          })()}
          {/* A continuation row has no header: the words end the text instead
              (DS MessageItem › Sent by an assistant), without the face. */}
          {delegatedBy && groupState?.showName === false && !showSelectedGroupedHeader ? (
            <div data-testid={`message-delegated-continuation-${message.id}`}>
              <DelegatedByLabel delegatedBy={delegatedBy} inBody messageId={message.id} />
            </div>
          ) : null}
          {agentReadFaces ? <AgentReadFaces messageId={message.id} /> : null}
        </MessageItemBody>
        {showBilingualOriginal ? (
          <MessageItemTranslationOriginal
            className="mt-1.5"
            data-testid={`message-translation-bilingual-original-${message.id}`}
          >
            <MessageItemTranslationOriginalLabel>
              {formatMessage({ id: "message.messageItem.bilingualOriginal" })}
            </MessageItemTranslationOriginalLabel>
            <div
              className={`${messageBodyFontSizeClass} break-words select-text [&_*]:select-text`}
              style={getMessageBodyFontSizeStyle(messageBodyFontSize)}
            >
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
                channelParticipantExternalsById={channelParticipantExternalsById}
                unavailableQuotedPermalinkUrl={unavailableQuotedPermalinkUrl}
                onNavigateChannel={readOnlyProjection ? onReadOnlyNavigateChannel ?? ignoreReadOnlyProjectionNavigation : handleNavigateChannel}
                onNavigateDm={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateDm}
                onNavigateAgent={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateAgent}
                onNavigateHuman={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateHuman}
                onNavigateExternal={readOnlyProjection ? ignoreReadOnlyProjectionNavigation : handleNavigateExternalMention}
                onOpenThread={readOnlyProjection ? undefined : handleOpenThreadRef}
                resolvingThreadRefKey={resolvingThreadRefKey}
                onOpenTask={readOnlyProjection ? undefined : handleOpenTaskRef}
                onOpenMessage={readOnlyProjection ? undefined : handleOpenMessageRef}
                onOpenPermalink={readOnlyProjection ? undefined : handleOpenPermalink}
                serverSlug={serverSlug}
                refAuthorityServerSlug={refAuthorityServerSlug}
                threadRefAuthorityUnavailable={readOnlyProjection || threadRefAuthorityUnavailable}
                taskContextChannelId={taskContextChannelId}
                taskByChannelNumber={taskByChannelNumber}
                timeFormatOptions={timeFormatOptions}
                threadSearchHighlightQuery={threadSearchHighlightQuery}
                searchHitQuery={searchHitQuery}
                mentionsDisplayOnly={readOnlyProjection}
              />
            </div>
          </MessageItemTranslationOriginal>
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
        {!readOnlyProjection && !forwardedBundleMetadata && (
          <LinkCardBoundary><ArtifactMessageRefs links={linkCards.objects} /></LinkCardBoundary>
        )}
        {!readOnlyProjection && quotedPermalink && !quotedPermalinkUnavailable ? (
          // The linked message as this viewer may see it (its conversation,
          // author, words): never in a share image, in any state. The marker
          // is on the box that carries the margin, so no gap is left either.
          <div className="mt-1.5" data-select-screenshot-viewer-only="true">
            <QuotedMessagePermalinkPreview
              permalink={quotedPermalink.parsed}
              onOpen={handleOpenQuotedPermalink}
              onUnavailable={handleQuotedPermalinkUnavailable}
            />
          </div>
        ) : null}
        </CollapsibleMessageContent>
        </MessageLinkCardsProvider>
        {/* Attached files */}
        {message.attachments && message.attachments.length > 0 ? (
          <ScreenshotAttachmentSummary attachments={message.attachments} />
        ) : null}
        {readOnlyProjection && message.attachments && message.attachments.length > 0 ? (
          <div data-select-screenshot-attachment-content="true">
            <ReadOnlyMessageAttachments attachments={message.attachments} />
          </div>
        ) : null}
        {!readOnlyProjection && !forwardedBundleMetadata && message.attachments && message.attachments.length > 0 && (() => {
          return renderWithImageInlineFallback(imageFallbackKey, (imageFallbackUrls) => {
            // Stryker disable all: pre-existing attachment classification moved under the fallback seam.
            if (!message.attachments) return null;
            const renderedImages = imagePreviewAttachments.filter((att) => (
              !!getImageGalleryPreviewSrc(att, imageFallbackUrls)
            ));
            const imageRows = buildMessageImageGalleryRows(renderedImages);
            const videoAttachments = message.attachments.filter((att) => isPreviewableVideoAttachment(att));
            const audioAttachments = message.attachments.filter((att) => isPreviewableAudioAttachment(att));
            const otherAttachments = message.attachments.filter((att) => {
              if (!isPreviewableImageAttachment(att)) return true;
              return shouldRenderImageAsAttachmentChip(att, imageFallbackUrls);
            }).filter((att) => !isPreviewableVideoAttachment(att) && !isPreviewableAudioAttachment(att));
            // Stryker restore all

          return (
            <div className="mt-1 stack-y-2" data-select-screenshot-attachment-content="true">
              {/* Josh's ending matrix: image-terminated rows sit 1px short of
                  the rhythm; same one-pixel knife as the reply card (#9444). */}
              {imageRows.length > 0 && (
                <MessageImageGallery className="group-data-[followed-by]/message:mb-px">
                  {imageRows.map((row, rowIndex) => (
                    <MessageImageGalleryRow
                      key={`${row.items.map((item) => renderedImages[item.index].id).join("-")}-${rowIndex}`}
                      row={row}
                    >
                      {row.items.map((item) => {
                        const att = renderedImages[item.index];
                        const previewSrc = getImageGalleryPreviewSrc(att, imageFallbackUrls);
                        if (!previewSrc) return null;
                        return (
                          <GalleryImageItem
                            key={att.id}
                            att={att}
                            previewSrc={previewSrc}
                            isOptimistic={isOptimisticAttachment(att)}
                            imageIndex={lightboxImages.findIndex((img) => img.id === att.id)}
                            lightboxImages={lightboxImages}
                            layout={item}
                            onDownload={handleDownloadAttachment}
                          />
                        );
                      })}
                    </MessageImageGalleryRow>
                  ))}
                </MessageImageGallery>
              )}
              {videoAttachments.length > 0 && (
                <div className="stack-y-2 group-data-[followed-by]/message:mb-px">
                  {videoAttachments.map((att) => {
                    const isOptimistic = isOptimisticAttachment(att);
                    return (
                      <InlineVideoAttachmentCard
                        key={att.id}
                        attachment={att}
                        isOptimistic={isOptimistic}
                        onOpenPreview={handleOpenVideoPreview}
                        onDownload={handleDownloadAttachment}
                      />
                    );
                  })}
                </div>
              )}
              {audioAttachments.length > 0 && (
                <div className="stack-y-2">
                  {audioAttachments.map((att) => {
                    const isOptimistic = isOptimisticAttachment(att);
                    return (
                      <InlineAudioAttachmentCard
                        key={att.id}
                        attachment={att}
                        isOptimistic={isOptimistic}
                        onDownload={handleDownloadAttachment}
                      />
                    );
                  })}
                </div>
              )}
              {otherAttachments.length > 0 && (
                <MessageAttachmentGroup className="max-w-[22.5rem] group-data-[followed-by]/message:mb-px">
                  {otherAttachments.map((att) => {
                    const isImage = isPreviewableImageAttachment(att);
                    const isHtml = isPreviewableHtmlAttachment(att);
                    const isVideo = isPreviewableVideoAttachment(att);
                    const isOptimistic = isOptimisticAttachment(att);
                    const isHtmlLoading = htmlPreviewLoadingId === att.id || videoPreviewLoadingId === att.id || documentPreviewLoadingId === att.id;
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
                        onClick={handleOpenAttachmentCard}
                        onDownload={handleDownloadAttachment}
                        messageId={message.id}
                        conversationId={message.channelId}
                      />
                    );
                  })}
                </MessageAttachmentGroup>
              )}
              {/* Any attachment saved as an Artifact (images and video too, when the server says so): one line each, under them all. */}
              <ArtifactSavedAttachments attachments={message.attachments} />
	            </div>
	          );
	          });
	        })()}
        {activeTranslationEntry && shouldRenderTranslationIndicator(activeTranslationEntry) ? (
	          <div className="mt-0">
	            <TranslationIndicator
	              entry={activeTranslationEntry}
	              showOriginal={activeTranslationShowOriginal}
	              onToggleOriginal={handleToggleTranslationOriginal}
	              onRetry={handleRetryTranslation}
	              onUpgrade={handleUpgradePlan}
	            />
	          </div>
	        ) : null}
        {/* Many tasks per message (task v2): the list replaces the single footer chip,
            and sits above the replies, which stay the message's own discussion. */}
        {linkedTaskList ? <TaskChipList tasks={linkedTaskList} onOpenTask={openTaskFromList} /> : null}
        {createFromMessageOpen ? (
          <CreateTaskDialog
            channelId={message.channelId}
            onClose={closeCreateFromMessage}
            sourceMessage={createFromMessageSource}
          />
        ) : null}
        {/* Footer metadata/actions — below translation status and the full message content block. */}
        {(
          // Stryker disable all: footer badge visibility/editability behavior is pre-existing; this PR only swaps Badge chrome to raft-ui.
          linkedTask ||
          isSaved ||
          visibleReactions.length > 0 ||
          hasThreadFooterMetadata
          // Stryker restore all
        ) ? (
          // The footer can end a message (saved marker, reactions) — same
          // one-pixel knife as the other short endings (Josh's matrix).
          <MessageItemFooter className="mt-1.5 flex flex-wrap items-center gap-1.5 group-data-[followed-by]/message:mb-px">
            {linkedTask && (() => {
              const fullLabel = linkedTask.claimedByName ? `task #${linkedTask.taskNumber} @${linkedTask.claimedByName}` : `task #${linkedTask.taskNumber}`;
              const assignee = linkedTask.claimedByName
                ? taskAssigneeHandle(linkedTask.claimedByName)
                : null;
              // Source of truth: rui's task-status appearance (the legacy
              // inline STATUS_BADGE_CONFIG was removed — the footer chip is rui's
              // `TaskChip`, coloured from the same `task-status-*` tokens as
              // every other surface).
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
                <Tooltip content={fullLabel}>
                <button
                  type="button"
                  onClick={openLinkedTask}
                  className={`inline-flex min-w-0 max-w-full items-center overflow-hidden whitespace-nowrap ${WRAPPED_CHIP_PRESS_CLASS}`}
                  aria-label={formatMessage({ id: "task.chip.openAria" }, { taskNumber: linkedTask.taskNumber, title: linkedTask.title })}
                  data-message-affordance="open-linked-task"
                >
                  <TaskChip
                    status={toRuiTaskStatus(linkedTask.status)}
                    data-testid="message-task-badge"
                    data-task-status={linkedTask.status}
                  >
                    <TaskStatusIcon status={toRuiTaskStatus(linkedTask.status)} />
                    <span className="shrink-0">{taskNumberSigil(linkedTask.taskNumber)}</span>
                    {assignee}
                  </TaskChip>
                </button>
                </Tooltip>
              );
            })()}
            {isSaved ? (
              <MessageItemSavedIndicator
                render={<button type="button" />}
                data-message-affordance="saved-badge"
                aria-label={formatMessage({ id: "message.messageItem.removeFromSaved" })}
                onClick={handleSavedIndicatorClick}
              >
                <Bookmark size={10} className="shrink-0" />
                <span className="shrink-0">{formatMessage({ id: "message.messageItem.saved" })}</span>
              </MessageItemSavedIndicator>
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
              const reactionLabel = formatMessage({ id: "message.messageItem.reactionAria" }, { emoji: reaction.emoji, reactors: reactorSummary });
              const reactionContent = (
                <>
                  <MessageReactionGlyph>
                    <ReactionGlyph emoji={reaction.emoji} size={16} className="block" />
                  </MessageReactionGlyph>
                  <MessageReactionCount>{reaction.count}</MessageReactionCount>
                </>
              );
              return (
                <span
                  key={reaction.emoji}
                  className="inline-flex"
                  data-select-screenshot-reaction="true"
                >
                  {canReact ? (
                    // raft-ui MessageReactionChip (a Base UI Toggle: aria-pressed
                    // says whether you reacted, yours on attention-soft); a failed
                    // toggle flashes the orange-soft problem wash.
                    <RaftTooltip>
                      <TooltipTrigger
                        delay={0}
                        closeDelay={0}
                        render={(
                          <MessageReactionChip
                            pressed={currentViewerReacted}
                            onClick={handleReactionChipClick}
                            data-reaction-emoji={reaction.emoji}
                            className={showFailureFlash ? REACTION_FAILURE_FLASH_CLASS : undefined}
                            aria-label={reactionLabel}
                          />
                        )}
                      >
                        {reactionContent}
                      </TooltipTrigger>
                      <MessageReactionTooltipContent side="bottom" align="start" sideOffset={4}>
                        <ReactionReactorsTooltipBody
                          emoji={reaction.emoji}
                          {...reactionReactorNames(reaction)}
                        />
                      </MessageReactionTooltipContent>
                    </RaftTooltip>
                  ) : (
                    // Read-only (no reacting here): the same chip, inert. A Toggle
                    // would still be a button, so the look is drawn on a span.
                    <span
                      className={`${READ_ONLY_REACTION_CHIP_CLASS} ${currentViewerReacted ? "bg-attention-soft" : "bg-fill-muted"}`}
                      aria-label={reactionLabel}
                    >
                      {reactionContent}
                    </span>
                  )}
                </span>
              );
            })}
              {!isSystem && canReact && visibleReactions.length > 0 ? (
                <span className="inline-flex md:hidden">
                  <Tooltip content={formatMessage({ id: "message.messageItem.addReaction" })}>
                  <MessageReactionAddButton
                    onClick={handleMobileReactionAddClick}
                    aria-label={formatMessage({ id: "message.messageItem.addReaction" })}
                    data-message-affordance="mobile-reaction-add"
                  >
                    <Plus strokeWidth={2} aria-hidden />
                  </MessageReactionAddButton>
                  </Tooltip>
                </span>
              ) : null}
          </MessageItemFooter>
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
        {/* An agent about to reply in this message's thread: said here, under
            the replies, not above the channel's composer (raft-design 0042). */}
        {!hideThreadActions && !readOnlyProjection ? (
          <AgentReplyingHint channelId={message.channelId} parentMessageId={message.id} />
        ) : null}
        {/* artin (option C): the read-status line under the message, below
            everything it owns (MessageReadStatusLine). */}
        {showDmReadReceipt ? (
          <DmReadStatusLine />
        ) : showAgentReadStatus && !readOnlyProjection ? (
          <AgentReadStatusLine messageId={message.id} />
        ) : null}
      </MessageItemContent>
      {/* Its time for the touch reveal: drag the conversation left. */}
      <TimelineRevealTime dateTime={sentAtIso}>{gutterClock}</TimelineRevealTime>
    </MessageItem>
    {reactionPicker && typeof document !== "undefined" && createPortal(
      <PopoverPopup
        ref={reactionPickerRef}
        className="fixed z-popup min-w-0 flex items-center gap-0.5 p-1"
        data-message-affordance="reaction-picker"
        {...dismissLayerProps}
        style={reactionPickerPopupStyle}
        onMouseEnter={handleReactionPickerBoundaryEnter}
        onMouseLeave={handleReactionPickerBoundaryLeave}
        onClick={stopClickPropagation}
      >
        <QuickReactionButtons onReact={handleQuickReactionButtonClick} onMore={handleOpenEmojiPickerFromBar} />
      </PopoverPopup>,
      document.body,
    )}
    {ctxMenu && !selectionScopedHere && createPortal(
      <>
        <DismissBackdrop onDismiss={handleCloseCtx} trapContextMenu />
        {ctxMenuClickShielded && (
          // Over the dismiss backdrop and under the menu (all z-popup, in
          // this DOM order) so it absorbs the iOS phantom outside-tap without
          // blocking menu rows.
          <DismissBackdrop onDismiss={handleCloseCtx} stopPropagation />
        )}
        <ContextMenuPopup
          ref={ctxMenuRef}
          className="fixed z-popup select-none p-0"
          role="menu"
          aria-label={formatMessage({ id: "message.messageItem.messageContextMenu" })}
          style={ctxMenuPopupStyle}
        >
          {/* The popup is the frame (max height, rounded clip); the items scroll in a raft-ui
              ScrollArea, the popup's padding on its content. The items take focus: no tab stop. */}
          <ScrollArea tabIndex={-1} className="min-h-0 flex-1" contentClassName="flex flex-col p-1">
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
              {/* raft-ui's quick row (raft-design dropdown-menu.md, "The
                  message menu"): 7 drawings at 22px, each a menu item the
                  arrow keys reach, then Add Reaction for every other emoji.
                  `px-0.75` lines the first drawing up with the items' icons
                  (10px in); raft-ui ships it as the row's own padding next. */}
              <MessageReactionQuickRow
                data-message-affordance="reaction-quick-row"
              >
                <QuickReactionButtons itemRole="menuitem" onReact={handleMenuQuickReactionClick} onMore={handleOpenEmojiPickerFromMenu} />
              </MessageReactionQuickRow>
              <ContextMenuDivider />
            </>
          )}
          {/* Sections, by what the action does (stdrc 2026-10-20 #proj-chat:2466beff):
              keep going on this message (thread + task — a task's discussion
              lives in its thread), take it elsewhere (nothing changes here),
              just for me (nobody else sees it). The hover toolbar is a
              shortcut for this menu and keeps its order. */}
          {showThreadTaskSection && (
            <>
              {!hideThreadActions && (
                <MenuItem
                  icon={<ThreadIcon width={14} height={14} />}
                  onClick={handleOpenThreadFromContextMenu}
                >
                  {formatMessage({ id: "message.messageItem.replyInThread" })}
                </MenuItem>
              )}
              {showOwnThreadFollowAction && (
                <MenuItem
                  icon={threadFollowed ? <UnfollowThreadIcon width={14} height={14} /> : <FollowThreadIcon width={14} height={14} />}
                  onClick={threadFollowed ? handleUnfollowThread : handleFollowThread}
                >
                  {threadFollowed ? formatMessage({ id: "message.messageItem.unfollowThread" }) : formatMessage({ id: "message.messageItem.followThread" })}
                </MenuItem>
              )}
              {enclosingThreadFollowCommand ? (
                <MenuItem
                  icon={enclosingThreadFollowCommand.followed ? <UnfollowThreadIcon width={14} height={14} /> : <FollowThreadIcon width={14} height={14} />}
                  onClick={handleEnclosingThreadFollowFromMenu}
                  disabled={enclosingThreadFollowCommand.disabled}
                  data-testid="message-context-thread-follow-action"
                >
                  {formatMessage({ id: enclosingThreadFollowCommand.followed ? "message.messageItem.unfollowThread" : "message.messageItem.followThread" })}
                </MenuItem>
              ) : null}
              {markThreadUnread ? (
                <MenuItem
                  icon={<MessageSquareDot size={14} />}
                  onClick={handleMarkThreadUnreadFromMenu}
                  data-testid="message-context-mark-thread-unread"
                >
                  {formatMessage({ id: "message.messageItem.markThreadAsUnread" })}
                </MenuItem>
              ) : null}
              {!parentMessageId && supportsMessageTasks && (
                !isExternal ? (linkedTask ? (
                  <>
                    <MenuItem
                      icon={linkedTask.status === "done" ? <ReopenTaskIcon width={14} height={14} /> : <SquareCheckBig size={14} />}
                      onClick={handleToggleTaskDone}
                    >
                      {linkedTask.status === "done" ? formatMessage({ id: "message.messageItem.reopenTask" }) : formatMessage({ id: "message.messageItem.markAsDone" })}
                    </MenuItem>
                  </>
                ) : taskV2 ? (
                  <MenuItem
                    icon={<Plus size={14} />}
                    onClick={openCreateFromMessage}
                    data-testid="message-create-task-from-message"
                  >
                    {formatMessage({ id: "message.messageItem.createTaskFromMessage" })}
                  </MenuItem>
                ) : (
                  <MenuItem
                    icon={<Plus size={14} />}
                    onClick={handleConvertToTask}
                  >
                    {formatMessage({ id: "message.messageItem.convertToTask" })}
                  </MenuItem>
                )) : null
              )}
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
            onClick={handleCopyMarkdown}
          >
            {formatMessage({ id: "message.messageItem.copyMarkdown" })}
          </MenuItem>
          {ctxMenu.source === "touch" && canSelectText && (
            <MenuItem
              icon={<SquareDashedText size={14} />}
              onClick={handleOpenSelectText}
            >
              {formatMessage({ id: "message.messageItem.selectText" })}
            </MenuItem>
          )}
          {canForwardThisMessage && (
            <MenuItem
              icon={<ForwardIcon size={14} />}
              onClick={handleForward}
              data-testid="message-context-forward"
            >
              {formatMessage({ id: "message.messageItem.forward" })}
            </MenuItem>
          )}
          {(() => {
            // "Select Message" — last item in the take-it-elsewhere section
            // (Copy link → Copy markdown → Forward → Select Message), in
            // ascending "weight" of what gets propagated: pointer →
            // content → send one → multi-message render+send. Was previously
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
            // System messages cannot be selected. Guests also cannot enter
            // the image-share flow because it persists a public artifact;
            // their server-side role check remains the authoritative guard.
            if (isSystem || currentUserServerRole === "guest") return null;
            return (
              <MenuItem
                // Not SquareCheckBig: that is Mark as Done, earlier in this menu. ListChecks
                // is also the multi-select toolbar's Select All.
                icon={<ListChecks size={14} />}
                onClick={handleSelectShare}
              >
                {formatMessage({ id: "message.messageItem.selectMessage" })}
              </MenuItem>
            );
          })()}
          <ContextMenuDivider />
          <MenuItem
            icon={isSaved ? <BookmarkMinus size={14} /> : <Bookmark size={14} />}
            onClick={handleSaveFromMenu}
          >
            {isSaved ? formatMessage({ id: "message.messageItem.removeFromSaved" }) : formatMessage({ id: "message.messageItem.saveMessage" })}
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
          {/* The conversation's Mark as Unread (the sidebar row's), last of the just-for-me section. */}
          {markConversationUnread ? (
            <MenuItem
              icon={<MessageSquareDot size={14} />}
              onClick={handleMarkConversationUnreadFromMenu}
              data-testid="message-context-mark-conversation-unread"
            >
              {formatMessage({ id: isDmSurface ? "message.messageItem.markDmAsUnread" : "message.messageItem.markChannelAsUnread" })}
            </MenuItem>
          ) : null}
          {/* View Context: its own last group, agent messages only, shown once the Server says the person may open it.
              Never in a joint channel: its messages live in the joint's storage channel (the
              joint-storage namespace, never a Server), so the route answers a bare 404 for every one. */}
          {isAgent && !onJointSurface ? <ViewContextMenuGroup agentId={message.senderId} onOpen={handleViewContextFromMenu} /> : null}
          </ScrollArea>
        </ContextMenuPopup>
      </>,
      document.body
    )}
    {selectTextSheet !== "closed" && (
      <MessageSelectTextDrawer
        open={selectTextSheet === "open"}
        onClose={handleCloseSelectText}
        onClosed={handleSelectTextClosed}
        senderName={senderDisplayName}
        time={time}
        markdown={message.content}
        quoteChannelId={quoteComposerChannelId}
      />
    )}
    {emojiPickerAt && createPortal(
      <>
        <DismissBackdrop onDismiss={closeEmojiPicker} />
        <PopoverPopup
          className="fixed z-popup min-w-0 p-0"
          role="dialog"
          aria-label={formatMessage({ id: "message.messageItem.addReaction" })}
          data-message-affordance="reaction-emoji-picker"
          style={emojiPickerStyle}
          onClick={stopClickPropagation}
        >
          <EmojiPickerPanel onEmojiClick={handleEmojiPickerChoose} focusSearch={emojiPickerAt.focusSearch} />
        </PopoverPopup>
      </>,
      document.body,
    )}
    {senderCtxMenu && createPortal(
      <>
        <DismissBackdrop onDismiss={closeSenderCtxMenu} trapContextMenu />
        <ContextMenuPopup
          className="fixed z-popup select-none"
          role="menu"
          aria-label={formatMessage({ id: "message.messageItem.senderContextMenu" })}
          style={senderCtxMenuPopupStyle}
        >
          <MenuItem
            icon={<Copy size={14} />}
            onClick={handleCopySenderDisplayName}
          >
            {formatMessage({ id: "message.messageItem.copyName" })}
          </MenuItem>
          {senderHandleText ? (
            <MenuItem
              icon={<Copy size={14} />}
              onClick={handleCopySenderHandle}
            >
              {formatMessage({ id: "message.messageItem.copyHandle" })}
            </MenuItem>
          ) : null}
        </ContextMenuPopup>
      </>,
      document.body
    )}
    </>
  );
});

export default ConnectedMessageItem;

