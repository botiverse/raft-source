import { useCallback, useEffect, useMemo } from "react";
import type { ChannelId, MessageId } from "@botiverse/raft-shared";

import { setArtifactShareHost } from "../../apps/artifacts";
import type { ArtifactHostConversation, ArtifactMessagePlace, ArtifactOpenMessageOptions, ArtifactShareHost, ArtifactUploadLimitsHost } from "../../apps/artifacts";
import { deferredDialog } from "../../boot/deferredUi";
import { trackUploadLimitHit } from "../../analytics/paywall";
import { useServerStore } from "../../store/serverStore";
import { readMonthlyUploadQuota } from "../../utils/monthlyUploadQuota";
import { openUploadUpgrade, openUpgradeIfMonthUsedUp } from "../../utils/uploadUpgrade";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useChannelStore } from "../../store/channelStore";
import { findStoredChannel } from "../../store/storedChannel";
import type { Channel } from "../../store/channelStore";
import { useMessageStore } from "../../store/messageStore";

// Core's side of workspace Artifacts' "Send to conversation" (S5, F29): the
// Forward dialog, with the Artifact as what it forwards (#proj-workspace:#99).
// Also the viewer's original message (#proj-workspace:#72): its conversation
// as the reader's own list names it, and the way to it. The app draws the
// line and the Artifact's part of the dialog; it reads no core store itself
// (module boundary).

/** Loaded when first opened, as Forward is from a channel panel. */
const ForwardDialog = deferredDialog(() => import("./ArtifactForwardDialog"));
/** The public page's Send to conversation (#proj-workspace:#128): the same dialog, the link as what it sends. */
const LinkSendDialog = deferredDialog(() => import("./ArtifactLinkSendDialog").then((module) => ({ default: module.ArtifactLinkSendDialog })));

/** A conversation in the reader's own lists (the sidebar's): joined channels, the public ones listed, DMs, Lounges. */
function findConversation(state: Parameters<typeof findStoredChannel>[0], conversationId: string): Channel | undefined {
  return findStoredChannel(state, conversationId);
}

function useOpenMessage(): ReturnType<ArtifactShareHost["useOpenMessage"]> {
  const nav = useAppNavigate();
  return useCallback((at: ArtifactMessagePlace, messageId: MessageId, options?: ArtifactOpenMessageOptions) => {
    // The message route opens the conversation (or the thread) at the message and highlights it (`?msg=`).
    const dm = findConversation(useChannelStore.getState(), at.conversationId)?.type === "dm";
    const navOptions = options?.replace || options?.onOpened
      ? { ...(options.replace ? { replace: true } : {}), ...(options.onOpened ? { onNavigated: options.onOpened } : {}) }
      : undefined;
    if (at.threadRootId) nav.toThreadMessage(at.conversationId, at.threadRootId, messageId, dm ? "dm" : "channel", navOptions);
    else if (dm) nav.toDmMessage(at.conversationId, messageId, navOptions);
    else nav.toMessage(at.conversationId, messageId, navOptions);
  }, [nav]);
}

/** As the sidebar names it: a DM by the other person's display name, else their handle. */
function describe(channel: Channel): ArtifactHostConversation {
  if (channel.type === "dm") return { id: channel.id, name: channel.peerDisplayName || channel.peerName || channel.name, type: "dm" };
  return { id: channel.id, name: channel.name, type: channel.type === "private" ? "private" : "channel" };
}

function useConversation(conversationId: ChannelId | null): ArtifactHostConversation | null {
  const channel = useChannelStore((s) => (conversationId ? findConversation(s, conversationId) : undefined));
  const loading = useChannelStore((s) => s.loading);
  // A page outside the server layout (the Artifact's own page) has no list loaded yet: load the
  // sidebar's (coalesced with the layout's own first load, which is already out when it has one).
  useEffect(() => {
    if (!conversationId || !loading) return;
    void useChannelStore.getState().loadChannels();
    void useChannelStore.getState().loadDMChannels();
  }, [conversationId, loading]);
  return useMemo(() => (channel ? describe(channel) : null), [channel]);
}

function conversationOf(conversationId: string): ArtifactHostConversation | null {
  const channel = findConversation(useChannelStore.getState(), conversationId);
  return channel ? describe(channel) : null;
}

/**
 * Save as Artifact's copy counts against the monthly upload quota: it is an
 * upload entry like the composer's (a used-up month opens the upgrade dialog
 * instead), and a refusal for the quota on Free opens it too. Either way the
 * paywall is met on the `artifact` surface, so its checkout says so.
 */
const uploadLimits: ArtifactUploadLimitsHost = {
  openIfUsedUp: (sizeBytes) => openUpgradeIfMonthUsedUp("save_artifact", [sizeBytes]),
  quotaRefused: (details, file) => {
    const { billing, current } = useServerStore.getState();
    if ((billing?.plan || current?.plan || "free") !== "free") return false;
    const quota = readMonthlyUploadQuota(details);
    if (!quota) return false;
    trackUploadLimitHit({ limit: "monthly_quota", entry: "save_artifact", response: "upgrade_dialog", sizes: [file.sizeBytes] });
    openUploadUpgrade("upload_monthly_quota", { kind: "monthly_quota", quota, files: [{ name: file.name, size: file.sizeBytes }] }, "artifact");
    return true;
  },
};

/**
 * Fork in Raft's start for "Send to conversation"'s note (#proj-workspace:#140): written into the note's draft
 * as the dialog opens, before its note box mounts and reads the draft, and only into an empty one: a note the
 * reader already wrote there stays theirs.
 */
function startNote(draftKey: string, text: string): void {
  const { drafts, setDraft } = useMessageStore.getState();
  if (!(drafts[draftKey] ?? "").trim()) setDraft(draftKey, text);
}

export const coreArtifactShareHost: ArtifactShareHost = { ForwardDialog, LinkSendDialog, useOpenMessage, useConversation, conversationOf, uploadLimits, startNote };

/** Registered once, when the channel panel's module loads (ChatPanel imports this). */
export function installArtifactShareHost(): void {
  setArtifactShareHost(coreArtifactShareHost);
}
