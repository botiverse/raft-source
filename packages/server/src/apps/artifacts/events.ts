// Recording events on an Artifact (first-party app mechanism §三; the kind
// and its event kinds are kinds.ts): recordArtifactEvent is the one way this
// module records one, in the transaction of the change, with the Artifact's
// home after it and whom the event is for (only those who can see it).
import { WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import type { DatabaseExecutor } from "../../platform/db";
import { recordObjectEvent, type ObjectEventInput, type ObjectEventRecipient } from "../../platform/objects";
import { jointViewersOf } from "../../platform/visibility";
import type { ArtifactActorRef } from "./apiCommon";
import { ARTIFACT_OBJECT_KIND, type ArtifactObjectEvent } from "./kinds";
import type { ArtifactItemRow } from "./schema";
import { actorsWhoCanViewArtifact, type ArtifactVisibilitySubject } from "./visibility";

export type ArtifactEventRecipient = ObjectEventRecipient;

/** An Artifact's home as object events record it (a conversation home without its conversation: an orphan). */
export function artifactHome(item: Pick<ArtifactItemRow, "serverId" | "homeKind" | "homeChannelId">): ObjectEventInput["home"] {
  switch (item.homeKind) {
    case "conversation": return { kind: "conversation", channelId: item.homeChannelId };
    case "server": return { kind: "server", serverId: item.serverId };
    case "public": return { kind: "public" };
  }
}

/**
 * Who hears of an event on the Artifact besides those it mentions: its
 * followers, the one who made it (still following) as `owner`. The event's
 * actor is left out by the platform.
 */
export function followerRecipients(item: Pick<ArtifactItemRow, "createdByType" | "createdById">, followers: readonly ArtifactActorRef[]): ArtifactEventRecipient[] {
  return followers.map((actor) => ({
    actor,
    reason: actor.type === item.createdByType && actor.id === item.createdById ? "owner" as const : "following" as const,
  }));
}

/**
 * Of these recipients, those who can see the item now: as actors of the
 * item's server, or, for an item homed in a joint channel, from another
 * server in it (platform/visibility jointViewersOf: a joint's object is a
 * message there for its other servers' people, #68). Called inside the
 * change's transaction, which the platform's reads join (db/index
 * scopeTransactions). Someone who can't is never written as a recipient: no
 * recipient row, no Activity row, no `activity:changed` ping
 * (announceObjectEvents pings the recipient rows), so a mention or a follow
 * from before they could see it never surfaces if they gain access later;
 * one who left the joint is told nothing more.
 */
async function visibleRecipients(item: ArtifactVisibilitySubject & Pick<ArtifactItemRow, "id">, recipients: readonly ArtifactEventRecipient[]): Promise<ArtifactEventRecipient[]> {
  const actors = [...new Map(recipients.map(({ actor }) => [`${actor.type}:${actor.id}`, actor])).values()];
  // One batched check for all of them (a fixed number of queries per server), those who stand in its server.
  const answers = await actorsWhoCanViewArtifact(actors.map((actor) => ({ type: actor.type, id: actor.id, serverId: item.serverId })), item, { requireStanding: true });
  const seeing = new Set(actors.filter((_, index) => answers[index]).map((actor) => `${actor.type}:${actor.id}`));
  // The rest, from a joint's other servers.
  const rest = actors.filter((actor) => !seeing.has(`${actor.type}:${actor.id}`));
  if (rest.length > 0 && item.homeKind === "conversation" && item.deletedAt === null && item.revokedAt === null) {
    const peers = await jointViewersOf({
      id: item.id,
      serverId: item.serverId,
      homeKind: item.homeKind,
      homeChannelId: item.homeChannelId,
      author: { type: item.createdByType, id: item.createdById },
    }, rest, WORKSPACE_ARTIFACTS_FEATURE_FLAG_KEY);
    for (const key of peers.keys()) seeing.add(key);
  }
  return recipients.filter(({ actor }) => seeing.has(`${actor.type}:${actor.id}`));
}

/**
 * Record one event on the Artifact in `tx`, the transaction of the change,
 * for those of `recipients` who can see it now (visibleRecipients). Every
 * event this module records goes through here: comments, reviews, edits,
 * versions, moves.
 */
export async function recordArtifactEvent(tx: DatabaseExecutor, input: {
  item: Pick<ArtifactItemRow, "id" | "serverId" | "homeKind" | "homeChannelId"> & ArtifactVisibilitySubject;
  eventKind: ArtifactObjectEvent;
  actor: ArtifactActorRef;
  data: ObjectEventInput["data"];
  recipients: readonly ArtifactEventRecipient[];
  /** The home before the change, when it moved the Artifact. */
  previousHome?: ObjectEventInput["home"];
}): Promise<{ id: string; seq: number }> {
  return recordObjectEvent(tx, {
    serverId: input.item.serverId,
    kind: ARTIFACT_OBJECT_KIND,
    objectId: input.item.id,
    eventKind: input.eventKind,
    home: artifactHome(input.item),
    ...(input.previousHome ? { previousHome: input.previousHome } : {}),
    actor: input.actor,
    data: input.data,
    recipients: input.recipients.length === 0 ? [] : await visibleRecipients(input.item, input.recipients),
  });
}
