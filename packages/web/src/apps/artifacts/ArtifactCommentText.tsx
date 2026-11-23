import { useMemo } from "react";
import { MessageReferenceText } from "@botiverse/raft-ui";
import type { ArtifactActor, ArtifactCommentPart } from "@botiverse/raft-shared";

import { MessageMarkdownText } from "../../components/message/MessageMarkdownText";
import type { MessageMarkdownTextPart } from "../../components/message/MessageMarkdownText";
import type { ArtifactViewerActor } from "./artifactApi";
import { actorKey, mentionToken } from "./artifactComments";
import { ArtifactSearchMarks } from "./ArtifactSearchMarks";

const NO_TERMS: readonly string[] = [];

// Apart from ArtifactActorParts on purpose: the message renderer reaches the app's stores as it
// loads, and that file's place names (anchorLabel, anchorQuote) are read where there is no browser.

/** A mention in a comment: the mention chip, the viewer's own in the primary style, the words searched for marked in it. */
function ArtifactMention({ actor, own, terms }: { actor: ArtifactActor; own: boolean; terms: readonly string[] }) {
  return (
    <MessageReferenceText variant={own ? "primary" : "secondary"} data-mention={actorKey(actor)}>
      <ArtifactSearchMarks text={mentionToken(actor)} terms={terms} />
    </MessageReferenceText>
  );
}

/**
 * A comment's text drawn as a message body is (#proj-workspace:#265, the
 * message renderer: Markdown, Raft references, links, the same security
 * rules), with its mentions drawn as mentions (ArtifactMention) where its
 * parts put them, never found again in the words. Block Markdown: not for a
 * one-line preview, which shows the words as written (draftExcerpt, shortQuote).
 *
 * `highlight`: the comment list's search words (artifactCommentSearch), marked where the text shows
 * them (the message renderer's search marks: in the words, link labels and code, not inside a ref
 * or a link's address) and in its mentions.
 */
export function ArtifactCommentText({ body, viewer, highlight = NO_TERMS }: {
  body: readonly ArtifactCommentPart[];
  viewer: ArtifactViewerActor | null;
  highlight?: readonly string[];
}) {
  const viewerKey = viewer ? actorKey(viewer) : null;
  const parts = useMemo(() => body.map((part): MessageMarkdownTextPart => (part.type === "text"
    ? part
    : { type: "inline", text: mentionToken(part.actor), node: <ArtifactMention actor={part.actor} own={actorKey(part.actor) === viewerKey} terms={highlight} /> })), [body, viewerKey, highlight]);
  // The words are folded and have no spaces: the renderer marks each, any case, as it marks a search's.
  return <MessageMarkdownText parts={parts} highlight={highlight.length > 0 ? highlight.join(" ") : undefined} />;
}
