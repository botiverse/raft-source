import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";

import api from "../../api/client";
import { artifactRealtimeStandIn } from "../../apps/artifacts";
import { readServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useMessageStore } from "../../store/messageStore";
import type { Message } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import { buildThreadParentContextRequest } from "./messageContextRequest";

// Workspace Artifacts S5 (Remy): after an attachment is saved as an Artifact
// the server broadcasts `artifact:attachment-saved { channelId, messageId,
// attachmentId }` to the channel, with no Artifact id or title (who may see
// it differs per person). Each client refetches that one message, and the
// server computes `savedAsArtifact` for that viewer.

export interface ArtifactAttachmentSavedEvent {
  channelId: string;
  messageId: string;
  attachmentId: string;
}

export function readArtifactAttachmentSavedEvent(payload: unknown): ArtifactAttachmentSavedEvent | null {
  if (!payload || typeof payload !== "object") return null;
  const { channelId, messageId, attachmentId } = payload as Record<string, unknown>;
  if (typeof channelId !== "string" || typeof messageId !== "string" || typeof attachmentId !== "string") return null;
  return { channelId, messageId, attachmentId };
}

function cachedMessage(channelId: string, messageId: string): Message | undefined {
  const state = useMessageStore.getState();
  return (state.channelMessages[channelId] ?? []).find((m) => m.id === messageId) ?? state.messages.find((m) => m.id === messageId);
}

/**
 * Refetches the message an `artifact:attachment-saved` names, if it is
 * loaded here and workspace_artifacts_v0 is on, and merges it into the
 * message store. With the fake data source there is no server to ask: the
 * stand-in answers `savedAsArtifact` for the message's attachments.
 */
export async function handleArtifactAttachmentSaved(payload: unknown): Promise<void> {
  const event = readArtifactAttachmentSavedEvent(payload);
  if (!event) return;
  if (!readServerFeatureFlag(useServerStore.getState().current?.id, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY)) return;
  const cached = cachedMessage(event.channelId, event.messageId);
  // Not loaded here: whoever loads it later gets it with `savedAsArtifact`.
  if (!cached) return;
  if (artifactRealtimeStandIn.active()) {
    useMessageStore.getState().updateMessage({
      id: cached.id,
      channelId: cached.channelId,
      attachments: (cached.attachments ?? []).map((attachment) => (
        attachment.id === event.attachmentId ? { ...attachment, savedAsArtifact: artifactRealtimeStandIn.savedAsFor(attachment.id) } : attachment
      )),
    });
    return;
  }
  // One read per message at a time; an event during it asks for one more after.
  const running = inFlight.get(event.messageId);
  if (running) {
    running.again = true;
    return running.done;
  }
  const state: { again: boolean; done: Promise<void> } = { again: false, done: Promise.resolve() };
  inFlight.set(event.messageId, state);
  state.done = (async () => {
    try {
      do {
        state.again = false;
        await refetchSavedAs(event.channelId, event.messageId);
      } while (state.again);
    } finally {
      inFlight.delete(event.messageId);
    }
  })();
  return state.done;
}

/** Refetches in flight, per message id. */
const inFlight = new Map<string, { again: boolean; done: Promise<void> }>();

/**
 * Reads the message once (the thread parent's single-message read: no
 * surrounding window) and merges only its attachments' `savedAsArtifact`
 * into the stored message as it is now: the rest of the read can be older
 * than socket updates that arrived meanwhile (reactions, edits, replies).
 */
async function refetchSavedAs(channelId: string, messageId: string): Promise<void> {
  const request = buildThreadParentContextRequest(messageId, channelId);
  let fresh: Message | undefined;
  try {
    const { data } = await api.get<{ messages?: Message[] }>(request.url, request.config);
    fresh = data.messages?.find((m) => m.id === messageId);
  } catch {
    // Best effort: the next load of the message carries it.
    return;
  }
  const current = cachedMessage(channelId, messageId);
  if (!fresh || !current) return;
  const savedAs = new Map((fresh.attachments ?? []).map((a) => [a.id, a.savedAsArtifact]));
  useMessageStore.getState().updateMessage({
    id: current.id,
    channelId: current.channelId,
    attachments: (current.attachments ?? []).map((attachment) => (
      savedAs.has(attachment.id) ? { ...attachment, savedAsArtifact: savedAs.get(attachment.id) ?? null } : attachment
    )),
  });
}

/** The fake data source's stand-in for the broadcast; a no-op once the API source is in. */
export function installArtifactAttachmentSavedStandIn(): () => void {
  return artifactRealtimeStandIn.onAttachmentSaved((event) => { void handleArtifactAttachmentSaved(event); });
}
