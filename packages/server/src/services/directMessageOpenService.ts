/**
 * The one path a person opens a DM by: the web's "Send DM" (`POST
 * /api/servers/:id/channels/dm`) and a personal assistant sending as its owner
 * to someone the owner has no DM with yet (RFC 077, `dmWith`). Both call
 * `openDirectMessageForUser`, so whoever the person can DM themselves, and only
 * them, can be DMed for them.
 *
 * Every rule runs before anything is written: a refusal creates no DM. An
 * existing DM is returned (and restored if it was hidden) as it always was.
 */
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/index";
import { agents } from "../db/schema";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import * as channelService from "./channelService";
import * as serverService from "./serverService";

export type DirectMessageTarget = { agentId: string; userId?: undefined } | { userId: string; agentId?: undefined };

/** Why a person may not open this DM. `code` is new; `status` and `error` are what the web route always answered. */
export type DirectMessageOpenRefusal =
  | { status: 403; code: "dm_requester_guest"; error: string }
  | { status: 404; code: "dm_target_not_found"; error: string }
  | { status: 400; code: "dm_target_not_member"; error: string }
  | { status: 403; code: "dm_target_guest"; error: string };

export type DirectMessageOpenResult =
  | { ok: true; channel: channelService.DMChannel | null }
  | ({ ok: false } & DirectMessageOpenRefusal);

async function existingDmWithUser(serverId: string, requesterUserId: string, userId: string): Promise<string | null> {
  return (await channelService.listDMChannels(serverId, requesterUserId))
    .find((dm) => dm.peerType === "user" && dm.peerId === userId)?.id ?? null;
}

/** The agent `findOrCreateDM` would accept: live in this server, and not someone else's assistant (RFC 074 §2). */
async function dmableAgent(serverId: string, requesterUserId: string, agentId: string): Promise<boolean> {
  const [agent] = await getDb()
    .select({ assistantOwnerUserId: agents.assistantOwnerUserId })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.serverId, serverId), isNull(agents.deletedAt)))
    .limit(1);
  return !!agent && (!agent.assistantOwnerUserId || agent.assistantOwnerUserId === requesterUserId);
}

/**
 * Every rule of "Send DM", writing nothing: whether `requesterUserId` may
 * open (or reuse) this DM, and the DM when it already exists. A personal
 * assistant's dry-run forward answers "creates a DM" from this.
 * - a Guest has no DMs, new or existing (#wg-rbac:#15);
 * - an agent must be live in this server, and an assistant's only DM is the
 *   one with its owner (RFC 074 §2; `findOrCreateDM` checks it again as it writes);
 * - a person: while the human directory is hidden from the requester, only an
 *   existing DM (self-DM always OK); they must be a member of this server; a
 *   Guest cannot be added to a new DM.
 */
export async function checkDirectMessageOpen(
  serverId: string,
  requesterUserId: string,
  target: DirectMessageTarget,
  /** Look the existing DM up even when no rule needs it (the web's path skips that list read). */
  opts: { findExisting?: boolean } = {},
): Promise<{ ok: true; existingChannelId: string | null } | ({ ok: false } & DirectMessageOpenRefusal)> {
  const requesterRole = await getActorServerRoleInServer(serverId, "user", requesterUserId);
  if (requesterRole === "guest") {
    return { ok: false, status: 403, code: "dm_requester_guest", error: "Guests can't create direct messages" };
  }

  if (target.agentId !== undefined) {
    if (!await dmableAgent(serverId, requesterUserId, target.agentId)) {
      return { ok: false, status: 404, code: "dm_target_not_found", error: "Agent not found in this server" };
    }
    return {
      ok: true,
      existingChannelId: opts.findExisting ? await channelService.findHumanAgentDmChannelId(serverId, requesterUserId, target.agentId) : null,
    };
  }

  const userId = target.userId;
  let existing: Promise<string | null> | null = null;
  const existingDm = () => (existing ??= existingDmWithUser(serverId, requesterUserId, userId));
  if (
    userId !== requesterUserId
    && await serverService.shouldHideHumanDirectoryFromRequester(serverId, requesterUserId)
    && !await existingDm()
  ) {
    return { ok: false, status: 404, code: "dm_target_not_found", error: "DM target not found" };
  }
  const targetRole = await getActorServerRoleInServer(serverId, "user", userId);
  if (!targetRole) {
    return { ok: false, status: 400, code: "dm_target_not_member", error: "User is not a member of this server" };
  }
  if (targetRole === "guest" && !await existingDm()) {
    return { ok: false, status: 403, code: "dm_target_guest", error: "Guests can't be added to new direct messages" };
  }
  return { ok: true, existingChannelId: opts.findExisting || existing ? await existingDm() : null };
}

/**
 * Find or create `requesterUserId`'s DM with an agent or a person in this
 * server: `checkDirectMessageOpen`'s rules, then the write. A refusal
 * creates nothing.
 */
export async function openDirectMessageForUser(
  serverId: string,
  requesterUserId: string,
  target: DirectMessageTarget,
): Promise<DirectMessageOpenResult> {
  const checked = await checkDirectMessageOpen(serverId, requesterUserId, target);
  if (!checked.ok) return checked;

  if (target.agentId !== undefined) {
    const channel = await channelService.findOrCreateDM(serverId, requesterUserId, target.agentId);
    if (!channel) return { ok: false, status: 404, code: "dm_target_not_found", error: "Agent not found in this server" };
    return { ok: true, channel };
  }
  const channel = await channelService.findOrCreateUserDM(serverId, requesterUserId, target.userId, {
    hidePassivePeerOnCreate: true,
  });
  return { ok: true, channel };
}
