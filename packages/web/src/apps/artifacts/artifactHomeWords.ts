import type { IntlShape } from "react-intl";
import type { ArtifactHome } from "@botiverse/raft-shared";

import type { ArtifactServerName } from "./artifactServerName";

/** Where an Artifact lives, in words: what its scope chip, the lists of cards and its links say of a home. */

/** "#proj-daemon-size", a DM by its peer ("Judith"), or the conversation's own name. */
export function conversationLabel(conversation: Extract<ArtifactHome, { kind: "conversation" }>["conversation"]): string {
  if (conversation.type === "dm") return conversationName(conversation);
  if (conversation.type === "channel" || conversation.type === "private") return `#${conversation.name}`;
  return conversation.name;
}

/** A conversation by the name the sidebar shows: a DM by its peer's display name, else the handle; any other by its name. */
export function conversationName(conversation: Extract<ArtifactHome, { kind: "conversation" }>["conversation"]): string {
  return conversation.peerDisplayName || conversation.name;
}

/**
 * Where it lives, in words: "#proj-daemon-size", "Direct message with cindyz",
 * "Everyone in Northwind Labs", "Anyone with the link". A bare "@cindyz" here
 * would read as the author. Another server's public Artifact read as an
 * outsider (the card's `fromAnotherServer`): "From another server", as its
 * chip says, naming no server (the chip's tooltip says who can see it). The lists' words (useArtifactHomeText)
 * and an icon-only chip's name.
 */
export function artifactHomeWords(formatMessage: IntlShape["formatMessage"], home: ArtifactHome, server: ArtifactServerName, fromAnotherServer = false): string {
  if (home.kind === "public" && fromAnotherServer) return formatMessage({ id: "artifacts.scope.publicFromAnotherServer" });
  if (home.kind !== "conversation") return formatMessage({ id: home.kind === "server" ? "artifacts.scope.server" : "artifacts.scope.public" }, server);
  if (home.conversation.type === "dm") return formatMessage({ id: "artifacts.dashboard.inDm" }, { name: conversationName(home.conversation) });
  return conversationLabel(home.conversation);
}
