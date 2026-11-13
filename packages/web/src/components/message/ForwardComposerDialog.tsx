import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useIntl } from "react-intl";
import type { Channel } from "../../store/channelStore";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import type { Message } from "../../store/messageStore";
import { useMessageStore } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import api from "../../api/client";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useMediaQuery } from "../../hooks/effectPrimitives";
import ForwardedBundleCard from "./ForwardedBundleCard";
import type { ForwardedBundleMetadata } from "./ForwardedBundleCard";
import { openComposerAttachment } from "./openComposerAttachment";
import { forwardToast } from "./forwardToast";
import ForwardComposerTargetList from "./ForwardComposerTargetList";
import { channelLabel } from "../pickers/ChannelPicker";
import ForwardComposerMobile from "./ForwardComposerMobile";
import ForwardComposerWarnings, { ForwardSkippedNotice } from "./ForwardComposerWarnings";
import ForwardComposerDesktop from "./ForwardComposerDesktop";
import { useForwardConversationTargets } from "./useForwardConversationTargets";
import { forwardDeliveryLabel, forwardDeliveryOpener } from "./forwardViewInChat";
export { canForwardToTarget, getForwardTargets } from "./forwardComposerModel";
export type { ForwardDelivery } from "./forwardComposerModel";
import {
  MAX_FORWARD_DESTINATIONS,
  MAX_FORWARD_MESSAGES,
  canForwardToTarget,
  composerError,
  composerLabelVisibility,
  composerSourceLabel,
  fallbackDestination,
  forwardRequestFailureMessage,
  getForwardTargets,
  isConversationTarget,
  orderForwardSourceMessages,
  searchTargetChannelType,
  useForwardSearch,
} from "./forwardComposerModel";
import type {
  ForwardBatchResponse,
  ForwardDelivery,
  ForwardOutcome,
  ForwardPreviewPlace,
  ForwardResolved,
  ForwardSearchHandle,
  ForwardSelection,
  ForwardSource,
  JoinActionStatus,
  MobileForwardStep,
  SelectedDestination,
} from "./forwardComposerModel";

/** The Forward dialog's chosen destinations, kept by its host so the source can read them. */
export interface ForwardDestinations {
  selectedDestinations: Map<string, SelectedDestination>;
  setSelectedDestinations: Dispatch<SetStateAction<Map<string, SelectedDestination>>>;
  /** The same, as a source sees them. */
  selections: ForwardSelection[];
}

export function useForwardDestinations(): ForwardDestinations {
  const [selectedDestinations, setSelectedDestinations] = useState<Map<string, SelectedDestination>>(() => new Map());
  const channelLocalMembership = useChannelStore((state) => state.channelLocalMembership);
  const selections = useMemo(() => [...selectedDestinations.values()].map((entry): ForwardSelection => {
    const target = entry.searchTarget;
    const joinedNow = target?.requiredAction === "join_channel" && !!target.channelId && channelLocalMembership[target.channelId] === true;
    const ready = target && (joinedNow || (target.requiredAction === null && target.canForwardNow));
    const kind = entry.localTarget ? entry.localTarget.type : target ? searchTargetChannelType(target) : "channel";
    return {
      key: entry.key,
      label: entry.label,
      channelId: entry.resolvedChannelId ?? entry.localTarget?.id ?? (ready ? target.channelId : null),
      kind: kind === "thread" ? "channel" : kind,
      ...(target?.serverId ? { serverId: target.serverId } : {}),
    };
  }), [selectedDestinations, channelLocalMembership]);
  return { selectedDestinations, setSelectedDestinations, selections };
}

const NO_ACTIVITY: Record<string, string | null> = {};

/** Forwarding messages: the selected messages as one bundle, through POST /messages/forward. */
export default function ForwardComposerDialog({
  sourceMessages,
  sourceChannel,
  sourceLabel,
  sourceParentChannelId,
  channelActivity = NO_ACTIVITY,
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
  const destinations = useForwardDestinations();
  const source = useMessageForwardSource({ sourceMessages, sourceChannel, sourceLabel, sourceParentChannelId, skippedCount, nestedForwardCount, onSent });
  // Messages can go into a thread or a task discussion: the picker offers recent ones, the one it was opened from first.
  const conversations = useMemo(() => ({ currentChannelId: sourceChannel.type === "thread" ? sourceChannel.id : null }), [sourceChannel.type, sourceChannel.id]);
  return <ForwardComposer source={source} destinations={destinations} channelActivity={channelActivity} conversations={conversations} onClose={onClose} />;
}

function useMessageForwardSource({
  sourceMessages,
  sourceChannel,
  sourceLabel,
  sourceParentChannelId,
  skippedCount,
  nestedForwardCount,
  onSent,
}: {
  sourceMessages: Message[];
  sourceChannel: Channel;
  sourceLabel?: string;
  sourceParentChannelId?: string | null;
  skippedCount: number;
  nestedForwardCount: number;
  onSent: (deliveries: ForwardDelivery[]) => void;
}): ForwardSource {
  const { formatMessage } = useIntl();
  /** One request id for the attempt until every destination has it (a retry is the same forward). */
  const forwardRequestIdRef = useRef<string | null>(null);
  const sourceLabelText = sourceLabel ?? channelLabel(sourceChannel);
  const orderedSourceMessages = useMemo(
    () => orderForwardSourceMessages(sourceMessages, sourceChannel),
    [sourceMessages, sourceChannel],
  );
  const draftKey = useMemo(
    () => `forward-note:${sourceChannel.id}:${orderedSourceMessages.map((message) => message.id).join("|")}`,
    [orderedSourceMessages, sourceChannel.id],
  );
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

  const renderPreview = useCallback((place: ForwardPreviewPlace, openDetail: () => boolean) => (
    <ForwardedBundleCard
      metadata={previewMetadata}
      onOpenAttachment={openComposerAttachment}
      onShowAll={place === "phone" ? openDetail : undefined}
      forceExpanded={place === "detail"}
      fullWidth
    />
  ), [previewMetadata]);

  const send = useCallback(async (destinations: ForwardResolved[], note: string): Promise<ForwardOutcome> => {
    let response: ForwardBatchResponse;
    try {
      forwardRequestIdRef.current ??= crypto.randomUUID();
      const res = await api.post<ForwardBatchResponse>("/messages/forward", {
        destinationChannelIds: destinations.map((destination) => destination.channelId),
        requestId: forwardRequestIdRef.current,
        sourceMessageIds: orderedSourceMessages.map((message) => message.id),
        note: note.trim(),
      });
      response = res.data;
    } catch (error) {
      throw new Error(forwardRequestFailureMessage(error, formatMessage));
    }
    const byChannel = new Map(destinations.map((destination) => [destination.channelId, destination]));
    const deliveries: ForwardDelivery[] = [];
    for (const result of response.results) {
      if (result.status !== "success") continue;
      const destination = byChannel.get(result.destinationChannelId);
      if (destination) deliveries.push({ message: result.message, destination: destination.destination });
    }
    if (deliveries.length === destinations.length) forwardRequestIdRef.current = null;
    if (deliveries.length > 0) onSent(deliveries);
    return {
      sent: deliveries.map((delivery) => ({ channelId: delivery.destination.id, messageId: delivery.message.id, context: delivery.message.conversationContext })),
      held: null,
    };
  }, [orderedSourceMessages, formatMessage, onSent]);

  return useMemo(() => ({
    title: formatMessage({ id: "message.forwardComposer.title" }),
    summary: formatMessage({ id: "message.forwardComposer.selectedFrom" }, { count: sourceMessages.length, source: sourceLabelText }),
    sendLabel: formatMessage({ id: "message.forwardComposer.sendForward" }),
    detailTitle: formatMessage({ id: "message.forwardComposer.forwardedMessages" }),
    renderPreview,
    notices: <ForwardSkippedNotice skippedCount={skippedCount} nestedForwardCount={nestedForwardCount} sourceIsThread={sourceChannel.type === "thread"} />,
    // More than the Server takes: say so before sending (it refuses with too_many_messages).
    blockedReason: sourceMessages.length === 0
      ? formatMessage({ id: "message.forwardComposer.noMessagesSelected" })
      : sourceMessages.length > MAX_FORWARD_MESSAGES
        ? formatMessage({ id: "message.forwardComposer.tooManyMessages" }, { max: MAX_FORWARD_MESSAGES })
        : null,
    warnsJoint: true,
    note: { draftKey, maxLength: 4000, plainText: false },
    send,
  }), [formatMessage, sourceMessages.length, sourceLabelText, renderPreview, skippedCount, nestedForwardCount, sourceChannel.type, draftKey, send]);
}

/**
 * The one Forward dialog (desktop two columns, phone pages): destinations
 * (recent, search, several at once, joining a channel, a new DM), the
 * source's preview and notices, an optional note whose send delivers it,
 * and the outcome. What is forwarded and how it is delivered is the source's.
 * `scope`: above the destinations' search (the server they are in, where the
 * host offers a choice of server); given `busy` (a send or a join is out), as
 * the choice must wait for it. `search`: the destinations' search, where
 * the host has its own (across servers); default, the current server's.
 * `conversations`: threads and task discussions are destinations too (a
 * "Threads & tasks" group above Recent, and their search rows), the one the
 * dialog was opened from first; absent, they are not offered.
 */
export function ForwardComposer({
  source,
  destinations,
  channelActivity = NO_ACTIVITY,
  scope,
  search: injectedSearch,
  conversations,
  onClose,
}: {
  source: ForwardSource;
  destinations: ForwardDestinations;
  channelActivity?: Record<string, string | null>;
  scope?: (state: { busy: boolean }) => ReactNode;
  search?: ForwardSearchHandle;
  conversations?: { currentChannelId: string | null };
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const { selectedDestinations, setSelectedDestinations } = destinations;
  const [sending, setSending] = useState(false);
  const [joinAction, setJoinAction] = useState<{ signature: string; status: JoinActionStatus }>({
    signature: "",
    status: "idle",
  });
  const [mobileStep, setMobileStep] = useState<MobileForwardStep>("targets");
  const [mobileMultiSelect, setMobileMultiSelect] = useState(false);
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
  const ownSearch = useForwardSearch();
  const conversationTargets = useForwardConversationTargets({ enabled: !!conversations, currentChannelId: conversations?.currentChannelId ?? null });
  const {
    results: allSearchResults,
    loading: searchLoading,
    failed: searchFailed,
    search,
    reset: resetSearch,
  } = injectedSearch ?? ownSearch;
  const searchPartialFailure = injectedSearch?.partialFailure ?? null;
  const searchResults = useMemo(
    () => conversations ? allSearchResults : allSearchResults.filter((target) => !isConversationTarget(target)),
    [allSearchResults, conversations],
  );
  const selectedEntries = useMemo(() => [...selectedDestinations.values()], [selectedDestinations]);
  const noteMentionScope = useMemo(() => {
    // Multi-destination notes intentionally avoid channel-member rosters. MessageInput
    // adds member results unconditionally, so privacy depends on this undefined scoped
    // id plus its useChannelMembers channel-id guard returning an empty roster.
    if (selectedEntries.length !== 1 || source.note.plainText) {
      return { channelId: undefined, channelType: null };
    }
    const entry = selectedEntries[0]!;
    const target = entry.searchTarget;
    // A thread / task discussion's mentions resolve against its parent channel, as a reply composer's do.
    if (target && isConversationTarget(target)) {
      return { channelId: target.parentChannelId ?? undefined, channelType: target.parentChannelType ?? null };
    }
    return {
      channelId: entry.resolvedChannelId ?? entry.localTarget?.id ?? target?.channelId ?? undefined,
      channelType: entry.localTarget?.type ?? (target?.channelType === "thread" || target?.channelType === "task" ? null : target?.channelType) ?? null,
    };
  }, [selectedEntries, source.note.plainText]);
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
  const scopeNode = scope?.({ busy: sending || joinInFlight });
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

  const draftKey = source.note.draftKey;
  const closeComposer = useCallback(() => {
    useMessageStore.getState().clearDraft(draftKey);
    onClose();
  }, [draftKey, onClose]);

  const filteredTargets = useMemo(() => {
    return getForwardTargets(channelTargets, dmTargets, lowerQuery, channelActivity);
  }, [channelTargets, dmTargets, lowerQuery, channelActivity]);

  const hasSelection = selectedEntries.length > 0;
  const submitDisabledReason = !hasSelection
    ? formatMessage({ id: "message.forwardComposer.selectTargetFirst" })
    : !joinReady
      ? formatMessage({ id: "message.forwardComposer.joinSelectedFirst" })
      : source.blockedReason;
  const submitDisabled = submitDisabledReason !== null || sending;
  const hasJointDestination = source.warnsJoint && selectedEntries.some((entry) => (
    entry.localTarget?.type === "joint" || entry.searchTarget?.channelType === "joint" || entry.searchTarget?.parentChannelType === "joint"
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
  }, [setSelectedDestinations]);

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
  }, [isMobile, joinInFlight, mobileMultiSelect, openMobilePreview, toggleDestination, setSelectedDestinations]);

  const joinSelectedChannels = useCallback(async () => {
    if (joinAttemptRef.current || joinTargets.length === 0) return;
    const attemptSignature = joinSignature;
    joinAttemptRef.current = true;
    setJoinAction({ signature: attemptSignature, status: "joining" });
    try {
      const results = await Promise.allSettled(joinTargets.map(async (entry) => {
        const channelId = entry.searchTarget?.channelId;
        if (!channelId) throw new Error(formatMessage({ id: "message.forwardComposer.destinationUnavailable" }));
        const joined = await useChannelStore.getState().joinChannel(channelId, "forward");
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
  }, [formatMessage, joinSignature, joinTargets, setSelectedDestinations]);

  const handleJoinSelectedChannels = useCallback(() => {
    void joinSelectedChannels();
  }, [joinSelectedChannels]);
  const handleClearSelection = useCallback(() => setSelectedDestinations(new Map()), [setSelectedDestinations]);
  const resolveDestination = useCallback(async (entry: SelectedDestination) => {
    if (entry.resolvedChannelId) return entry.resolvedChannelId;
    if (entry.localTarget) return entry.localTarget.id;

    const target = entry.searchTarget;
    if (!target) throw new Error(formatMessage({ id: "message.forwardComposer.destinationUnavailable" }));
    if (target.requiredAction === "join_channel") {
      if (!target.channelId) throw new Error(formatMessage({ id: "message.forwardComposer.destinationUnavailable" }));
      if (channelLocalMembership[target.channelId] === true) return target.channelId;
      const joined = await useChannelStore.getState().joinChannel(target.channelId, "forward");
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
    return findStoredChannel(state, channelId)
      ?? entry.localTarget
      ?? (entry.searchTarget ? fallbackDestination(entry.searchTarget, channelId) : null);
  }, []);

  const selectionByKey = useMemo(
    () => new Map(destinations.selections.map((selection) => [selection.key, selection])),
    [destinations.selections],
  );

  const sendForwardNote = useCallback(async (note: string) => {
    if (sending || !hasSelection || !joinReady || source.blockedReason !== null) return;
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

      const toSend: ForwardResolved[] = [];
      for (const [channelId, entries] of entriesByChannelId) {
        const entry = entries[0]!;
        const destination = destinationChannel(entry, channelId);
        const selection = selectionByKey.get(entry.key);
        if (!destination || !selection) continue;
        toSend.push({ ...selection, channelId, destination });
      }
      const keepResolved = () => setSelectedDestinations((current) => {
        const next = new Map(current);
        for (const entry of alreadySettledEntries) next.delete(entry.key);
        for (const [channelId, entries] of entriesByChannelId) {
          for (const entry of entries) next.set(entry.key, { ...entry, resolvedChannelId: channelId });
        }
        return next;
      });

      let outcome: ForwardOutcome;
      try {
        outcome = await source.send(toSend, note);
      } catch (error) {
        keepResolved();
        const failureMessage = error instanceof Error ? error.message : formatMessage({ id: "message.forwardComposer.uncertainOutcome" });
        forwardToast.error(failureMessage);
        throw composerError(failureMessage);
      }

      const { sent, held } = outcome;
      const heldIds = new Set(held?.channelIds ?? []);
      const successIds = new Set(sent.map((delivery) => delivery.channelId));
      const deliveries = toSend.flatMap((destination) => {
        const delivery = sent.find((item) => item.channelId === destination.channelId);
        return delivery ? [{
          destination: destination.destination,
          messageId: delivery.messageId,
          serverId: delivery.serverId,
          context: delivery.context,
          target: selectedDestinations.get(destination.key)?.searchTarget,
        }] : [];
      });
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

      const failedCanonicalCount = entriesByChannelId.size - successIds.size - [...heldIds].filter((id) => !successIds.has(id)).length;
      const failureCount = failedCanonicalCount + resolutionFailureCount;
      if (failureCount === 0 && held && deliveries.length < toSend.length) {
        // Held back for the person to decide, nothing failed: what went is said, the dialog stays with
        // the held ones chosen, and the note is kept (the composer's line says why).
        if (deliveries.length > 0) {
          forwardToast.success(formatMessage(
            { id: "message.forwardComposer.forwardedToDestinations" },
            { count: deliveries.length },
          ));
        }
        throw composerError(held.message);
      }
      if (failureCount === 0) {
        settledSuccessChannelIdsRef.current.clear();
        if (deliveries.length === 1) {
          const delivery = deliveries[0]!;
          // Another server's conversation: the toast says where, without the way there (the app's routes are the current server's).
          const elsewhere = !!delivery.serverId && delivery.serverId !== useServerStore.getState().current?.id;
          // A thread or task discussion opens as one: its thread on the message, or the task's conversation.
          const open = elsewhere ? null : forwardDeliveryOpener(nav, delivery);
          forwardToast.success(formatMessage(
            { id: "message.forwardComposer.forwardedToTarget" },
            { target: forwardDeliveryLabel(delivery) },
          ), open ? {
            // DS Toast: the action is underlined text, no glyph.
            action: { label: formatMessage({ id: "message.forwardComposer.viewInChat" }), onClick: open },
          } : undefined);
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
  }, [sending, hasSelection, joinReady, source, selectedEntries, selectedDestinations, resolveDestination, setSelectedDestinations, formatMessage, destinationChannel, selectionByKey, nav, closeComposer]);

  const targetResults = (
    <ForwardComposerTargetList
      currentServerId={currentServerId}
      isSearchMode={isSearchMode}
      lowerQuery={lowerQuery}
      searchResults={searchResults}
      conversationTargets={conversationTargets}
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
      searchPartialFailure={searchPartialFailure}
    />
  );

  const warnings = (
    <>
      <ForwardComposerWarnings
        joinTargetCount={joinTargets.length}
        joinTargetSummary={joinTargetSummary}
        joinTargetTitle={joinTargetTitle}
        joinInFlight={joinInFlight}
        onJoin={handleJoinSelectedChannels}
        hasJointDestination={hasJointDestination}
      />
      {source.notices}
    </>
  );

  if (isMobile) {
    return createPortal(
      <ForwardComposerMobile
        mobileStep={mobileStep}
        setMobileStep={setMobileStep}
        source={source}
        sending={sending}
        joinInFlight={joinInFlight}
        selectedDestinations={selectedDestinations}
        setSelectedDestinations={setSelectedDestinations}
        mobileMultiSelect={mobileMultiSelect}
        setMobileMultiSelect={setMobileMultiSelect}
        hasSelection={hasSelection}
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
        sendForwardNote={sendForwardNote}
        scope={scopeNode}
        hasConversationGroup={conversationTargets.length > 0}
        onClose={closeComposer}
      />,
      document.body,
    );
  }
  return (
    <ForwardComposerDesktop
      source={source}
      onClose={closeComposer}
      sending={sending}
      joinInFlight={joinInFlight}
      query={query}
      setQuery={setQuery}
      search={search}
      resetSearch={resetSearch}
      selectedCount={selectedDestinations.size}
      clearSelection={handleClearSelection}
      targetResults={targetResults}
      warnings={warnings}
      openDetail={openMobileDetail}
      noteMentionChannelId={noteMentionScope.channelId}
      noteMentionScopeChannelType={noteMentionScope.channelType}
      submitDisabled={submitDisabled}
      submitDisabledReason={submitDisabledReason}
      sendForwardNote={sendForwardNote}
      scope={scopeNode}
    />
  );
}
