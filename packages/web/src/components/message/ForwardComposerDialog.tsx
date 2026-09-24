import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import { ChevronRight } from "lucide-react";
import type { Channel } from "../../store/channelStore";
import { useChannelStore } from "../../store/channelStore";
import type { Message, MessageAttachment } from "../../store/messageStore";
import { useMessageStore } from "../../store/messageStore";
import { useImageLightboxStore } from "../../store/imageLightboxStore";
import { useServerStore } from "../../store/serverStore";
import api from "../../api/client";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import type {
  ForwardedBundleAttachmentSnapshot,
  ForwardedBundleMetadata,
} from "./ForwardedBundleCard";
import { isPreviewableImageAttachment } from "./urlImageFallback";
import {
  isAudioPreviewAttachment as isPreviewableAudioAttachment,
  isDocumentPreviewAttachment as isPreviewableDocumentAttachment,
  isVideoPreviewAttachment as isPreviewableVideoAttachment,
} from "./attachmentPreview";
import { isHtmlPreviewAttachment } from "./attachmentPreview";
import { openMediaPreview } from "./openMediaPreview";
import { openDocumentPreview } from "./openDocumentPreview";
import { downloadAttachmentById } from "./downloadAttachment";
import { forwardToast } from "./forwardToast";
import ForwardComposerTargetList from "./ForwardComposerTargetList";
import ForwardComposerMobile from "./ForwardComposerMobile";
import ForwardComposerWarnings from "./ForwardComposerWarnings";
import ForwardComposerDesktop from "./ForwardComposerDesktop";
export { canForwardToTarget, getForwardTargets } from "./forwardComposerModel";
export type { ForwardDelivery } from "./forwardComposerModel";
import {
  MAX_FORWARD_DESTINATIONS,
  canForwardToTarget,
  composerError,
  composerLabelVisibility,
  composerSourceLabel,
  fallbackDestination,
  forwardRequestFailureMessage,
  getForwardTargets,
  orderForwardSourceMessages,
  targetLabel,
  useForwardSearch,
} from "./forwardComposerModel";
import type {
  ForwardBatchResponse,
  ForwardDelivery,
  JoinActionStatus,
  MobileForwardStep,
  SelectedDestination,
} from "./forwardComposerModel";

export default function ForwardComposerDialog({
  sourceMessages,
  sourceChannel,
  sourceLabel,
  sourceParentChannelId,
  channelActivity = {},
  skippedCount = 0,
  nestedForwardCount = 0,
  onClose,
  onSent,
}: {
  sourceMessages: Message[];
  sourceChannel: Channel;
  sourceLabel?: string;
  sourceParentChannelId?: string | null;
  channelActivity?: Record<string, string | null>;
  skippedCount?: number;
  nestedForwardCount?: number;
  onClose: () => void;
  onSent: (deliveries: ForwardDelivery[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedDestinations, setSelectedDestinations] = useState<Map<string, SelectedDestination>>(() => new Map());
  const [sending, setSending] = useState(false);
  const [joinAction, setJoinAction] = useState<{ signature: string; status: JoinActionStatus }>({
    signature: "",
    status: "idle",
  });
  const [mobileStep, setMobileStep] = useState<MobileForwardStep>("targets");
  const [mobileMultiSelect, setMobileMultiSelect] = useState(false);
  const forwardRequestIdRef = useRef<string | null>(null);
  const settledSuccessChannelIdsRef = useRef<Set<string>>(new Set());
  const joinAttemptRef = useRef(false);
  const currentServerId = useServerStore((state) => state.current?.id) ?? "current";
  const channels = useChannelStore((state) => state.channels);
  const dmChannels = useChannelStore((state) => state.dmChannels);
  const channelLocalMembership = useChannelStore((state) => state.channelLocalMembership);
  const isMobile = useMediaQuery("(max-width: 767px)");
  const nav = useAppNavigate();
  const { formatMessage } = useIntl();
  const channelTargets = useMemo(() => channels.filter(canForwardToTarget), [channels]);
  const dmTargets = useMemo(() => dmChannels.filter(canForwardToTarget), [dmChannels]);
  const lowerQuery = query.trim().toLowerCase();
  const isSearchMode = lowerQuery.length > 0;
  const {
    results: searchResults,
    loading: searchLoading,
    failed: searchFailed,
    search,
    reset: resetSearch,
  } = useForwardSearch();
  const selectedEntries = useMemo(() => [...selectedDestinations.values()], [selectedDestinations]);
  const noteMentionScope = useMemo(() => {
    // Multi-destination notes intentionally avoid channel-member rosters. MessageInput
    // adds member results unconditionally, so privacy depends on this undefined scoped
    // id plus its useChannelMembers channel-id guard returning an empty roster.
    if (selectedEntries.length !== 1) {
      return { channelId: undefined, channelType: null };
    }
    const entry = selectedEntries[0]!;
    return {
      channelId: entry.resolvedChannelId ?? entry.localTarget?.id ?? entry.searchTarget?.channelId ?? undefined,
      channelType: entry.localTarget?.type ?? entry.searchTarget?.channelType ?? null,
    };
  }, [selectedEntries]);
  const selectedJoinEntries = useMemo(
    () => selectedEntries.filter((entry) => entry.searchTarget?.requiredAction === "join_channel"),
    [selectedEntries],
  );
  const joinTargets = useMemo(
    () => selectedJoinEntries.filter((entry) => {
      if (entry.resolvedChannelId) return false;
      const channelId = entry.searchTarget?.channelId;
      return !channelId || channelLocalMembership[channelId] !== true;
    }),
    [channelLocalMembership, selectedJoinEntries],
  );
  const joinSignature = useMemo(
    () => selectedJoinEntries.map((entry) => entry.key).sort().join("|"),
    [selectedJoinEntries],
  );
  const joinActionStatus: JoinActionStatus = joinAction.signature === joinSignature
    ? joinAction.status
    : "idle";
  const joinInFlight = joinActionStatus === "joining";
  const joinReady = joinTargets.length === 0;
  const joinTargetSummary = joinTargets.length > 1
    ? formatMessage(
      { id: "message.forwardComposer.targetAndMore" },
      {
        target: joinTargets[0]?.label ?? formatMessage({ id: "message.forwardComposer.selectedChannel" }),
        count: joinTargets.length - 1,
      },
    )
    : joinTargets[0]?.label ?? formatMessage({ id: "message.forwardComposer.selectedChannel" });
  const joinTargetTitle = joinTargets.map((entry) => entry.label).join(", ");

  const sourceLabelText = sourceLabel ?? targetLabel(sourceChannel);
  const orderedSourceMessages = useMemo(
    () => orderForwardSourceMessages(sourceMessages, sourceChannel),
    [sourceMessages, sourceChannel],
  );
  const noteComposerChannelId = useMemo(
    () => `forward-note:${sourceChannel.id}:${orderedSourceMessages.map((message) => message.id).join("|")}`,
    [orderedSourceMessages, sourceChannel.id],
  );
  const closeComposer = useCallback(() => {
    useMessageStore.getState().clearDraft(noteComposerChannelId);
    onClose();
  }, [noteComposerChannelId, onClose]);
  const previewMetadata = useMemo<ForwardedBundleMetadata>(() => ({
    kind: "forwarded-bundle",
    version: 1,
    forwardedItems: orderedSourceMessages.map((message, index) => ({
      index,
      sourceMessageSeq: message.seq,
      sourceIsThreadParent: sourceChannel.type === "thread" && message.channelId !== sourceChannel.id,
      sourceTargetId: sourceChannel.type === "thread" ? null : sourceChannel.id,
      sourceThreadId: sourceChannel.type === "thread" ? sourceChannel.id : null,
      parentChannelId: sourceChannel.type === "thread" ? sourceParentChannelId ?? null : null,
      sourceMessageId: message.id,
      sourceAuthorSnapshot: {
        type: message.senderType,
        id: message.senderId,
        name: message.senderName,
        uniqueName: message.senderName,
      },
      sourceCreatedAt: message.createdAt,
      sourceTargetSnapshot: {
        id: sourceChannel.id,
        type: sourceChannel.type,
        label: composerSourceLabel(sourceChannel, sourceLabelText, sourceLabel != null),
        labelVisibility: composerLabelVisibility(sourceChannel),
      },
      contentSnapshot: message.content,
      attachmentSnapshots: (message.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        width: attachment.width,
        height: attachment.height,
      })),
      // These ids stay inside the source user's local composer preview. The
      // persisted Forward response replaces them with destination projection
      // ids before any recipient card can become interactive.
      attachmentPolicy: "projected",
      provenanceState: "available",
    })),
  }), [orderedSourceMessages, sourceChannel, sourceLabel, sourceLabelText, sourceParentChannelId]);

  const filteredTargets = useMemo(() => {
    return getForwardTargets(channelTargets, dmTargets, lowerQuery, channelActivity);
  }, [channelTargets, dmTargets, lowerQuery, channelActivity]);

  const hasSelection = selectedEntries.length > 0;
  const submitDisabledReason = !hasSelection
    ? formatMessage({ id: "message.forwardComposer.selectTargetFirst" })
    : !joinReady
      ? formatMessage({ id: "message.forwardComposer.joinSelectedFirst" })
      : sourceMessages.length === 0
        ? formatMessage({ id: "message.forwardComposer.noMessagesSelected" })
        : null;
  const submitDisabled = submitDisabledReason !== null || sending;
  const hasJointDestination = selectedEntries.some((entry) => (
    entry.localTarget?.type === "joint" || entry.searchTarget?.channelType === "joint"
  ));

  useEffect(() => {
    if (!isMobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile]);

  const toggleDestination = useCallback((entry: SelectedDestination) => {
    setSelectedDestinations((current) => {
      const next = new Map(current);
      if (next.has(entry.key)) {
        next.delete(entry.key);
      } else if (next.size < MAX_FORWARD_DESTINATIONS) {
        next.set(entry.key, entry);
      }
      return next;
    });
  }, []);

  const openMobilePreview = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setMobileStep("preview");
  }, []);

  const openMobileDetail = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setMobileStep("detail");
    return true;
  }, []);

  const chooseDestination = useCallback((entry: SelectedDestination, disabled: boolean) => {
    if (disabled || joinInFlight) return;
    if (isMobile && !mobileMultiSelect) {
      setSelectedDestinations(new Map([[entry.key, entry]]));
      openMobilePreview();
      return;
    }
    toggleDestination(entry);
  }, [isMobile, joinInFlight, mobileMultiSelect, openMobilePreview, toggleDestination]);

  const joinSelectedChannels = useCallback(async () => {
    if (joinAttemptRef.current || joinTargets.length === 0) return;
    const attemptSignature = joinSignature;
    joinAttemptRef.current = true;
    setJoinAction({ signature: attemptSignature, status: "joining" });
    try {
      const results = await Promise.allSettled(joinTargets.map(async (entry) => {
        const channelId = entry.searchTarget?.channelId;
        if (!channelId) throw new Error(formatMessage({ id: "message.forwardComposer.destinationUnavailable" }));
        const joined = await useChannelStore.getState().joinChannel(channelId);
        if (!joined) throw new Error(formatMessage({ id: "message.forwardComposer.joinDestinationFailed" }));
        return { key: entry.key, channelId };
      }));
      const joinedEntries = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      if (joinedEntries.length > 0) {
        setSelectedDestinations((current) => {
          const next = new Map(current);
          for (const joinedEntry of joinedEntries) {
            const currentEntry = next.get(joinedEntry.key);
            if (currentEntry) next.set(joinedEntry.key, { ...currentEntry, resolvedChannelId: joinedEntry.channelId });
          }
          return next;
        });
      }
      setJoinAction({
        signature: attemptSignature,
        status: "idle",
      });
      const failedCount = results.length - joinedEntries.length;
      if (failedCount > 0) {
        forwardToast.error(
          results.length === 1
            ? formatMessage(
              { id: "message.forwardComposer.joinOneFailed" },
              { target: joinTargets[0]?.label ?? formatMessage({ id: "message.forwardComposer.selectedChannel" }) },
            )
            : joinedEntries.length === 0
              ? formatMessage({ id: "message.forwardComposer.joinAllFailed" }, { count: failedCount })
              : formatMessage(
                { id: "message.forwardComposer.joinPartial" },
                { joined: joinedEntries.length, total: results.length, failed: failedCount },
              ),
        );
      }
    } finally {
      joinAttemptRef.current = false;
    }
  }, [formatMessage, joinSignature, joinTargets]);

  const resolveDestination = useCallback(async (entry: SelectedDestination) => {
    if (entry.resolvedChannelId) return entry.resolvedChannelId;
    if (entry.localTarget) return entry.localTarget.id;

    const target = entry.searchTarget;
    if (!target) throw new Error(formatMessage({ id: "message.forwardComposer.destinationUnavailable" }));
    if (target.requiredAction === "join_channel") {
      if (!target.channelId) throw new Error(formatMessage({ id: "message.forwardComposer.destinationUnavailable" }));
      if (channelLocalMembership[target.channelId] === true) return target.channelId;
      const joined = await useChannelStore.getState().joinChannel(target.channelId);
      if (!joined) throw new Error(formatMessage({ id: "message.forwardComposer.joinDestinationFailed" }));
      return target.channelId;
    }
    if (target.requiredAction === "create_dm") {
      const dmChannel = target.type === "agent"
        ? await useChannelStore.getState().openDM(target.id)
        : await useChannelStore.getState().openUserDM(target.id);
      return dmChannel.id;
    }
    if (target.canForwardNow && target.channelId) return target.channelId;
    throw new Error(formatMessage({ id: "message.forwardComposer.destinationUnavailable" }));
  }, [channelLocalMembership, formatMessage]);

  const destinationChannel = useCallback((entry: SelectedDestination, channelId: string) => {
    const state = useChannelStore.getState();
    return state.channels.find((channel) => channel.id === channelId)
      ?? state.dmChannels.find((channel) => channel.id === channelId)
      ?? entry.localTarget
      ?? (entry.searchTarget ? fallbackDestination(entry.searchTarget, channelId) : null);
  }, []);

  const sendForwardNote = async (note: string) => {
    if (sending || !hasSelection || !joinReady) return;
    setSending(true);
    try {
      const resolutionResults = await Promise.allSettled(
        selectedEntries.map(async (entry) => ({ entry, channelId: await resolveDestination(entry) })),
      );
      const resolved = resolutionResults.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const resolutionFailureCount = resolutionResults.length - resolved.length;
      const entriesByChannelId = new Map<string, SelectedDestination[]>();
      const alreadySettledEntries: SelectedDestination[] = [];
      for (const item of resolved) {
        if (settledSuccessChannelIdsRef.current.has(item.channelId)) {
          alreadySettledEntries.push(item.entry);
          continue;
        }
        const entries = entriesByChannelId.get(item.channelId) ?? [];
        entries.push(item.entry);
        entriesByChannelId.set(item.channelId, entries);
      }

      if (alreadySettledEntries.length > 0) {
        setSelectedDestinations((current) => {
          const next = new Map(current);
          for (const entry of alreadySettledEntries) next.delete(entry.key);
          return next;
        });
      }

      if (entriesByChannelId.size === 0) {
        if (alreadySettledEntries.length > 0 && resolutionFailureCount === 0) {
          forwardToast.warning(formatMessage({ id: "message.forwardComposer.alreadyReceived" }));
          return;
        }
        const message = formatMessage({ id: "message.forwardComposer.destinationsUnavailable" });
        forwardToast.error(message);
        throw composerError(message);
      }

      let response: ForwardBatchResponse;
      try {
        forwardRequestIdRef.current ??= crypto.randomUUID();
        const res = await api.post<ForwardBatchResponse>("/messages/forward", {
          destinationChannelIds: [...entriesByChannelId.keys()],
          requestId: forwardRequestIdRef.current,
          sourceMessageIds: orderedSourceMessages.map((message) => message.id),
          note: note.trim(),
        });
        response = res.data;
      } catch (error) {
        setSelectedDestinations((current) => {
          const next = new Map(current);
          for (const entry of alreadySettledEntries) next.delete(entry.key);
          for (const [channelId, entries] of entriesByChannelId) {
            for (const entry of entries) next.set(entry.key, { ...entry, resolvedChannelId: channelId });
          }
          return next;
        });
        const failureMessage = forwardRequestFailureMessage(error, formatMessage);
        forwardToast.error(failureMessage);
        throw composerError(failureMessage);
      }

      const successIds = new Set<string>();
      const deliveries: ForwardDelivery[] = [];
      for (const result of response.results) {
        if (result.status !== "success") continue;
        const entry = entriesByChannelId.get(result.destinationChannelId)?.[0];
        if (!entry) continue;
        const destination = destinationChannel(entry, result.destinationChannelId);
        if (!destination) continue;
        successIds.add(result.destinationChannelId);
        deliveries.push({ message: result.message, destination });
      }
      for (const channelId of successIds) settledSuccessChannelIdsRef.current.add(channelId);

      setSelectedDestinations((current) => {
        const next = new Map(current);
        for (const [channelId, entries] of entriesByChannelId) {
          for (const entry of entries) {
            if (successIds.has(channelId)) next.delete(entry.key);
            else next.set(entry.key, { ...entry, resolvedChannelId: channelId });
          }
        }
        return next;
      });
      if (deliveries.length > 0) onSent(deliveries);

      const failedCanonicalCount = entriesByChannelId.size - successIds.size;
      const failureCount = failedCanonicalCount + resolutionFailureCount;
      if (failureCount === 0) {
        forwardRequestIdRef.current = null;
        settledSuccessChannelIdsRef.current.clear();
        if (deliveries.length === 1) {
          const delivery = deliveries[0]!;
          forwardToast.success(formatMessage(
            { id: "message.forwardComposer.forwardedToTarget" },
            { target: delivery.destination.type === "dm" ? "DM" : `#${delivery.destination.name}` },
          ), {
            action: {
              label: (
                <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                  {formatMessage({ id: "message.forwardComposer.viewInChat" })}
                  <ChevronRight aria-hidden="true" className="size-4" strokeWidth={2.5} />
                </span>
              ),
              onClick: () => {
                if (delivery.destination.type === "dm") nav.toDmMessage(delivery.destination.id, delivery.message.id);
                else nav.toMessage(delivery.destination.id, delivery.message.id);
              },
            },
          });
        } else {
          forwardToast.success(formatMessage(
            { id: "message.forwardComposer.forwardedToDestinations" },
            { count: deliveries.length },
          ));
        }
        closeComposer();
        return;
      }

      if (deliveries.length > 0) {
        forwardToast.warning(formatMessage(
          { id: "message.forwardComposer.partialForward" },
          { delivered: deliveries.length, failed: failureCount },
        ));
      } else {
        forwardToast.error(formatMessage(
          { id: "message.forwardComposer.forwardNone" },
          { count: failureCount },
        ));
      }
      throw composerError(formatMessage({ id: "message.forwardComposer.retryRemaining" }));
    } finally {
      setSending(false);
    }
  };

  const targetResults = (
    <ForwardComposerTargetList
      currentServerId={currentServerId}
      isSearchMode={isSearchMode}
      lowerQuery={lowerQuery}
      searchResults={searchResults}
      searchLoading={searchLoading}
      searchFailed={searchFailed}
      filteredTargets={filteredTargets}
      channelTargets={channelTargets}
      dmTargets={dmTargets}
      channelLocalMembership={channelLocalMembership}
      selectedDestinations={selectedDestinations}
      joinInFlight={joinInFlight}
      isMobile={isMobile}
      mobileMultiSelect={mobileMultiSelect}
      chooseDestination={chooseDestination}
      retrySearch={search}
    />
  );

  const warnings = (
    <ForwardComposerWarnings
      joinTargetCount={joinTargets.length}
      joinTargetSummary={joinTargetSummary}
      joinTargetTitle={joinTargetTitle}
      joinInFlight={joinInFlight}
      onJoin={() => { void joinSelectedChannels(); }}
      hasJointDestination={hasJointDestination}
      skippedCount={skippedCount}
      nestedForwardCount={nestedForwardCount}
      sourceIsThread={sourceChannel.type === "thread"}
    />
  );
  const openComposerAttachment = useCallback((snapshot: ForwardedBundleAttachmentSnapshot) => {
    if (!snapshot.id) return;
    const attachment: MessageAttachment = {
      id: snapshot.id,
      filename: snapshot.filename,
      mimeType: snapshot.mimeType || "application/octet-stream",
      sizeBytes: snapshot.sizeBytes ?? 0,
      width: snapshot.width ?? null,
      height: snapshot.height ?? null,
      thumbnailUrl: null,
      rasterPreviewUrl: null,
      localPreviewUrl: null,
    };
    if (isPreviewableImageAttachment(attachment)) {
      useImageLightboxStore.getState().open([attachment], 0);
      return;
    }
    // html / video / audio open the same shared previews the chat body uses.
    if (isHtmlPreviewAttachment(attachment)) {
      void openMediaPreview("html", attachment);
      return;
    }
    if (isPreviewableVideoAttachment(attachment)) {
      void openMediaPreview("video", attachment);
      return;
    }
    if (isPreviewableAudioAttachment(attachment)) {
      void openMediaPreview("audio", attachment);
      return;
    }
    if (isPreviewableDocumentAttachment(attachment)) {
      // No commentContext on purpose: a forward preview shows a snapshot, not
      // the original message, so there is no host to attribute comments to.
      void openDocumentPreview(attachment, { onFallbackDownload: downloadAttachmentById });
      return;
    }
    void downloadAttachmentById(attachment);
  }, []);

  if (isMobile) {
    return createPortal(
      <ForwardComposerMobile
        mobileStep={mobileStep}
        setMobileStep={setMobileStep}
        sourceMessages={sourceMessages}
        sourceLabelText={sourceLabelText}
        previewMetadata={previewMetadata}
        sending={sending}
        joinInFlight={joinInFlight}
        selectedDestinations={selectedDestinations}
        setSelectedDestinations={setSelectedDestinations}
        mobileMultiSelect={mobileMultiSelect}
        setMobileMultiSelect={setMobileMultiSelect}
        hasSelection={hasSelection}
        noteComposerChannelId={noteComposerChannelId}
        noteMentionChannelId={noteMentionScope.channelId}
        noteMentionScopeChannelType={noteMentionScope.channelType}
        submitDisabled={submitDisabled}
        submitDisabledReason={submitDisabledReason}
        warnings={warnings}
        targetResults={targetResults}
        query={query}
        setQuery={setQuery}
        search={search}
        resetSearch={resetSearch}
        openMobilePreview={openMobilePreview}
        openMobileDetail={openMobileDetail}
        onOpenAttachment={openComposerAttachment}
        sendForwardNote={sendForwardNote}
        onClose={closeComposer}
      />,
      document.body,
    );
  }
  return (
    <ForwardComposerDesktop
      onOpenAttachment={openComposerAttachment}
      sourceMessageCount={sourceMessages.length}
      sourceLabelText={sourceLabelText}
      onClose={closeComposer}
      sending={sending}
      joinInFlight={joinInFlight}
      query={query}
      setQuery={setQuery}
      search={search}
      resetSearch={resetSearch}
      selectedCount={selectedDestinations.size}
      clearSelection={() => setSelectedDestinations(new Map())}
      targetResults={targetResults}
      warnings={warnings}
      previewMetadata={previewMetadata}
      noteComposerChannelId={noteComposerChannelId}
      noteMentionChannelId={noteMentionScope.channelId}
      noteMentionScopeChannelType={noteMentionScope.channelType}
      submitDisabled={submitDisabled}
      submitDisabledReason={submitDisabledReason}
      sendForwardNote={sendForwardNote}
    />
  );
}
