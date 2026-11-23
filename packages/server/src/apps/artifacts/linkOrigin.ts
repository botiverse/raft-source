// An Artifact's original message from a link (`link`; README "Original
// message"): the registration's linkedInMessage (AppObjectKind), which core
// calls after a new ordinary message committed (services/firstPartyAppMessageLinks,
// never awaited by the send) with the ids its visible links name, as the
// message's cards read them (linkId: webCards.ts artifactIdOfLink).
//
// The message becomes the original message of each linked Artifact that has
// none yet, only when all of these hold:
// - the Artifact is live and lives in a conversation (home_kind
//   `conversation`, its channel not gone), of the server the message was
//   posted through;
// - the message is in that conversation, at its top level or in one of its
//   threads (platform/messages messageSource, as the author's server has it:
//   a joint's by that server's projection, which names either that
//   projection, as a save homes it, or the joint's canonical channel, as a
//   push does: platform/conversations conversationHome), and the author can
//   read it now;
// - the author can see the Artifact (canViewArtifacts);
// - it isn't the Artifact app's own message (a share, webShare.ts, records its
//   message as `share` itself).
// One conditional UPDATE (`WHERE origin_via IS NULL AND origin_message_id IS
// NULL`, the home rechecked), so of two messages racing the first to commit
// its update wins and the other changes nothing; once set it never moves, so
// an attachment's or a share's origin stays. Best effort: core logs a throw.
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { AppLinkingMessage } from "../../platform/apps";
import { conversationHome } from "../../platform/conversations";
import { getDb } from "../../platform/db";
import { messageSource } from "../../platform/messages";
import { artifactsEnabled } from "./apiCommon";
import { ARTIFACTS_APP_ID } from "./kinds";
import { artifactItems } from "./schema";
import { canViewArtifacts } from "./visibility";

/** linkedInMessage: the message is the original message (`link`) of the linked Artifacts in its conversation that have none. */
export async function recordLinkOrigins(message: AppLinkingMessage, ids: readonly string[]): Promise<void> {
  if (ids.length === 0 || message.postedByApp === ARTIFACTS_APP_ID) return;
  const homeless = and(isNull(artifactItems.originVia), isNull(artifactItems.originMessageId));
  const inConversation = and(eq(artifactItems.homeKind, "conversation"), isNotNull(artifactItems.homeChannelId), isNull(artifactItems.deletedAt), isNull(artifactItems.revokedAt));
  const candidates = await getDb().select().from(artifactItems)
    .where(and(inArray(artifactItems.id, [...ids]), eq(artifactItems.serverId, message.serverId), homeless, inConversation));
  if (candidates.length === 0 || !(await artifactsEnabled(message.serverId))) return;
  const author = { type: message.author.type, id: message.author.id, serverId: message.serverId };
  const source = await messageSource(author, message.id);
  if (!source) return;
  // The conversation as the author's server has it, and the home an object put there names (a joint's canonical channel).
  const homes = new Set([source.conversationId]);
  if (candidates.some((item) => item.homeChannelId !== source.conversationId)) {
    const home = await conversationHome(message.serverId, source.conversationId);
    if (home !== null) homes.add(home);
  }
  const inHome = candidates.filter((item) => item.homeChannelId !== null && homes.has(item.homeChannelId));
  if (inHome.length === 0) return;
  const sees = await canViewArtifacts(author, inHome);
  const linked = inHome.filter((_item, index) => sees[index]).map((item) => item.id);
  if (linked.length === 0) return;
  await getDb().update(artifactItems).set({ originMessageId: message.id, originVia: "link" })
    .where(and(inArray(artifactItems.id, linked), inArray(artifactItems.homeChannelId, [...homes]), homeless, inConversation));
}
