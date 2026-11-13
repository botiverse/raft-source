import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from "react";
import type { ChangeEvent } from "react";
import { useIntl } from "react-intl";
import { Send, Paperclip, ImagePlus } from "lucide-react";
import { ChannelIcon } from "../../components/channel/channelKindIcon";
import { Badge, CheckboxIndicator, Composer, ComposerActions, ComposerAttachments, ComposerDropOverlay, ComposerDropOverlayLabel, ComposerIconButton, ComposerInput, ComposerRoot, ComposerSubmit, ComposerSuggestionAside, ComposerSuggestionContent, ComposerSuggestionGroup, ComposerSuggestionIcon, ComposerSuggestionList, ComposerSuggestionMeta, ComposerSuggestionTitle, ComposerToolbar, ComposerToolbarLabel, Separator, Spinner } from "@botiverse/raft-ui";
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, arrayMove } from "@dnd-kit/sortable";
import { useMessageStore } from "../../store/messageStore";
import type { MessageDeliveryWarning, MessageMention, PendingMentionAction, Message } from "../../store/messageStore";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import type { MessageAttachment } from "../../store/imageLightboxStore";
import { isAgentInMemberLists, useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { useAuthStore } from "../../store/authStore";
import { getComposerFontStyle, useAppearanceStore } from "../../store/appearanceStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import type { Channel } from "../../store/channelStore";
import { useChannelFirstPageSettled } from "../../hooks/useChannelFirstPageSettled";
import { useJoinDeferred } from "../../store/joinDeferred";
import { useChannelMembers } from "../../hooks/useChannelMembers";
import { readChannelConversionBlocked, useChannelConversionState } from "../../hooks/useChannelConversionState";
import { notifyChannelMembersChanged } from "../../store/channelMemberEvents";
import { notifyAttachmentUploadChanged, subscribeAttachmentUploadChanged } from "../../store/attachmentUploadEvents";
import { useAutocomplete } from "../../hooks/useAutocomplete";
import { useRankedComposerSuggestions } from "../../hooks/useRankedComposerSuggestions";
import { useComposerAutosize } from "../../components/message/useComposerAutosize";
import { AutocompleteOptionRow } from "../../components/message/AutocompleteOptionRow";
import { MentionSuggestionList } from "../../components/mention/MentionSuggestionList";
import { useMentionPicker } from "../../components/mention/useMentionPicker";
import { chatMentionGroups } from "../../components/message/chatMentionGroups";
import { extractClipboardFiles, isFileReadable, materializePastedFiles } from "../../utils/clipboardFiles";
import { insertPastedText } from "../../utils/pastedText";
import Banner from "../../components/ui/Banner";
import Tooltip from "../../components/ui/Tooltip";
import { labelWithShortcut } from "../../components/ui/LabelWithShortcut";
import { matchesShortcut } from "../shortcuts/dispatcher";
import { isShortcutOverridden } from "../shortcuts/overrides";
import { useShortcutBinding } from "../shortcuts/useShortcutBinding";
import { MOD_ENTER_SEND_SHORTCUT, composerEnterAction, isImeComposing, useComposerSendKey } from "./composerSendKey";
import { ComposerSendKeyHint } from "./ComposerSendKeyHint";
import api from "../../api/client";
import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import {
  buildMentionCandidateGroupsFromRankedCandidates,
  channelAgentMentionCandidate,
  channelHumanMentionCandidate,
  isMemberScopedMentionChannel,
} from "../../components/message/mentionCandidates";
import type { MentionCandidate } from "../../components/message/mentionCandidates";
import { decideMessageAttachmentSelection } from "../../utils/messageAttachmentLimits";
import { resolveAttachmentUploadLimits } from "../../utils/attachmentUploadLimit";
import { attachmentRejectionPlan, notAttachedCopy } from "../../utils/attachmentLimitPresentation";
import type { NotAttachedReason } from "../../utils/attachmentLimitPresentation";
import { openUploadUpgrade, openUpgradeIfMonthUsedUp } from "../../utils/uploadUpgrade";
import { trackUploadLimitHit } from "../../analytics/paywall";
import { uploadQuotaRefusal } from "../../utils/monthlyUploadQuota";
import { noteMonthlyUploadQuota } from "../../store/monthlyUploadQuotaStore";
import { AttachmentUploadClientError, cancelAttachmentUploadSession, listActiveAttachmentUploads, uploadAttachmentFile } from "../../utils/directAttachmentUpload";
import type { RecoveryView } from "../../utils/directAttachmentUpload";
import { formatComposerUploadError } from "../../utils/attachmentUploadErrorPresentation";
import { uploadLegacyAttachmentWithIdleTimeout } from "../../utils/legacyAttachmentUpload";
import { SELECTED_TEXT_QUOTE_EVENT, appendQuoteToComposer } from "../../components/message/selectedTextQuote";
import type { SelectedTextQuoteDetail } from "../../components/message/selectedTextQuote";
import { PendingMentionActionStrip } from "../../components/message/PendingMentionActionStrip";
import type { PendingMentionActionLocalState } from "../../components/message/PendingMentionActionStrip";
import { createOptimisticMessageDraft } from "../../components/message/optimisticMessageDraft";
import { CHANNEL_TRIGGER } from "../../components/message/autocompleteTriggers";
import { COMPOSER_FULL_EDGE_CLASS } from "../../components/message/composerHost";
import { registerComposerFocusTarget } from "../../components/message/composerFocusRequest";
import type { ComposerSuggestionSearchEntry } from "../../utils/composerSuggestionSearch";
import { getSenderMentionInsertDetail, insertMentionAtCursor, SENDER_MENTION_INSERT_EVENT } from "../../components/message/senderMentionInsert";
import { useToastViewportFloor } from "../../components/toastViewportBottom";
import type { AttachmentUploadResponse, ComposerReference, PendingFile } from "./composerTypes";
import { holdReload } from "../../utils/reloadHolds";
import { adoptDraftPendingFiles, adoptFailedSendMentions, failedSendMentionsByDraftKey, getDraftPendingFiles, getDraftPendingFilesAuthScope, getDraftPendingFilesKey, markInterruptedUploads, mergeFailedSendMentions, saveDraftPendingFiles } from "./draftPendingFilesCache";
import { formatMentionActionStatusNotice, mentionActionSucceeded, mentionStillAppears, mergeFailedSendIntoDraft, releaseSubmittedDraftIntent } from "./pendingMentionActions";
import type { MentionUndoSnapshot, PendingMentionActionExecuteResponse } from "./pendingMentionActions";
import { getPendingFileDisplayPreview, getPendingFileLocalPreview, isPreviewableImageFile, readLocalImageDimensions } from "./pendingFilePreview";
import { ComposerFilePickers } from "./ComposerFilePickers";
import { RecoverableUploadCancelButton } from "./RecoverableUploadCancelButton";
import { SortableAttachment } from "./SortableAttachment";
import { UploadFailureBanner } from "./UploadFailureBanner";
import { preventSendButtonPointerDownBlur, preventTaskTogglePointerDownBlur, preventToolbarButtonPointerDownBlur } from "./composerPointerHandlers";
import { mayTakeFocus } from "../../utils/focusGuard";
import { useComposerTaskModeTarget } from "./composerTaskMode";

/**
 * Whether the current server is on Free, read when files are picked. Only the
 * Free per-file limit is one an upgrade lifts (Pro's is the ceiling). Pro's
 * 200 MB assumes direct upload is available (ATTACHMENT_DIRECT_UPLOAD_ENABLED
 * plus direct-upload storage); without it the served limit stays at the 90 MiB
 * multipart cap.
 */
function currentServerIsFree(): boolean {
  const { billing, current } = useServerStore.getState();
  return (billing?.plan || current?.plan || "free") === "free";
}
/** The text a message carries with a composer reference: its own text, then the token on a line of its own. */
function withComposerReference(content: string, reference: Pick<ComposerReference, "token"> | null | undefined): string {
  return reference ? `${content.replace(/\s+$/, "")}\n\n${reference.token}` : content;
}
export function MessageInput({
  channelId,
  channelName,
  showTaskButton,
  asTaskShortcutDisabled = false,
  onWillSend,
  resolveChannelId,
  onChannelResolved,
  mentionChannelId,
  mentionScopeChannelType,
  loadMentionMembers = true,
  deferUntilFirstPage = false,
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
  plainText = false,
  frameEdge,
  composerReference,
}: {
  channelId: string;
  channelName: string;
  showTaskButton?: boolean;
  /** Task v2: off where the composer offers no As task (a thread's, a task's conversation). */
  asTaskShortcutDisabled?: boolean;
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
  /**
   * Hold the mention roster and recoverable-upload fetches until this channel's
   * first message page is in (task #17). Set by the host that owns that page
   * load (ChatPanel); other hosts never record one and load immediately.
   */
  deferUntilFirstPage?: boolean;
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
  /** Plain text: typing @ or # opens no picker (a note the server resolves no mentions in, e.g. an Artifact's). */
  plainText?: boolean;
  /**
   * Drawn on the frame's top edge (the personal assistant's otter,
   * assistant/AssistantOtter.tsx). It sits in the frame's own positioned box
   * (`data-composer-frame-edge`), which carries `data-composing` while there
   * is text or an attachment, so the edge can react in CSS alone.
   */
  frameEdge?: React.ReactNode;
  /** A reference appended to the next message sent (see ComposerReference). */
  composerReference?: ComposerReference | null;
}) {
  const { formatMessage } = useIntl();
  // A toast sits above the composer (toastViewportBottom.ts).
  const toastFloorRef = useToastViewportFloor();
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
  // Narrow selector: the composer only needs the current user, so it must not
  // re-render on unrelated authStore mutations (a bare useAuthStore() subscribes
  // to the whole store). See frontend render-cost contract.
  const currentUser = useAuthStore((s) => s.user);
  const sendKey = useComposerSendKey();
  const sendAsTaskShortcut = useShortcutBinding("send-as-task");
  const messageBodyFontSize = useAppearanceStore((s) => s.messageBodyFontSize);
  const composerFontStyle = useMemo(() => getComposerFontStyle(messageBodyFontSize), [messageBodyFontSize]);
  // Uploads the monthly quota refused, so a send they were part of doesn't also say "retry or remove".
  const quotaRefusedIdsRef = useRef(new Set<string>());
  // The upload entries must know before a click whether the month is used up
  // (monthlyUploadQuotaStore), so a composer that can attach asks when it shows.
  const limitedUploadServerId = useServerStore((s) => (
    s.current && ((s.billing?.plan || s.current.plan || "free") === "free" || s.billing?.source === "appsumo") ? s.current.id : null
  ));
  // Right after a join it waits with the other secondary loads (#proj-frontend:#24).
  const joinDeferred = useJoinDeferred(channelId);
  useEffect(() => {
    if (variant === "compact" || !limitedUploadServerId || joinDeferred) return;
    void resolveAttachmentUploadLimits();
  }, [joinDeferred, limitedUploadServerId, variant]);
  const [content, setContent] = useState(draft);
  const sendMessage = useMessageStore((s) => s.sendMessage);
  const addOptimisticMessage = useMessageStore((s) => s.addOptimisticMessage);
  // Stryker disable next-line all: optimistic rollback is covered by send-failure tests outside this attachment-draft mutation slice.
  const removeOptimisticMessage = useMessageStore((s) => s.removeOptimisticMessage);
  // Stryker disable next-line all: task-toggle default state is covered by MessageInput submit-contract tests outside this attachment-draft mutation slice.
  const [alsoCreateTask, setAlsoCreateTask] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composerFrameRef = useRef<HTMLDivElement>(null);
  /** The value the composer box last held as far as this code knows (see the
   *  layout effect that writes `content` into it). */
  const lastSyncedValueRef = useRef("");
  // A finger's tap on Send (tasks #136, #161, stdrc). The tap itself must not
  // move focus out of the textarea: on a phone that closes the keyboard, the
  // layout moves under the finger, and the click the browser synthesizes
  // after the touch lands somewhere else (it missed Send, then it opened the
  // thread of the message that moved there). So the touch's end is
  // prevented, which keeps focus where it is and synthesizes no click at all,
  // and Send submits right there. Mouse and keyboard keep the plain click
  // (pointerdown is still prevented, so a mouse press keeps focus too).
  // After a tap the composer keeps focus (keepComposerFocused below), so
  // nothing on the page moves at all.
  const touchSendRef = useRef(false);
  const handleSendTouchEnd = useCallback((e: React.TouchEvent<HTMLButtonElement>) => {
    const button = e.currentTarget;
    const touch = e.changedTouches[0];
    if (!e.cancelable || !touch || button.disabled || !button.form) return;
    const rect = button.getBoundingClientRect();
    const inside = touch.clientX >= rect.left && touch.clientX <= rect.right && touch.clientY >= rect.top && touch.clientY <= rect.bottom;
    if (!inside) return;
    e.preventDefault();
    touchSendRef.current = true;
    button.form.requestSubmit(button);
  }, []);
  const contentRef = useRef(content);
  const pendingSenderMentionCursorRef = useRef<number | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Stryker disable all: see the draft attachment persistence note in draftPendingFilesCache.ts; the
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
  // The composer <textarea> is deliberately NOT a React-controlled input. For a
  // controlled textarea React also rewrites `defaultValue` — the element's text
  // child — on every keystroke, and a DOM structure change there forces Chrome
  // to re-evaluate every non-subject `:has()` rule against the whole page: ~58ms
  // of style recalc per key in a 300-message channel vs ~0.06ms for a plain
  // `.value` write (kabi-desktop task #133). `content` stays the source of
  // truth; the DOM value follows it imperatively, exactly like React's own
  // controlled update (`if (node.value !== value) node.value = value`) minus the
  // text-node rewrite. Never pass `value` / `defaultValue` to the textarea.
  // Every commit, not just on `content` changes: a textarea node attached in
  // this commit (refs attach before the parent's layout effects) must get the
  // current content too. One string compare per render. Precondition: `content`
  // is updated synchronously from onChange. If it ever moves into a deferred /
  // transition update, this would write stale content over what is being typed.
  //
  // Text written into the box without an input event (a voice keyboard such as
  // Typeless can, task #136 / triage #48) would be overwritten here by the next
  // render, and until then `content` reads empty and Send stays disabled. So
  // the DOM value is compared with the last value this code knows the box held
  // (`lastSyncedValueRef`): if the box changed behind our back, its text is
  // adopted into `content` instead of being overwritten; only a box still
  // holding what we last saw follows `content` (a send clearing it, a restored
  // draft, an inserted mention).
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    if (el.value !== content) {
      if (el.value !== lastSyncedValueRef.current) {
        adoptBypassedComposerValue();
        return;
      }
      el.value = content;
    }
    lastSyncedValueRef.current = el.value;
  });
  const composerTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    if (node && node !== textareaRef.current) lastSyncedValueRef.current = node.value;
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
  const [recoverableUploads, setRecoverableUploads] = useState<RecoveryView[]>([]);
  const recoverableUploadsRef = useRef<RecoveryView[]>([]);
  const canceledRecoverableUploadIdsRef = useRef<Set<string>>(new Set());
  const recoverableRefreshGenerationRef = useRef(0);
  const recoverableRefreshControllerRef = useRef<AbortController | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<MessageMention[]>([]);
  const selectedMentionsRef = useRef<MessageMention[]>([]);
  selectedMentionsRef.current = selectedMentions;
  const mentionUndoSnapshotRef = useRef<MentionUndoSnapshot | null>(null);
  const [pendingMentionActions, setPendingMentionActions] = useState<PendingMentionAction[]>([]);
  const [unresolvedMentionHandles, setUnresolvedMentionHandles] = useState<string[]>([]);
  const [deliveryWarnings, setDeliveryWarnings] = useState<MessageDeliveryWarning[]>([]);
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
  const { blocked: conversionBlocked } = useChannelConversionState(membershipChannelId);
  const conversionBlockedMessage = formatMessage({ id: "message.composer.conversionInProgress" });

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
    setDeliveryWarnings([]);
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
      // A composer that mounts late (channel still loading) leaves focus where the user put it.
      if (mayTakeFocus(textareaRef.current)) textareaRef.current?.focus({ preventScroll: autoFocusMode === "desktop" });
    }
  }, [autoFocus, autoFocusMode, channelId]);

  useEffect(() => {
    pendingFilesRef.current = pendingFiles;
    if (preservePendingDraftFiles) {
      saveDraftPendingFiles(draftPendingFilesCacheKeyRef.current, pendingFiles);
    }
  }, [pendingFiles, preservePendingDraftFiles]);

  // Picked or uploading attachments, As task on, picked mentions: no silent reload onto a new Web version (utils/reloadSafety).
  const holdsWork = pendingFiles.length > 0 || alsoCreateTask || selectedMentions.length > 0;
  useEffect(() => (holdsWork ? holdReload() : undefined), [holdsWork]);

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  // Cleanup object URLs and in-flight uploads on unmount
  useEffect(() => {
    if (attachmentSelectionAbortRef.current.signal.aborted) {
      attachmentSelectionAbortRef.current = new AbortController();
    }
    // The container is created once via useRef(new Map) and never
    // reassigned — capture it here so the cleanup reads no `.current`.
    // (pendingFilesRef stays a ref read: its array IS reassigned over time.)
    const uploadControllers = uploadControllersRef.current;
    const formatMessageFn = formatMessageRef.current;
    return () => {
      resetAttachmentSelectionValidation();
      if (preservePendingDraftFiles) {
        const interrupted = markInterruptedUploads(pendingFilesRef.current, formatMessageFn);
        for (const p of pendingFilesRef.current) {
          if (p.uploadStatus === "uploading") {
            uploadControllers.get(p.id)?.abort();
          }
        }
        const currentAuthScope = getDraftPendingFilesAuthScope(useAuthStore.getState().user?.id);
        if (draftPendingFilesAuthScopeRef.current === currentAuthScope) {
          saveDraftPendingFiles(draftPendingFilesCacheKeyRef.current, interrupted);
        }
      } else {
        for (const controller of uploadControllers.values()) {
          controller.abort();
        }
        for (const p of pendingFilesRef.current) {
          if (p.preview) URL.revokeObjectURL(p.preview);
        }
      }
      uploadControllers.clear();
    };
  }, [preservePendingDraftFiles, resetAttachmentSelectionValidation]);

  // Recoverable uploads and mention members are not needed for the first
  // paint; wait for the conversation's first message page (task #17), and
  // right after a join for its idle moment (#proj-frontend:#24).
  const channelFirstPageSettled = useChannelFirstPageSettled(channelId);
  const secondaryLoadsReady = !deferUntilFirstPage || (channelFirstPageSettled && !joinDeferred);
  // Direct-upload sessions outlive a drawer/channel remount. Hydrate only
  // active sessions owned by this member and expose cancellation; without the
  // original File object it is unsafe to pretend that a browser can resume
  // the PUT, so the UI deliberately offers no fake "continue" action.
  // With `resolveChannelId`, `channelId` is only a draft key: the channel is
  // created on first send (e.g. a thread that has no replies yet). Upload
  // sessions are bound to a real channel, so there is nothing to recover until
  // it exists — the same contract attachment uploads already follow.
  const channelExists = !resolveChannelId;
  const refreshRecoverableUploads = useCallback(() => {
    if (!preservePendingDraftFiles || !channelExists) return;
    const generation = recoverableRefreshGenerationRef.current + 1;
    recoverableRefreshGenerationRef.current = generation;
    recoverableRefreshControllerRef.current?.abort();
    const controller = new AbortController();
    recoverableRefreshControllerRef.current = controller;
    void listActiveAttachmentUploads(api, channelId, controller.signal)
      .then((uploads) => {
        if (!controller.signal.aborted && recoverableRefreshGenerationRef.current === generation) {
          const serverIds = new Set(uploads.map((upload) => upload.uploadId));
          for (const uploadId of canceledRecoverableUploadIdsRef.current) {
            if (!serverIds.has(uploadId)) canceledRecoverableUploadIdsRef.current.delete(uploadId);
          }
          const visible = uploads.filter((upload) => !canceledRecoverableUploadIdsRef.current.has(upload.uploadId));
          recoverableUploadsRef.current = visible;
          setRecoverableUploads(visible);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted && recoverableRefreshGenerationRef.current === generation) {
          recoverableUploadsRef.current = [];
          setRecoverableUploads([]);
        }
      });
  }, [channelExists, channelId, preservePendingDraftFiles]);

  useEffect(() => {
    if (!preservePendingDraftFiles || !secondaryLoadsReady) return;
    refreshRecoverableUploads();
    // Set identity is stable (never reassigned) — capture for the cleanup.
    const canceledIds = canceledRecoverableUploadIdsRef.current;
    return () => {
      recoverableRefreshGenerationRef.current += 1;
      recoverableRefreshControllerRef.current?.abort();
      recoverableRefreshControllerRef.current = null;
      recoverableUploadsRef.current = [];
      canceledIds.clear();
    };
  }, [preservePendingDraftFiles, refreshRecoverableUploads, secondaryLoadsReady]);

  useEffect(() => {
    if (!preservePendingDraftFiles) return;
    return subscribeAttachmentUploadChanged((change) => {
      if (change.channelId !== channelId) return;
      if (change.kind === "canceled") {
        canceledRecoverableUploadIdsRef.current.add(change.uploadId);
        const pending = pendingFilesRef.current.find((file) => file.directUploadSession?.uploadId === change.uploadId);
        if (pending) {
          uploadControllersRef.current.get(pending.id)?.abort();
          uploadControllersRef.current.delete(pending.id);
          if (pending.preview) URL.revokeObjectURL(pending.preview);
          const next = pendingFilesRef.current.filter((file) => file.id !== pending.id);
          pendingFilesRef.current = next;
          setPendingFiles(next);
          saveDraftPendingFiles(draftPendingFilesCacheKeyRef.current, next);
        }
        const nextRecoverable = recoverableUploadsRef.current.filter((upload) => upload.uploadId !== change.uploadId);
        recoverableUploadsRef.current = nextRecoverable;
        setRecoverableUploads(nextRecoverable);
      }
      refreshRecoverableUploads();
    });
  }, [channelId, preservePendingDraftFiles, refreshRecoverableUploads]);

  const cancelRecoverableUpload = useCallback(async (uploadId: string) => {
    try {
      await cancelAttachmentUploadSession(api, uploadId);
      notifyAttachmentUploadChanged({ channelId, uploadId, kind: "canceled" });
    } catch {
      // Keep the row visible so a transient failure remains actionable.
    }
  }, [channelId]);
  // Stryker restore all

  // Save draft on content change. Writes local `content` into the external
  // messageStore draft slot — a write-to-external-store sync, not derived local
  // state. no-derived-state-effect pattern-matches the effect shape; FP here.
  // NOTE(task #20): deliberately NOT debounced. The analyzed "second render
  // per key" is unproven — this component's own drafts selector returns a
  // string primitive equal to `content`, which Zustand bails out on — and a
  // debounce opens stale-read windows for the RENDER-TIME draft seed on
  // remount/switch paths. Per render-cost-contract's proof rule, changing this
  // needs a measured render-count RED first (task #19 fixtures).
  // oxlint-disable-next-line react-doctor/no-derived-state-effect, react-doctor/no-effect-chain -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  useEffect(() => {
    setDraft(channelId, content);
  }, [channelId, content, setDraft]);

  const agents = useAgentStore((s) => s.agents);
  const humans = useServerStore((s) => s.members);
  const currentServer = useServerStore((s) => s.current);
  const { channelAgents, channelHumans, channelExternalMembers } = useChannelMembers(mentionChannelId || channelId, {
    enabled: loadMentionMembers && secondaryLoadsReady,
  });
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const loungeChannels = useChannelStore((s) => s.loungeChannels);
  const composerChannel = useMemo(
    () => findStoredChannel({ channels, dmChannels, loungeChannels }, channelId),
    [channels, dmChannels, loungeChannels, channelId],
  );
  const isDmComposer = composerChannel?.type === "dm";
  const mentionScopeChannel = useMemo(
    () => findStoredChannel({ channels, dmChannels, loungeChannels }, mentionChannelId || channelId)
      ?? (mentionScopeChannelType ? { type: mentionScopeChannelType } : undefined),
    [channels, dmChannels, loungeChannels, mentionChannelId, channelId, mentionScopeChannelType],
  );
  // A thread composer's own name is "thread"; mentions resolve against the parent channel.
  const pendingMentionChannelName = mentionChannelId && mentionScopeChannel && "name" in mentionScopeChannel && mentionScopeChannel.name
    ? mentionScopeChannel.name
    : channelName;

  // #channel autocomplete (state only — filtering done below); the @ picker is declared below its candidates.
  const channel = useAutocomplete(CHANNEL_TRIGGER, "#");
  // useAutocomplete returns a fresh object every render, but these are
  // useCallback-stable — depend on the functions, not the wrapper.
  const { dismiss: dismissChannelPopover, clampIndex: clampChannelIndex, handleKeyDown: handleChannelKeyDown, detect: detectChannelTrigger } = channel;

  // Build channel member ID sets for fast lookup
  const channelMemberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of channelAgents) ids.add(a.id);
    for (const h of channelHumans) ids.add(h.id);
    return ids;
  }, [channelAgents, channelHumans]);

  // Build & filter mention candidates
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
      });
    }
    if (!memberScopedMentions) {
      for (const human of humans) {
        if (currentUser && human.userId === currentUser.id) continue;
        addCandidate({
          guest: human.role === "guest",
          id: human.userId,
          name: human.name,
          displayName: human.displayName,
          type: "user",
          avatarUrl: human.avatarUrl,
        });
      }
      for (const agent of agents) {
        if (!isAgentInMemberLists(agent)) continue;
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
      addCandidate(channelHumanMentionCandidate(human, currentServer?.id));
    }
    for (const agent of channelAgents) {
      if (agent.deletedAt) continue;
      addCandidate(channelAgentMentionCandidate(agent, currentServer?.id));
    }
    for (const external of channelExternalMembers.filter(member => member.mentionable !== false)) {
      // Slack-side participant — pick the first handle; when the projection
      // has no usable handle fall back to the display name. The composer
      // token must satisfy Raft's `\p{L}\p{N}_-` handle charset
      // (structuredRaftMentionStillAppears rejects a token containing
      // `.`/`'`/etc.), so sanitize every other char to `-`.
      const rawHandle = external.handles.find((h) => h.trim().length > 0)
        ?? external.displayName.replace(/\s+/g, "");
      const handle = rawHandle.replace(/[^\p{L}\p{N}_-]/gu, "-");
      if (!handle) continue;
      addCandidate({
        id: external.id,
        name: handle,
        displayName: external.displayName,
        type: "external",
        avatarUrl: external.avatarUrl,
        // Team label disambiguates same-name members across linked Slack
        // workspaces: two installs can surface identical "Name · @handle"
        // rows otherwise (#231).
        description: external.workspaceName
          ? `${formatMessage({ id: "settings.slackBridge.providerBadge" })} · ${external.workspaceName}`
          : formatMessage({ id: "settings.slackBridge.providerBadge" }),
      });
    }
    return [...byKey.values()];
  }, [currentUser, currentServer?.id, humans, agents, channelHumans, channelAgents, channelExternalMembers, mentionScopeChannel, formatMessage]);

  // Stryker disable all: this block is React wiring from local candidate arrays into
  // the covered composer ranker/worker hook. The behavior surface is pinned by
  // composerSuggestionSearch/mentionCandidates unit tests, channel archive source
  // contracts, the forward-composer DOM autocomplete smoke, and the production
  // build worker-bundling check; mutating useMemo deps here produces equivalent
  // source-level survivors rather than useful behavior gaps.
  // The shared @ picker over the loaded members (a local source: no requests,
  // chat's ranking and grouping unchanged).
  const groupMentionCandidates = useCallback((rankedCandidates: MentionCandidate[]) => chatMentionGroups(buildMentionCandidateGroupsFromRankedCandidates({
    rankedCandidates,
    channelMemberIds,
    threadMessages,
    prioritizeThreadParticipants: Boolean(isChannelThread),
  }), formatMessage), [channelMemberIds, isChannelThread, threadMessages, formatMessage]);
  const mention = useMentionPicker({ source: { local: allCandidates }, group: groupMentionCandidates });
  // The picker returns a fresh object every render, but these are
  // useCallback-stable — depend on the functions, not the wrapper.
  const { dismiss: dismissMentionPopover, handleKeyDown: handleMentionKeyDown, detect: detectMentionTrigger } = mention;

  // Stryker restore all


  // Channel switches keep MessageInput mounted, so any open autocomplete
  // popover must be cleared explicitly instead of relying on unmount cleanup.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-pass-live-state-to-parent -- resets the @ picker's own state (useMentionPicker), not a parent's; unchanged from before the extraction
    dismissMentionPopover();
    dismissChannelPopover();
  }, [channelId, dismissMentionPopover, dismissChannelPopover]);

  // Stryker disable all: as above, React wiring into the covered ranker.
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

  // Clamp the index when the filtered list changes (the @ picker clamps its own).
  // The clamp function is useCallback-stable (the `channel` wrapper is a fresh
  // object every render, so depending on it would re-run every keystroke).
  useEffect(() => { clampChannelIndex(filteredChannels.length); }, [clampChannelIndex, filteredChannels.length]);

  // Auto-resize: browser-native `field-sizing: content` when supported, else
  // a rAF-coalesced bounded measurement — see useComposerAutosize (task #20).
  const { autoResize, scheduleAutoResize, cancelScheduledAutoResize } = useComposerAutosize(textareaRef);

  // Native field-sizing follows typography changes automatically; fallback
  // engines need a fresh measurement even when the draft and width stay put.
  useEffect(() => { scheduleAutoResize(); }, [messageBodyFontSize, scheduleAutoResize]);

  // Selection-quote v0 (#proj-chat task #32): a message's selection context
  // menu "Quote" dispatches SELECTED_TEXT_QUOTE_EVENT with the target composer
  // channelId. Only the composer whose channelId matches pulls it in, so a
  // channel timeline + open thread panel (two mounted MessageInputs) route
  // correctly. Append to live `content` (the draft-save effect persists it).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<SelectedTextQuoteDetail>).detail;
      if (!detail || detail.channelId !== channelId) return;
      // Focus now, inside the tap that quoted: iOS raises the keyboard only
      // for a focus within the gesture (as the sender-mention insert does).
      // The cursor moves to the end once the quote has rendered.
      const textarea = textareaRef.current;
      if (textarea && document.activeElement !== textarea) textarea.focus();
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

  // A notice above this composer that goes away hands focus here, the next
  // element, so it doesn't fall to the document (requestComposerFocus). The
  // frame takes it, not the field: hiding a notice is not starting to type,
  // and focusing the textarea would open a phone's keyboard. One Tab from
  // the frame reaches the field.
  useEffect(() => registerComposerFocusTarget(channelId, () => composerFrameRef.current), [channelId]);

  // Insert helpers
  const doInsertMention = useCallback((candidate: MentionCandidate) => {
    const cursorPos = textareaRef.current?.selectionStart ?? content.length;
    const insertion = mention.buildInsert(candidate.name, content, cursorPos);
    const newCursor = insertion.newCursor;
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

  const preventAutocompleteOptionMouseDown = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
  }, []);

  // File handling
  const startAttachmentUpload = useCallback(async (
    pending: PendingFile,
    origin: { channelId: string; draftCacheKey: string } = {
      channelId: committedComposerOwnershipRef.current?.channelId ?? channelId,
      draftCacheKey: committedComposerOwnershipRef.current?.draftCacheKey ?? draftPendingFilesCacheKey,
    },
  ) => {
    const directUploadId = pending.directUploadSession?.uploadId;
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
    quotaRefusedIdsRef.current.delete(pending.id);

    updatePendingFile((file) => ({
      ...file,
      uploadStatus: "uploading",
      uploadProgress: 0,
      attachmentId: undefined,
      uploadError: undefined,
      uploadCanRetry: undefined,
    }));

    // The legacy upload response carries the server-generated raster
    // thumbnail (HEIC → WebP). It is what the chip shows once the upload
    // finishes when this browser cannot decode the local file.
    let serverThumbnailUrl: string | null = null;
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
              serverThumbnailUrl = data.attachments[0]?.thumbnailUrl ?? null;
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
        serverThumbnailUrl,
        uploadError: undefined,
        uploadCanRetry: undefined,
      }));
      if (directUploadId) notifyAttachmentUploadChanged({ channelId: origin.channelId, uploadId: directUploadId, kind: "completed" });
      // What's left of the month went down: the upload entries' answer follows (monthlyUploadQuotaStore).
      if (currentServerIsFree()) void resolveAttachmentUploadLimits();
      return attachmentId;
    } catch (err) {
      if (controller.signal.aborted) return null;
      // The month's quota had no room after all (another upload took it since the
      // selection was checked): the file comes off and the upgrade dialog opens,
      // as it would have at selection.
      const quota = uploadQuotaRefusal(err);
      if (quota) {
        quotaRefusedIdsRef.current.add(pending.id);
        const serverId = useServerStore.getState().current?.id;
        if (serverId) noteMonthlyUploadQuota(serverId, quota);
        const shown = isCommittedComposerOwner(origin.channelId, origin.draftCacheKey);
        trackUploadLimitHit({
          limit: "monthly_quota",
          entry: "upload_refused",
          response: shown ? "upgrade_dialog" : "kept_unattached",
          sizes: [pending.file.size],
        });
        if (shown) {
          if (pending.preview) URL.revokeObjectURL(pending.preview);
          setPendingFiles((prev) => prev.filter((pf) => pf.id !== pending.id));
          openUploadUpgrade("upload_monthly_quota", {
            kind: "monthly_quota",
            quota,
            files: [{ name: pending.file.name, size: pending.file.size }],
          });
          return null;
        }
      }
      // An unreadable file fails like a network error, but retrying cannot help.
      const unreadable = !quota && !(err instanceof AttachmentUploadClientError) && !(await isFileReadable(pending.file));
      updatePendingFile((file) => ({
        ...file,
        uploadStatus: "error",
        attachmentId: undefined,
        uploadError: quota || unreadable
          ? formatMessageRef.current({ id: quota ? "upgradeDialog.uploadQuota.title" : "message.composer.fileUnreadable" })
          : formatComposerUploadError(err, formatMessageRef.current),
        uploadCanRetry: quota || unreadable ? false : !(err instanceof AttachmentUploadClientError) || err.retryable,
      }));
      return null;
    } finally {
      if (uploadControllersRef.current.get(pending.id) === controller) {
        uploadControllersRef.current.delete(pending.id);
      }
    }
  }, [channelId, draftPendingFilesCacheKey, isCommittedComposerOwner, resolveDeliveryChannelId]);

  const addFiles = useCallback((files: FileList | File[], entry: "picker" | "drop" | "paste") => {
    // Compact comment composer: comments are text + anchor, never files —
    // drop drags/pastes/picker input at the single entry point.
    if (variant === "compact") return;
    const candidates = Array.from(files);
    if (candidates.length === 0) return;
    // A drop or a paste when the month is used up: the dialog, and nothing attached.
    if (openUpgradeIfMonthUsedUp(entry, candidates.map((file) => file.size))) return;

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
    const attachmentLimitsPromise = resolveAttachmentUploadLimits();

    submittedDraftIntentRef.current = null;
    pendingFilesRef.current = [...pendingFilesRef.current, ...provisionalFiles];
    setPendingFiles((prev) => [...prev, ...provisionalFiles]);
    for (const pending of provisionalFiles) {
      const preview = pending.preview;
      if (preview) {
        void readLocalImageDimensions(preview).then((probe) => {
          setPendingFiles((prev) => prev.map((pf) => {
            if (pf.id !== pending.id) return pf;
            return probe.decoded
              ? { ...pf, previewDecoded: true, previewWidth: probe.width, previewHeight: probe.height }
              : { ...pf, failedPreviewSrcs: [...(pf.failedPreviewSrcs ?? []), preview] };
          }));
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
      const attachmentLimits = await Promise.race([attachmentLimitsPromise, aborted]);
      if (handleAbort) selectionSignal.removeEventListener("abort", handleAbort);
      if (
        attachmentLimits === "aborted"
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
        !provisionalIds.has(file.id) && file.uploadStatus !== "validating" && !file.notAttached
      )).length;
      // Stryker disable next-line all: pass-through into the tested selection decision.
      const decision = decideMessageAttachmentSelection(
        existingCount,
        currentProvisionalFiles.map((file) => file.file),
        attachmentLimits,
      );
      const remainingAccepted = [...decision.accepted];
      const acceptedFiles = currentProvisionalFiles.filter((pending) => {
        const index = remainingAccepted.indexOf(pending.file);
        if (index < 0) return false;
        remainingAccepted.splice(index, 1);
        return true;
      });
      const acceptedIds = new Set(acceptedFiles.map((file) => file.id));
      // Pro would take it: the upgrade dialog. No plan would: it stays, failed, saying why.
      const plan = decision.rejection ? attachmentRejectionPlan(decision.rejection, currentServerIsFree()) : null;
      const keptReason = new Map<File, NotAttachedReason>(plan?.keep.map(({ file, reason }) => [file, reason]) ?? []);
      const maxBytes = decision.rejection?.limits?.maxBytes ?? null;
      for (const rejected of currentProvisionalFiles) {
        if (!acceptedIds.has(rejected.id) && !keptReason.has(rejected.file) && rejected.preview) URL.revokeObjectURL(rejected.preview);
      }

      const applyDecision = (filesToUpdate: PendingFile[]) => filesToUpdate.flatMap((file) => {
        if (!provisionalIds.has(file.id) || file.uploadStatus !== "validating") return [file];
        const reason = keptReason.get(file.file);
        if (reason) return [{ ...file, uploadStatus: "error" as const, uploadCanRetry: false, notAttached: { reason, maxBytes } }];
        if (!acceptedIds.has(file.id)) return [];
        return [{ ...file, uploadStatus: "queued" as const }];
      });
      pendingFilesRef.current = applyDecision(currentFiles);
      setPendingFiles(applyDecision);
      setError("");
      for (const hit of plan?.hits ?? []) trackUploadLimitHit({ ...hit, entry });
      if (plan?.upgradeGate) openUploadUpgrade(plan.upgradeGate, plan.upgradeContext ?? undefined);

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
      void addFiles(files, "picker");
    }
    e.currentTarget.value = "";
  }, [addFiles]);
  // A stable identity for <ComposerFilePickers> (memoized) that always runs
  // the latest handler.
  const attachmentPickerChangeRef = useRef(handleAttachmentPickerChange);
  attachmentPickerChangeRef.current = handleAttachmentPickerChange;
  const stableAttachmentPickerChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    attachmentPickerChangeRef.current(e);
  }, []);

  const removeFile = useCallback((index: number) => {
    submittedDraftIntentRef.current = null;
    setPendingFiles((prev) => {
      const removed = prev[index];
      if (removed) {
        uploadControllersRef.current.get(removed.id)?.abort();
        uploadControllersRef.current.delete(removed.id);
        if (removed.directUploadSession) {
          void cancelAttachmentUploadSession(api, removed.directUploadSession.uploadId)
            .then(() => notifyAttachmentUploadChanged({ channelId, uploadId: removed.directUploadSession!.uploadId, kind: "canceled" }))
            .catch(() => undefined);
        }
      }
      if (removed?.preview) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  }, [channelId]);

  const retryFile = useCallback((id: string) => {
    const pending = pendingFilesRef.current.find((pf) => pf.id === id);
    if (pending) {
      void startAttachmentUpload(pending);
    }
  }, [startAttachmentUpload]);

  const openDraftImagePreview = useCallback((attachmentId: string) => {
    const readyImages: MessageAttachment[] = pendingFilesRef.current
      .filter((pf) => getPendingFileDisplayPreview(pf) && pf.uploadStatus === "ready" && pf.attachmentId)
      .map((pf) => {
        const localPreviewUrl = getPendingFileLocalPreview(pf);
        return {
          id: pf.attachmentId!,
          filename: pf.file.name,
          mimeType: pf.file.type,
          sizeBytes: pf.file.size,
          width: pf.previewWidth ?? null,
          height: pf.previewHeight ?? null,
          thumbnailUrl: localPreviewUrl ? null : pf.serverThumbnailUrl ?? null,
          localPreviewUrl,
        };
      });
    const imageIndex = readyImages.findIndex((attachment) => attachment.id === attachmentId);
    if (imageIndex >= 0) {
      useImageLightboxStore.getState().open(readyImages, imageIndex);
    }
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursorPos = e.target.selectionStart;
    const undoSnapshot = mentionUndoSnapshotRef.current;
    if (undoSnapshot && val !== undoSnapshot.afterContent) {
      mentionUndoSnapshotRef.current = null;
    }
    submittedDraftIntentRef.current = null;
    lastSyncedValueRef.current = val;
    setContent(val);
    setSelectedMentions((prev) => prev.filter((selected) => mentionStillAppears(val, selected)));
    // Scheduled, not synchronous: the keystroke must not pay for a layout pass
    // before the character can paint (see autoResize above).
    scheduleAutoResize();

    if (plainText) return;
    const textBeforeCursor = val.slice(0, cursorPos);
    if (detectMentionTrigger(textBeforeCursor, cursorPos)) {
      dismissChannelPopover();
    } else if (!detectChannelTrigger(textBeforeCursor, cursorPos)) {
      // Neither matched — both are already dismissed by detect()
    }
  }, [scheduleAutoResize, plainText, detectMentionTrigger, detectChannelTrigger, dismissChannelPopover]);

  /** Takes text written into the box without an input event into `content`,
   *  so it is neither overwritten nor ignored by Send (task #136). */
  const adoptBypassedComposerValue = useCallback(() => {
    const el = textareaRef.current;
    if (!el || el.value === lastSyncedValueRef.current) return;
    const val = el.value;
    lastSyncedValueRef.current = val;
    submittedDraftIntentRef.current = null;
    setContent(val);
    setSelectedMentions((prev) => prev.filter((selected) => mentionStillAppears(val, selected)));
    scheduleAutoResize();
  }, [scheduleAutoResize]);

  // The box can change behind our back with no render to notice it, so Send
  // would stay disabled: check whenever the caret moves in it, it gains focus,
  // or an input method finishes.
  useEffect(() => {
    const onSelectionChange = () => {
      if (document.activeElement === textareaRef.current) adoptBypassedComposerValue();
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [adoptBypassedComposerValue]);

  // Handle pasting copied files from the OS clipboard into the attachment flow.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const pastedFiles = extractClipboardFiles(e.clipboardData);
    if (pastedFiles.length > 0) {
      e.preventDefault();
      // Copied into memory now: the clipboard File can become unreadable once the event ends.
      void materializePastedFiles(pastedFiles).then(({ files, unreadable }) => {
        if (unreadable) setError(formatMessageRef.current({ id: "message.composer.fileUnreadable" }));
        if (files.length > 0) addFiles(files, "paste");
      });
      return;
    }
    // Plain text goes in from the paste event itself (task #777). Chrome
    // reads the clipboard a second time to insert, and a dictation tool that
    // pastes then restores the old clipboard (Typeless) can swap it in
    // between: Chrome then inserts nothing and the sentence is lost.
    if (insertPastedText(e.currentTarget, e.clipboardData)) e.preventDefault();
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
      if (fileItems.length > 0) void addFiles(fileItems, "drop");
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
    if (fallback.length > 0) void addFiles(fallback, "drop");
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

  const handleSubmit = useCallback(async (e: React.FormEvent | React.KeyboardEvent, options?: { forceAsTask?: boolean }) => {
    // Taken before any await: a tap on Send set it just before this submit.
    const sentByTouch = touchSendRef.current;
    touchSendRef.current = false;
    e.preventDefault();
    if (submitDisabled || submitBusy || readChannelConversionBlocked(membershipChannelId)) return;
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
    if (pendingFiles.some((pf) => pf.notAttached)) {
      setError(formatMessage({ id: "message.composer.removeNotAttached" }));
      return;
    }
    if (pendingFiles.some((pf) => pf.uploadStatus === "error")) {
      setError(formatMessage({ id: "message.composer.removeOrRetryBeforeSend" }));
      return;
    }

    const msg = content;
    // Only a message with text carries the reference: it is never sent alone.
    const sentReference = hasContent ? composerReference ?? null : null;
    const textToSend = withComposerReference(msg, sentReference);
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
        // A file the quota refused came off with the upgrade dialog; only another failure is something to retry.
        const failedToRetry = queuedFiles.some((file) => !uploadedByPendingId.has(file.id) && !quotaRefusedIdsRef.current.has(file.id));
        if (failedToRetry && isCommittedComposerOwner(submittedComposerChannelId, submittedDraftPendingFilesCacheKey)) {
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
    if (readChannelConversionBlocked(membershipChannelId)) {
      submittedDraftIntentRef.current = releaseSubmittedDraftIntent(submittedDraftIntentRef.current, submittedDraftIntent);
      return;
    }
    const submittedTextarea = textareaRef.current!;
    // Enter, and a finger's tap on Send, keep the keyboard up for the next
    // message (every chat app does); a mouse click on Send lets focus go.
    const keepComposerFocused = e.type === "keydown" || sentByTouch;
    setContent("");
    setSelectedMentions([]);
    clearDraft(channelId);
    // Stryker disable next-line ArrayDeclaration: clearing the draft-pending cache is pinned by the remount/send DOM test; `setPendingFiles([])` also keeps the in-memory chip state clear.
    saveDraftPendingFiles(draftPendingFilesCacheKeyRef.current, []);
    setPendingFiles([]);
    dismissMentionPopover();
    dismissChannelPopover();
    // Cancel the measurement queued by the last keystroke so it cannot run
    // after this clear and overwrite the height (task #513).
    cancelScheduledAutoResize();
    submittedTextarea.style.height = "";
    if (!keepComposerFocused) submittedTextarea.blur();

    // Override path (compact comment composer): the caller owns delivery and
    // list refresh; no optimistic row exists to reconcile. Failure restores
    // the typed content + mentions exactly like the store path below.
    if (onSendOverride) {
      try {
        await onWillSend?.();
        if (readChannelConversionBlocked(membershipChannelId)) throw new Error(conversionBlockedMessage);
        setError("");
        await onSendOverride(textToSend, mentionsToSend);
        sentReference?.onSent();
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
        if (isCurrentComposer && mayTakeFocus(submittedTextarea)) submittedTextarea.focus();
        const response = getApiErrorResponse(err);
        const errorMessage = response?.code === "peer_not_member"
          ? formatMessage({ id: "message.composer.peerNotMember" })
          : response?.error ?? formatMessage({ id: "message.composer.failedToSend" });
        if (isCurrentComposer) setError(errorMessage);
      }
      return;
    }

    // Stryker disable next-line all: attachment-only fallback copy predates the stale-submit guard; this source oracle is not a DOM copy test.
    const messageContent = hasContent
      ? textToSend
      : formatMessage({ id: "message.composer.attachmentsOnlyBody" }, { count: filesToSend.length });
    const optimisticDraft = createOptimisticMessageDraft();
    const optimisticId = optimisticDraft.id;

    try {
      await onWillSend?.();
      if (readChannelConversionBlocked(membershipChannelId)) throw new Error(conversionBlockedMessage);
      setError("");
      setUnresolvedMentionHandles([]);
      setDeliveryWarnings([]);

      // Create optimistic message immediately. Images get local blob previews; other files get filename cards.
      const optimisticAttachments = filesToSend.map((pf, i) => ({
        id: `optimistic-att-${i}`,
        filename: pf.file.name,
        mimeType: pf.file.type,
        sizeBytes: pf.file.size,
        width: pf.previewWidth ?? null,
        height: pf.previewHeight ?? null,
        // Only a preview this browser decoded; an undecodable one (HEIC
        // outside Safari) would paint a broken image in the timeline.
        localPreviewUrl: getPendingFileLocalPreview(pf),
        thumbnailUrl: pf.serverThumbnailUrl ?? null,
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
      sentReference?.onSent();
      setPendingMentionActions(sendResult.pendingMentionActions);
      setUnresolvedMentionHandles(sendResult.unresolvedMentionHandles ?? []);
      setDeliveryWarnings(sendResult.deliveryWarnings ?? []);
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
        if (mayTakeFocus(submittedTextarea)) submittedTextarea.focus();
      } else {
        saveDraftPendingFiles(
          submittedDraftPendingFilesCacheKey,
          filesToSend,
        );
      }
      const response = getApiErrorResponse(err);
      const errorMessage = response?.code === "peer_not_member"
        ? formatMessage({ id: "message.composer.peerNotMember" })
        : response?.error ?? formatMessage({ id: "message.composer.failedToSendMessage" });
      if (isCurrentComposer) setError(errorMessage);
      console.error("Failed to send message:", err);
    }
  }, [
    submitDisabled, submitBusy, membershipChannelId, content, pendingFiles,
    allowEmptySubmit, onSendOverride, alsoCreateTask, formatMessage, channelId,
    composerReference, draftPendingFilesCacheKey, selectedMentions, resolveDeliveryChannelId,
    isCommittedComposerOwner, startAttachmentUpload, restoreFailedSendDraft,
    clearDraft, dismissMentionPopover, dismissChannelPopover,
    cancelScheduledAutoResize, onWillSend, addOptimisticMessage, currentUser,
    conversionBlockedMessage, sendMessage, onChannelResolved, setAlsoCreateTask,
    removeOptimisticMessage,
  ]);

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

  const dismissDeliveryWarning = useCallback(() => {
    setDeliveryWarnings([]);
  }, []);

  const handleRemovePendingFile = useCallback((pendingId: string) => {
    removeFile(pendingFiles.findIndex((candidate) => candidate.id === pendingId));
  }, [pendingFiles, removeFile]);

  const handlePreviewDraftImage = useCallback((attachmentId: string) => {
    openDraftImagePreview(attachmentId);
  }, [openDraftImagePreview]);

  const handlePendingPreviewError = useCallback((pendingId: string, src: string) => {
    setPendingFiles((prev) => prev.map((pf) => (
      pf.id === pendingId && !pf.failedPreviewSrcs?.includes(src)
        ? { ...pf, failedPreviewSrcs: [...(pf.failedPreviewSrcs ?? []), src] }
        : pf
    )));
  }, []);

  const handleAttachmentDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setPendingFiles((prev) => {
        const oldIndex = prev.findIndex((p) => p.id === active.id);
        const newIndex = prev.findIndex((p) => p.id === over.id);
        return arrayMove(prev, oldIndex, newIndex);
      });
    }
  }, []);

  // When the month is used up the dialog opens instead of the picker: it must
  // decide inside this click, which a file picker needs (monthlyUploadQuotaStore).
  const handleAttachImageClick = useCallback(() => {
    if (!openUpgradeIfMonthUsedUp("attach_media")) imageInputRef.current?.click();
  }, []);

  const handleAttachFileClick = useCallback(() => {
    if (!openUpgradeIfMonthUsedUp("attach_file")) fileInputRef.current?.click();
  }, []);

  const handleSelectMentionCandidate = useCallback((candidate: MentionCandidate) => {
    doInsertMention(candidate);
  }, [doInsertMention]);

  const handleSelectChannelCandidate = useCallback((ch: { name: string }) => {
    doInsertChannel(ch);
  }, [doInsertChannel]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (isImeComposing(e)) return;

    const undoSnapshot = mentionUndoSnapshotRef.current;
    if (undoSnapshot && matchesShortcut(e, "undo-mention") && contentRef.current === undoSnapshot.afterContent) {
      e.preventDefault();
      mentionUndoSnapshotRef.current = null;
      contentRef.current = undoSnapshot.beforeContent;
      setContent(undoSnapshot.beforeContent);
      setSelectedMentions(undoSnapshot.beforeMentions);
      pendingSenderMentionCursorRef.current = undoSnapshot.beforeCursor;
      return;
    }

    if (handleMentionKeyDown(e, doInsertMention)) return;

    if (handleChannelKeyDown(e, filteredChannels.length, () => {
      const item = filteredChannels[channel.index];
      if (item) doInsertChannel(item);
    })) return;

    // What Enter does is the account's choice (composerSendKey.ts, #triage:#210):
    // Cmd/Ctrl+Shift+Enter sends as a task (cindyz #proj-uiux:306ce5ff; Task v2
    // keeps it where the As task checkbox is); touch-primary portrait keeps plain
    // Enter a newline (cindyz #proj-uiux:3e2aa689); a newline is the browser's.
    // Send as task on the person's own keys (the shortcuts panel), when they changed it; at its default it is the
    // Enter decision's ⌘/Ctrl+Shift+Enter below.
    if (!asTaskShortcutDisabled && isShortcutOverridden("send-as-task")) {
      if (matchesShortcut(e, "send-as-task")) {
        e.preventDefault();
        handleSubmit(e, { forceAsTask: true });
        return;
      }
    }
    const action = composerEnterAction(e, sendKey, { sendAsTask: !asTaskShortcutDisabled && !isShortcutOverridden("send-as-task") });
    if (action === "sendAsTask" || action === "send") {
      e.preventDefault();
      handleSubmit(e, action === "sendAsTask" ? { forceAsTask: true } : undefined);
    }
  }, [handleMentionKeyDown, handleChannelKeyDown, filteredChannels, channel.index, doInsertMention, doInsertChannel, handleSubmit, asTaskShortcutDisabled, sendKey]);


  const toggleTaskModeWithoutBlur = useCallback((e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault();
    setAlsoCreateTask((prev) => !prev);
  }, []);
  // A channel Tasks card's "+" (task v2): As task on, the cursor at the end of the input.
  const turnOnTaskMode = useCallback(() => {
    setAlsoCreateTask(true);
    const textarea = textareaRef.current;
    textarea?.focus();
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);
  useComposerTaskModeTarget(showTaskButton ? channelId : null, turnOnTaskMode);

  const hasValidatingAttachments = pendingFiles.some((pf) => pf.uploadStatus === "validating");
  const hasUploadingAttachments = pendingFiles.some((pf) => pf.uploadStatus === "uploading");
  const hasFailedAttachments = pendingFiles.some((pf) => pf.uploadStatus === "error");
  const hasNotAttached = pendingFiles.some((pf) => pf.notAttached);
  // A file that isn't attached stays on its chip, saying why; an upload that failed gets the retry bar.
  const visibleUploadFailures = pendingFiles.filter((pf) => pf.uploadStatus === "error" && !pf.notAttached);
  const compactPendingFiles = pendingFiles.filter((pf) => pf.uploadStatus !== "error" || pf.notAttached);
  const freePlan = useServerStore((s) => (s.billing?.plan || s.current?.plan || "free") === "free");
  const sortablePendingFileIds = useMemo(() => compactPendingFiles.map((pf) => pf.id), [compactPendingFiles]);
  const locallyOwnedUploadIds = new Set(pendingFiles.flatMap((file) => (
    file.directUploadSession ? [file.directUploadSession.uploadId] : []
  )));
  const visibleRecoverableUploads = recoverableUploads.filter(
    (upload) => !locallyOwnedUploadIds.has(upload.uploadId),
  );
  const composing = content.trim().length > 0 || pendingFiles.length > 0;
  const canSubmit = composing || (allowEmptySubmit && Boolean(onSendOverride));
  const submitBlocked = !canSubmit || hasValidatingAttachments || hasUploadingAttachments || hasFailedAttachments || submitDisabled || submitBusy || conversionBlocked;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: spinner state is covered by MessageInput DOM tests; generated mutants hang tsx.
  const showSubmitSpinner = submitBusy || hasValidatingAttachments || hasUploadingAttachments;
  // As task on: the send button and the input say the next message becomes a task (screen readers too).
  const sendLabel = alsoCreateTask ? formatMessage({ id: "message.composer.sendAsTaskTooltip" }) : formatMessage({ id: "message.composer.send" });
  const submitTitle = conversionBlocked ? conversionBlockedMessage : submitBusy
    ? formatMessage({ id: "message.composer.sending" })
    : submitDisabled
      ? submitDisabledReason ?? formatMessage({ id: "message.composer.sendDisabled" })
      : hasValidatingAttachments
        ? formatMessage({ id: "message.composer.checkingAttachmentsTitle" })
        : hasUploadingAttachments
          ? formatMessage({ id: "message.composer.uploadingTitle" })
          : hasNotAttached
            ? formatMessage({ id: "message.composer.removeNotAttached" })
            : hasFailedAttachments
              ? formatMessage({ id: "message.composer.retryFailedTitle" })
              : submitTitleOverride ?? (sendKey === "mod_enter" ? labelWithShortcut(sendLabel, MOD_ENTER_SEND_SHORTCUT, formatMessage) : sendLabel);
  const submitLabel = conversionBlocked ? conversionBlockedMessage : submitBusy
    ? formatMessage({ id: "message.composer.sendingLabel" })
    : submitDisabled
      ? submitDisabledReason ?? formatMessage({ id: "message.composer.sendDisabled" })
      : hasValidatingAttachments
        ? formatMessage({ id: "message.composer.checkingAttachmentsAria" })
        : hasUploadingAttachments
          ? formatMessage({ id: "message.composer.uploadingAria" })
          : hasNotAttached
            ? formatMessage({ id: "message.composer.removeNotAttached" })
            : hasFailedAttachments
              ? formatMessage({ id: "message.composer.retryFailedTitle" })
              : submitLabelOverride ?? sendLabel;
  // Stryker disable next-line ConditionalExpression: icon branch is covered by MessageInput DOM tests; generated JSX mutants hang tsx.
  const submitIcon = showSubmitSpinner ? <Spinner size="sm" aria-label={formatMessage({ id: "common.loadingLabel" })} /> : <Send size={18} />;

  return (
    <ComposerRoot
      ref={toastFloorRef}
      onSubmit={handleSubmit}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      // Full: the conversation's own composer, on the 20px edge its messages
      // and header keep (DS: "the composer below" shares the header's edge),
      // on the panel colour so it covers the timeline it floats over.
      // Compact: the host docks it (COMPOSER_DOCK_CLASS) and owns the
      // surface around it.
      className={variant === "compact" ? "relative flex min-w-0 w-full items-center" : `relative flex min-w-0 w-full items-center bg-layer-canvas ${COMPOSER_FULL_EDGE_CLASS}`}
    >
      {/* Drop overlay — only visible while a file drag is in progress over
          the composer area. Pointer-events are kept on so the overlay
          itself is the drop target (browser fires drop on the topmost
          element under the cursor at drop time). */}
      {isDraggingFiles && (
        <ComposerDropOverlay
          aria-hidden
          data-testid="composer-drop-overlay"
        >
          <ComposerDropOverlayLabel>
            {formatMessage({ id: "message.composer.dropToAttach" })}
          </ComposerDropOverlayLabel>
        </ComposerDropOverlay>
      )}
      <ComposerFilePickers
        imageInputRef={imageInputRef}
        fileInputRef={fileInputRef}
        onChange={stableAttachmentPickerChange}
      />

      {/* `relative`: the suggestion lists below anchor here, so they span the
          composer's own column (the frame's width), not the padded root. */}
      <div className="relative flex w-full flex-col gap-2">
        {/* Marked as the composer's notices: the assistant's otter lies on top of them (composerTopEdge). */}
        {activationBanner ? <div className="empty:hidden" data-composer-notices="">{activationBanner}</div> : null}
        {error && (
          <Banner intent="warning" density="sm">
            {error}
          </Banner>
        )}

        {mentionActionNotice && (
          <div className="rounded-control bg-fill-muted px-2.5 py-1.5 text-caption font-semibold text-foreground-muted">
            {mentionActionNotice}
          </div>
        )}

        {isDmComposer && deliveryWarnings.length > 0 && (
          <Banner
            intent="warning"
            density="sm"
            onClose={dismissDeliveryWarning}
            closeLabel={formatMessage({ id: "message.composer.dismissDeliveryWarning" })}
          >
            {formatMessage({
              id: deliveryWarnings.some((warning) => warning.reason === "agent_stopped")
                ? "message.composer.agentStoppedDeliveryWarning"
                : "message.composer.agentStuckDeliveryWarning",
            })}
          </Banner>
        )}

        {!isDmComposer && unresolvedMentionHandles.length > 0 && (
          <Banner
            intent="warning"
            density="sm"
            onClose={dismissUnresolvedMentionWarning}
            closeLabel={formatMessage({ id: "message.composer.dismissUnresolvedMentions" })}
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
            channelName={pendingMentionChannelName}
            onMarkAction={markPendingMentionAction}
            onAddAllActions={addAllPendingMentionActions}
            onDismissAction={dismissPendingMentionAction}
          />
        )}

        {visibleRecoverableUploads.length > 0 && (
          <Banner
            intent="warning"
            density="sm"
            className="min-w-0 font-normal"
            data-testid="composer-recoverable-uploads"
          >
            <div className="min-w-0 stack-y-2">
              <div className="font-bold">
                {formatMessage(
                  { id: "message.composer.recoverableUploadsTitle" },
                  { count: visibleRecoverableUploads.length },
                )}
              </div>
              <div className="break-words">
                {formatMessage({ id: "message.composer.recoverableUploadsDescription" })}
              </div>
              <ul className="stack-y-1.5">
                {visibleRecoverableUploads.map((upload) => (
                  <li key={upload.uploadId}>
                    <Separator className="mb-1.5" />
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <Tooltip content={upload.filename}>
                        <span className="min-w-0 flex-1 truncate font-bold">
                          {upload.filename}
                        </span>
                      </Tooltip>
                      <RecoverableUploadCancelButton
                        uploadId={upload.uploadId}
                        filename={upload.filename}
                        onCancel={cancelRecoverableUpload}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </Banner>
        )}

        {/* Pending attachments */}
        {compactPendingFiles.length > 0 && (
          <DndContext
            sensors={dndSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleAttachmentDragEnd}
          >
            <SortableContext items={sortablePendingFileIds} strategy={horizontalListSortingStrategy}>
              <ComposerAttachments>
                {compactPendingFiles.map((pf) => (
                  <SortableAttachment
                    key={pf.id}
                    id={pf.id}
                    preview={getPendingFileDisplayPreview(pf)}
                    fileName={pf.file.name}
                    mimeType={pf.file.type}
                    uploadStatus={pf.uploadStatus}
                    uploadProgress={pf.uploadProgress}
                    attachmentId={pf.attachmentId ?? null}
                    failedReason={pf.notAttached
                      ? notAttachedCopy({ ...pf.notAttached, size: pf.file.size, freePlan }, formatMessage)
                      : undefined}
                    onRemove={handleRemovePendingFile}
                    onPreview={
                      getPendingFileDisplayPreview(pf) && pf.uploadStatus === "ready" && pf.attachmentId
                        ? handlePreviewDraftImage
                        : undefined
                    }
                    onPreviewError={handlePendingPreviewError}
                  />
                ))}
              </ComposerAttachments>
            </SortableContext>
          </DndContext>
        )}

        {visibleUploadFailures.map((pf) => (
          <UploadFailureBanner
            key={`upload-error-${pf.id}`}
            fileId={pf.id}
            fileName={pf.file.name}
            error={pf.uploadError}
            progress={pf.uploadProgress}
            canRetry={pf.uploadCanRetry !== false}
            onRetry={retryFile}
            onRemove={handleRemovePendingFile}
          />
        ))}

        {/* Composer shell — single bordered card holding the textarea AND
            the action toolbar. */}
        {/* Accessory chips ride ABOVE the composer card — the same slot as
            pending attachments — so the input itself stays clean. */}
        {accessoryRow || composerReference ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {accessoryRow}
            {composerReference?.chip}
          </div>
        ) : null}

        {/* @mention dropdown — placed before <Composer> (outside the card) per
            the RUI spec, so the card never clips it. */}
        <MentionSuggestionList picker={mention} onSelect={handleSelectMentionCandidate} testId="mention-autocomplete-popover" />

        {/* #channel dropdown */}
        {channel.show && filteredChannels.length > 0 && (
          <ComposerSuggestionList
            ref={channel.popupRef}
            className="z-float"
            data-testid="channel-autocomplete-popover"
          >
            <ComposerSuggestionGroup>
              {filteredChannels.map((ch, i) => {
                const isSelected = i === channel.index;
                const isArchived = !!ch.archivedAt;
                return (
                  <AutocompleteOptionRow
                    key={ch.id}
                    value={ch}
                    flatIndex={i}
                    highlighted={isSelected}
                    onMouseDown={preventAutocompleteOptionMouseDown}
                    onSelect={handleSelectChannelCandidate}
                  >
                    <ComposerSuggestionIcon variant="framed">
                      <ChannelIcon channel={ch} size={12} />
                    </ComposerSuggestionIcon>
                    <ComposerSuggestionContent>
                      <ComposerSuggestionTitle>{ch.name}</ComposerSuggestionTitle>
                      {ch.description && (
                        <ComposerSuggestionMeta>{ch.description}</ComposerSuggestionMeta>
                      )}
                      {isArchived && (
                        <ComposerSuggestionAside>
                          <Badge appearance="soft" variant="muted">
                            {formatMessage({ id: "message.composer.archivedBadge" })}
                          </Badge>
                        </ComposerSuggestionAside>
                      )}
                    </ComposerSuggestionContent>
                  </AutocompleteOptionRow>
                );
              })}
            </ComposerSuggestionGroup>
          </ComposerSuggestionList>
        )}

        {/* Focusable only from code (requestComposerFocus). Its ring is the
            frame's own focus ring, for keyboard focus only: raft-ui rings the
            frame while a field inside has focus-visible, and the frame itself
            matches that ring here. */}
        {/* Always this box, with or without `frameEdge`: the frame must not
            remount (and lose the caret) when the edge comes or goes. */}
        <div
          className="group/composer-frame relative"
          data-composer-frame-edge=""
          data-composing={composing ? "" : undefined}
        >
        {frameEdge}
        <Composer
          ref={composerFrameRef}
          tabIndex={-1}
          className="outline-none focus-visible:shadow-focus"
          data-testid="composer-frame"
        >
          <ComposerInput
            id={textareaId}
            data-testid="composer-textarea"
            style={composerFontStyle}
            ref={composerTextareaRef}
            onChange={handleChange}
            onFocus={adoptBypassedComposerValue}
            onCompositionEnd={adoptBypassedComposerValue}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder ?? (alsoCreateTask
              ? formatMessage({ id: "message.composer.messagePlaceholderAsTask" }, { channel: channelName })
              : formatMessage({ id: "message.composer.messagePlaceholder" }, { channel: channelName }))}
            maxLength={maxLength}
            rows={1}
          />
          <ComposerToolbar>
            {variant === "compact" ? (
              <div />
            ) : (
              <ComposerActions>
                <Tooltip content={formatMessage({ id: "message.composer.attachImage" })}>
                <ComposerIconButton
                  onPointerDown={preventToolbarButtonPointerDownBlur}
                  onClick={handleAttachImageClick}
                  data-slot="button"
                  aria-label={formatMessage({ id: "message.composer.attachImage" })}
                >
                  <ImagePlus size={18} />
                </ComposerIconButton>
                </Tooltip>
                <Tooltip content={formatMessage({ id: "message.composer.attachFile" })}>
                <ComposerIconButton
                  onPointerDown={preventToolbarButtonPointerDownBlur}
                  onClick={handleAttachFileClick}
                  data-slot="button"
                  aria-label={formatMessage({ id: "message.composer.attachFile" })}
                >
                  <Paperclip size={18} />
                </ComposerIconButton>
                </Tooltip>
              </ComposerActions>
            )}
            <div className="flex items-center gap-2">
              {sendKey === "mod_enter" && composing ? <ComposerSendKeyHint /> : null}
              {showTaskButton && (
                <Tooltip content={sendAsTaskShortcut.combos[0] ? labelWithShortcut(formatMessage({ id: "message.composer.sendAsTaskTooltip" }), sendAsTaskShortcut.combos[0], formatMessage) : formatMessage({ id: "message.composer.sendAsTaskTooltip" })}>
                {/* raft-ui's composer toolbar label (DS `rf-check` in the
                    composer bar), drawn as a button so a tap toggles without
                    taking focus from the input. */}
                <ComposerToolbarLabel
                  render={<button type="button" />}
                  role="checkbox"
                  data-testid="composer-as-task-toggle"
                  aria-checked={alsoCreateTask}
                  className="rounded-control outline-none focus-visible:shadow-focus"
                  onPointerDown={preventTaskTogglePointerDownBlur}
                  onClick={toggleTaskModeWithoutBlur}
                >
                  <CheckboxIndicator
                    checked={alsoCreateTask}
                  />
                  {formatMessage({ id: "message.composer.asTask" })}
                </ComposerToolbarLabel>
                </Tooltip>
              )}
              <Tooltip content={submitTitle}>
              <ComposerSubmit
                size="icon-md"
                data-slot="button"
                onPointerDown={preventSendButtonPointerDownBlur}
                onTouchEnd={handleSendTouchEnd}
                disabled={submitBlocked}
                aria-label={submitLabel}
              >
                {submitIcon}
              </ComposerSubmit>
              </Tooltip>
            </div>
          </ComposerToolbar>
        </Composer>
        </div>
      </div>
    </ComposerRoot>
  );
}
