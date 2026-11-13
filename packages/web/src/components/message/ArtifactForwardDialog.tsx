import { useEffect, useMemo } from "react";
import { asChannelId } from "@botiverse/raft-shared";

import { useArtifactForward } from "../../apps/artifacts";
import type { ArtifactForwardDialogProps, ArtifactForwardTarget } from "../../apps/artifacts";
import { useChannelStore } from "../../store/channelStore";
import { ForwardComposer, useForwardDestinations } from "./ForwardComposerDialog";
import type { ForwardSelection, ForwardSource } from "./forwardComposerModel";

/** A chosen destination as the app names it; a joint channel is a channel to the Artifact's events. */
function artifactTarget(selection: ForwardSelection, conversationId: string | null): ArtifactForwardTarget {
  return {
    key: selection.key,
    label: selection.label,
    conversationId: conversationId ? asChannelId(conversationId) : null,
    kind: selection.kind === "joint" ? "channel" : selection.kind,
  };
}

/**
 * "Send to conversation" for an Artifact (#proj-workspace:#99): the one
 * Forward dialog, with the Artifact (the app's useArtifactForward) as what
 * it forwards in place of messages. The destinations, the note and the
 * outcome are the dialog's, as for messages; the preview, who there can't
 * see it and the share calls are the app's.
 */
export default function ArtifactForwardDialog({ data, onClose, onShared, onStale }: ArtifactForwardDialogProps) {
  const destinations = useForwardDestinations();
  const channelActivity = useChannelStore((s) => s.channelActivity);
  const loading = useChannelStore((s) => s.loading);
  // Sent from the Artifact's own page, outside the server layout: no list is loaded yet, so load the
  // sidebar's (coalesced with the layout's own first load where there is one).
  useEffect(() => {
    if (!loading) return;
    void useChannelStore.getState().loadChannels();
    void useChannelStore.getState().loadDMChannels();
  }, [loading]);
  const targets = useMemo(
    () => destinations.selections.map((selection) => artifactTarget(selection, selection.channelId)),
    [destinations.selections],
  );
  const artifact = useArtifactForward({ data, onShared, onStale }, targets);
  const { title, sendLabel, preview, notices, blockedReason, draftKey, noteMaxLength, send: sendArtifact } = artifact;
  const source = useMemo((): ForwardSource => ({
    title,
    // The preview card names it and its version (#250).
    summary: null,
    sendLabel,
    detailTitle: null,
    renderPreview: () => preview,
    notices,
    blockedReason,
    warnsJoint: false,
    note: { draftKey, maxLength: noteMaxLength, plainText: true },
    send: async (resolved, note) => {
      const outcome = await sendArtifact(resolved.map((destination) => ({ ...artifactTarget(destination, destination.channelId), conversationId: asChannelId(destination.channelId) })), note);
      return {
        sent: outcome.sent.map((delivery) => ({ channelId: delivery.conversationId, messageId: delivery.messageId })),
        held: outcome.held,
      };
    },
  }), [title, sendLabel, preview, notices, blockedReason, draftKey, noteMaxLength, sendArtifact]);
  return <ForwardComposer source={source} destinations={destinations} channelActivity={channelActivity} onClose={onClose} />;
}
