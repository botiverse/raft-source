// Moving an Artifact to a larger or a smaller home and deleting it (D13,
// D15; the rule Tenny decided 2026-10-26, narrowing 2026-10-27). The web
// routes (webRoutes.ts) and the agent API's (createManageOperations below:
// `POST …/:artifact/home { to }`, `DELETE …/:artifact`; never narrowing)
// check the flag and call these.
//
// Who may (mayManageArtifact, platform/visibility canManageObject): the
// author, the manager of a live agent author, and the owners and admins of
// the Artifact's own server, each while standing in it; an author who left
// hands it to the owners and admins. Another server (a joint conversation's
// other side, a public Artifact's outside reader) never may. Widening shows
// it to more people, so only a non-guest member or a live agent widens: a
// guest may delete their own Artifact, never widen it.
//
// widenArtifactHome checks, in this order, with the item row locked:
// 1. the actor sees it now (canViewArtifacts; else not_visible);
// 2. the actor may widen it (else forbidden);
// 3. `public` only by a person (else forbidden), so no agent route can;
// 4. the home only grows, conversation → server → public (else not_wider);
// 5. an agent only for what the person who manages it (platform/visibility
//    agentManagerOf) could move on the web now (decided 2026-10-27): that
//    person sees it (canViewArtifacts as them in the Artifact's server) and
//    may widen it (mayManageArtifact: so not a guest, nor one who left).
//    Moving shows its pages and comments to more people, so a person who
//    sees what it would show and may show it stands behind it. Else
//    forbidden, `agentMove` saying why (`no_manager`, `manager_cannot_see`,
//    `manager_cannot_move`). Under the same lock, so a home or role change
//    can't slip between the check and the move. deleteArtifact has no such
//    check (decided): deleting narrows who sees it, never widens, and an
//    author may delete their own on the web too;
// 6. no live Artifact of the larger home has its name (else name_taken);
// then moves it, writes the audit row (`home_changed`, or `made_public`) and
// the `moved` object event for its followers ({ from, to, fromChannelId }:
// the conversation it left, null when it was server-wide). The checks are
// one function (widenRefusal): share-audience runs it without the lock to
// offer the larger homes and say why it can't offer the others
// (widerHomeChoices, #77), a share's `widenTo` calls widenArtifactHome itself.
//
// narrowArtifactHome moves it to a smaller home (conversation < server <
// public; two conversations are the same rank, so no move between them):
// the whole server from public, or a conversation from the server or public
// (xxchan and Tenny 2026-10-27), and that conversation only the Artifact's
// original one (`items.original_home_channel_id`, #75, xxchan, Kirby and
// Remy 2026-10-28: narrowing undoes a too-wide share, so it returns the
// Artifact where it was published or saved, where its author is; no other
// conversation). Checked in this order with the item row locked
// (narrowingTarget; previewNarrowing runs it without the lock):
// 1. the actor sees it now (else not_visible);
// 2. the actor may widen it (mayManageArtifact "widen": no guest) and is a
//    person (an agent, a delegated actor: forbidden; no agent route
//    narrows);
// 3. `to` is smaller than its home (else not_narrower);
// 4. a conversation: the original one (else not_original_home, naming it
//    only as shownOriginalHome would to this actor: null when there is none,
//    it is gone, or the actor can't see it);
// 5. a conversation: a top-level conversation of the Artifact's own server
//    (topLevelConversationOf) the actor can see now (else
//    target_not_found, also for a thread under one it can't see), not a
//    thread or task conversation itself (target_not_supported `thread`),
//    not a joint channel (`joint`), no guest in it nor open to guests
//    (target_has_guests, the import's rule: conversationGuestAccess);
// 6. its author keeps it: an author who sees it now sees it there, and an
//    agent author is a member of the conversation (isConversationMember;
//    a public channel is read by agents that never joined), else
//    author_loses_access (`cannot_see`, `agent_not_member`);
// 7. no live Artifact of the smaller home has its name (else name_taken);
// 8. with `expectedLost` (the count the mover confirmed from the preview),
//    the people and agents losing it now, counted the same capped way, are
//    that many (else loss_changed { expected, actual, capped });
// then, in the same transaction, moves it, records the `moved` event for
// the followers who still see it, forgets the Activity rows of those who
// don't (forgetArtifactActivityOfThoseWhoLost; the route tells their
// clients after the commit) and writes the audit row `narrowed`: the home
// before and after, how many of the server's people and agents lost it
// (artifactViewersLost within homeChangeLimits, the preview's count: at most
// 500 are checked under the lock, so with `capped` the numbers are "at
// least") and the Activity rows removed. What someone already read can't be taken back.
//
// unpublishArtifact moves a public Artifact back to the whole server (the
// way back from `public`; Tenny and xxchan 2026-10-26), by the same people
// who may make it public, checked with the item row locked:
// 1. the actor sees it now (else not_visible);
// 2. the actor may widen it (mayManageArtifact "widen": no guest; else
//    forbidden), and is a person (else forbidden);
// 3. its home is public (else not_public);
// 4. no live Artifact of the server home has its name (else name_taken);
// then moves it, writes the audit row (`made_private`) and the `moved`
// object event ({ from: "public", to: "server", fromChannelId: null }).
// Signed-out visitors lose it with the commit (publicRoutes.ts, and the
// content Worker's next authorize: contentRoutes.ts decideAnonymous).
//
// deleteArtifact needs no sight of it (an admin deletes what they can't see):
// a live item (else not_visible), the actor may delete it (else forbidden if
// the actor sees it, not_visible if not). It sets `deleted_at` (every read
// leaves deleted items out: visibility.ts), writes the audit row (`deleted`)
// and the `deleted` object event (for no one), and drops the item's pending
// notices, search row and people's Activity rows (forgetArtifactActivity;
// the route tells their clients after the commit: announceForgottenActivity).
//
// The agent API (an agent may manage only what it made: it is never a
// manager, an owner or an admin): the flag, the Artifact the agent sees
// (resolveVisibleItem: an id or a name, one 404 NOT_VISIBLE otherwise, as
// every agent route; so, unlike a person on the web, an agent deletes only
// what it sees), then the call above; its refusals as the agent API's
// codes (403 FORBIDDEN { title, author }, and for an agent's move blocked at
// step 5 also { reason: no_manager | manager_cannot_see | manager_cannot_move,
// manager, target },
// 409 HOME_NOT_WIDER { title, home, to }, 409 NAME_TAKEN { name }). A move
// answers the Artifact and the home it left; `public` is refused by
// widenArtifactHome (403). A delete answers the Artifact's id, name and
// title, and tells people's clients their Activity changed, as the web route
// does.
import { eq, sql } from "drizzle-orm";
import {
  ARTIFACT_HOME_CHANGE_MAX_COUNTED,
  asServerId,
  RAFT_HINTS,
  type AgentApiArtifactDeleted,
  type AgentApiArtifactMoveBody,
  type AgentApiArtifactMoved,
  type AgentApiArtifactParams,
} from "@botiverse/raft-shared";
import { announceForgottenRows, type ForgottenActivityRow } from "../../platform/activity";
import { clearChannelAnnouncementsOf } from "../../platform/channelAnnouncements";
import { conversationGuestAccess, isConversationMember, topLevelConversationOf } from "../../platform/conversations";
import { getDb, type DatabaseExecutor } from "../../platform/db";
import { deleteObjectFileBytes, deleteObjectFiles } from "../../platform/objectFiles";
import { agentManagerOf, assertNeverViewActor, canManageObject, canManageObjectActionsWithStanding, type HomedObjectManagement, type ServerViewActor, type ViewActor } from "../../platform/visibility";
import { forgetArtifactActivity, forgetArtifactActivityOfThoseWhoLost } from "./activity";
import {
  answer,
  artifactRef,
  fail,
  homesOf,
  json,
  namer,
  notVisible,
  resolveVisibleItem,
  summarize,
  viewActor,
  type ArtifactAgent,
  type ArtifactApiError,
  type ArtifactApiResult,
} from "./apiCommon";
import { artifactFileObject, deleteItemChecks } from "./checks";
import { clearItemExcerpts } from "./excerpt";
import { artifactHome, followerRecipients, recordArtifactEvent } from "./events";
import { isNameTakenInHome, isUniqueViolation, type ArtifactHomeRef } from "./names";
import { followersOf } from "./notices";
import { renameAllowed } from "./rename";
import { fillCurrentPublicText } from "./publicText";
import { artifactAudit, artifactItems, artifactPendingNotices, artifactSearch, type ArtifactHomeKind, type ArtifactItemRow } from "./schema";
import { actorsWhoCanViewArtifact, artifactViewersLost, canViewArtifacts } from "./visibility";

/** The homes from narrowest to widest. */
const HOME_ORDER: readonly ArtifactHomeKind[] = ["conversation", "server", "public"];

export type ArtifactWiderHome = "server" | "public";

/** Why an agent may not move an Artifact it may manage: no person manages it, or that person can't see it now, or may not move it. */
export type ArtifactAgentMoveBlock = { code: "no_manager" } | { code: "manager_cannot_see" | "manager_cannot_move"; managerId: string };

/** A smaller home: the whole server (from public), or a top-level conversation of the Artifact's server, by id (from the server or public). */
export type ArtifactNarrowerHome = { kind: "server" } | { kind: "conversation"; conversationId: string };

export type ArtifactManageRefusal =
  | { kind: "not_visible" }
  | { kind: "forbidden"; reason: string; agentMove?: ArtifactAgentMoveBlock }
  | { kind: "not_wider"; home: ArtifactHomeKind; to: ArtifactWiderHome }
  | { kind: "not_narrower"; home: ArtifactHomeKind; to: ArtifactNarrowerHome["kind"] }
  | { kind: "not_public"; home: ArtifactHomeKind }
  | { kind: "name_taken"; name: string }
  | { kind: "target_not_found"; conversationId: string }
  | { kind: "target_not_supported"; conversationId: string; reason: "thread" | "joint" }
  | { kind: "target_has_guests"; conversationId: string; reason: "guest_members" | "open_to_guests" }
  | { kind: "author_loses_access"; reason: "agent_not_member" | "cannot_see" }
  | { kind: "not_original_home"; originalConversationId: string | null }
  | { kind: "loss_changed"; expected: number; actual: number; capped: boolean };

/** What a narrowing takes away (the preview and the audit row): artifactViewersLost's counts, and whether it leaves public. */
export interface ArtifactNarrowingImpact {
  people: number;
  agents: number;
  capped: boolean;
  leavesPublic: boolean;
}

/** How many of the server's people and agents a narrowing's impact counts (artifactViewersLost); tests lower it. */
export const homeChangeLimits = { maxCounted: ARTIFACT_HOME_CHANGE_MAX_COUNTED };

/**
 * Whether the actor may move this item to a larger home (`widen`) or delete
 * it, sight aside (the rule above; platform/visibility canManageObject).
 */
export function mayManageArtifact(
  actor: ViewActor,
  item: Pick<ArtifactItemRow, "serverId" | "createdByType" | "createdById">,
  action: HomedObjectManagement,
  opts?: { executor?: DatabaseExecutor },
): Promise<boolean> {
  return canManageObject(actor, { serverId: item.serverId, author: { type: item.createdByType, id: item.createdById } }, action, opts);
}

/**
 * mayManageArtifact for several actions at once (the viewer's capabilities),
 * one answer per action in input order, in the queries of one. `rename` is
 * rename.ts mayRename's rule, answered from the same standing read
 * (renameAllowed), so the viewer asks who may rename it in no statement more.
 */
export async function mayManageArtifactActions(
  actor: ViewActor,
  item: Pick<ArtifactItemRow, "serverId" | "createdByType" | "createdById">,
  actions: readonly (HomedObjectManagement | "rename")[],
): Promise<boolean[]> {
  const managed = actions.filter((action): action is HomedObjectManagement => action !== "rename");
  const { manages, fullMember } = await canManageObjectActionsWithStanding(actor, { serverId: item.serverId, author: { type: item.createdByType, id: item.createdById } }, managed);
  let next = 0;
  return actions.map((action) => (action === "rename" ? renameAllowed(actor, item, fullMember) : manages[next++]!));
}

/** Whether `to` is a larger home than `home`. */
export const isWiderHome = (home: ArtifactHomeKind, to: ArtifactWiderHome): boolean => HOME_ORDER.indexOf(to) > HOME_ORDER.indexOf(home);

/** Whether `to` is a smaller home than `home` (a conversation is never smaller than another: the same rank). */
export const isNarrowerHome = (home: ArtifactHomeKind, to: ArtifactNarrowerHome["kind"]): boolean => HOME_ORDER.indexOf(to) < HOME_ORDER.indexOf(home);

class Refused extends Error {
  constructor(readonly refusal: ArtifactManageRefusal) {
    super(refusal.kind);
  }
}

const homeFacts = (item: Pick<ArtifactItemRow, "homeKind" | "homeChannelId">) => ({ home_kind: item.homeKind, home_channel_id: item.homeChannelId });

/**
 * Who manages an Artifact as `actor`: a person or an agent. An assistant
 * acting for its owner (RFC 080 `delegated`) manages none yet
 * (visibilityService serverStanding): null.
 */
function managerKind(actor: ViewActor): "person" | "agent" | null {
  switch (actor.type) {
    case "user": return "person";
    case "agent": return "agent";
    case "delegated": return null;
    default: return assertNeverViewActor(actor);
  }
}

/** `actor` itself when it may manage an Artifact at all (a person or an agent); null for a delegated actor (managerKind). */
function managingActor(actor: ViewActor): ServerViewActor | null {
  switch (actor.type) {
    case "user":
    case "agent":
      return actor;
    case "delegated":
      return null;
    default:
      return assertNeverViewActor(actor);
  }
}

const DELEGATED_MANAGES_NONE: ArtifactManageRefusal = { kind: "forbidden", reason: "An assistant acting for its owner can't move, delete or rename an artifact: ask the owner to do it themselves." };

const MAY_NOT_MOVE: ArtifactManageRefusal = { kind: "forbidden", reason: "Only the artifact's author, the person who manages an agent author, and the server's owners and admins (none of them guests) can move it: ask one of them to." };

/**
 * Whether `viewer` may move `item` to another home at all, sight aside (the
 * caller checked it): the refusal (403 on the web) or null. The home route
 * asks it before refusing a narrowing sent without `expectedLost` (409), so
 * someone who may not move the Artifact hears that first, as from either move.
 */
export async function mayNotMove(viewer: ViewActor, item: ArtifactItemRow): Promise<ArtifactManageRefusal | null> {
  const actor = managingActor(viewer);
  if (actor === null) return DELEGATED_MANAGES_NONE;
  return (await mayManageArtifact(actor, item, "widen")) ? null : MAY_NOT_MOVE;
}

/**
 * widenArtifactHome's checks 1 to 6 (the file's header), in `executor`: the
 * refusal, or null when `actor` may move `item` to `to` now. The one
 * decision for a move to a larger home: the home route and a share's
 * `widenTo` run it under the item's lock (widenArtifactHome), share-audience
 * without it to say which larger homes it may offer and why not the others
 * (widerHomeChoices).
 */
async function widenRefusal(executor: DatabaseExecutor, actor: ServerViewActor, item: ArtifactItemRow, to: ArtifactWiderHome): Promise<ArtifactManageRefusal | null> {
  const kind = managerKind(actor);
  if (!(await canViewArtifacts(actor, [item], { executor }))[0]) return { kind: "not_visible" };
  if (!(await mayManageArtifact(actor, item, "widen", { executor }))) return MAY_NOT_MOVE;
  if (to === "public" && kind !== "person") return { kind: "forbidden", reason: "Only a person can turn on link sharing for an artifact, since anyone with the link could then open it: ask a person who manages it to choose \"Anyone with the link\" on the web." };
  if (!isWiderHome(item.homeKind, to)) return { kind: "not_wider", home: item.homeKind, to };
  if (kind === "agent") {
    const managerId = await agentManagerOf({ id: actor.id, serverId: item.serverId }, { executor });
    if (!managerId) return { kind: "forbidden", reason: "An agent moves an artifact only for a person who manages it and can see it, and this agent has none: ask a server owner or admin to move it on the web.", agentMove: { code: "no_manager" } };
    const manager: ViewActor = { type: "user", id: managerId, serverId: item.serverId };
    const [managerSees] = await canViewArtifacts(manager, [item], { executor });
    if (!managerSees) return { kind: "forbidden", reason: "The person who manages this agent can't see the artifact where it is, and moving it would show its pages and comments to the whole server: ask a server owner or admin who can see it to make it visible to the whole server on the web.", agentMove: { code: "manager_cannot_see", managerId } };
    if (!(await mayManageArtifact(manager, item, "widen", { executor }))) {
      return { kind: "forbidden", reason: "The person who manages this agent may not move the artifact to the whole server either: ask a server owner or admin to make it visible to the whole server on the web.", agentMove: { code: "manager_cannot_move", managerId } };
    }
  }
  // Only an Artifact from before titles has an old name to keep unique.
  if (item.name !== null && await isNameTakenInHome(executor, item.serverId, { kind: to }, item.name)) return { kind: "name_taken", name: item.name };
  return null;
}

/**
 * Each home larger than `item`'s, narrowest first, with widenRefusal's answer
 * for `viewer` now (null: it may move it there; no lock: the move itself
 * checks again under it). A delegated actor is refused each.
 */
export async function widerHomeChoices(viewer: ViewActor, item: ArtifactItemRow): Promise<Array<{ to: ArtifactWiderHome; refusal: ArtifactManageRefusal | null }>> {
  const actor = managingActor(viewer);
  const choices: Array<{ to: ArtifactWiderHome; refusal: ArtifactManageRefusal | null }> = [];
  for (const to of ["server", "public"] as const) {
    if (!isWiderHome(item.homeKind, to)) continue;
    choices.push({ to, refusal: actor === null ? DELEGATED_MANAGES_NONE : await widenRefusal(getDb(), actor, item, to) });
  }
  return choices;
}

/** The larger homes `viewer` may move `item` to now, narrowest first (widerHomeChoices without a refusal). */
export async function widerHomesFor(viewer: ViewActor, item: ArtifactItemRow): Promise<ArtifactWiderHome[]> {
  return (await widerHomeChoices(viewer, item)).filter((choice) => choice.refusal === null).map((choice) => choice.to);
}


/**
 * Move the item to a larger home (checks in the file's header). Made public,
 * its current version's signed-out text is stored after the commit, in the
 * background (publicText.ts).
 */
export async function widenArtifactHome(viewer: ViewActor, itemId: string, to: ArtifactWiderHome): Promise<{ kind: "moved"; item: ArtifactItemRow } | ArtifactManageRefusal> {
  const actor = managingActor(viewer);
  if (actor === null) return DELEGATED_MANAGES_NONE;
  try {
    const result = await getDb().transaction(async (tx) => {
      const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, itemId)).for("update");
      if (!locked) throw new Refused({ kind: "not_visible" });
      const refusal = await widenRefusal(tx, actor, locked, to);
      if (refusal) throw new Refused(refusal);

      const [moved] = await tx.update(artifactItems).set({ homeKind: to, homeChannelId: null })
        .where(eq(artifactItems.id, locked.id)).returning();
      // Out of its channel: no longer that channel's announcement (channel_announcement_v0).
      await clearChannelAnnouncementsOf(locked.id, locked.homeChannelId, tx);
      const by = { type: actor.type, id: actor.id };
      await tx.insert(artifactAudit).values({
        itemId: locked.id,
        actorType: by.type,
        actorId: by.id,
        action: to === "public" ? "made_public" : "home_changed",
        before: homeFacts(locked),
        after: homeFacts(moved!),
      });
      await recordArtifactEvent(tx, {
        item: moved!,
        eventKind: "moved",
        actor: by,
        data: { from: locked.homeKind, to, fromChannelId: locked.homeChannelId },
        previousHome: artifactHome(locked),
        recipients: followerRecipients(moved!, await followersOf(tx, locked.id)),
      });
      return { kind: "moved" as const, item: moved! };
    });
    // Made public: its current version's signed-out text, after the commit, in the background (publicText.ts).
    if (result.item.homeKind === "public") fillCurrentPublicText(result.item);
    return result;
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    // Another Artifact took the name in that home between the check and the move.
    if (isUniqueViolation(error)) {
      const [item] = await getDb().select({ name: artifactItems.name }).from(artifactItems).where(eq(artifactItems.id, itemId)).limit(1);
      return { kind: "name_taken", name: item?.name ?? "" };
    }
    throw error;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The item as it would be in `home` (only its home columns change), for asking who would see it there. */
const inHome = (item: ArtifactItemRow, home: ArtifactHomeRef): ArtifactItemRow =>
  ({ ...item, homeKind: home.kind, homeChannelId: home.kind === "conversation" ? home.channelId : null });

/**
 * The Artifact's original conversation (#75) as `actor` may be told of it
 * and narrow it to: its id while that conversation still exists as a
 * top-level conversation of the Artifact's server (not deleted, not a joint
 * channel, which no narrowing reaches) and `actor` can see it now (the
 * conversation check narrowingTarget makes); else null, one answer for every
 * reason, so a private conversation is never named to someone who can't see
 * it. The viewer's `originalHome` and NOT_ORIGINAL_HOME's details.
 */
export async function shownOriginalHome(actor: ServerViewActor, item: ArtifactItemRow, opts: { executor?: DatabaseExecutor } = {}): Promise<string | null> {
  const original = item.originalHomeChannelId;
  if (original === null) return null;
  const conversation = await topLevelConversationOf(item.serverId, original);
  if (!conversation || conversation.conversationId !== original || conversation.type === "joint") return null;
  const [sees] = await canViewArtifacts(actor, [inHome(item, { kind: "conversation", channelId: original })], opts);
  return sees ? original : null;
}

/**
 * narrowArtifactHome's checks 1 to 7 (the file's header), in `executor`: the
 * refusal, or the home it would move to. The one decision for a move to a
 * smaller home: the home route runs it under the item's lock
 * (narrowArtifactHome), the preview without it (previewNarrowing).
 */
async function narrowingTarget(executor: DatabaseExecutor, actor: ServerViewActor, item: ArtifactItemRow, to: ArtifactNarrowerHome): Promise<{ refusal: ArtifactManageRefusal } | { home: ArtifactHomeRef }> {
  if (!(await canViewArtifacts(actor, [item], { executor }))[0]) return { refusal: { kind: "not_visible" } };
  if (!(await mayManageArtifact(actor, item, "widen", { executor }))) return { refusal: MAY_NOT_MOVE };
  if (managerKind(actor) !== "person") return { refusal: { kind: "forbidden", reason: "Only a person can move an artifact to a smaller home: ask a person who manages it to do it on the web." } };
  if (!isNarrowerHome(item.homeKind, to.kind)) return { refusal: { kind: "not_narrower", home: item.homeKind, to: to.kind } };
  let home: ArtifactHomeRef = { kind: "server" };
  if (to.kind === "conversation") {
    const { conversationId } = to;
    // Only back to its original conversation (#75), named only as the actor may be told of it.
    if (item.originalHomeChannelId === null || conversationId.toLowerCase() !== item.originalHomeChannelId.toLowerCase()) {
      return { refusal: { kind: "not_original_home", originalConversationId: await shownOriginalHome(actor, item, { executor }) } };
    }
    const notFound = { refusal: { kind: "target_not_found" as const, conversationId } };
    const conversation = UUID.test(conversationId) ? await topLevelConversationOf(item.serverId, conversationId) : null;
    if (!conversation) return notFound;
    // A conversation the actor can see now; nothing more is said of one it can't (a thread under it neither).
    if (!(await canViewArtifacts(actor, [inHome(item, { kind: "conversation", channelId: conversation.conversationId })], { executor }))[0]) return notFound;
    if (conversation.conversationId !== conversationId) return { refusal: { kind: "target_not_supported", conversationId, reason: "thread" } };
    if (conversation.type === "joint") return { refusal: { kind: "target_not_supported", conversationId, reason: "joint" } };
    const guests = await conversationGuestAccess(item.serverId, conversationId);
    if (guests) return { refusal: { kind: "target_has_guests", conversationId, reason: guests } };
    home = { kind: "conversation", channelId: conversationId };
  }
  // Its author keeps it: one who sees it now sees it there; an agent author is in the conversation.
  const author: ServerViewActor = { type: item.createdByType, id: item.createdById, serverId: item.serverId };
  if ((await canViewArtifacts(author, [item], { executor }))[0]) {
    if (!(await canViewArtifacts(author, [inHome(item, home)], { executor }))[0]) return { refusal: { kind: "author_loses_access", reason: "cannot_see" } };
    switch (author.type) {
      case "user":
        break;
      case "agent":
        if (home.kind === "conversation" && !(await isConversationMember(home.channelId, author))) {
          return { refusal: { kind: "author_loses_access", reason: "agent_not_member" } };
        }
        break;
      default:
        return assertNeverViewActor(author);
    }
  }
  if (item.name !== null && await isNameTakenInHome(executor, item.serverId, home, item.name)) return { refusal: { kind: "name_taken", name: item.name } };
  return { home };
}

/** Who a move of `item` to `home` takes it from (artifactViewersLost, within homeChangeLimits), and whether it leaves public. */
async function narrowingImpact(item: ArtifactItemRow, home: ArtifactHomeRef): Promise<ArtifactNarrowingImpact> {
  const lost = await artifactViewersLost(item, home, homeChangeLimits);
  return { ...lost, leavesPublic: item.homeKind === "public" };
}

/**
 * What moving `item` to the smaller home `to` would take away, before
 * confirming it: narrowingTarget's refusal, else the impact. No lock, no
 * write: the move checks again.
 */
export async function previewNarrowing(viewer: ViewActor, item: ArtifactItemRow, to: ArtifactNarrowerHome): Promise<{ kind: "impact"; impact: ArtifactNarrowingImpact } | ArtifactManageRefusal> {
  const actor = managingActor(viewer);
  if (actor === null) return DELEGATED_MANAGES_NONE;
  const target = await narrowingTarget(getDb(), actor, item, to);
  if ("refusal" in target) return target.refusal;
  return { kind: "impact", impact: await narrowingImpact(item, target.home) };
}

/** Move the item to a smaller home (narrowArtifactHome's checks and writes in the file's header). */
export async function narrowArtifactHome(
  viewer: ViewActor,
  itemId: string,
  to: ArtifactNarrowerHome,
  opts: { expectedLost?: number } = {},
): Promise<{ kind: "moved"; item: ArtifactItemRow; impact: ArtifactNarrowingImpact; forgotten: ForgottenActivityRow[] } | ArtifactManageRefusal> {
  const actor = managingActor(viewer);
  if (actor === null) return DELEGATED_MANAGES_NONE;
  try {
    return await getDb().transaction(async (tx) => {
      const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, itemId)).for("update");
      if (!locked) throw new Refused({ kind: "not_visible" });
      const target = await narrowingTarget(tx, actor, locked, to);
      if ("refusal" in target) throw new Refused(target.refusal);
      const impact = await narrowingImpact(locked, target.home);
      // What the mover confirmed (the preview's people + agents, on the same capped count) must still hold.
      const actual = impact.people + impact.agents;
      if (opts.expectedLost !== undefined && opts.expectedLost !== actual) {
        throw new Refused({ kind: "loss_changed", expected: opts.expectedLost, actual, capped: impact.capped });
      }

      const [moved] = await tx.update(artifactItems).set({ homeKind: target.home.kind, homeChannelId: target.home.kind === "conversation" ? target.home.channelId : null })
        .where(eq(artifactItems.id, locked.id)).returning();
      // Out of its channel: no longer that channel's announcement (channel_announcement_v0).
      if (moved!.homeChannelId !== locked.homeChannelId) await clearChannelAnnouncementsOf(locked.id, locked.homeChannelId, tx);
      const by = { type: actor.type, id: actor.id };
      // Told to the followers who still see it; the others hear nothing more of it.
      const followers = await followersOf(tx, locked.id);
      const stillSee = await actorsWhoCanViewArtifact(followers.map((follower) => ({ type: follower.type, id: follower.id, serverId: locked.serverId })), moved!);
      await recordArtifactEvent(tx, {
        item: moved!,
        eventKind: "moved",
        actor: by,
        data: { from: locked.homeKind, to: target.home.kind, fromChannelId: locked.homeChannelId },
        previousHome: artifactHome(locked),
        recipients: followerRecipients(moved!, followers.filter((_, index) => stillSee[index])),
      });
      // Out of the Activity of those who can't see it there, with the move.
      const forgotten = await forgetArtifactActivityOfThoseWhoLost(tx, locked.id, (people) =>
        actorsWhoCanViewArtifact(people.map((person) => ({ type: "user" as const, id: person.userId, serverId: asServerId(person.serverId) })), moved!));
      await tx.insert(artifactAudit).values({
        itemId: locked.id,
        actorType: by.type,
        actorId: by.id,
        action: "narrowed",
        before: homeFacts(locked),
        after: {
          ...homeFacts(moved!),
          lost_access: { people: impact.people, agents: impact.agents, capped: impact.capped, left_public: impact.leavesPublic },
          activity_rows_removed: forgotten.length,
        },
      });
      return { kind: "moved" as const, item: moved!, impact, forgotten };
    });
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    // Another Artifact took the name in that home between the check and the move.
    if (isUniqueViolation(error)) {
      const [item] = await getDb().select({ name: artifactItems.name }).from(artifactItems).where(eq(artifactItems.id, itemId)).limit(1);
      return { kind: "name_taken", name: item?.name ?? "" };
    }
    throw error;
  }
}

/** Move a public item back to the server (unpublishArtifact's checks in the file's header). */
export async function unpublishArtifact(viewer: ViewActor, itemId: string): Promise<{ kind: "moved"; item: ArtifactItemRow } | ArtifactManageRefusal> {
  const actor = managingActor(viewer);
  if (actor === null) return DELEGATED_MANAGES_NONE;
  try {
    return await getDb().transaction(async (tx) => {
      const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, itemId)).for("update");
      if (!locked || !(await canViewArtifacts(actor, [locked], { executor: tx }))[0]) throw new Refused({ kind: "not_visible" });
      if (!(await mayManageArtifact(actor, locked, "widen", { executor: tx })) || managerKind(actor) !== "person") {
        throw new Refused({ kind: "forbidden", reason: "Only the artifact's author, the person who manages an agent author, and the server's owners and admins (none of them guests) can turn its link sharing off: ask one of them to." });
      }
      if (locked.homeKind !== "public") throw new Refused({ kind: "not_public", home: locked.homeKind });
      if (locked.name !== null && await isNameTakenInHome(tx, locked.serverId, { kind: "server" }, locked.name)) throw new Refused({ kind: "name_taken", name: locked.name });

      const [moved] = await tx.update(artifactItems).set({ homeKind: "server", homeChannelId: null })
        .where(eq(artifactItems.id, locked.id)).returning();
      const by = { type: actor.type, id: actor.id };
      await tx.insert(artifactAudit).values({
        itemId: locked.id,
        actorType: by.type,
        actorId: by.id,
        action: "made_private",
        before: homeFacts(locked),
        after: homeFacts(moved!),
      });
      await recordArtifactEvent(tx, {
        item: moved!,
        eventKind: "moved",
        actor: by,
        data: { from: locked.homeKind, to: "server", fromChannelId: null },
        previousHome: artifactHome(locked),
        recipients: followerRecipients(moved!, await followersOf(tx, locked.id)),
      });
      return { kind: "moved" as const, item: moved! };
    });
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    if (isUniqueViolation(error)) {
      const [item] = await getDb().select({ name: artifactItems.name }).from(artifactItems).where(eq(artifactItems.id, itemId)).limit(1);
      return { kind: "name_taken", name: item?.name ?? "" };
    }
    throw error;
  }
}

/**
 * Delete the item (soft: `deleted_at`; checks in the file's header). Its
 * publish checks go with it, rows in the transaction, their screenshots'
 * objects after it commits (checks.ts).
 */
export async function deleteArtifact(viewer: ViewActor, itemId: string): Promise<{ kind: "deleted"; forgotten: ForgottenActivityRow[] } | ArtifactManageRefusal> {
  const actor = managingActor(viewer);
  if (actor === null) return DELEGATED_MANAGES_NONE;
  try {
    const { files, ...deleted } = await getDb().transaction(async (tx) => {
      const [locked] = await tx.select().from(artifactItems).where(eq(artifactItems.id, itemId)).for("update");
      if (!locked || locked.deletedAt !== null || locked.revokedAt !== null) throw new Refused({ kind: "not_visible" });
      if (!(await mayManageArtifact(actor, locked, "delete", { executor: tx }))) {
        // One who may not learns nothing about an Artifact they can't see.
        const [visible] = await canViewArtifacts(actor, [locked], { executor: tx });
        throw new Refused(visible
          ? { kind: "forbidden", reason: "Only the artifact's author, the person who manages an agent author, and the server's owners and admins can delete it: ask one of them to." }
          : { kind: "not_visible" });
      }
      const [deleted] = await tx.update(artifactItems).set({ deletedAt: sql`now()` })
        .where(eq(artifactItems.id, locked.id)).returning();
      // Nor is it its channel's announcement any more (channel_announcement_v0).
      await clearChannelAnnouncementsOf(locked.id, locked.homeChannelId, tx);
      const by = { type: actor.type, id: actor.id };
      await tx.insert(artifactAudit).values({
        itemId: locked.id,
        actorType: by.type,
        actorId: by.id,
        action: "deleted",
        before: { deleted_at: null },
        after: { deleted_at: deleted!.deletedAt!.toISOString() },
      });
      // Told to no one: the event records the change for whoever reads the Artifact's events.
      await recordArtifactEvent(tx, { item: deleted!, eventKind: "deleted", actor: by, data: {}, recipients: [] });
      // Nothing about it goes out any more (a queued notice would be dropped on sending: it can't be seen), nor is it searched.
      await tx.delete(artifactPendingNotices).where(eq(artifactPendingNotices.itemId, locked.id));
      await tx.delete(artifactSearch).where(eq(artifactSearch.itemId, locked.id));
      // Nor are its publish checks kept, nor its excerpts, nor any of its files (core's: the checks' screenshots; their bytes after the commit, below).
      await deleteItemChecks(tx, locked.id);
      await clearItemExcerpts(tx, locked.id);
      const files = await deleteObjectFiles({ object: artifactFileObject(locked.id), executor: tx });
      // Nor is it in anyone's Activity: the rows go with the delete, and the badge with them.
      const forgotten = await forgetArtifactActivity(tx, locked.id);
      return { kind: "deleted" as const, forgotten, files };
    });
    await deleteObjectFileBytes(files);
    return deleted;
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}

/** After a delete's commit: tell those whose Activity rows went with it (deleteArtifact's `forgotten`); their clients read Activity again. */
export function announceForgottenActivity(forgotten: readonly ForgottenActivityRow[]): void {
  announceForgottenRows(forgotten);
}

/** A refused move or delete as the agent API answers it (the codes in the header); `item` is the one the agent sees. */
async function agentRefusal(agent: ArtifactAgent, item: ArtifactItemRow, refusal: ArtifactManageRefusal): Promise<ArtifactApiError> {
  switch (refusal.kind) {
    case "not_visible": return notVisible();
    case "forbidden": {
      const author = { type: item.createdByType, id: item.createdById };
      const block = refusal.agentMove;
      const manager = block && block.code !== "no_manager" ? { type: "user" as const, id: block.managerId } : null;
      const name = await namer(manager ? [author, manager] : [author]);
      const home = manager ? (await homesOf(agent, [item])).get(item.id) : undefined;
      return fail(403, {
        code: "FORBIDDEN",
        error: refusal.reason,
        details: {
          title: item.title,
          author: name(author),
          ...(block ? { reason: block.code } : {}),
          ...(manager ? { manager: name(manager), target: home?.kind === "conversation" ? home.conversation.target : null } : {}),
        },
      });
    }
    case "not_wider": return fail(409, {
      code: "HOME_NOT_WIDER",
      error: refusal.home === "public"
        ? "Nothing changed: anyone with the link can already open this artifact, a wider home than the whole server."
        : "Nothing changed: the whole server can already see this artifact.",
      next: RAFT_HINTS.artifactRead({ artifact: item.id }),
      details: { title: item.title, home: refusal.home, to: refusal.to },
    });
    case "name_taken": return fail(409, {
      code: "NAME_TAKEN",
      error: "Another artifact visible to the whole server already has this artifact's name, so it can't move there: ask the other one's author or a server admin whether it can be deleted, then move this one again.",
      details: { name: refusal.name },
    });
    // Making a public Artifact private again, or moving one to a smaller home, is a person's step: no agent route reaches unpublishArtifact or narrowArtifactHome.
    case "not_public":
    case "not_narrower":
    case "target_not_found":
    case "target_not_supported":
    case "target_has_guests":
    case "author_loses_access":
    case "loss_changed":
    case "not_original_home":
      throw new Error(`${refusal.kind} answers unpublishArtifact or narrowArtifactHome only`);
  }
}

/** The agent API's move and delete (mount.ts; the checks in the header). */
export function createManageOperations() {
  return {
    move: (agent: ArtifactAgent, params: AgentApiArtifactParams, body: AgentApiArtifactMoveBody): Promise<ArtifactApiResult<AgentApiArtifactMoved>> => answer(async () => {
      // resolveVisibleItem checks the caller's flag first.
      const item = await resolveVisibleItem(agent, params.artifact);
      const result = await widenArtifactHome(viewActor(agent), item.id, body.to);
      if (result.kind !== "moved") return agentRefusal(agent, item, result);
      const [artifact] = await summarize(agent, [result.item]);
      // A home only grows, so the one it left is the one the agent saw (a conversation's never changes).
      const from = (await homesOf(agent, [item])).get(item.id)!;
      return json({ artifact: artifact!, from });
    }),

    delete: (agent: ArtifactAgent, params: AgentApiArtifactParams): Promise<ArtifactApiResult<AgentApiArtifactDeleted>> => answer(async () => {
      // resolveVisibleItem checks the caller's flag first.
      const item = await resolveVisibleItem(agent, params.artifact);
      const result = await deleteArtifact(viewActor(agent), item.id);
      if (result.kind !== "deleted") return agentRefusal(agent, item, result);
      announceForgottenActivity(result.forgotten);
      return json({ artifact: await artifactRef(item), deleted: true as const });
    }),
  };
}
