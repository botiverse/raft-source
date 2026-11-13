import { useMemo } from "react";
import { MessageReferenceText } from "@botiverse/raft-ui";
import type { ArtifactActor, ArtifactCommentPart } from "@botiverse/raft-shared";

import { MessageMarkdownText } from "../../components/message/MessageMarkdownText";
import type { MessageMarkdownTextPart } from "../../components/message/MessageMarkdownText";
import type { ArtifactViewerActor } from "./artifactApi";
import { actorKey, mentionToken } from "./artifactComments";

// Apart from ArtifactActorParts on purpose: the message renderer reaches the app's stores as it
// loads, and that file's place names (anchorLabel, anchorQuote) are read where there is no browser.

/** A mention in a comment: the mention chip, the viewer's own in the primary style. */
function ArtifactMention({ actor, own }: { actor: ArtifactActor; own: boolean }) {
  return (
    <MessageReferenceText variant={own ? "primary" : "secondary"} data-mention={actorKey(actor)}>
      {mentionToken(actor)}
    </MessageReferenceText>
  );
}

/**
 * A comment's text drawn as a message body is (#proj-workspace:#265, the
 * message renderer: Markdown, Raft references, links, the same security
 * rules), with its mentions drawn as mentions (ArtifactMention) where its
 * parts put them, never found again in the words. Block Markdown: not for a
 * one-line preview, which shows the words as written (draftExcerpt, shortQuote).
 */
export function ArtifactCommentText({ body, viewer }: { body: readonly ArtifactCommentPart[]; viewer: ArtifactViewerActor | null }) {
  const viewerKey = viewer ? actorKey(viewer) : null;
  const parts = useMemo(() => body.map((part): MessageMarkdownTextPart => (part.type === "text"
    ? part
    : { type: "inline", text: mentionToken(part.actor), node: <ArtifactMention actor={part.actor} own={actorKey(part.actor) === viewerKey} /> })), [body, viewerKey]);
  return <MessageMarkdownText parts={parts} />;
}
