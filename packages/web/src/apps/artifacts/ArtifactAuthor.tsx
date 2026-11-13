import { useIntl } from "react-intl";
import type { ArtifactShownActor } from "@botiverse/raft-shared";

import { ArtifactActorAvatar } from "./ArtifactActorParts";
import { artifactAuthorText } from "./artifactAuthorText";

/**
 * Who made an Artifact, as every card and row of the home page names it
 * (#proj-workspace:#133, design D17): the avatar and the name; the reader's own
 * as "You"; a personal assistant's as the assistant with whom it worked for,
 * "Ottie for you", "Friday for Remy" (ArtifactActor `onBehalfOf`, #12881).
 */

/** The avatar and the name, one line (`wrap`: the "for …" may go to a second line rather than be cut). */
export function ArtifactAuthor({ actor, readerId, wrap = false, className }: { actor: ArtifactShownActor; readerId: string | null; wrap?: boolean; className?: string }) {
  const { formatMessage } = useIntl();
  const text = artifactAuthorText(actor, readerId, formatMessage);
  return (
    <span className={`flex min-w-0 items-center gap-1.5 ${className ?? ""}`} data-testid="artifacts-author">
      <ArtifactActorAvatar actor={actor} context="creator-link" className="shrink-0" />
      <span className={`min-w-0 text-footnote text-foreground ${wrap ? "break-words" : "truncate"}`} data-testid="artifacts-author-text">
        <span data-testid="artifacts-author-name">{text.name}</span>
        {text.behalf ? <span className="ml-1 text-foreground-muted" data-testid="artifacts-author-behalf">{text.behalf}</span> : null}
      </span>
    </span>
  );
}
