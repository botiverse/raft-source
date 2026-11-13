import { useCallback, useRef } from "react";
import { useIntl } from "react-intl";
import { TextLink } from "@botiverse/raft-ui";
import { MessageIcon } from "@botiverse/ricons";
import { useTruncated } from "@botiverse/raft-ui/wip";
import type { ArtifactViewerData } from "@botiverse/raft-shared";

import { conversationLabel } from "./artifactHomeWords";
import Tooltip from "../../components/ui/Tooltip";
import { artifactShareHost } from "./artifactShareHost";
import type { ArtifactHostConversation } from "./artifactShareHost";

/**
 * A message glyph and "#general" (#proj-workspace:#72; #250: the glyph says
 * "from a message", so the sentence is only its accessible name, "From a
 * message in #general"): the Artifact's original message, in the header's
 * meta line after where it lives. A click opens
 * that message in its conversation (its thread for a reply) and highlights
 * it. `replace`: the message takes the place of the current history entry
 * (a phone, where the viewer is a page of its own); `onOpened` runs once the
 * navigation has happened (not while the unsaved channel-settings prompt
 * holds it, nor at all if that keeps the page). Truncated in a narrow meta
 * line, the name's `title` says it in full, only while it is cut.
 *
 * Only from the server's `origin` (null: no line), and only while the
 * reader's own channel list has that conversation, named as their sidebar
 * names it (a DM by the other person's display name); else no line, so it
 * never shows an id or a name from anywhere else (Tenny). The public page
 * has no `origin` and draws none.
 */
export default function ArtifactOriginLink({ origin, replace = false, onOpened }: {
  origin: ArtifactViewerData["origin"];
  replace?: boolean;
  onOpened?: () => void;
}) {
  const conversation = artifactShareHost().useConversation(origin?.conversationId ?? null);
  if (!origin || !conversation) return null;
  return <OriginLink origin={origin} conversation={conversation} replace={replace} onOpened={onOpened} />;
}

/** The line itself: only drawn with a conversation to name, so only then does it take the host's navigation. */
function OriginLink({ origin, conversation, replace, onOpened }: {
  origin: NonNullable<ArtifactViewerData["origin"]>;
  conversation: ArtifactHostConversation;
  replace: boolean;
  onOpened?: () => void;
}) {
  const { formatMessage } = useIntl();
  const openMessage = artifactShareHost().useOpenMessage();
  const open = useCallback(() => {
    openMessage({ conversationId: origin.conversationId, threadRootId: origin.threadRootId ?? null }, origin.messageId, { replace, onOpened });
  }, [origin, openMessage, replace, onOpened]);
  const name = conversationLabel(conversation);
  const label = formatMessage({ id: "artifacts.viewer.origin" }, { kind: conversation.type === "dm" ? "dm" : "conversation", name });
  const nameRef = useRef<HTMLSpanElement>(null);
  const cut = useTruncated(nameRef);
  return (
    <TextLink onClick={open} aria-label={label} className="inline-flex min-w-0 items-center gap-1" data-testid="artifact-origin-link">
      <MessageIcon aria-hidden className="size-[1em] shrink-0" />
      {/* The whole name on hover only where the link cuts it: raft-ui's Tooltip, held shut while the name fits (a native title is no DS tooltip). */}
      <Tooltip content={name} open={cut ? undefined : false}>
        <span ref={nameRef} className="min-w-0 truncate">{name}</span>
      </Tooltip>
    </TextLink>
  );
}
