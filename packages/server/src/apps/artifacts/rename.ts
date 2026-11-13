// Renaming an Artifact (task #147; decided with xxchan and Tenny,
// #proj-workspace:98241a2e): the title is a property of the Artifact, not of
// a version. An agent renames it with a push whose only change is the title
// (publish.ts retitle), a person with the web's title route
// (`PATCH /api/artifacts/:id/title`, webRoutes.ts); both write it through
// retitleItem. An agent renames with the permission to push a new version
// (mayPublish); a person must also not be a guest, unless it is theirs
// (mayRename, Tenny: a guest changes only their own, as canManageObject).
//
// retitleItem, on the item row the caller locked in its transaction: the
// title and updatedAt, the search entry (search.ts), a `renamed` object event
// ({ from, to }, for no one's Activity: it is neither a version nor a
// comment), and a notice to each agent that follows the Artifact, not the one
// renaming, and can see it (notices.ts noticeRename), left queued: a rename
// only changes what the Artifact is shown as, so it wakes no agent (Sage,
// task #160); each gets it the next time it wakes for something else. No
// version is made and no read position moves.
//
// While the Artifact is a channel's announcement (channel_announcement_v0), a
// person's rename also needs the right to set that channel's announcement
// (editChannelMetadata; Tenny, review of #13968), as an agent's push does
// (announcement.ts): refused `channel_announcement` otherwise.
import { eq, sql } from "drizzle-orm";
import { replaceAgentLineBreaks, type ServerId } from "@botiverse/raft-shared";
import { channelAnnouncementPushRefusal } from "../../platform/channelAnnouncements";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { isFullMemberOfOwnServer, type ServerViewActor } from "../../platform/visibility";
import type { ArtifactActorRef, ArtifactNoticeOutbox } from "./apiCommon";
import { recordArtifactEvent } from "./events";
import type { ArtifactManageRefusal } from "./manage";
import { followersOf, noticeRename } from "./notices";
import { artifactItems, type ArtifactItemRow } from "./schema";
import { indexArtifactSearch } from "./search";
import { canViewArtifacts } from "./visibility";

/**
 * A title as an Artifact keeps it: one line wherever agents read it,
 * and trimmed, as an Artifact is looked up by its exact title. "" for a blank
 * one, which no route stores. Its length is checked on what was sent.
 */
export const storedTitle = (raw: string): string => replaceAgentLineBreaks(raw, " ").trim();

/**
 * Who may push a new version of an Artifact it sees, or give it a new title:
 * an actor of the Artifact's own server (D9; publish.ts step 1). The viewer's
 * `capabilities.publish`. Another server's actor (a public Artifact read from
 * outside, a joint channel's other side) never may.
 */
export const mayPublish = (actor: { serverId: ServerId }, item: Pick<ArtifactItemRow, "serverId">): boolean => item.serverId === actor.serverId;

const isAuthorOf = (actor: { type: string; id: string }, item: Pick<ArtifactItemRow, "createdByType" | "createdById">): boolean =>
  item.createdByType === actor.type && item.createdById === actor.id;

/**
 * Who may rename an Artifact as a person (the web's title route, the viewer's
 * `capabilities.publish`): one who may publish it (mayPublish: its own
 * server) and is a non-guest member of it, or its author (a guest renames
 * their own, never anyone else's: canManageObject's rule for a guest).
 */
export async function mayRename(actor: ServerViewActor, item: Pick<ArtifactItemRow, "serverId" | "createdByType" | "createdById">, opts?: { executor?: DatabaseExecutor }): Promise<boolean> {
  if (!mayPublish(actor, item)) return false;
  if (isAuthorOf(actor, item)) return true;
  return isFullMemberOfOwnServer(actor, opts);
}

/**
 * mayRename's rule on a standing already read (`fullMember`: the actor is a
 * non-guest member or a live agent of the item's server, as
 * isFullMemberOfOwnServer answers): the viewer's capabilities read it once
 * with delete and widen (manage.ts mayManageArtifactActions `rename`).
 */
export const renameAllowed = (actor: { type: string; id: string; serverId: ServerId }, item: Pick<ArtifactItemRow, "serverId" | "createdByType" | "createdById">, fullMember: boolean): boolean =>
  mayPublish(actor, item) && (isAuthorOf(actor, item) || fullMember);

/**
 * Give `locked` (the item row locked in `tx`) the title `title` (stored form,
 * not its own): the rule in the file's header. Its notices are queued in `tx`
 * and never pushed (they wake no one).
 */
export async function retitleItem(tx: DatabaseExecutor, input: {
  locked: ArtifactItemRow;
  title: string;
  actor: ArtifactActorRef;
  outbox: ArtifactNoticeOutbox;
  /** Following agents not told besides the actor (noticeRename `except`): an assistant renaming as its owner. */
  except?: readonly string[];
}): Promise<{ item: ArtifactItemRow }> {
  const { locked, title, actor } = input;
  const [updated] = await tx.update(artifactItems).set({ title, updatedAt: sql`now()` }).where(eq(artifactItems.id, locked.id)).returning();
  const item = updated!;
  await indexArtifactSearch(tx, item);
  await recordArtifactEvent(tx, { item, eventKind: "renamed", actor, data: { from: locked.title, to: title }, recipients: [] });
  await noticeRename({ executor: tx, outbox: input.outbox, item, by: actor, from: locked.title, following: await followersOf(tx, item.id), ...(input.except ? { except: input.except } : {}) });
  return { item };
}

const MAY_NOT_RENAME: ArtifactManageRefusal = { kind: "forbidden", reason: "Only the artifact's author and the members of its own server who aren't guests can rename it: ask one of them to." };

/**
 * A person's rename (the web's title route), `title` in stored form and not
 * blank: under the item's row lock, it is live and `actor` sees it (else
 * not_visible), `actor` may rename it (mayRename, else forbidden), then retitleItem,
 * unless it has that title already (`changed` false: nothing written,
 * nothing told).
 */
export async function renameArtifact(
  actor: ServerViewActor,
  itemId: string,
  title: string,
  outbox: ArtifactNoticeOutbox,
): Promise<{ kind: "done"; item: ArtifactItemRow; changed: boolean } | { kind: "channel_announcement"; channel: string; title: string } | ArtifactManageRefusal> {
  const result = await getDb().transaction(async (tx) => {
    const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, itemId)).for("update");
    if (!locked || !(await canViewArtifacts(actor, [locked], { executor: tx }))[0]) return { kind: "not_visible" as const };
    if (!(await mayRename(actor, locked, { executor: tx }))) return MAY_NOT_RENAME;
    if (locked.title === title) return { kind: "done" as const, item: locked, changed: false };
    // A channel's announcement: only who may set it changes it.
    const announcement = locked.homeKind === "conversation"
      ? await channelAnnouncementPushRefusal(locked.id, locked.homeChannelId, { type: actor.type, id: actor.id, serverId: actor.serverId }, tx)
      : null;
    if (announcement) return { kind: "channel_announcement" as const, channel: announcement.channel, title: locked.title };
    const renamed = await retitleItem(tx, { locked, title, actor: { type: actor.type, id: actor.id }, outbox });
    return { kind: "done" as const, changed: true, ...renamed };
  });
  if (result.kind !== "done") return result;
  return { kind: "done", item: result.item, changed: result.changed };
}
