import type { ComponentType, ReactNode } from "react";
import type { ArtifactHome, ArtifactId, ArtifactViewerData, ChannelId, MessageId } from "@botiverse/raft-shared";

/**
 * A conversation chosen in the Forward dialog to send an Artifact to (F21,
 * #proj-workspace:#99). Core's dialog picks them from its own stores; the app
 * never reads those itself (the module boundary).
 */
export interface ArtifactForwardTarget {
  /** Unique among the chosen. */
  key: string;
  /** What the dialog calls it: `#general`, `@artin`. */
  label: string;
  /** Null until known: a new DM, or a channel to join first, has none before the send. */
  conversationId: ChannelId | null;
  kind: "channel" | "private" | "dm";
}

/** What the viewer hands core's Forward dialog for one Artifact. */
export interface ArtifactForwardDialogProps {
  data: ArtifactViewerData;
  onClose: () => void;
  /** After a send that moved it first: where it lives now. */
  onShared: (home: ArtifactHome) => void;
  /** A refusal saying the shown home or who may move it is out of date: the viewer reads it again. */
  onStale: () => void;
}

/**
 * What the public page (PublicArtifactPage, a signed-in reader) hands core's
 * dialog for "Send to conversation" (#proj-workspace:#128): an ordinary
 * message whose text is the Artifact's link, which the app draws as its card.
 * Core picks the server and the conversations; the app draws the preview.
 */
export interface ArtifactLinkSendDialogProps {
  /** The Artifact's canonical link (artifactUrl): the message's text. */
  link: string;
  /** What is about to be sent, as the app draws it. Not a way in. */
  preview: ReactNode;
  onClose: () => void;
}

/** A conversation as the reader's own channel list (the sidebar's) names it: a DM by the other person's display name. */
export interface ArtifactHostConversation {
  id: string;
  name: string;
  type: "channel" | "private" | "dm";
}

/** Where a message is: its conversation, and its thread's root when it is a reply in one. */
export interface ArtifactMessagePlace {
  conversationId: ChannelId;
  /** Set for a reply in a thread: its root message, in `conversationId`. */
  threadRootId: MessageId | null;
}

export interface ArtifactOpenMessageOptions {
  replace?: boolean;
  onOpened?: () => void;
}

/**
 * The server's monthly upload quota as it bears on Save as Artifact, whose
 * copy counts against it as an upload does. Core owns the quota, the upgrade
 * dialog and the analytics; the app only asks (the module boundary).
 */
export interface ArtifactUploadLimitsHost {
  /**
   * Before a save of a file this big: true, having opened the upgrade dialog,
   * when the month's uploads are used up, so the save doesn't start.
   */
  openIfUsedUp: (sizeBytes: number) => boolean;
  /**
   * A save the server refused for the quota (FILE_UPLOAD_QUOTA_EXCEEDED, its
   * details' `quota`): true, having opened the upgrade dialog, when that is the
   * answer (a Free server); false leaves the failure line to say it.
   */
  quotaRefused: (quota: unknown, file: { name: string; sizeBytes: number }) => boolean;
}

/** What the host (core) does for "Send to conversation" and the viewer's original message. */
export interface ArtifactShareHost {
  /**
   * "Send to conversation": core's Forward dialog with this Artifact as what
   * is forwarded (the app's useArtifactForward), one dialog for messages and
   * Artifacts. Rendered while open.
   */
  ForwardDialog: ComponentType<ArtifactForwardDialogProps>;
  /**
   * "Send to conversation" on the public page: core's Forward dialog with the
   * link as what is sent, in a server of the reader's (they may be in
   * several). Rendered while open. Absent: the page doesn't offer it.
   */
  LinkSendDialog?: ComponentType<ArtifactLinkSendDialogProps>;
  /**
   * A hook: opens a message in its conversation (or its thread) and
   * highlights it, as a message link does: the toast's View, the viewer's
   * original message. `replace`: in place of the current history entry.
   * `onOpened`: once the navigation has happened (at once, or after the
   * unsaved channel-settings prompt lets it go; never if that keeps the page).
   */
  useOpenMessage: () => (at: ArtifactMessagePlace, messageId: MessageId, options?: ArtifactOpenMessageOptions) => void;
  /**
   * A hook: the conversation as the reader's own channel list has it, null
   * while it isn't there (not loaded yet, or not the reader's). Never a name
   * from anywhere else.
   */
  useConversation: (conversationId: ChannelId | null) => ArtifactHostConversation | null;
  /** The conversation a message is in, for saving its attachment (the fake names the home from it). */
  conversationOf: (conversationId: string) => ArtifactHostConversation | null;
  /** The upload quota for Save as Artifact; absent: no limit is acted on here (the server still refuses). */
  uploadLimits?: ArtifactUploadLimitsHost;
  /**
   * Puts `text` in a dialog note's draft (`draftKey`) when it has none, just
   * before the dialog opens: Fork in Raft starts "Send to conversation"'s note
   * so (#proj-workspace:#140). The note box reads its draft once, as it
   * mounts, so the start must be there first; the reader may change it. Absent:
   * the note starts as its draft is.
   */
  startNote?: (draftKey: string, text: string) => void;
}

/** The draft key of the note in the viewer's "Send to conversation" (core's Forward dialog with the Artifact). */
export function artifactShareNoteKey(id: ArtifactId): string {
  return `artifact-share-note:${id}`;
}

/** The draft key of the note in the public page's "Send to conversation" (the Artifact's link as what it sends). */
export function artifactLinkSendNoteKey(link: string): string {
  return `artifact-link-send-note:${link}`;
}

const NoForwardDialog = () => null;
const noOpen = () => () => {};

const emptyHost: ArtifactShareHost = { ForwardDialog: NoForwardDialog, useOpenMessage: noOpen, useConversation: () => null, conversationOf: () => null };

let host: ArtifactShareHost = emptyHost;

/**
 * Core registers its host once, at load, before anything renders (the
 * hooks must stay the same functions for the life of the app). Tests set
 * their own; null puts back the empty one.
 */
export function setArtifactShareHost(next: ArtifactShareHost | null): void {
  host = next ?? emptyHost;
}

export function artifactShareHost(): ArtifactShareHost {
  return host;
}
