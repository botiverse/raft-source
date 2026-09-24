import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Send, UserX, Hash, Paperclip, X, FileText, ImagePlus, Monitor, Blocks } from "lucide-react";
import Spinner from "../ui/Spinner";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type {
  DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMessageStore } from "../../store/messageStore";
import type { MessageMention, PendingMentionAction } from "../../store/messageStore";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import type { MessageAttachment } from "../../store/imageLightboxStore";
import { useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import type { Channel } from "../../store/channelStore";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { notifyChannelMembersChanged } from "../../store/channelMemberEvents";
import { useAutocomplete } from "../../hooks/useAutocomplete";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useRankedComposerSuggestions } from "../../hooks/useRankedComposerSuggestions";
import { extractClipboardFiles } from "../../utils/clipboardFiles";
import AvatarSlot from "../ui/AvatarSlot";
import Banner from "../ui/Banner";
import CheckMarker from "../ui/CheckMarker";
import SectionEyebrow from "../ui/SectionEyebrow";
import AgentActivityDot from "../agent/AgentActivityDot";
import api from "../../api/client";
import type { Message } from "../../store/messageStore";
import {
  buildMentionCandidateGroupsFromRankedCandidates,
  createMentionCandidateSearchEntries,
  getMentionCandidateDescription,
  getMentionCandidateServerLabel,
  isMemberScopedMentionChannel,
} from "./mentionCandidates";
import type {
  MentionCandidate,
} from "./mentionCandidates";
import { transparentImageBackgroundClass } from "../../utils/imagePreviewStyles";
import { decideMessageAttachmentSelection } from "../../utils/messageAttachmentLimits";
import { resolveAttachmentUploadLimitBytes } from "../../utils/attachmentUploadLimit";
import {
  AttachmentUploadClientError,
  cancelAttachmentUploadSession,
  uploadAttachmentFile,
} from "../../utils/directAttachmentUpload";
import type {
  DirectAttachmentUploadSession,
} from "../../utils/directAttachmentUpload";
import {
  formatAttachmentUploadClientError,
  formatAttachmentUploadServerError,
} from "../../utils/attachmentUploadErrorPresentation";
import { uploadLegacyAttachmentWithIdleTimeout } from "../../utils/legacyAttachmentUpload";
import { SELECTED_TEXT_QUOTE_EVENT, appendQuoteToComposer } from "./selectedTextQuote";
import type { SelectedTextQuoteDetail } from "./selectedTextQuote";
import { PendingMentionActionStrip } from "./PendingMentionActionStrip";
import type { PendingMentionActionLocalState } from "./PendingMentionActionStrip";
import { createOptimisticMessageDraft } from "./optimisticMessageDraft";
import { CHANNEL_TRIGGER, MENTION_TRIGGER } from "./autocompleteTriggers";
import type { ComposerSuggestionSearchEntry } from "../../utils/composerSuggestionSearch";
import {
  getSenderMentionInsertDetail,
  insertMentionAtCursor,
  SENDER_MENTION_INSERT_EVENT,
} from "./senderMentionInsert";
import {
  ARCHIVED_CHANNEL_BADGE_CLASS,
  ARCHIVED_CHANNEL_ICON_CLASS,
  ARCHIVED_CHANNEL_MUTED_TEXT_CLASS,
  ARCHIVED_CHANNEL_TEXT_CLASS,
} from "../channel/channelArchiveVisual";
import {
  COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY,
  formatRaftRefTarget,
  structuredRaftMentionStillAppears,
} from "@botiverse/raft-shared";

interface PendingFile {
  id: string;
  file: File;
  preview: string | null; // object URL for image preview
  previewWidth?: number;
  previewHeight?: number;
  uploadStatus: "validating" | "queued" | "uploading" | "ready" | "error";
  uploadProgress: number;
  uploadClientRequestId: string;
  directUploadSession?: DirectAttachmentUploadSession;
  attachmentId?: string;
  uploadError?: string;
  uploadCanRetry?: boolean;
}

interface AttachmentUploadResponse {
  attachments: Array<{ id: string }>;
}

interface InstalledRapAppSummary {
  appId: string;
  displayName: string;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/([[\]\\])/g, "\\$1");
}

// Stryker disable all: draft attachment persistence is pinned by
// messageInputDraftAttachments.behavior tests. Generated mutations in this
// module-scoped session cache and its React cleanup callers mostly collapse
// into equivalent remount timing states, so the DOM tests are the useful oracle.
const DRAFT_PENDING_FILE_KEY_SEPARATOR = "\u0000";
const draftPendingFilesByChannel = new Map<string, PendingFile[]>();
const failedSendMentionsByDraftKey = new Map<string, MessageMention[]>();

function getDraftPendingFilesAuthScope(userId: string | null | undefined) {
  return userId ? `user:${userId}` : "no-auth-session";
}

function getDraftPendingFilesKey(authScope: string, channelId: string) {
  return `${authScope}${DRAFT_PENDING_FILE_KEY_SEPARATOR}${channelId}`;
}

function getDraftPendingFilesChannelId(cacheKey: string) {
  return cacheKey.split(DRAFT_PENDING_FILE_KEY_SEPARATOR).at(-1) ?? cacheKey;
}

function revokeDraftPendingFilePreviews(files: PendingFile[]) {
  for (const file of files) {
    if (file.preview) URL.revokeObjectURL(file.preview);
  }
}

function clearDraftPendingFilesCache(channelId?: string) {
  for (const [cacheKey, files] of draftPendingFilesByChannel) {
    if (channelId && getDraftPendingFilesChannelId(cacheKey) !== channelId) continue;
    revokeDraftPendingFilePreviews(files);
    draftPendingFilesByChannel.delete(cacheKey);
  }
}

function clearFailedSendMentionsCache(channelId?: string) {
  if (!channelId) {
    failedSendMentionsByDraftKey.clear();
    return;
  }
  for (const cacheKey of failedSendMentionsByDraftKey.keys()) {
    if (getDraftPendingFilesChannelId(cacheKey) === channelId) {
      failedSendMentionsByDraftKey.delete(cacheKey);
    }
  }
}

function mergeFailedSendMentions(...groups: MessageMention[][]): MessageMention[] {
  const byHandle = new Map<string, MessageMention>();
  for (const group of groups) {
    for (const mention of group) byHandle.set(mention.name, mention);
  }
  return [...byHandle.values()];
}

/** Move failed structured payloads when a provisional composer gets a durable channel id. */
function adoptFailedSendMentions(
  sourceCacheKey: string,
  destinationCacheKey: string,
  adoptSource: boolean,
): MessageMention[] {
  if (sourceCacheKey === destinationCacheKey) {
    return failedSendMentionsByDraftKey.get(destinationCacheKey) ?? [];
  }
  const adopted = adoptSource
    ? failedSendMentionsByDraftKey.get(sourceCacheKey) ?? []
    : failedSendMentionsByDraftKey.get(destinationCacheKey) ?? [];
  failedSendMentionsByDraftKey.delete(sourceCacheKey);
  if (adopted.length > 0) failedSendMentionsByDraftKey.set(destinationCacheKey, adopted);
  else failedSendMentionsByDraftKey.delete(destinationCacheKey);
  return adopted;
}

let draftPendingFilesAuthScope = getDraftPendingFilesAuthScope(useAuthStore.getState().user?.id);
useAuthStore.subscribe((state) => {
  const nextAuthScope = getDraftPendingFilesAuthScope(state.user?.id);
  if (nextAuthScope === draftPendingFilesAuthScope) return;
  draftPendingFilesAuthScope = nextAuthScope;
  clearDraftPendingFilesCache();
  clearFailedSendMentionsCache();
});

export function clearDraftPendingFilesForTests(channelId?: string) {
  clearDraftPendingFilesCache(channelId);
}

export function clearFailedSendMentionsForTests(channelId?: string) {
  clearFailedSendMentionsCache(channelId);
}

function getDraftPendingFiles(cacheKey: string): PendingFile[] {
  return draftPendingFilesByChannel.get(cacheKey) ?? [];
}

function saveDraftPendingFiles(cacheKey: string, files: PendingFile[]) {
  if (files.length === 0) {
    draftPendingFilesByChannel.delete(cacheKey);
    return;
  }
  draftPendingFilesByChannel.set(cacheKey, files);
}

function adoptDraftPendingFiles(
  sourceCacheKey: string,
  destinationCacheKey: string,
  preferSource: boolean,
): PendingFile[] {
  if (sourceCacheKey === destinationCacheKey) return getDraftPendingFiles(destinationCacheKey);

  const sourceFiles = getDraftPendingFiles(sourceCacheKey);
  const destinationFiles = getDraftPendingFiles(destinationCacheKey);
  const adoptedFiles = preferSource
    ? sourceFiles
    : destinationFiles.length > 0
      ? destinationFiles
      : sourceFiles;
  const discardedFiles = adoptedFiles === sourceFiles ? destinationFiles : sourceFiles;
  const adoptedIds = new Set(adoptedFiles.map((file) => file.id));
  revokeDraftPendingFilePreviews(discardedFiles.filter((file) => !adoptedIds.has(file.id)));

  draftPendingFilesByChannel.delete(sourceCacheKey);
  saveDraftPendingFiles(destinationCacheKey, adoptedFiles);
  return adoptedFiles;
}

function markInterruptedUploads(files: PendingFile[], formatMessage: IntlShape["formatMessage"]): PendingFile[] {
  return files.map((file) => (
    file.uploadStatus === "validating"
      ? {
          ...file,
          uploadStatus: "error",
          uploadProgress: 0,
          uploadError: formatMessage({ id: "message.composer.attachmentCheckInterrupted" }),
          uploadCanRetry: false,
        }
      : file.uploadStatus === "uploading"
      ? { ...file, uploadStatus: "error", uploadProgress: 0, uploadError: formatMessage({ id: "message.composer.uploadInterrupted" }) }
      : file
  ));
}
// Stryker restore all

export type PendingMentionActionExecuteStatus =
  | "queued"
  | "delivered"
  | "dropped"
  | "stale"
  | "expired"
  | "no_permission"
  | "not_found"
  | "ambiguous";
export type PendingMentionActionExecuteAction = "notify" | "add";

export interface PendingMentionActionExecuteResult {
  resolutionId: string;
  action: PendingMentionActionExecuteAction;
  status: PendingMentionActionExecuteStatus;
  reason?: string;
}

interface PendingMentionActionExecuteResponse {
  ok?: boolean;
  action?: string;
  results?: PendingMentionActionExecuteResult[];
}

const MEDIA_PICKER_ACCEPT = "image/*,video/*";

export function mentionStillAppears(content: string, mention: MessageMention): boolean {
  return structuredRaftMentionStillAppears(content, mention.name);
}

interface MentionUndoSnapshot {
  beforeContent: string;
  beforeMentions: MessageMention[];
  beforeCursor: number;
  afterContent: string;
  afterCursor: number;
}

export function mergeFailedSendIntoDraft(failedMessage: string, currentDraft: string): string {
  if (!currentDraft) return failedMessage;
  if (!failedMessage) return currentDraft;
  const separator = failedMessage.endsWith("\n") || currentDraft.startsWith("\n") ? "" : "\n";
  return `${failedMessage}${separator}${currentDraft}`;
}

/** Clear only the request intent that completed; a newer request owns its guard. */
export function releaseSubmittedDraftIntent(
  currentIntent: string | null,
  completedIntent: string,
): string | null {
  return currentIntent === completedIntent ? null : currentIntent;
}

export function formatMentionActionStatusNotice(
  result: PendingMentionActionExecuteResult | undefined,
  formatMessage: IntlShape["formatMessage"],
): string {
  if (!result) return formatMessage({ id: "message.mentionActionNotice.unavailable" });
  if (result.status === "dropped") {
    if (result.reason === "delivery_unavailable") return formatMessage({ id: "message.mentionActionNotice.droppedDeliveryUnavailable" });
    return formatMessage({ id: "message.mentionActionNotice.dropped" });
  }
  if (result.status === "no_permission") {
    if (result.reason === "sender_lacks_channel_access") return formatMessage({ id: "message.mentionActionNotice.senderLacksAccess" });
    if (result.reason === "target_lacks_read_access") return formatMessage({ id: "message.mentionActionNotice.targetLacksReadAccess" });
    if (result.reason === "add_not_allowed_for_surface") return formatMessage({ id: "message.mentionActionNotice.addNotAllowedForSurface" });
    if (result.reason === "add_requires_human_member_authority") return formatMessage({ id: "message.mentionActionNotice.addRequiresHumanMember" });
    if (result.reason === "add_requires_member_management_authority") return formatMessage({ id: "message.mentionActionNotice.addRequiresMemberManagement" });
    return formatMessage({ id: "message.mentionActionNotice.noPermissionDefault" });
  }
  if (result.status === "stale") {
    if (result.reason === "target_already_member") return formatMessage({ id: "message.mentionActionNotice.targetAlreadyMember" });
    if (result.reason === "target_unavailable") return formatMessage({ id: "message.mentionActionNotice.targetUnavailable" });
    return formatMessage({ id: "message.mentionActionNotice.noLongerPending" });
  }
  if (result.status === "expired") return formatMessage({ id: "message.mentionActionNotice.expired" });
  if (result.status === "not_found") return formatMessage({ id: "message.mentionActionNotice.notFound" });
  if (result.status === "ambiguous") return formatMessage({ id: "message.mentionActionNotice.ambiguous" });
  return formatMessage({ id: "message.mentionActionNotice.couldNotApply" });
}

export function mentionActionSucceeded(
  action: PendingMentionActionExecuteAction,
  result: PendingMentionActionExecuteResult | undefined,
): boolean {
  return action === "notify"
    ? result?.status === "queued"
    : result?.status === "delivered";
}

function isPreviewableImageFile(file: File): boolean {
  const mimeType = file.type.split(";")[0]?.trim().toLowerCase();
  return !!mimeType && mimeType.startsWith("image/") && mimeType !== "image/svg+xml";
}

function isBillingUploadQuotaError(error: string | undefined): boolean {
  if (!error) return false;
  return error.includes("Monthly file upload quota exceeded");
}

function readLocalImageDimensions(previewUrl: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      resolve(width > 0 && height > 0 ? { width, height } : null);
    };
    image.onerror = () => resolve(null);
    image.src = previewUrl;
  });
}

function SortableAttachment({
  id,
  preview,
  fileName,
  mimeType,
  uploadStatus,
  uploadProgress,
  onRemove,
  onPreview,
}: {
  id: string;
  preview: string | null;
  fileName: string;
  mimeType: string;
  uploadStatus: PendingFile["uploadStatus"];
  uploadProgress: number;
  onRemove: () => void;
  onPreview?: () => void;
}) {
  const { formatMessage } = useIntl();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  return (
    <div ref={setNodeRef} style={style} className="relative group" {...attributes}>
      {/* Drag handle: the chip body itself. Spreading dnd-kit's
          {...listeners} ONLY here (not on the outer container) keeps
          the Remove button outside the drag handle, so taps on the
          ✕ never get captured by PointerSensor's native pointerdown
          listener. Without this split, on touch devices the parent
          element owned both the drag region and the button area —
          dnd-kit attaches NATIVE pointerdown listeners (not React),
          which `e.stopPropagation()` on a React synthetic onClick
          can't preempt; the X tap got swallowed and onRemove never
          fired. tygg #proj-mobile task #8. */}
      <div
        {...listeners}
        role={preview && onPreview ? "button" : undefined}
        tabIndex={preview && onPreview ? 0 : undefined}
        onClick={preview && onPreview ? onPreview : undefined}
        onKeyDown={(e) => {
          if (!preview || !onPreview) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onPreview();
          }
        }}
        aria-label={preview && onPreview ? formatMessage({ id: "message.composer.previewAttachment" }, { file: fileName }) : undefined}
        title={preview && onPreview ? formatMessage({ id: "message.composer.previewImage" }) : undefined}
        className={preview && onPreview ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing"}
      >
        {preview ? (
          <img src={preview} alt={fileName} className={`size-16 object-cover border-2 border-black ${transparentImageBackgroundClass}`} />
        ) : (
          <div className="flex h-16 w-32 items-center gap-2 border-2 border-black bg-white px-2">
            <FileText size={16} className="shrink-0 text-black/70" />
            <div className="min-w-0">
              <div className="truncate text-xs font-bold text-black">{fileName}</div>
              <div className="truncate text-[10px] text-black/50">{mimeType || formatMessage({ id: "message.composer.fileFallback" })}</div>
            </div>
          </div>
        )}
      </div>
      {/* Remove button. Desktop: hidden until hover so the chip reads
          clean. Touch devices: always visible — `(hover: none)` matches
          phones/tablets without an attached pointer, which is exactly
          where the hover-only X disappears.
          size-5 on touch gives a 20px hit area instead of the desktop
          16px — still small but big enough for thumb tap on a 64px
          chip without enlarging the chip itself. */}
      {uploadStatus === "validating" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center border-2 border-black bg-white/85 px-1 text-center text-[10px] font-bold text-black">
          <Spinner size="sm" className="mb-1" />
          <span>{formatMessage({ id: "message.composer.checkingAttachment" })}</span>
        </div>
      )}
      {uploadStatus === "uploading" && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center border-2 border-black bg-white/85 px-1 text-center text-[10px] font-bold text-black">
          <Spinner size="sm" className="mb-1" />
          <span>
            {uploadProgress >= 99
              ? formatMessage({ id: "message.composer.finishingUpload" })
              : uploadProgress > 0
                ? `${uploadProgress}%`
                : formatMessage({ id: "message.composer.uploading" })}
          </span>
          <div className="absolute bottom-0 left-0 h-1 w-full bg-black/15">
            <div
              className="h-full bg-brutal-pink"
              style={{ width: `${Math.max(4, Math.min(uploadProgress, 100))}%` }}
            />
          </div>
        </div>
      )}
      {uploadStatus === "error" && (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center border-2 border-black bg-brutal-orange/90 px-1 text-center text-[10px] font-bold leading-3 text-black"
        >
          <span>{formatMessage({ id: "message.composer.uploadFailed" })}</span>
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={formatMessage({ id: "message.composer.removeAttachment" }, { file: fileName })}
        className="absolute -top-1.5 -right-1.5 z-20 flex size-4 items-center justify-center rounded-full bg-black text-white opacity-0 transition-opacity group-hover:opacity-100 [@media(hover:none)]:h-6 [@media(hover:none)]:w-6 [@media(hover:none)]:opacity-100"
      >
        <X size={10} />
      </button>
    </div>
  );
}

function MentionCandidateBody({
  candidate,
  selected,
  muted,
}: {
  candidate: MentionCandidate;
  selected: boolean;
  muted: boolean;
}) {
  const { formatMessage } = useIntl();
  const description = getMentionCandidateDescription(candidate);
  const serverLabel = getMentionCandidateServerLabel(candidate);
  const nameClass = muted
    ? selected ? "text-black/70" : "text-black/50"
    : "text-black";
  const handleClass = muted
    ? selected ? "text-black/40" : "text-black/30"
    : "text-black/40";
  const descriptionClass = muted
    ? selected ? "text-black/50" : "text-black/40"
    : selected ? "text-black/70" : "text-black/50";
  const nameWidthClass = description ? "max-w-[45%] shrink-0 sm:max-w-[35%]" : "min-w-0";
  const actorTypeLabel = candidate.type === "user"
    ? formatMessage({ id: "message.composer.actorType.human" })
    : candidate.type === "agent"
      ? formatMessage({ id: "message.composer.actorType.agent" })
      : null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
      <span className={`${nameWidthClass} truncate ${nameClass}`}>{candidate.displayName || candidate.name}</span>
      {actorTypeLabel && (
        <span
          data-testid={`mention-actor-type-${candidate.type}`}
          className={`shrink-0 border border-current px-1 py-px text-[10px] font-bold uppercase leading-none ${descriptionClass}`}
        >
          {actorTypeLabel}
        </span>
      )}
      {description && (
        <span className={`min-w-0 flex-1 truncate text-xs font-normal ${descriptionClass}`} title={description}>
          {description}
        </span>
      )}
      {serverLabel && (
        <span className={`min-w-0 max-w-[10rem] truncate text-xs font-normal ${descriptionClass}`} title={formatMessage({ id: "message.composer.sourceServer" }, { server: serverLabel })}>
          {serverLabel}
        </span>
      )}
      <span className={`ml-auto shrink-0 text-xs font-mono ${handleClass}`}>@{candidate.name}</span>
    </div>
  );
}

function MentionCandidateAvatar({
  candidate,
  muted,
}: {
  candidate: MentionCandidate;
  muted: boolean;
}) {
  if (candidate.type === "computer") {
    return (
      <span data-mention-candidate-avatar="computer" className="flex size-5 shrink-0 items-center justify-center border border-black bg-brutal-cyan/30">
        <Monitor size={12} aria-hidden />
      </span>
    );
  }

  if (candidate.type === "app") {
    return (
      <span data-mention-candidate-avatar="app" className="flex size-5 shrink-0 items-center justify-center border border-black bg-soft-signal/40">
        <Blocks size={12} aria-hidden />
      </span>
    );
  }

  if (candidate.type === "agent") {
    return (
      <AvatarSlot
        context="compact-list"
        type="agent"
        agentAvatarUrl={candidate.avatarUrl}
        badge={muted ? undefined : <MentionCandidateActivityBadge agentId={candidate.id} />}
        className={muted ? "!border-black/40 opacity-60" : undefined}
      />
    );
  }

  return (
    <AvatarSlot
      context="compact-list"
      type="human"
      humanAvatarUrl={candidate.avatarUrl}
      gravatarHash={candidate.gravatarHash}
      email={candidate.email}
      humanPlaceholder={!candidate.avatarUrl && !candidate.gravatarHash && !candidate.email}
      className={muted ? "!border-black/40 opacity-60 [&_svg]:opacity-50" : undefined}
    />
  );
}

function MentionCandidateActivityBadge({ agentId }: { agentId: string }) {
  return (
    <span data-mention-avatar-badge-shell="true" className="absolute bottom-0 right-0 block size-0">
      <AgentActivityDot
        agentId={agentId}
        size="sm"
        pulse
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      />
    </span>
  );
}

export default function MessageInput({
  channelId,
  channelName,
  showTaskButton,
  onWillSend,
  resolveChannelId,
  onChannelResolved,
  mentionChannelId,
  mentionScopeChannelType,
  loadMentionMembers = true,
  migrateDraftFromChannelId,
  isChannelThread,
  threadMessages,
  autoFocus,
  autoFocusMode = "desktop",
  variant = "full",
  onSendOverride,
  accessoryRow,
  activationBanner,
  placeholder,
  allowEmptySubmit = false,
  submitDisabled = false,
  submitBusy = false,
  submitDisabledReason,
  submitTitleOverride,
  submitLabelOverride,
  textareaId,
  maxLength,
}: {
  channelId: string;
  channelName: string;
  showTaskButton?: boolean;
  onWillSend?: () => void | Promise<void>;
  /**
   * Lazily resolve the durable delivery channel before the first upload/send.
   * Thread panels use this to keep a view-only open from creating storage.
   */
  resolveChannelId?: () => Promise<string>;
  /** Called only after a message has been durably accepted. */
  onChannelResolved?: (channelId: string) => void;
  /** Channel ID to use for @mention autocomplete (defaults to channelId). Use parent channel ID in threads. */
  mentionChannelId?: string;
  /** Channel type for mention autocomplete when the scoped channel is not present in the local channel store. */
  mentionScopeChannelType?: "channel" | "private" | "joint" | "dm" | "thread" | null;
  /** Disable member roster loading when autocomplete is intentionally server-scoped from a synthetic draft key. */
  loadMentionMembers?: boolean;
  /** Provisional composer key to adopt when an empty thread receives its first durable reply. */
  migrateDraftFromChannelId?: string;
  /** Whether this is a thread under a regular channel (not DM). Controls whether @mention shows all server members. */
  isChannelThread?: boolean;
  /** Current thread messages used to lightly prioritize recent participants. */
  threadMessages?: Message[];
  /** Auto-focus the textarea on mount */
  autoFocus?: boolean;
  /** Controls whether auto-focus is desktop-only or allowed on keyboard-managed mobile surfaces. */
  autoFocusMode?: "desktop" | "always";
  /**
   * Compact comment-composer variant (attachment comments task #20): no file
   * attach affordances, tighter chrome, host surface owns the outer border.
   * The base contract — drafts, mentions, shortcuts, IME guard, sending and
   * error states, a11y — is identical to the full composer.
   */
  variant?: "full" | "compact";
  /**
   * Replaces the store send path. The composer then never creates optimistic
   * messages or calls sendMessage — the caller owns delivery (e.g.
   * POST /attachments/:id/comments, which must pair the message with its ref
   * row). File attachments are unsupported with an override.
   */
  onSendOverride?: (content: string, mentions: MessageMention[]) => Promise<void>;
  /** Rendered inside the composer card above the textarea (e.g. scope chips). */
  accessoryRow?: React.ReactNode;
  /** Primary mobile composer-only activation surface, rendered above all composer notices. */
  activationBanner?: React.ReactNode;
  /** Overrides the default `Message {channelName}` placeholder. */
  placeholder?: string;
  /** Allows override-backed composers to submit an intentionally empty body. */
  allowEmptySubmit?: boolean;
  /** External surfaces can block submit while preserving base composer chrome. */
  submitDisabled?: boolean;
  /** External surfaces can show delivery in progress for override submits. */
  submitBusy?: boolean;
  submitDisabledReason?: string;
  submitTitleOverride?: string;
  submitLabelOverride?: string;
  textareaId?: string;
  maxLength?: number;
}) {
  const { formatMessage } = useIntl();
  // Locale-stable handle to formatMessage for effects/callbacks that must read
  // the latest formatter without taking it as a dependency — otherwise a display
  // language switch would re-run channel-switch/reset effects and clear draft
  // state (selected mentions, pending actions, errors). Render-time copy still
  // uses formatMessage directly so visible text updates on locale change.
  const formatMessageRef = useRef(formatMessage);
  formatMessageRef.current = formatMessage;
  const draft = useMessageStore((s) => s.drafts[channelId] ?? "");
  const setDraft = useMessageStore((s) => s.setDraft);
  const adoptDraftChannel = useMessageStore((s) => s.adoptDraftChannel);
  const clearDraft = useMessageStore((s) => s.clearDraft);
  const currentUser = useAuthStore().user;
  const nav = useAppNavigate();
  const [content, setContent] = useState(draft);
  const sendMessage = useMessageStore((s) => s.sendMessage);
  const addOptimisticMessage = useMessageStore((s) => s.addOptimisticMessage);
  // Stryker disable next-line all: optimistic rollback is covered by send-failure tests outside this attachment-draft mutation slice.
  const removeOptimisticMessage = useMessageStore((s) => s.removeOptimisticMessage);
  // Stryker disable next-line all: task-toggle default state is covered by MessageInput submit-contract tests outside this attachment-draft mutation slice.
  const [alsoCreateTask, setAlsoCreateTask] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const contentRef = useRef(content);
  const pendingSenderMentionCursorRef = useRef<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Stryker disable all: see draft attachment persistence note above; the
  // behavior is covered by remount/channel-switch DOM tests.
  // oxlint-disable-next-line react-doctor/no-event-handler -- Derived from the static composer variant; used to route full vs compact attachment lifecycle.
  const preservePendingDraftFiles = variant === "full";
  const draftPendingFilesAuthScope = getDraftPendingFilesAuthScope(currentUser?.id);
  const draftPendingFilesCacheKey = getDraftPendingFilesKey(draftPendingFilesAuthScope, channelId);
  const draftPendingFilesCacheKeyRef = useRef(draftPendingFilesCacheKey);
  const draftPendingFilesAuthScopeRef = useRef(draftPendingFilesAuthScope);
  // Cross-render identity snapshot distinguishes a live adoption from an
  // ordinary composer switch. This is intentionally a render ref because it
  // is only used by the draft restore effect after commit.
  // oxlint-disable-next-line react-doctor/no-event-handler -- Previous-value identity for committed draft adoption, not an event-handler bridge.
  const composerChannelIdRef = useRef(channelId);
  // The callback ref is the single committed ownership primitive for this
  // composer. React attaches/detaches it during commit, so an abandoned
  // concurrent render cannot claim ownership and an unmounted composer is
  // invalidated before any later async callback can write to it. This is not a
  // layout effect: no DOM measurement or pre-paint visual correction occurs.
  const committedComposerOwnershipRef = useRef<{
    channelId: string;
    draftAlias: string | null;
    draftCacheKey: string;
    authScope: string;
  } | null>(null);
  const composerTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node;
    committedComposerOwnershipRef.current = node
      ? {
          channelId,
          draftAlias: migrateDraftFromChannelId ?? null,
          draftCacheKey: draftPendingFilesCacheKey,
          authScope: draftPendingFilesAuthScope,
        }
      : null;
  }, [channelId, draftPendingFilesAuthScope, draftPendingFilesCacheKey, migrateDraftFromChannelId]);
  const isCommittedComposerOwner = useCallback((targetChannelId: string, targetDraftCacheKey?: string) => {
    const owner = committedComposerOwnershipRef.current;
    if (!owner) return false;
    if (owner.channelId === targetChannelId) {
      return targetDraftCacheKey === undefined || owner.draftCacheKey === targetDraftCacheKey;
    }
    if (owner.draftAlias !== targetChannelId) return false;
    return targetDraftCacheKey === undefined
      || getDraftPendingFilesKey(owner.authScope, targetChannelId) === targetDraftCacheKey;
  }, []);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>(() => (
    preservePendingDraftFiles ? getDraftPendingFiles(draftPendingFilesCacheKey) : []
  ));
  const [selectedMentions, setSelectedMentions] = useState<MessageMention[]>([]);
  const selectedMentionsRef = useRef<MessageMention[]>([]);
  selectedMentionsRef.current = selectedMentions;
  const mentionUndoSnapshotRef = useRef<MentionUndoSnapshot | null>(null);
  const [pendingMentionActions, setPendingMentionActions] = useState<PendingMentionAction[]>([]);
  const [unresolvedMentionHandles, setUnresolvedMentionHandles] = useState<string[]>([]);
  const [pendingMentionActionState, setPendingMentionActionState] = useState<Record<string, PendingMentionActionLocalState>>({});
  const [pendingMentionActionRemoving, setPendingMentionActionRemoving] = useState<Record<string, boolean>>({});
  const [pendingMentionActionExecuting, setPendingMentionActionExecuting] = useState<Record<string, PendingMentionActionLocalState>>({});
  const pendingMentionActionBatchInFlightRef = useRef(false);
  const pendingMentionActionRemovalTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>[]>>(new Map());
  const pendingFilesRef = useRef<PendingFile[]>([]);
  const uploadControllersRef = useRef<Map<string, AbortController>>(new Map());
  const attachmentSelectionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const attachmentSelectionGenerationRef = useRef(0);
  const attachmentSelectionAbortRef = useRef(new AbortController());
  const submittedDraftIntentRef = useRef<string | null>(null);
  const resolvedChannelIdRef = useRef<{ composerChannelId: string; deliveryChannelId: string } | null>(null);
  const resolvingChannelIdRef = useRef<{ composerChannelId: string; promise: Promise<string> } | null>(null);
  const [error, setError] = useState("");
  const [mentionActionNotice, setMentionActionNotice] = useState("");
  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const membershipChannelId = mentionChannelId || channelId;

  const resetAttachmentSelectionValidation = useCallback(() => {
    attachmentSelectionAbortRef.current.abort();
    attachmentSelectionAbortRef.current = new AbortController();
    attachmentSelectionGenerationRef.current += 1;
    attachmentSelectionQueueRef.current = Promise.resolve();
  }, []);

  const resolveDeliveryChannelId = useCallback(async () => {
    if (!resolveChannelId) return channelId;
    if (resolvedChannelIdRef.current?.composerChannelId === channelId) {
      return resolvedChannelIdRef.current.deliveryChannelId;
    }
    if (resolvingChannelIdRef.current?.composerChannelId === channelId) {
      return resolvingChannelIdRef.current.promise;
    }
    const resolving = resolveChannelId()
      .then((resolved) => {
        resolvedChannelIdRef.current = { composerChannelId: channelId, deliveryChannelId: resolved };
        return resolved;
      })
      .finally(() => {
        if (resolvingChannelIdRef.current?.promise === resolving) resolvingChannelIdRef.current = null;
      });
    resolvingChannelIdRef.current = { composerChannelId: channelId, promise: resolving };
    return resolving;
  }, [channelId, resolveChannelId]);

  // Draft restore on channel switch: `content` is seeded from the external
  // Zustand `messageStore.drafts[channelId]` — sync-with-external-store, per
  // React docs the legitimate "sync state with an external system" pattern.
  // NOT a mirror-prop effect; the IME composition guard at L921
  // (`isComposing || keyCode === 229`) means a key-remount refactor here
  // would break CJK input + lose user's typed draft, so inline-disable is
  // the right call (per @铁根 msg=15678dad triage). Sister rules broadened
  // per @铁根 msg=2e922c7d.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    mentionUndoSnapshotRef.current = null;
    const previousChannelId = composerChannelIdRef.current;
    if (previousChannelId !== channelId) resetAttachmentSelectionValidation();
    const isLiveDraftAdoption = Boolean(
      // oxlint-disable-next-line react-doctor/no-event-handler -- This prop is external draft-migration identity, not an event callback.
      migrateDraftFromChannelId
      && previousChannelId === migrateDraftFromChannelId
      && channelId !== migrateDraftFromChannelId,
    );
    const isDraftAdoption = Boolean(
      // oxlint-disable-next-line react-doctor/no-event-handler -- This prop is external draft-migration identity, not an event callback.
      migrateDraftFromChannelId && channelId !== migrateDraftFromChannelId,
    );
    const destinationDraftBeforeAdoption = useMessageStore.getState().drafts[channelId] ?? "";
    const adoptSourcePayload = isLiveDraftAdoption || !destinationDraftBeforeAdoption;
    let saved = destinationDraftBeforeAdoption;
    if (isDraftAdoption) {
      // oxlint-disable-next-line react-doctor/no-event-handler -- This prop is external draft-migration identity, not an event callback.
      saved = adoptDraftChannel(migrateDraftFromChannelId!, channelId, isLiveDraftAdoption);
    }
    const migrationSourceCacheKey = migrateDraftFromChannelId
      ? getDraftPendingFilesKey(draftPendingFilesAuthScope, migrateDraftFromChannelId)
      : null;
    const failedMentions = migrationSourceCacheKey && migrationSourceCacheKey !== draftPendingFilesCacheKey
      ? adoptFailedSendMentions(
          migrationSourceCacheKey,
          draftPendingFilesCacheKey,
          adoptSourcePayload,
        )
      : failedSendMentionsByDraftKey.get(draftPendingFilesCacheKey) ?? [];
    composerChannelIdRef.current = channelId;
    // oxlint-disable-next-line react-doctor/no-derived-state
    setContent(saved);
    if (!isLiveDraftAdoption) {
      // A real composer switch gets a fresh structured mention payload. The
      // pending-thread -> durable-thread adoption is the same live composer,
      // so its selected mentions must move with the visible text draft.
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      failedSendMentionsByDraftKey.delete(draftPendingFilesCacheKey);
      // Restore the failed request's structured payload alongside its draft;
      // this is an async failure handoff, not a render-derived mirror.
      // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-adjust-state-on-prop-change
      setSelectedMentions(failedMentions.filter((mention) => mentionStillAppears(saved, mention)));
    } else if (failedMentions.length > 0) {
      // A pending Thread can become durable while it remains mounted. Keep
      // mentions already selected in that live composer and add payloads from
      // a failed request that was restored while the user was elsewhere.
      // oxlint-disable-next-line react-doctor/no-derived-state, react-doctor/no-adjust-state-on-prop-change
      setSelectedMentions((currentMentions) => mergeFailedSendMentions(currentMentions, failedMentions)
        .filter((mention) => mentionStillAppears(saved, mention)));
      failedSendMentionsByDraftKey.delete(draftPendingFilesCacheKey);
    }
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setPendingMentionActions([]);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setUnresolvedMentionHandles([]);
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setPendingMentionActionState({});
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setPendingMentionActionExecuting({});
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setError("");
    if (textareaRef.current) textareaRef.current.style.height = "";
    // Keep normal-composer attachment drafts with the same durability level as
    // text drafts for this session. A transient composer remount/channel return
    // must not drop ready image chips while leaving typed text intact.
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-derived-state
    setPendingFiles((prev) => {
      const previousCacheKey = draftPendingFilesCacheKeyRef.current;
      const previousAuthScope = draftPendingFilesAuthScopeRef.current;
      if (preservePendingDraftFiles && previousCacheKey !== draftPendingFilesCacheKey) {
        const interrupted = markInterruptedUploads(prev, formatMessageRef.current);
        for (const p of prev) {
          if (p.uploadStatus === "uploading") {
            uploadControllersRef.current.get(p.id)?.abort();
            uploadControllersRef.current.delete(p.id);
          }
        }
        if (previousAuthScope === draftPendingFilesAuthScope) {
          saveDraftPendingFiles(previousCacheKey, interrupted);
        }
      } else if (!preservePendingDraftFiles) {
        for (const p of prev) {
          uploadControllersRef.current.get(p.id)?.abort();
          uploadControllersRef.current.delete(p.id);
          if (p.preview) URL.revokeObjectURL(p.preview);
        }
      }
      const shouldAdoptPendingFiles = preservePendingDraftFiles
        && migrationSourceCacheKey
        && migrationSourceCacheKey !== draftPendingFilesCacheKey
        && previousAuthScope === draftPendingFilesAuthScope;
      const adoptedPendingFiles = shouldAdoptPendingFiles
        ? adoptDraftPendingFiles(
            migrationSourceCacheKey,
            draftPendingFilesCacheKey,
            previousCacheKey === migrationSourceCacheKey,
          )
        : null;
      draftPendingFilesCacheKeyRef.current = draftPendingFilesCacheKey;
      draftPendingFilesAuthScopeRef.current = draftPendingFilesAuthScope;
      return preservePendingDraftFiles
        ? adoptedPendingFiles ?? getDraftPendingFiles(draftPendingFilesCacheKey)
        : [];
    });
  }, [
    adoptDraftChannel,
    channelId,
    draftPendingFilesAuthScope,
    draftPendingFilesCacheKey,
    migrateDraftFromChannelId,
    preservePendingDraftFiles,
    resetAttachmentSelectionValidation,
  ]);

  // Auto-focus on mount. Mobile is opt-in for hosts that already manage the keyboard viewport.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
    if (autoFocus && (autoFocusMode === "always" || window.matchMedia("(hover: hover)").matches)) {
      textareaRef.current?.focus();
    }
  }, [autoFocus, autoFocusMode, channelId]);

  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
    if (preservePendingDraftFiles) {
      saveDraftPendingFiles(draftPendingFilesCacheKeyRef.current, pendingFiles);
    }
  }, [pendingFiles, preservePendingDraftFiles]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Cleanup object URLs and in-flight uploads on unmount
  // oxlint-disable react-hooks/exhaustive-deps -- This cleanup must intentionally read the latest refs at unmount time; mount-time snapshots would lose in-flight/ready attachment drafts.
  useEffect(() => {
    if (attachmentSelectionAbortRef.current.signal.aborted) {
      attachmentSelectionAbortRef.current = new AbortController();
    }
    return () => {
      resetAttachmentSelectionValidation();
      if (preservePendingDraftFiles) {
        const interrupted = markInterruptedUploads(pendingFilesRef.current, formatMessageRef.current);
        for (const p of pendingFilesRef.current) {
          if (p.uploadStatus === "uploading") {
            uploadControllersRef.current.get(p.id)?.abort();
          }
        }
        const currentAuthScope = getDraftPendingFilesAuthScope(useAuthStore.getState().user?.id);
        if (draftPendingFilesAuthScopeRef.current === currentAuthScope) {
          saveDraftPendingFiles(draftPendingFilesCacheKeyRef.current, interrupted);
        }
      } else {
        for (const controller of uploadControllersRef.current.values()) {
          controller.abort();
        }
        for (const p of pendingFilesRef.current) {
          if (p.preview) URL.revokeObjectURL(p.preview);
        }
      }
      uploadControllersRef.current.clear();
    };
  }, [preservePendingDraftFiles, resetAttachmentSelectionValidation]);
  // oxlint-enable react-hooks/exhaustive-deps
  // Stryker restore all

  // Save draft on content change. Writes local `content` into the external
  // messageStore draft slot — a write-to-external-store sync, not derived local
  // state. no-derived-state-effect pattern-matches the effect shape; FP here.
  // oxlint-disable-next-line react-doctor/no-derived-state-effect, react-doctor/no-effect-chain -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  useEffect(() => {
    setDraft(channelId, content);
  }, [channelId, content, setDraft]);

  const agents = useAgentStore((s) => s.agents);
  const humans = useServerStore((s) => s.members);
  const currentServer = useServerStore((s) => s.current);
  const resourceReferencesGate = useServerFeatureFlag(COMPOSER_RESOURCE_REFERENCES_FEATURE_FLAG_KEY);
  const machines = useMachineStore((s) => s.machines);
  const [installedApps, setInstalledApps] = useState<InstalledRapAppSummary[]>([]);
  const installedAppsServerIdRef = useRef<string | null>(null);
  const { channelAgents, channelHumans } = useChannelMembers(mentionChannelId || channelId, { enabled: loadMentionMembers });
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const composerChannel = useMemo(
    () => channels.find((c) => c.id === channelId) ?? dmChannels.find((c) => c.id === channelId),
    [channels, dmChannels, channelId],
  );
  const isDmComposer = composerChannel?.type === "dm";
  const mentionScopeChannel = useMemo(
    () => channels.find((c) => c.id === (mentionChannelId || channelId))
      ?? dmChannels.find((c) => c.id === (mentionChannelId || channelId))
      ?? (mentionScopeChannelType ? { type: mentionScopeChannelType } : undefined),
    [channels, dmChannels, mentionChannelId, channelId, mentionScopeChannelType],
  );

  // Autocomplete hooks (state only — filtering done below)
  const mention = useAutocomplete(MENTION_TRIGGER, "@");
  const channel = useAutocomplete(CHANNEL_TRIGGER, "#");

  // Apps are needed only while @ autocomplete is open. Keeping this lazy avoids
  // turning every mounted composer into an unrelated registry request; the
  // successful result is cached for the current server until the component or
  // server changes.
  useEffect(() => {
    let active = true;
    const serverId = currentServer?.id;
    if (!resourceReferencesGate.enabled || !mention.show || !serverId || installedAppsServerIdRef.current === serverId) {
      return () => { active = false; };
    }
    void api.get<{ apps: InstalledRapAppSummary[] }>(`/servers/${serverId}/apps`)
      .then((response) => {
        if (!active) return;
        installedAppsServerIdRef.current = serverId;
        setInstalledApps(Array.isArray(response.data.apps) ? response.data.apps : []);
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [currentServer?.id, mention.show, resourceReferencesGate.enabled]);

  // Channel switches keep MessageInput mounted, so any open autocomplete
  // popover must be cleared explicitly instead of relying on unmount cleanup.
  // oxlint-disable react-hooks/exhaustive-deps -- dismiss popovers on channelId change; effect correctly deps on the stable `.dismiss` callbacks + channelId. `mention`/`channel` are fresh objects every render (useAutocomplete); depending on the whole objects would dismiss the open popover every keystroke.
  useEffect(() => {
    mention.dismiss();
    channel.dismiss();
  }, [channelId, mention.dismiss, channel.dismiss]);
  // oxlint-enable react-hooks/exhaustive-deps

  // Build channel member ID sets for fast lookup
  const channelMemberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of channelAgents) ids.add(a.id);
    for (const h of channelHumans) ids.add(h.id);
    return ids;
  }, [channelAgents, channelHumans]);

  // Build & filter mention candidates
  // oxlint-disable react-hooks/exhaustive-deps -- mention scope only depends on channel type; the helper takes the channel object to keep the predicate API readable/testable.
  const allCandidates = useMemo(() => {
    const byKey = new Map<string, MentionCandidate>();
    const addCandidate = (candidate: MentionCandidate) => {
      byKey.set(`${candidate.type}:${candidate.id}`, candidate);
    };
    const memberScopedMentions = isMemberScopedMentionChannel(mentionScopeChannel);
    if (!memberScopedMentions && currentUser) {
      addCandidate({
        id: currentUser.id,
        name: currentUser.name,
        displayName: currentUser.displayName,
        type: "user",
        avatarUrl: currentUser.avatarUrl,
        email: currentUser.email,
      });
    }
    if (!memberScopedMentions) {
      for (const human of humans) {
        if (currentUser && human.userId === currentUser.id) continue;
        addCandidate({
          id: human.userId,
          name: human.name,
          displayName: human.displayName,
          type: "user",
          avatarUrl: human.avatarUrl,
          gravatarHash: human.gravatarHash,
        });
      }
      for (const agent of agents) {
        if (agent.deletedAt) continue;
        addCandidate({
          id: agent.id,
          serverId: agent.serverId,
          serverName: agent.serverName,
          serverSlug: agent.serverSlug,
          name: agent.name,
          displayName: agent.displayName,
          type: "agent",
          avatarUrl: agent.avatarUrl,
          description: agent.description,
        });
      }
    }
    for (const human of channelHumans) {
      if (currentUser && human.id === currentUser.id) continue;
      const isRemoteHuman = Boolean(currentServer?.id && human.serverId && human.serverId !== currentServer.id);
      addCandidate({
        id: human.id,
        serverId: isRemoteHuman ? human.serverId : undefined,
        serverName: isRemoteHuman ? human.serverName : undefined,
        serverSlug: isRemoteHuman ? human.serverSlug : undefined,
        name: human.name,
        displayName: human.displayName,
        type: "user",
        avatarUrl: human.avatarUrl,
        gravatarHash: human.gravatarHash,
        description: human.description,
      });
    }
    for (const agent of channelAgents) {
      if (agent.deletedAt) continue;
      const isRemoteAgent = Boolean(currentServer?.id && agent.serverId && agent.serverId !== currentServer.id);
      addCandidate({
        id: agent.id,
        serverId: isRemoteAgent ? agent.serverId : undefined,
        serverName: isRemoteAgent ? agent.serverName : undefined,
        serverSlug: isRemoteAgent ? agent.serverSlug : undefined,
        name: agent.name,
        displayName: agent.displayName,
        type: "agent",
        avatarUrl: agent.avatarUrl,
        description: agent.description,
      });
    }
    if (resourceReferencesGate.enabled) {
      for (const machine of machines) {
        if (!machine.isComputer) continue;
        addCandidate({
          id: machine.id,
          name: machine.name,
          displayName: machine.name,
          type: "computer",
          avatarUrl: null,
          description: machine.description,
        });
      }
      for (const app of installedAppsServerIdRef.current === currentServer?.id ? installedApps : []) {
        addCandidate({
          id: app.appId,
          name: app.appId,
          displayName: app.displayName,
          type: "app",
          avatarUrl: null,
        });
      }
    }
    return [...byKey.values()];
  }, [currentUser, currentServer?.id, humans, agents, channelHumans, channelAgents, mentionScopeChannel?.type, machines, installedApps, resourceReferencesGate.enabled]);
  // oxlint-enable react-hooks/exhaustive-deps

  // Stryker disable all: this block is React wiring from local candidate arrays into
  // the covered composer ranker/worker hook. The behavior surface is pinned by
  // composerSuggestionSearch/mentionCandidates unit tests, channel archive source
  // contracts, the forward-composer DOM autocomplete smoke, and the production
  // build worker-bundling check; mutating useMemo deps here produces equivalent
  // source-level survivors rather than useful behavior gaps.
  const mentionSearchEntries = useMemo(() => createMentionCandidateSearchEntries(allCandidates), [allCandidates]);
  const rankedMentionCandidates = useRankedComposerSuggestions(mention.query, mentionSearchEntries);
  const filteredMentions = useMemo(() => {
    return buildMentionCandidateGroupsFromRankedCandidates({
      rankedCandidates: rankedMentionCandidates,
      channelMemberIds,
      threadMessages,
      prioritizeThreadParticipants: Boolean(isChannelThread),
    });
  }, [rankedMentionCandidates, channelMemberIds, isChannelThread, threadMessages]);

  const channelAutocompleteCandidates = useMemo(
    () => channels.filter((c) => c.type === "channel" || c.type === "private" || c.type === "joint"),
    [channels],
  );
  const channelSearchEntries = useMemo(() => {
    return channelAutocompleteCandidates.map((candidate, index): ComposerSuggestionSearchEntry<Channel> => ({
      index,
      suggestion: candidate,
      fields: [
        { raw: candidate.name, priority: 0 },
        { raw: candidate.description ?? "", priority: 3 },
      ],
    }));
  }, [channelAutocompleteCandidates]);
  const filteredChannels = useRankedComposerSuggestions(channel.query, channelSearchEntries);
  // Stryker restore all

  // Clamp indices when filtered lists change
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- clamp on filtered-length change only; `mention` is a fresh object every render (useAutocomplete) so depending on it would re-run every keystroke. `mention.clampIndex` is useCallback-stable.
  useEffect(() => { mention.clampIndex(filteredMentions.flat.length); }, [filteredMentions.flat.length]);
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- clamp on filtered-length change only; `channel` is a fresh object every render (useAutocomplete returns an unmemoized literal) so depending on it would re-run every keystroke. `channel.clampIndex` is useCallback-stable.
  useEffect(() => { channel.clampIndex(filteredChannels.length); }, [filteredChannels.length]);

  // Auto-resize textarea
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const minH = parseFloat(getComputedStyle(el).minHeight) || 0;
    el.style.height = `${Math.max(Math.min(el.scrollHeight, 160), minH)}px`;
  }, []);

  // Selection-quote v0 (#proj-chat task #32): a message's selection context
  // menu "Quote" dispatches SELECTED_TEXT_QUOTE_EVENT with the target composer
  // channelId. Only the composer whose channelId matches pulls it in, so a
  // channel timeline + open thread panel (two mounted MessageInputs) route
  // correctly. Append to live `content` (the draft-save effect persists it).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SelectedTextQuoteDetail>).detail;
      if (!detail || detail.channelId !== channelId) return;
      setContent((prev) => appendQuoteToComposer(prev, detail.quote));
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus({ preventScroll: true });
          const end = el.value.length;
          el.setSelectionRange(end, end);
        }
        autoResize();
      }, 0);
    };
    window.addEventListener(SELECTED_TEXT_QUOTE_EVENT, handler);
    return () => window.removeEventListener(SELECTED_TEXT_QUOTE_EVENT, handler);
  }, [channelId, autoResize]);

  // Stryker disable all: focused behavior tests cover sender-name insertion, channel guard, cursor placement, title, and mention dedupe; remaining mutants here are React callback/timer mechanics or jsdom-defensive branches.
  const handleSenderMentionInsert = useCallback((event: Event) => {
    const detail = getSenderMentionInsertDetail(event);
    if (!detail || detail.channelId !== channelId) return;
    // Mobile keyboards require focus to happen synchronously inside the
    // originating tap/long-press gesture. Match a direct textarea tap here:
    // native focus must be allowed to scroll the composer into the shrunken
    // visual viewport. The layout effect below restores only the cursor after
    // React commits, without causing a second scroll.
    const textarea = textareaRef.current;
    if (textarea && document.activeElement !== textarea) textarea.focus();
    const currentContent = contentRef.current;
    // Stryker disable next-line OptionalChaining: the handler only runs while the composer is mounted; no-textarea fallback is defensive.
    const cursorPos = textareaRef.current?.selectionStart ?? currentContent.length;
    const { newContent, newCursor } = insertMentionAtCursor(currentContent, cursorPos, detail.mention.name);
    mentionUndoSnapshotRef.current = {
      beforeContent: currentContent,
      beforeMentions: selectedMentionsRef.current,
      beforeCursor: cursorPos,
      afterContent: newContent,
      afterCursor: newCursor,
    };
    pendingSenderMentionCursorRef.current = newCursor;
    contentRef.current = newContent;
    setContent(newContent);
    setSelectedMentions((prev) => {
      const without = prev.filter((item) => item.name !== detail.mention.name);
      return [...without, detail.mention];
    });
    mention.dismiss();
    channel.dismiss();
  }, [channel, channelId, mention]);
  // Stryker restore all

  // Stryker disable all: cursor restoration is a DOM post-commit effect for a custom event; focused behavior tests assert the observable cursor result.
  useLayoutEffect(() => {
    const cursor = pendingSenderMentionCursorRef.current;
    if (cursor === null) return;
    pendingSenderMentionCursorRef.current = null;
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(cursor, cursor);
    }
    autoResize();
  }, [autoResize, content]);
  // Stryker restore all

  // Stryker disable all: listener cleanup/deps prevent duplicate/stale DOM subscriptions across remounts, which this focused fixture cannot observe reliably.
  useEffect(() => {
    window.addEventListener(SENDER_MENTION_INSERT_EVENT, handleSenderMentionInsert);
    return () => window.removeEventListener(SENDER_MENTION_INSERT_EVENT, handleSenderMentionInsert);
  }, [handleSenderMentionInsert]);
  // Stryker restore all

  // Insert helpers
  const doInsertMention = useCallback((candidate: MentionCandidate) => {
    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    let newCursor: number;
    if (candidate.type === "computer" || candidate.type === "app") {
      const target = candidate.type === "computer"
        ? formatRaftRefTarget({ kind: "computer", machineId: candidate.id })
        : formatRaftRefTarget({ kind: "app", appId: candidate.id });
      const label = `@${escapeMarkdownLinkLabel(candidate.displayName || candidate.name)}`;
      const reference = `[${label}](<${target}>)`;
      const before = content.slice(0, mention.startPos);
      const after = content.slice(cursorPos);
      const newContent = `${before}${reference} ${after}`;
      newCursor = before.length + reference.length + 1;
      setContent(newContent);
    } else {
      const insertion = mention.buildInsert(candidate.name, content, cursorPos);
      newCursor = insertion.newCursor;
      mentionUndoSnapshotRef.current = {
        beforeContent: content,
        beforeMentions: selectedMentionsRef.current,
        beforeCursor: cursorPos,
        afterContent: insertion.newContent,
        afterCursor: insertion.newCursor,
      };
      setContent(insertion.newContent);
      const selected: MessageMention = {
        type: candidate.type,
        id: candidate.id,
        name: candidate.name,
      };
      setSelectedMentions((prev) => {
        const without = prev.filter((item) => item.name !== selected.name);
        return [...without, selected];
      });
    }
    mention.dismiss();
    setTimeout(() => { textareaRef.current?.focus({ preventScroll: true }); textareaRef.current?.setSelectionRange(newCursor, newCursor); }, 0);
  }, [content, mention]);

  const doInsertChannel = useCallback((ch: { name: string }) => {
    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    const { newContent, newCursor } = channel.buildInsert(ch.name, content, cursorPos);
    setContent(newContent);
    channel.dismiss();
    setTimeout(() => { textareaRef.current?.focus({ preventScroll: true }); textareaRef.current?.setSelectionRange(newCursor, newCursor); }, 0);
  }, [content, channel]);

  const preventAutocompleteOptionMouseDown = useCallback((e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
  }, []);

  // File handling
  const formatUploadError = useCallback((err: unknown): string => {
    if (err instanceof AttachmentUploadClientError) {
      return formatAttachmentUploadClientError(err, formatMessageRef.current);
    }
    const responseError =
      typeof err === "object" &&
      err !== null &&
      "response" in err &&
      typeof (err as { response?: { data?: { error?: string } } }).response?.data?.error === "string"
        ? (err as { response?: { data?: { error?: string } } }).response!.data!.error!
        : null;
    if (responseError) return formatAttachmentUploadServerError(responseError, formatMessageRef.current);
    return formatMessageRef.current({ id: "message.composer.uploadRetryHint" });
  }, []);

  const startAttachmentUpload = useCallback(async (
    pending: PendingFile,
    origin: { channelId: string; draftCacheKey: string } = {
      channelId: committedComposerOwnershipRef.current?.channelId ?? channelId,
      draftCacheKey: committedComposerOwnershipRef.current?.draftCacheKey ?? draftPendingFilesCacheKey,
    },
  ) => {
    const updatePendingFile = (update: (file: PendingFile) => PendingFile) => {
      if (isCommittedComposerOwner(origin.channelId, origin.draftCacheKey)) {
        setPendingFiles((prev) => prev.map((pf) => pf.id === pending.id ? update(pf) : pf));
        return;
      }
      const saved = getDraftPendingFiles(origin.draftCacheKey);
      const next = saved.length > 0 ? saved : [pending];
      saveDraftPendingFiles(
        origin.draftCacheKey,
        next.map((file) => file.id === pending.id ? update(file) : file),
      );
    };
    uploadControllersRef.current.get(pending.id)?.abort();
    const controller = new AbortController();
    uploadControllersRef.current.set(pending.id, controller);

    updatePendingFile((file) => ({
      ...file,
      uploadStatus: "uploading",
      uploadProgress: 0,
      attachmentId: undefined,
      uploadError: undefined,
      uploadCanRetry: undefined,
    }));

    try {
      const uploadChannelId = await resolveDeliveryChannelId();
      const attachmentId = await uploadAttachmentFile({
        api,
        file: pending.file,
        channelId: uploadChannelId,
        clientRequestId: pending.uploadClientRequestId,
        previousSession: pending.directUploadSession,
        signal: controller.signal,
        onSession: (directUploadSession) => {
          updatePendingFile((file) => ({ ...file, directUploadSession }));
        },
        onProgress: (uploadProgress) => {
          updatePendingFile((file) => ({ ...file, uploadProgress }));
        },
        legacyUpload: async () => {
          return uploadLegacyAttachmentWithIdleTimeout({
            signal: controller.signal,
            upload: async ({ signal, markProgress, markTransferComplete }) => {
              const formData = new FormData();
              formData.append("channelId", uploadChannelId);
              formData.append("files", pending.file);
              let uploadedBytes = 0;
              const { data } = await api.post<AttachmentUploadResponse>("/attachments/upload", formData, {
                headers: { "Content-Type": "multipart/form-data" },
                signal,
                onUploadProgress: (event) => {
                  if (event.loaded <= uploadedBytes) return;
                  uploadedBytes = event.loaded;
                  markProgress();
                  if (
                    (event.total !== undefined && event.loaded >= event.total)
                    || event.progress === 1
                  ) {
                    markTransferComplete();
                  }
                  if (!event.total) return;
                  const progress = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
                  updatePendingFile((file) => ({ ...file, uploadProgress: progress }));
                },
              });
              const legacyAttachmentId = data.attachments[0]?.id;
              if (!legacyAttachmentId) throw new Error("Upload response did not include an attachment id");
              return legacyAttachmentId;
            },
          });
        },
      });
      updatePendingFile((file) => ({
        ...file,
        uploadStatus: "ready",
        uploadProgress: 100,
        directUploadSession: undefined,
        attachmentId,
        uploadError: undefined,
        uploadCanRetry: undefined,
      }));
      return attachmentId;
    } catch (err) {
      if (controller.signal.aborted) return null;
      updatePendingFile((file) => ({
        ...file,
        uploadStatus: "error",
        attachmentId: undefined,
        uploadError: formatUploadError(err),
        uploadCanRetry: !(err instanceof AttachmentUploadClientError) || err.retryable,
      }));
      return null;
    } finally {
      if (uploadControllersRef.current.get(pending.id) === controller) {
        uploadControllersRef.current.delete(pending.id);
      }
    }
  }, [channelId, draftPendingFilesCacheKey, formatUploadError, isCommittedComposerOwner, resolveDeliveryChannelId]);

  const addFiles = useCallback((files: FileList | File[]) => {
    // Compact comment composer: comments are text + anchor, never files —
    // drop drags/pastes/picker input at the single entry point.
    if (variant === "compact") return;
    const candidates = Array.from(files);
    if (candidates.length === 0) return;

    // Show the local files before the server-owned ceiling resolves. This state
    // is deliberately "validating", not "uploading": no network transfer has
    // started and the files are not sendable yet.
    const provisionalFiles: PendingFile[] = candidates.map((file) => ({
      id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
      file,
      preview: isPreviewableImageFile(file) ? URL.createObjectURL(file) : null,
      uploadStatus: "validating",
      uploadProgress: 0,
      uploadClientRequestId: crypto.randomUUID(),
    }));
    const provisionalIds = new Set(provisionalFiles.map((file) => file.id));
    const selectionGeneration = attachmentSelectionGenerationRef.current;
    const selectionSignal = attachmentSelectionAbortRef.current.signal;
    const attachmentMaxSizePromise = resolveAttachmentUploadLimitBytes();

    submittedDraftIntentRef.current = null;
    pendingFilesRef.current = [...pendingFilesRef.current, ...provisionalFiles];
    setPendingFiles((prev) => [...prev, ...provisionalFiles]);
    for (const pending of provisionalFiles) {
      if (pending.preview) {
        void readLocalImageDimensions(pending.preview).then((dimensions) => {
          if (!dimensions) return;
          setPendingFiles((prev) => prev.map((pf) => (
            pf.id === pending.id
              ? { ...pf, previewWidth: dimensions.width, previewHeight: dimensions.height }
              : pf
          )));
        });
      }
    }

    const validateSelection = async () => {
      let handleAbort: (() => void) | null = null;
      const aborted = new Promise<"aborted">((resolve) => {
        if (selectionSignal.aborted) resolve("aborted");
        else {
          handleAbort = () => resolve("aborted");
          selectionSignal.addEventListener("abort", handleAbort, { once: true });
        }
      });
      const attachmentMaxSizeBytes = await Promise.race([attachmentMaxSizePromise, aborted]);
      if (handleAbort) selectionSignal.removeEventListener("abort", handleAbort);
      if (
        attachmentMaxSizeBytes === "aborted"
        || selectionSignal.aborted
        || selectionGeneration !== attachmentSelectionGenerationRef.current
      ) return;

      const currentFiles = pendingFilesRef.current;
      const currentProvisionalFiles = currentFiles.filter((file) => (
        provisionalIds.has(file.id) && file.uploadStatus === "validating"
      ));
      if (currentProvisionalFiles.length === 0) return;

      // Validation batches are applied in selection order. Later provisional
      // rows do not consume earlier batches' slots, and a rejected/removed row
      // releases its slot before the next batch is decided.
      const existingCount = currentFiles.filter((file) => (
        !provisionalIds.has(file.id) && file.uploadStatus !== "validating"
      )).length;
      // Stryker disable next-line all: pass-through into the tested selection decision.
      const decision = decideMessageAttachmentSelection(
        existingCount,
        currentProvisionalFiles.map((file) => file.file),
        attachmentMaxSizeBytes,
        formatMessageRef.current,
      );
      const remainingAccepted = [...decision.accepted];
      const acceptedFiles = currentProvisionalFiles.filter((pending) => {
        const index = remainingAccepted.indexOf(pending.file);
        if (index < 0) return false;
        remainingAccepted.splice(index, 1);
        return true;
      });
      const acceptedIds = new Set(acceptedFiles.map((file) => file.id));
      for (const rejected of currentProvisionalFiles) {
        if (!acceptedIds.has(rejected.id) && rejected.preview) URL.revokeObjectURL(rejected.preview);
      }

      const applyDecision = (filesToUpdate: PendingFile[]) => filesToUpdate.flatMap((file) => {
        if (!provisionalIds.has(file.id) || file.uploadStatus !== "validating") return [file];
        if (!acceptedIds.has(file.id)) return [];
        return [{ ...file, uploadStatus: "queued" as const }];
      });
      pendingFilesRef.current = applyDecision(currentFiles);
      setPendingFiles(applyDecision);
      setError(decision.error);

      if (!resolveChannelId) {
        for (const pending of acceptedFiles) void startAttachmentUpload(pending);
      }
    };
    attachmentSelectionQueueRef.current = attachmentSelectionQueueRef.current.then(
      validateSelection,
      validateSelection,
    );
  }, [resolveChannelId, startAttachmentUpload, variant]);

  const handleAttachmentPickerChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.currentTarget.files;
    if (files && files.length > 0) {
      // Keep focus through the toolbar tap so mobile browsers reliably open
      // the native picker, then release it as soon as a selection returns.
      // iOS otherwise restores the textarea as the active element, leaves the
      // software keyboard open, and the new attachment row can push the
      // composer below the shrunken visual viewport.
      textareaRef.current?.blur();
      void addFiles(files);
    }
    e.currentTarget.value = "";
  }, [addFiles]);

  const removeFile = useCallback((index: number) => {
    submittedDraftIntentRef.current = null;
    setPendingFiles((prev) => {
      const removed = prev[index];
      if (removed) {
        uploadControllersRef.current.get(removed.id)?.abort();
        uploadControllersRef.current.delete(removed.id);
        if (removed.directUploadSession) {
          void cancelAttachmentUploadSession(api, removed.directUploadSession.uploadId).catch(() => undefined);
        }
      }
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, []);

  const retryFile = useCallback((id: string) => {
    const pending = pendingFilesRef.current.find((pf) => pf.id === id);
    if (pending) {
      void startAttachmentUpload(pending);
    }
  }, [startAttachmentUpload]);

  const openDraftImagePreview = useCallback((attachmentId: string) => {
    const readyImages: MessageAttachment[] = pendingFilesRef.current
      .filter((pf) => pf.preview && pf.uploadStatus === "ready" && pf.attachmentId)
      .map((pf) => ({
        id: pf.attachmentId!,
        filename: pf.file.name,
        mimeType: pf.file.type,
        sizeBytes: pf.file.size,
        width: pf.previewWidth ?? null,
        height: pf.previewHeight ?? null,
        thumbnailUrl: null,
        localPreviewUrl: pf.preview,
      }));
    const imageIndex = readyImages.findIndex((attachment) => attachment.id === attachmentId);
    if (imageIndex >= 0) {
      useImageLightboxStore.getState().open(readyImages, imageIndex);
    }
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursorPos = e.target.selectionStart;
    const undoSnapshot = mentionUndoSnapshotRef.current;
    if (undoSnapshot && val !== undoSnapshot.afterContent) {
      mentionUndoSnapshotRef.current = null;
    }
    submittedDraftIntentRef.current = null;
    setContent(val);
    setSelectedMentions((prev) => prev.filter((selected) => mentionStillAppears(val, selected)));
    autoResize();

    const textBeforeCursor = val.slice(0, cursorPos);
    if (mention.detect(textBeforeCursor, cursorPos)) {
      channel.dismiss();
    } else if (!channel.detect(textBeforeCursor, cursorPos)) {
      // Neither matched — both are already dismissed by detect()
    }
  };

  // Handle pasting copied files from the OS clipboard into the attachment flow.
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const pastedFiles = extractClipboardFiles(e.clipboardData);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      void addFiles(pastedFiles);
    }
  }, [addFiles]);

  // ── Drag-and-drop file upload ──────────────────────────────────────
  // tygg / cindyz 2026-05-06 #proj-uiux task #121:
  //   "input box 应该可以支持文件拖拽上传，这个小心点做"
  //
  // The "small care" cindyz called for translates to four things:
  //   1. Only react to file drags. Text drags must not trigger the overlay
  //      or push 0-byte files into pendingFiles. We gate on
  //      `dataTransfer.types.includes("Files")` (set by the browser only
  //      when the OS-level drag carries files).
  //   2. Don't flicker the overlay when the cursor crosses nested children
  //      inside the composer (textarea, attachment chips, send button).
  //      `dragenter` / `dragleave` fire on every parent/child crossing —
  //      track an enter-count ref and only hide when it returns to 0.
  //   3. Don't conflict with the existing paste path. Both reuse `addFiles`,
  //      which already enforces the per-file size cap, the empty-file
  //      reject, and the message attachment cap.
  //   4. No-op on touch devices. Touch doesn't fire HTML5 drag events at
  //      all, so the overlay simply never appears — no extra mobile guard
  //      needed.
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragCounterRef = useRef(0);

  const isFileDrag = (e: React.DragEvent): boolean => {
    if (!e.dataTransfer) return false;
    // `types` is a DOMStringList; spec guarantees "Files" when the OS-level
    // drag is files. Text drags carry "text/plain" / "text/html" instead.
    return Array.from(e.dataTransfer.types).includes("Files");
  };

  // Compact (comment composer): file drags must show NO attach affordance
  // (Dozy review of 09b5292e) — but dragover/drop still need preventDefault,
  // otherwise releasing a file over the composer triggers the browser's
  // default "open file" navigation. So compact swallows the drag with a
  // "none" drop cursor, never tracks counters, never reveals the overlay,
  // never adds files.
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (variant === "compact") return;
    dragCounterRef.current += 1;
    if (dragCounterRef.current === 1) setIsDraggingFiles(true);
  }, [variant]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (variant === "compact") return;
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDraggingFiles(false);
    }
  }, [variant]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    // Required to allow the drop event. Without preventDefault on dragover
    // the browser falls back to its default "open file" behavior (which
    // would navigate the tab away from Slock — exactly the disaster
    // cindyz's "小心点做" is asking us to avoid).
    e.preventDefault();
    e.dataTransfer.dropEffect = variant === "compact" ? "none" : "copy";
  }, [variant]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    if (variant === "compact") return;
    dragCounterRef.current = 0;
    setIsDraggingFiles(false);

    // Folder filter — cindyz #proj-uiux:040edcd0 follow-up:
    //   "现在好像一整个文件夹拖入也是会显示 overlay?".
    //
    // The overlay can't be suppressed during drag (DataTransfer.items only
    // exposes `kind`/`type` synchronously, not the underlying File-vs-Folder
    // distinction — `webkitGetAsEntry()` is what tells you that, and it's
    // only safely callable on drop in some browsers). So we let the overlay
    // reveal, then on drop we walk the items, identify folders via
    // `webkitGetAsEntry()`, skip them, and surface a clear error so the
    // user knows what happened. Without this, dropping a folder would
    // produce a 0-byte phantom File which `addFiles` rejects as "Empty
    // files cannot be uploaded." — accurate but confusing.
    let folderSkipped = false;
    const items = e.dataTransfer.items;
    if (items && items.length > 0) {
      const fileItems: File[] = [];
      const seen = new Set<string>();
      for (const item of Array.from(items)) {
        if (item.kind !== "file") continue;
        const entry = (item as { webkitGetAsEntry?: () => { isDirectory: boolean } | null })
          .webkitGetAsEntry?.();
        if (entry && entry.isDirectory) {
          folderSkipped = true;
          continue;
        }
        const file = item.getAsFile();
        if (!file) continue;
        const key = `${file.name}::${file.size}::${file.type}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fileItems.push(file);
      }
      if (fileItems.length > 0) void addFiles(fileItems);
      if (folderSkipped && fileItems.length === 0) {
        setError(formatMessageRef.current({ id: "message.composer.foldersCantUpload" }));
      } else if (folderSkipped) {
        // Mixed drop: at least one real file went through, plus at least
        // one folder was skipped. Best-effort: surface a softer notice.
        setError(formatMessageRef.current({ id: "message.composer.foldersSkipped" }));
      }
      return;
    }
    // Fallback for browsers / events without `items` — use `files` directly.
    // No way to tell folders apart in this branch; addFiles' empty-file
    // reject will catch most cases.
    const fallback = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : [];
    if (fallback.length > 0) void addFiles(fallback);
  }, [addFiles, variant]);

  const restoreFailedSendDraft = useCallback((
    failedContent: string,
    failedMentions: MessageMention[],
    targetChannelId: string,
    targetDraftCacheKey: string,
  ) => {
    // The request may settle after the user has switched threads. Restore into
    // the channel that owned the send, never into whichever composer happens
    // to be visible when the failure callback runs.
    const committedOwner = committedComposerOwnershipRef.current;
    const isCurrentComposer = isCommittedComposerOwner(targetChannelId, targetDraftCacheKey);
    const currentDraft = isCurrentComposer
      ? contentRef.current
      : useMessageStore.getState().drafts[targetChannelId] ?? "";
    const restoredContent = mergeFailedSendIntoDraft(failedContent, currentDraft);
    if (isCurrentComposer && committedOwner && committedOwner.channelId !== targetChannelId) {
      useMessageStore.getState().setDraft(committedOwner.channelId, restoredContent);
      useMessageStore.getState().clearDraft(targetChannelId);
    } else {
      useMessageStore.getState().setDraft(targetChannelId, restoredContent);
    }
    const previousMentions = failedSendMentionsByDraftKey.get(targetDraftCacheKey) ?? [];
    const mergedMentions = mergeFailedSendMentions(previousMentions, failedMentions);
    if (!isCurrentComposer) {
      failedSendMentionsByDraftKey.set(
        targetDraftCacheKey,
        mergedMentions.filter((mention) => mentionStillAppears(restoredContent, mention)),
      );
      return false;
    }
    failedSendMentionsByDraftKey.delete(targetDraftCacheKey);
    const currentDraftCacheKey = committedOwner?.draftCacheKey;
    if (isCurrentComposer && currentDraftCacheKey && currentDraftCacheKey !== targetDraftCacheKey) {
      failedSendMentionsByDraftKey.set(
        currentDraftCacheKey,
        mergedMentions.filter((mention) => mentionStillAppears(restoredContent, mention)),
      );
    }
    contentRef.current = restoredContent;
    setContent(restoredContent);
    setSelectedMentions((currentMentions) => {
      return mergeFailedSendMentions(mergedMentions, currentMentions)
        .filter((mention) => mentionStillAppears(restoredContent, mention));
    });
    return true;
  }, [isCommittedComposerOwner]);

  const handleSubmit = async (e: React.FormEvent | React.KeyboardEvent, options?: { forceAsTask?: boolean }) => {
    e.preventDefault();
    if (submitDisabled || submitBusy) return;
    const hasContent = content.trim().length > 0;
    const hasFiles = pendingFiles.length > 0;
    if (!hasContent && !hasFiles && !(allowEmptySubmit && onSendOverride)) return;
    const submitAsTask = alsoCreateTask || options?.forceAsTask === true;
    if (pendingFiles.some((pf) => pf.uploadStatus === "validating")) {
      setError(formatMessage({ id: "message.composer.waitForAttachmentChecks" }));
      return;
    }
    if (pendingFiles.some((pf) => pf.uploadStatus === "uploading")) {
      setError(formatMessage({ id: "message.composer.waitForUploads" }));
      return;
    }
    if (pendingFiles.some((pf) => pf.uploadStatus === "error")) {
      setError(formatMessage({ id: "message.composer.removeOrRetryBeforeSend" }));
      return;
    }

    const msg = content;
    const submittedComposerChannelId = channelId;
    const submittedDraftPendingFilesCacheKey = draftPendingFilesCacheKey;
    const mentionsToSend = selectedMentions.filter((selected) => mentionStillAppears(msg, selected));
    let filesToSend = [...pendingFiles];
    // Stryker disable all: source contract pins this stale-render duplicate-submit guard; the duplicate window is same-draft event replay before React state flush.
    const submittedDraftIntent = JSON.stringify({
      channelId,
      content: msg,
      attachmentIds: filesToSend.map((file) => file.attachmentId ?? `pending:${file.id}`),
      submitAsTask,
      mentions: mentionsToSend.map((mention) => `${mention.type}:${mention.id}:${mention.name}`),
    });
    if (submittedDraftIntentRef.current === submittedDraftIntent) {
      return;
    }
    submittedDraftIntentRef.current = submittedDraftIntent;
    // Stryker restore all
    let deliveryChannelId: string;
    try {
      deliveryChannelId = await resolveDeliveryChannelId();
    } catch (err) {
      submittedDraftIntentRef.current = releaseSubmittedDraftIntent(
        submittedDraftIntentRef.current,
        submittedDraftIntent,
      );
      const errorMessage =
        typeof err === "object" &&
        err !== null &&
        "response" in err &&
        typeof (err as { response?: { data?: { error?: string } } }).response?.data?.error === "string"
          ? (err as { response?: { data?: { error?: string } } }).response!.data!.error!
          : formatMessage({ id: "message.composer.failedCreateThread" });
      if (isCommittedComposerOwner(submittedComposerChannelId, submittedDraftPendingFilesCacheKey)) {
        setError(errorMessage);
      }
      return;
    }
    const uploadedByPendingId = new Map<string, string>();
    const queuedFiles = filesToSend.filter((file) => file.uploadStatus === "queued");
    if (queuedFiles.length > 0) {
      const uploadedIds = await Promise.all(queuedFiles.map((file) => startAttachmentUpload(file, {
        channelId: submittedComposerChannelId,
        draftCacheKey: submittedDraftPendingFilesCacheKey,
      })));
      for (let index = 0; index < queuedFiles.length; index += 1) {
        const attachmentId = uploadedIds[index];
        if (attachmentId) uploadedByPendingId.set(queuedFiles[index]!.id, attachmentId);
      }
      if (uploadedByPendingId.size !== queuedFiles.length) {
        submittedDraftIntentRef.current = releaseSubmittedDraftIntent(
          submittedDraftIntentRef.current,
          submittedDraftIntent,
        );
        if (isCommittedComposerOwner(submittedComposerChannelId, submittedDraftPendingFilesCacheKey)) {
          setError(formatMessage({ id: "message.composer.removeOrRetryBeforeSend" }));
        }
        return;
      }
      filesToSend = filesToSend.map((file) => {
        const attachmentId = uploadedByPendingId.get(file.id);
        return attachmentId
          ? {
              ...file,
              uploadStatus: "ready",
              uploadProgress: 100,
              attachmentId,
              uploadError: undefined,
            }
          : file;
      });
    }
    const attachmentIds = filesToSend.map((file) => file.attachmentId);
    if (hasFiles && attachmentIds.some((id) => !id)) {
      submittedDraftIntentRef.current = releaseSubmittedDraftIntent(
        submittedDraftIntentRef.current,
        submittedDraftIntent,
      );
      if (isCommittedComposerOwner(submittedComposerChannelId, submittedDraftPendingFilesCacheKey)) {
        setError(formatMessage({ id: "message.composer.waitForUploads" }));
      }
      return;
    }
    const submittedTextarea = textareaRef.current!;
    const keepComposerFocused = e.type === "keydown";
    setContent("");
    setSelectedMentions([]);
    clearDraft(channelId);
    // Stryker disable next-line ArrayDeclaration: clearing the draft-pending cache is pinned by the remount/send DOM test; `setPendingFiles([])` also keeps the in-memory chip state clear.
    saveDraftPendingFiles(draftPendingFilesCacheKeyRef.current, []);
    setPendingFiles([]);
    mention.dismiss();
    channel.dismiss();
    submittedTextarea.style.height = "";
    if (!keepComposerFocused) submittedTextarea.blur();

    // Override path (compact comment composer): the caller owns delivery and
    // list refresh; no optimistic row exists to reconcile. Failure restores
    // the typed content + mentions exactly like the store path below.
    if (onSendOverride) {
      try {
        await onWillSend?.();
        setError("");
        await onSendOverride(msg, mentionsToSend);
      } catch (err) {
        submittedDraftIntentRef.current = releaseSubmittedDraftIntent(
          submittedDraftIntentRef.current,
          submittedDraftIntent,
        );
        const isCurrentComposer = restoreFailedSendDraft(
          msg,
          mentionsToSend,
          submittedComposerChannelId,
          submittedDraftPendingFilesCacheKey,
        );
        if (isCurrentComposer) submittedTextarea.focus();
        const errorMessage =
          typeof err === "object" &&
          err !== null &&
          "response" in err &&
          typeof (err as { response?: { data?: { error?: string } } }).response?.data?.error === "string"
            ? (err as { response?: { data?: { error?: string } } }).response!.data!.error!
            : formatMessage({ id: "message.composer.failedToSend" });
        if (isCurrentComposer) setError(errorMessage);
      }
      return;
    }

    // Stryker disable next-line all: attachment-only fallback copy predates the stale-submit guard; this source oracle is not a DOM copy test.
    const messageContent = hasContent
      ? msg
      : formatMessage({ id: "message.composer.attachmentsOnlyBody" }, { count: filesToSend.length });
    const optimisticDraft = createOptimisticMessageDraft();
    const optimisticId = optimisticDraft.id;

    try {
      await onWillSend?.();
      setError("");
      setUnresolvedMentionHandles([]);

      // Create optimistic message immediately. Images get local blob previews; other files get filename cards.
      const optimisticAttachments = filesToSend.map((pf, i) => ({
        id: `optimistic-att-${i}`,
        filename: pf.file.name,
        mimeType: pf.file.type,
        sizeBytes: pf.file.size,
        width: pf.previewWidth ?? null,
        height: pf.previewHeight ?? null,
        localPreviewUrl: pf.preview,
        thumbnailUrl: null,
      }));
      addOptimisticMessage({
        id: optimisticId,
        channelId: deliveryChannelId,
        randomId: optimisticDraft.randomId,
        senderType: "user",
        senderId: currentUser?.id || "",
        senderName: currentUser?.displayName || currentUser?.name || formatMessage({ id: "message.author.you" }),
        // Stryker disable next-line all: optimistic row message type predates the stale-submit guard and is covered by reconciliation tests.
        messageType: "chat",
        content: messageContent,
        mentions: hasContent ? mentionsToSend : undefined,
        createdAt: optimisticDraft.createdAt,
        // Stryker disable next-line all: optimistic attachment shape is covered by reconciliation/attachment tests outside this mobile keyboard oracle.
        attachments: optimisticAttachments.length > 0 ? optimisticAttachments : undefined,
      });

      // Send message with already-uploaded attachment ids — server response
      // arrives via socket, which auto-replaces the optimistic message.
      // Stryker disable next-line MethodExpression: the preceding missing-id guard makes the defensive filter equivalent for UI submits; behavior tests pin the forwarded ids.
      const sendResult = await sendMessage(deliveryChannelId, messageContent, attachmentIds.filter((id): id is string => Boolean(id)), submitAsTask || undefined, optimisticId, optimisticDraft.randomId, hasContent ? mentionsToSend : undefined);
      onChannelResolved?.(deliveryChannelId);
      setPendingMentionActions(sendResult.pendingMentionActions);
      setUnresolvedMentionHandles(sendResult.unresolvedMentionHandles ?? []);
      setPendingMentionActionState({});
      setPendingMentionActionRemoving({});
      setPendingMentionActionExecuting({});
      setMentionActionNotice("");
      // Do not revoke image blob URLs here. The message store preserves them
      // through the optimistic -> persisted handoff so sent images do not
      // flash/reload when the server ack replaces the local row.

      if (alsoCreateTask) {
        // Stryker disable next-line all: checkbox reset predates the stale-submit guard; shortcut/source tests cover task-submit wiring.
        setAlsoCreateTask(false);
      }
    } catch (err) {
      // Remove optimistic message on failure, restore content
      submittedDraftIntentRef.current = releaseSubmittedDraftIntent(
        submittedDraftIntentRef.current,
        submittedDraftIntent,
      );
      removeOptimisticMessage(optimisticId, deliveryChannelId);
      const isCurrentComposer = restoreFailedSendDraft(
        msg,
        mentionsToSend,
        submittedComposerChannelId,
        submittedDraftPendingFilesCacheKey,
      );
      if (isCurrentComposer) {
        setPendingFiles(filesToSend);
        submittedTextarea.focus();
      } else {
        saveDraftPendingFiles(
          submittedDraftPendingFilesCacheKey,
          filesToSend,
        );
      }
      const errorMessage =
        typeof err === "object" &&
        err !== null &&
        "response" in err &&
        typeof (err as { response?: { data?: { error?: string } } }).response?.data?.error === "string"
          ? (err as { response?: { data?: { error?: string } } }).response!.data!.error!
          : formatMessage({ id: "message.composer.failedToSendMessage" });
      if (isCurrentComposer) setError(errorMessage);
      console.error("Failed to send message:", err);
    }
  };

  const clearPendingMentionActionRemovalTimers = useCallback((resolutionId?: string) => {
    const clearTimers = (timers: ReturnType<typeof setTimeout>[] | undefined) => {
      timers?.forEach((timer) => clearTimeout(timer));
    };
    if (resolutionId) {
      clearTimers(pendingMentionActionRemovalTimersRef.current.get(resolutionId));
      pendingMentionActionRemovalTimersRef.current.delete(resolutionId);
      return;
    }
    pendingMentionActionRemovalTimersRef.current.forEach(clearTimers);
    pendingMentionActionRemovalTimersRef.current.clear();
  }, []);

  const removePendingMentionAction = useCallback((resolutionId: string, preserveFeedback = false) => {
    clearPendingMentionActionRemovalTimers(resolutionId);
    if (!preserveFeedback) {
      setError("");
      setMentionActionNotice("");
    }
    setPendingMentionActions((prev) => prev.filter((action) => action.resolutionId !== resolutionId));
    setPendingMentionActionState((prev) => {
      const { [resolutionId]: _removed, ...rest } = prev;
      return rest;
    });
    setPendingMentionActionRemoving((prev) => {
      const { [resolutionId]: _removed, ...rest } = prev;
      return rest;
    });
    setPendingMentionActionExecuting((prev) => {
      const { [resolutionId]: _removed, ...rest } = prev;
      return rest;
    });
  }, [clearPendingMentionActionRemovalTimers]);

  useEffect(() => () => {
    clearPendingMentionActionRemovalTimers();
  }, [clearPendingMentionActionRemovalTimers]);

  const schedulePendingMentionActionRemoval = useCallback((
    resolutionId: string,
    state: PendingMentionActionLocalState,
    preserveFeedback = false,
  ) => {
    clearPendingMentionActionRemovalTimers(resolutionId);
    setPendingMentionActionState((prev) => ({ ...prev, [resolutionId]: state }));
    const fadeTimer = setTimeout(() => {
      setPendingMentionActionRemoving((prev) => ({ ...prev, [resolutionId]: true }));
    }, 450);
    const removeTimer = setTimeout(() => {
      removePendingMentionAction(resolutionId, preserveFeedback);
    }, 750);
    pendingMentionActionRemovalTimersRef.current.set(resolutionId, [fadeTimer, removeTimer]);
  }, [clearPendingMentionActionRemovalTimers, removePendingMentionAction]);

  const markPendingMentionAction = useCallback(async (resolutionId: string, state: PendingMentionActionLocalState) => {
    const action = state === "added" ? "add" : "notify";
    setPendingMentionActionExecuting((prev) => ({ ...prev, [resolutionId]: state }));
    setError("");
    setMentionActionNotice("");
    try {
      const { data } = await api.post<PendingMentionActionExecuteResponse>("/messages/mention-actions/execute", {
        action,
        resolutionIds: [resolutionId],
      });
      const result = data.results?.find((row) => row.resolutionId === resolutionId);
      if (!mentionActionSucceeded(action, result)) {
        setMentionActionNotice(formatMentionActionStatusNotice(result, formatMessageRef.current));
        return;
      }
      if (state === "added") {
        notifyChannelMembersChanged(membershipChannelId);
      }
      schedulePendingMentionActionRemoval(resolutionId, state);
    } catch (err) {
      const errorMessage =
        typeof err === "object" &&
        err !== null &&
        "response" in err &&
        typeof (err as { response?: { data?: { error?: string } } }).response?.data?.error === "string"
          ? (err as { response?: { data?: { error?: string } } }).response!.data!.error!
          : formatMessageRef.current({ id: "message.composer.failedMentionAction" });
      setError(errorMessage);
      console.error("Failed to execute mention action:", err);
    } finally {
      setPendingMentionActionExecuting((prev) => {
        const { [resolutionId]: _done, ...rest } = prev;
        return rest;
      });
    }
  }, [membershipChannelId, schedulePendingMentionActionRemoval]);

  const addAllPendingMentionActions = useCallback(async (resolutionIds: string[]) => {
    const uniqueResolutionIds = Array.from(new Set(resolutionIds));
    if (uniqueResolutionIds.length < 2 || pendingMentionActionBatchInFlightRef.current) return;
    pendingMentionActionBatchInFlightRef.current = true;

    setPendingMentionActionExecuting((prev) => {
      const next = { ...prev };
      uniqueResolutionIds.forEach((resolutionId) => {
        next[resolutionId] = "added";
      });
      return next;
    });
    setError("");
    setMentionActionNotice("");
    try {
      const { data } = await api.post<PendingMentionActionExecuteResponse>("/messages/mention-actions/execute", {
        action: "add",
        resolutionIds: uniqueResolutionIds,
      });
      const resultsById = new Map(data.results?.map((result) => [result.resolutionId, result]) ?? []);
      const succeededIds = uniqueResolutionIds.filter((resolutionId) => (
        mentionActionSucceeded("add", resultsById.get(resolutionId))
      ));
      const failedIds = uniqueResolutionIds.filter((resolutionId) => !succeededIds.includes(resolutionId));

      if (succeededIds.length > 0) {
        notifyChannelMembersChanged(membershipChannelId);
      }
      if (failedIds.length > 0) {
        const failureNotice = formatMentionActionStatusNotice(
          resultsById.get(failedIds[0]!),
          formatMessageRef.current,
        );
        setMentionActionNotice(
          succeededIds.length > 0
            ? `${formatMessageRef.current(
              { id: "message.composer.mentionAddedPartial" },
              { succeeded: succeededIds.length, total: uniqueResolutionIds.length },
            )}${failureNotice}`
            : `${formatMessageRef.current({ id: "message.composer.mentionAddedNone" })}${failureNotice}`,
        );
      }
      succeededIds.forEach((resolutionId) => {
        schedulePendingMentionActionRemoval(resolutionId, "added", failedIds.length > 0);
      });
    } catch (err) {
      const errorMessage =
        typeof err === "object" &&
        err !== null &&
        "response" in err &&
        typeof (err as { response?: { data?: { error?: string } } }).response?.data?.error === "string"
          ? (err as { response?: { data?: { error?: string } } }).response!.data!.error!
          : formatMessageRef.current({ id: "message.composer.mentionAddFailed" });
      setError(errorMessage);
      console.error("Failed to add mentioned people:", err);
    } finally {
      pendingMentionActionBatchInFlightRef.current = false;
      setPendingMentionActionExecuting((prev) => {
        const next = { ...prev };
        uniqueResolutionIds.forEach((resolutionId) => {
          delete next[resolutionId];
        });
        return next;
      });
    }
  }, [membershipChannelId, schedulePendingMentionActionRemoval]);

  const dismissPendingMentionAction = useCallback((resolutionId: string) => {
    removePendingMentionAction(resolutionId);
  }, [removePendingMentionAction]);

  const dismissUnresolvedMentionWarning = useCallback(() => {
    setUnresolvedMentionHandles([]);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

    const undoSnapshot = mentionUndoSnapshotRef.current;
    if (
      undoSnapshot
      && (e.metaKey || e.ctrlKey)
      && !e.shiftKey
      && !e.altKey
      && e.key.toLowerCase() === "z"
      && contentRef.current === undoSnapshot.afterContent
    ) {
      e.preventDefault();
      mentionUndoSnapshotRef.current = null;
      contentRef.current = undoSnapshot.beforeContent;
      setContent(undoSnapshot.beforeContent);
      setSelectedMentions(undoSnapshot.beforeMentions);
      pendingSenderMentionCursorRef.current = undoSnapshot.beforeCursor;
      return;
    }

    if (mention.handleKeyDown(e, filteredMentions.flat.length, () => {
      const item = filteredMentions.flat[mention.index];
      if (item) doInsertMention(item);
    })) return;

    if (channel.handleKeyDown(e, filteredChannels.length, () => {
      const item = filteredChannels[channel.index];
      if (item) doInsertChannel(item);
    })) return;

    if (e.key !== "Enter") return;

    // Cmd/Ctrl+Shift+Enter = send as task (force, even if "As Task" checkbox
    // is unchecked). Desktop-only convention; on touch primary inputs no
    // modifier keys are reachable so this branch is never taken there.
    // cindyz #proj-uiux:306ce5ff 2026-05-27.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      handleSubmit(e, { forceAsTask: true });
      return;
    }

    // Shift+Enter: let default newline. Cmd+Enter is the Mac send shortcut;
    // Ctrl+Enter is the Windows/Linux send shortcut.
    if (e.shiftKey) return;

    // Plain Enter on touch-primary + portrait viewports (phones in any
    // orientation reachable by thumb-typing, tablets held vertically) →
    // insert newline like every other chat app on mobile; sending happens
    // via the Send button. `(pointer: coarse)` reflects the device's
    // PRIMARY pointer, so an iPad with a Magic Keyboard / trackpad attached
    // becomes `(pointer: fine)` and falls through to desktop behavior.
    // cindyz #proj-uiux:3e2aa689 2026-05-27.
    if (typeof window !== "undefined" &&
        window.matchMedia("(pointer: coarse) and (orientation: portrait)").matches) {
      return;
    }

    e.preventDefault();
    handleSubmit(e);
  };

  const preventSendButtonPointerDownBlur = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Android Chrome can collapse the keyboard on the pointer-down blur before
    // the submit click runs, shifting the visual viewport and swallowing the
    // first tap. Keep focus stable; the following click still submits.
    e.preventDefault();
  };

  const preventToolbarButtonPointerDownBlur = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Toolbar buttons sit beside the textarea. Preserve focus through
    // pointerdown so Android Chrome does not collapse the keyboard before the
    // button click opens the picker or toggles composer state.
    e.preventDefault();
  };

  const preventTaskTogglePointerDownBlur = (e: React.PointerEvent<HTMLButtonElement>) => {
    // Keep the composer focused while toggling task mode; the following click
    // still toggles the checkbox without sending.
    e.preventDefault();
  };

  const toggleTaskModeWithoutBlur = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    setAlsoCreateTask((prev) => !prev);
  };

  const hasValidatingAttachments = pendingFiles.some((pf) => pf.uploadStatus === "validating");
  const hasUploadingAttachments = pendingFiles.some((pf) => pf.uploadStatus === "uploading");
  const hasFailedAttachments = pendingFiles.some((pf) => pf.uploadStatus === "error");
  const billingUploadQuotaError = pendingFiles.find((pf) => isBillingUploadQuotaError(pf.uploadError))?.uploadError;
  const visibleUploadFailures = pendingFiles.filter(
    (pf) => pf.uploadStatus === "error" && !isBillingUploadQuotaError(pf.uploadError),
  );
  const compactPendingFiles = pendingFiles.filter(
    (pf) => pf.uploadStatus !== "error" || isBillingUploadQuotaError(pf.uploadError),
  );
  const canSubmit = content.trim().length > 0 || pendingFiles.length > 0 || (allowEmptySubmit && Boolean(onSendOverride));
  const submitBlocked = !canSubmit || hasValidatingAttachments || hasUploadingAttachments || hasFailedAttachments || submitDisabled || submitBusy;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: spinner state is covered by MessageInput DOM tests; generated mutants hang tsx.
  const showSubmitSpinner = submitBusy || hasValidatingAttachments || hasUploadingAttachments;
  const submitTitle = submitBusy
    ? formatMessage({ id: "message.composer.sending" })
    : submitDisabled
      ? submitDisabledReason ?? formatMessage({ id: "message.composer.sendDisabled" })
      : hasValidatingAttachments
        ? formatMessage({ id: "message.composer.checkingAttachmentsTitle" })
        : hasUploadingAttachments
          ? formatMessage({ id: "message.composer.uploadingTitle" })
          : hasFailedAttachments
            ? formatMessage({ id: "message.composer.retryFailedTitle" })
            : submitTitleOverride ?? formatMessage({ id: "message.composer.send" });
  const submitLabel = submitBusy
    ? formatMessage({ id: "message.composer.sendingLabel" })
    : submitDisabled
      ? submitDisabledReason ?? formatMessage({ id: "message.composer.sendDisabled" })
      : hasValidatingAttachments
        ? formatMessage({ id: "message.composer.checkingAttachmentsAria" })
        : hasUploadingAttachments
          ? formatMessage({ id: "message.composer.uploadingAria" })
          : hasFailedAttachments
            ? formatMessage({ id: "message.composer.retryFailedTitle" })
            : submitLabelOverride ?? formatMessage({ id: "message.composer.send" });
  // Stryker disable next-line ConditionalExpression: icon branch is covered by MessageInput DOM tests; generated JSX mutants hang tsx.
  const submitIcon = showSubmitSpinner ? <Spinner size="sm" /> : <Send size={14} />;

  return (
    <form
      onSubmit={handleSubmit}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={
        variant === "compact"
          ? "relative flex items-center bg-white"
          : "relative flex items-center border-t-2 border-black bg-white px-3 pt-3 safe-bottom"
      }
    >
      {/* Drop overlay — only visible while a file drag is in progress over
          the composer area. Pointer-events are kept on so the overlay
          itself is the drop target (browser fires drop on the topmost
          element under the cursor at drop time). */}
      {isDraggingFiles && (
        <div
          aria-hidden
          data-testid="composer-drop-overlay"
          className="absolute inset-0 z-30 flex items-center justify-center border-2 border-dashed border-brutal-pink bg-brutal-pink/15"
        >
          <span className="border-2 border-black bg-white px-3 py-1.5 text-sm font-bold text-black shadow-brutal-sm">
            {formatMessage({ id: "message.composer.dropToAttach" })}
          </span>
        </div>
      )}
      {/* @mention dropdown */}
      {mention.show && filteredMentions.flat.length > 0 && (
        <div
          ref={mention.popupRef}
          data-testid="mention-autocomplete-popover"
          className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto card-brutal"
        >
          {filteredMentions.inChannel.length > 0 && filteredMentions.notInChannel.length > 0 && (
            <SectionEyebrow as="div" className="px-3 py-1.5">
              {formatMessage({ id: "message.composer.inThisChannel" })}
            </SectionEyebrow>
          )}
          {filteredMentions.inChannel.map((candidate, i) => (
            <button
              key={`${candidate.type}:${candidate.id}`}
              type="button"
              data-ac-index={i}
              onMouseDown={preventAutocompleteOptionMouseDown}
              onClick={() => doInsertMention(candidate)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${
                i === mention.index
                  ? "bg-soft-signal text-black font-bold"
                  : "text-black hover:bg-soft-signal/50"
              }`}
            >
              <MentionCandidateAvatar candidate={candidate} muted={false} />
              <MentionCandidateBody candidate={candidate} selected={i === mention.index} muted={false} />
            </button>
          ))}
          {filteredMentions.notInChannel.length > 0 && (
            <SectionEyebrow as="div" className={`px-3 py-1.5 ${filteredMentions.inChannel.length > 0 ? "border-t-2 border-black" : ""}`}>
              {formatMessage({ id: "message.composer.notInThisChannel" })}
            </SectionEyebrow>
          )}
          {filteredMentions.notInChannel.map((candidate, i) => {
            const flatIndex = filteredMentions.inChannel.length + i;
            const isSelected = flatIndex === mention.index;
            return (
              <button
                key={`${candidate.type}:${candidate.id}`}
                type="button"
                data-ac-index={flatIndex}
                onMouseDown={preventAutocompleteOptionMouseDown}
                onClick={() => doInsertMention(candidate)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${
                  isSelected
                    ? "bg-black/10 text-black/70 font-bold"
                    : "text-black/50 hover:bg-black/5"
                }`}
              >
                <MentionCandidateAvatar candidate={candidate} muted />
                <UserX size={12} className="shrink-0 text-black/40 -ml-1" />
                <MentionCandidateBody candidate={candidate} selected={isSelected} muted />
              </button>
            );
          })}
          {filteredMentions.computers.length > 0 && (
            <SectionEyebrow as="div" className="border-t-2 border-black px-3 py-1.5">
              {formatMessage({ id: "message.composer.computers" })}
            </SectionEyebrow>
          )}
          {filteredMentions.computers.map((candidate, i) => {
            const flatIndex = filteredMentions.inChannel.length + filteredMentions.notInChannel.length + i;
            const isSelected = flatIndex === mention.index;
            return (
              <button
                key={`computer:${candidate.id}`}
                type="button"
                data-ac-index={flatIndex}
                onMouseDown={preventAutocompleteOptionMouseDown}
                onClick={() => doInsertMention(candidate)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${isSelected ? "bg-brutal-cyan/30 font-bold text-black" : "text-black hover:bg-brutal-cyan/15"}`}
              >
                <MentionCandidateAvatar candidate={candidate} muted={false} />
                <MentionCandidateBody candidate={candidate} selected={isSelected} muted={false} />
              </button>
            );
          })}
          {filteredMentions.apps.length > 0 && (
            <SectionEyebrow as="div" className="border-t-2 border-black px-3 py-1.5">
              {formatMessage({ id: "message.composer.apps" })}
            </SectionEyebrow>
          )}
          {filteredMentions.apps.map((candidate, i) => {
            const flatIndex = filteredMentions.inChannel.length + filteredMentions.notInChannel.length + filteredMentions.computers.length + i;
            const isSelected = flatIndex === mention.index;
            return (
              <button
                key={`app:${candidate.id}`}
                type="button"
                data-ac-index={flatIndex}
                onMouseDown={preventAutocompleteOptionMouseDown}
                onClick={() => doInsertMention(candidate)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${isSelected ? "bg-soft-signal/40 font-bold text-black" : "text-black hover:bg-soft-signal/20"}`}
              >
                <MentionCandidateAvatar candidate={candidate} muted={false} />
                <MentionCandidateBody candidate={candidate} selected={isSelected} muted={false} />
              </button>
            );
          })}
        </div>
      )}

      {/* #channel dropdown */}
      {channel.show && filteredChannels.length > 0 && (
        <div
          ref={channel.popupRef}
          data-testid="channel-autocomplete-popover"
          className="absolute bottom-full left-3 right-3 mb-1 max-h-48 overflow-y-auto card-brutal"
        >
          {filteredChannels.map((ch, i) => {
            const isSelected = i === channel.index;
            const isArchived = !!ch.archivedAt;
            return (
              <button
                key={ch.id}
                type="button"
                data-ac-index={i}
                onMouseDown={preventAutocompleteOptionMouseDown}
                onClick={() => doInsertChannel(ch)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-sm font-medium transition-colors ${
                  isSelected
                    ? isArchived
                      ? "bg-black/10 text-black/70 font-bold"
                      : "bg-brutal-pink text-black font-bold"
                    : isArchived
                      ? `${ARCHIVED_CHANNEL_TEXT_CLASS} hover:bg-black/5`
                      : "text-black hover:bg-soft-signal"
                }`}
              >
                <div
                  className={`flex size-5 shrink-0 items-center justify-center border ${
                    isArchived ? ARCHIVED_CHANNEL_ICON_CLASS : "border-black bg-soft-signal text-black"
                  }`}
                >
                  <Hash size={12} />
                </div>
                <span className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                  <span className="max-w-[50%] flex-none truncate">{ch.name}</span>
                  {ch.description && (
                    <span className={`min-w-0 flex-1 truncate text-xs ${isArchived ? ARCHIVED_CHANNEL_MUTED_TEXT_CLASS : "text-black/40"}`}>
                      {ch.description}
                    </span>
                  )}
                </span>
                {isArchived && (
                  <span className={`ml-auto shrink-0 ${ARCHIVED_CHANNEL_BADGE_CLASS}`}>
                    {formatMessage({ id: "message.composer.archivedBadge" })}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      <input
        ref={imageInputRef}
        data-testid="composer-media-input"
        type="file"
        accept={MEDIA_PICKER_ACCEPT}
        multiple
        className="hidden"
        onChange={handleAttachmentPickerChange}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleAttachmentPickerChange}
      />

      <div className="flex w-full flex-col gap-2">
        {activationBanner}
        {error && (
          <Banner intent="warning" density="sm" className="font-bold">
            {error}
          </Banner>
        )}
        {billingUploadQuotaError && (
          <Banner intent="warning" density="sm" className="font-bold">
            {billingUploadQuotaError}{" "}
            <button
              type="button"
              onClick={() => nav.toSettings("billing")}
              className="font-bold underline"
            >
              {formatMessage({ id: "message.composer.viewBilling" })}
            </button>
          </Banner>
        )}

        {mentionActionNotice && (
          <div className="border-2 border-black/35 bg-black/[0.04] px-2 py-1 text-[11px] font-bold leading-4 text-black/70">
            {mentionActionNotice}
          </div>
        )}

        {!isDmComposer && unresolvedMentionHandles.length > 0 && (
          <Banner
            intent="warning"
            density="sm"
            className="font-bold"
            actions={(
              <button
                type="button"
                onClick={dismissUnresolvedMentionWarning}
                className="btn-brutal-sm bg-white p-1"
                aria-label={formatMessage({ id: "message.composer.dismissUnresolvedMentions" })}
                title={formatMessage({ id: "message.composer.dismissUnresolvedMentions" })}
              >
                <X size={12} strokeWidth={3} aria-hidden="true" />
              </button>
            )}
          >
            {formatMessage(
              { id: "message.composer.unresolvedMentions" },
              { handles: unresolvedMentionHandles.join(", ") },
            )}
          </Banner>
        )}

        {pendingMentionActions.length > 0 && (
          <PendingMentionActionStrip
            actions={pendingMentionActions}
            actionState={pendingMentionActionState}
            actionRemoving={pendingMentionActionRemoving}
            actionExecuting={pendingMentionActionExecuting}
            channelName={channelName}
            onMarkAction={markPendingMentionAction}
            onAddAllActions={addAllPendingMentionActions}
            onDismissAction={dismissPendingMentionAction}
          />
        )}

        {/* Pending attachments */}
        {compactPendingFiles.length > 0 && (
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={(event: DragEndEvent) => {
              const { active, over } = event;
              if (over && active.id !== over.id) {
                setPendingFiles((prev) => {
                  const oldIndex = prev.findIndex((p) => p.id === active.id);
                  const newIndex = prev.findIndex((p) => p.id === over.id);
                  return arrayMove(prev, oldIndex, newIndex);
                });
              }
            }}
          >
            <SortableContext items={compactPendingFiles.map((pf) => pf.id)} strategy={horizontalListSortingStrategy}>
              <div className="flex gap-2 flex-wrap">
                {compactPendingFiles.map((pf) => (
                  <SortableAttachment
                    key={pf.id}
                    id={pf.id}
                    preview={pf.preview}
                    fileName={pf.file.name}
                    mimeType={pf.file.type}
                    uploadStatus={pf.uploadStatus}
                    uploadProgress={pf.uploadProgress}
                    onRemove={() => removeFile(pendingFiles.findIndex((candidate) => candidate.id === pf.id))}
                    onPreview={
                      pf.preview && pf.uploadStatus === "ready" && pf.attachmentId
                        ? () => openDraftImagePreview(pf.attachmentId!)
                        : undefined
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}

        {visibleUploadFailures.map((pf) => (
          <div
            key={`upload-error-${pf.id}`}
            role="alert"
            className="flex w-full flex-wrap items-center gap-2 border-2 border-black bg-brutal-orange px-2 py-1.5 text-xs text-black"
          >
            <div className="min-w-0 flex-[1_1_14rem]">
              <div className="break-all font-bold">{pf.file.name}</div>
              <div className="break-words leading-4">
                {pf.uploadError || formatMessage({ id: "message.composer.uploadFailed" })}
              </div>
              {pf.uploadProgress > 0 && (
                <div className="font-bold">
                  {formatMessage({ id: "message.composer.uploadProgressSent" }, { progress: pf.uploadProgress })}
                </div>
              )}
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {pf.uploadCanRetry !== false && (
                <button
                  type="button"
                  onClick={() => retryFile(pf.id)}
                  aria-label={formatMessage({ id: "message.composer.retryUploadAttachment" }, { file: pf.file.name })}
                  className="border-2 border-black bg-white px-2 py-1 font-bold underline shadow-brutal-xs hover:bg-soft-signal"
                >
                  {formatMessage({ id: "message.composer.tapToRetry" })}
                </button>
              )}
              <button
                type="button"
                onClick={() => removeFile(pendingFiles.findIndex((candidate) => candidate.id === pf.id))}
                aria-label={formatMessage({ id: "message.composer.removeAttachment" }, { file: pf.file.name })}
                className="flex size-7 items-center justify-center border-2 border-black bg-black text-white"
              >
                <X size={12} />
              </button>
            </div>
          </div>
        ))}

        {/* Composer shell — single bordered card holding the textarea AND
            the action toolbar. stdrc 2026-05-07 #proj-message task #18:
            "参考分支 bugen/theme-skin-poc 做一下输入框的，按钮整合进输入框内部".
            Modern composer pattern (Linear / OpenAI playground / ChatGPT)
            unifies typing + actions into one card instead of stacking
            input + separate toolbar row. */}
        {/* Accessory chips ride ABOVE the composer card — the same slot as
            pending attachments — so the input itself stays clean (cindyz,
            task #21). */}
        {accessoryRow ? (
          <div className="flex flex-wrap items-center gap-1">{accessoryRow}</div>
        ) : null}
        <div className="flex flex-col gap-2 border-2 border-black bg-white p-2 shadow-brutal-sm focus-within:shadow-brutal">
          <textarea
            id={textareaId}
            ref={composerTextareaRef}
            value={content}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder ?? formatMessage({ id: "message.composer.messagePlaceholder" }, { channel: channelName })}
            maxLength={maxLength}
            className="max-h-32 w-full resize-none text-base md:text-sm font-display focus:outline-none leading-5 min-h-5 md:min-h-10"
            rows={1}
          />
          <div className="flex items-center justify-between gap-3">
            {variant === "compact" ? (
              <div />
            ) : (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onPointerDown={preventToolbarButtonPointerDownBlur}
                  onClick={() => imageInputRef.current!.click()}
                  className="btn-brutal-sm bg-white p-1"
                  title={formatMessage({ id: "message.composer.attachImage" })}
                >
                  <ImagePlus size={14} />
                </button>
                <button
                  type="button"
                  onPointerDown={preventToolbarButtonPointerDownBlur}
                  onClick={() => fileInputRef.current!.click()}
                  className="btn-brutal-sm bg-white p-1"
                  title={formatMessage({ id: "message.composer.attachFile" })}
                >
                  <Paperclip size={14} />
                </button>
              </div>
            )}
            <div className="flex items-center gap-3">
              {showTaskButton && (
                <button
                  type="button"
                  role="checkbox"
                  data-testid="composer-as-task-toggle"
                  aria-checked={alsoCreateTask}
                  className="inline-flex items-center gap-1.5 select-none"
                  title={formatMessage({ id: "message.composer.sendAsTaskTooltip" })}
                  onPointerDown={preventTaskTogglePointerDownBlur}
                  onClick={toggleTaskModeWithoutBlur}
                >
                  <CheckMarker
                    checked={alsoCreateTask}
                  />
                  <span className="text-xs font-bold text-black/60">{formatMessage({ id: "message.composer.asTask" })}</span>
                </button>
              )}
              <button
                type="submit"
                onPointerDown={preventSendButtonPointerDownBlur}
                disabled={submitBlocked}
                className="btn-brutal-sm flex size-7 shrink-0 items-center justify-center bg-brutal-pink p-0 disabled:opacity-30 disabled:pointer-events-none"
                title={submitTitle}
                aria-label={submitLabel}
              >
                {submitIcon}
              </button>
            </div>
          </div>
        </div>
      </div>
    </form>
  );
}
