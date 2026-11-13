import { MessageEmbed, MessageEmbedHeader, messageCard } from "@botiverse/raft-ui";

import { ArtifactVersionBadge } from "./ArtifactMessageCard";

/**
 * What "Send to conversation" on the public page is about to send
 * (#proj-workspace:#128): the Artifact's title and version, and the link that
 * is the message's text (the conversation draws it as the Artifact's card).
 * The public page has the public view only, not a card, so this is the
 * card's frame (raft-ui MessageEmbed) with what it has. Not a way in: nothing
 * on it opens or takes focus, as the Forward dialog's preview of a card.
 */
export function PublicArtifactSendPreview({ title, version, link }: { title: string; version: number; link: string }) {
  return (
    <MessageEmbed size="item" data-testid="public-artifact-send-preview">
      <MessageEmbedHeader className="grid min-w-0 gap-1">
        <div className="flex min-w-0 items-start gap-2">
          <p className={messageCard().title({ className: "min-w-0 break-words" })}>{title}</p>
          <span className="pt-px"><ArtifactVersionBadge version={version} /></span>
        </div>
        <p className="truncate font-mono text-mono-meta text-foreground-hint" data-testid="public-artifact-send-link">{link}</p>
      </MessageEmbedHeader>
    </MessageEmbed>
  );
}
