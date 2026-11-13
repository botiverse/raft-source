import type {
  AgentApiArtifactActor,
  AgentApiArtifactComment,
  AgentApiArtifactHome,
  AgentApiAssistantOwnerArtifactPublishBody,
  AgentApiAssistantOwnerArtifactPublishResponse,
  AgentApiAssistantOwnerArtifactResponse,
  ArtifactActor,
  ArtifactComment,
  ArtifactHome,
  ArtifactReadAsUser,
  ArtifactShownActor,
  ServerId,
} from "@botiverse/raft-shared";
import { firstPartyApps } from "../apps/firstPartyApps";
import type { AppNoticeOutbox, AppPaywallHit } from "../platform/apps";
import * as channelService from "./channelService";
import { dmScopeOf, readableOwnerDmPolicy } from "./assistantDmScope";
import { getActorServerRoleInServer } from "../lib/actorPermissions";

/**
 * RFC 075, #proj-assistant:#31: a personal assistant reads an Artifact as its
 * owner opens it on the web. Artifacts' `readArtifactAsUser` runs the web's
 * own checks with the owner as reader; this adds what the web's request
 * pipeline and the assistant's own limits add around it:
 * - the owner is still a member (not a guest) of the server (core's
 *   `requireServer` checks it for the web; readArtifactAsUser runs outside it: Tenny, #31);
 * - an Artifact living in a DM is read only while the owner lets the assistant
 *   read DMs, except one in the assistant's own DM with the owner (where it
 *   publishes).
 * Everything the assistant can't read answers the one not-found, as the web
 * does. Nothing here marks anything read or follows anything for the owner.
 */

export type OwnerArtifactReadResult =
  | { ok: true; body: AgentApiAssistantOwnerArtifactResponse }
  | { ok: false; status: number; code: string; error: string };

export const OWNER_ARTIFACT_NOT_FOUND = {
  ok: false as const,
  status: 404,
  code: "artifact_not_found",
  error: "No Artifact your owner can open has that id or link. Pass its id, its pt_ id, or its https://app.raft.build/artifacts/… link.",
};

/** Whether the assistant may read an Artifact that lives in this conversation. */
export async function mayAssistantReadArtifactHome(input: {
  agentId: string;
  serverId: string;
  ownerUserId: string;
  homeConversationId: string;
}): Promise<boolean> {
  const channel = await channelService.getChannel(input.homeConversationId);
  if (!channel) return false;
  const scope = await dmScopeOf(channel);
  if (!scope.dm) return true;
  if (scope.rootChannelId === null) return false;
  const ownDm = await channelService.findHumanAgentDmChannelId(input.serverId, input.ownerUserId, input.agentId);
  if (ownDm !== null && scope.rootChannelId === ownDm) return true;
  return await readableOwnerDmPolicy({ agentId: input.agentId, serverId: input.serverId, ownerUserId: input.ownerUserId }) !== null;
}

function actorOf(actor: ArtifactShownActor | ArtifactActor | null): AgentApiArtifactActor {
  if (!actor || actor.gone) return { type: actor?.type ?? "user", name: null };
  return { type: actor.type, name: actor.name || null };
}

/** The home as the owner names it: `#channel`, or `dm:@peer` for one of their DMs. */
async function homeOf(home: ArtifactHome, serverId: string, ownerUserId: string): Promise<AgentApiArtifactHome> {
  if (home.kind === "server") return { kind: "server" };
  if (home.kind === "public") return { kind: "public" };
  const { id, type, name } = home.conversation;
  if (!id) return { kind: "conversation", conversation: { id: null, type, target: null } };
  if (type === "dm") {
    const peer = await channelService.resolveUserFacingDmPeerRef(serverId, ownerUserId, id);
    return { kind: "conversation", conversation: { id, type, target: peer ? `dm:@${peer}` : null } };
  }
  return { kind: "conversation", conversation: { id, type, target: name ? `#${name}` : null } };
}

function commentOf(comment: ArtifactComment): AgentApiArtifactComment {
  const body = comment.body.map((part) => (part.type === "text" ? part.text : `@${part.actor.name}`)).join("");
  return {
    id: comment.id,
    author: actorOf(comment.author),
    version: comment.version,
    path: comment.target.scope === "file" ? comment.target.path : null,
    anchor: comment.target.scope === "file" && comment.target.anchor ? { type: comment.target.anchor.type, data: comment.target.anchor.data as Record<string, unknown> } : null,
    replyTo: comment.replyTo,
    body: comment.deletedAt ? "" : body,
    createdAt: comment.createdAt,
    editedAt: comment.editedAt,
    ...(comment.reviewId ? { reviewId: comment.reviewId } : {}),
    resolvedAt: comment.resolvedAt,
    resolvedBy: comment.resolvedBy ? actorOf(comment.resolvedBy) : null,
  };
}

async function responseOf(read: ArtifactReadAsUser, serverId: string, ownerUserId: string, olderPage: boolean): Promise<AgentApiAssistantOwnerArtifactResponse> {
  const { item, file } = read;
  return {
    owner: { userId: ownerUserId },
    artifact: {
      id: item.id,
      url: item.url,
      title: item.title,
      description: item.description,
      home: await homeOf(item.home, serverId, ownerUserId),
      author: actorOf(item.author),
      version: item.version,
      latestVersion: item.latestVersion,
      commentCount: item.commentCount,
      // Only once every comment is in this answer: the newest page alone must not stand for having seen older ones (Remy, #31).
      // Only a first read that holds every comment: a later page's position may cover comments posted while paging (Remy, #14633).
      position: olderPage || read.comments?.olderCursor ? null : item.position,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    },
    versions: read.versions.map((version) => ({
      number: version.number,
      publisher: actorOf(version.publisher),
      createdAt: version.createdAt,
      note: version.note,
      changedPaths: version.changedPaths,
    })),
    files: read.files.map((entry) => ({ path: entry.path, sizeBytes: entry.sizeBytes, kind: entry.kind, entry: entry.entry })),
    file: file.kind === "text"
      ? { kind: "text", path: file.path, entry: file.entry, contentType: file.contentType, sizeBytes: file.sizeBytes, content: file.text, truncated: file.truncated }
      : { kind: "binary", path: file.path, entry: file.entry, contentType: file.contentType, sizeBytes: file.sizeBytes },
    comments: {
      items: (read.comments?.comments ?? []).map(commentOf),
      olderCursor: read.comments?.olderCursor ?? null,
      newestPosition: item.position,
    },
  };
}

export async function readOwnerArtifact(input: {
  agentId: string;
  serverId: ServerId;
  ownerUserId: string;
  ref: string;
  version?: number;
  path?: string;
  commentsBefore?: string;
}): Promise<OwnerArtifactReadResult> {
  // A member of the server, not a guest (resolveAssistantOwner refuses guests too; this service says it itself).
  const role = await getActorServerRoleInServer(input.serverId, "user", input.ownerUserId);
  if (!role || role === "guest") return OWNER_ARTIFACT_NOT_FOUND;
  // The one app that reads as a person for a caller acting for them (Artifacts; the registry, not a name).
  const readAsUser = firstPartyApps().find((app) => app.actingFor?.readAsUser)?.actingFor?.readAsUser;
  if (!readAsUser) return OWNER_ARTIFACT_NOT_FOUND;
  const answer = await readAsUser({
    serverId: input.serverId,
    userId: input.ownerUserId,
    ref: input.ref,
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.path !== undefined ? { path: input.path } : {}),
    comments: true,
    ...(input.commentsBefore !== undefined ? { commentsBefore: input.commentsBefore } : {}),
    // Decided before any version, path or content: a hidden home answers the one not-found whatever else was asked (Warden, #14494).
    homeAllowed: async (home) => home.kind !== "conversation" || (home.channelId !== null
      && await mayAssistantReadArtifactHome({ agentId: input.agentId, serverId: input.serverId, ownerUserId: input.ownerUserId, homeConversationId: home.channelId })),
  });
  if (answer.kind === "error") {
    if (answer.status === 404 && answer.body.code === "NOT_VISIBLE") return OWNER_ARTIFACT_NOT_FOUND;
    return { ok: false, status: answer.status, code: answer.body.code, error: answer.body.error };
  }
  const read = answer.body;
  return { ok: true, body: await responseOf(read, input.serverId, input.ownerUserId, input.commentsBefore !== undefined) };
}

export type OwnerArtifactPublishResult =
  | { ok: true; status: number; body: AgentApiAssistantOwnerArtifactPublishResponse }
  | { ok: false; status: number; code: string; error: string; details?: Record<string, unknown>; retryAfterSeconds?: number; paywallHit?: AppPaywallHit };

/**
 * Step 2 of #proj-assistant:#31: the assistant publishes as itself, a new
 * Artifact only into its DM with its owner, a new version only of one it
 * published (Artifacts' publishAs checks the mark). The owner must still be
 * a member (not a guest), as for a read. Quota, limits and notices are the
 * publish's own, counted on the author (the assistant, in its owner's server).
 */
export async function publishOwnerArtifact(input: {
  agentId: string;
  serverId: ServerId;
  ownerUserId: string;
  request: AgentApiAssistantOwnerArtifactPublishBody;
  outbox: AppNoticeOutbox;
}): Promise<OwnerArtifactPublishResult> {
  const role = await getActorServerRoleInServer(input.serverId, "user", input.ownerUserId);
  if (!role || role === "guest") return OWNER_ARTIFACT_NOT_FOUND;
  // The one app that publishes for a caller acting for a person (Artifacts; the registry, not a name).
  const publishAs = firstPartyApps().find((app) => app.actingFor?.publishAs)?.actingFor?.publishAs;
  if (!publishAs) return OWNER_ARTIFACT_NOT_FOUND;
  // Its DM with its current owner: where a new Artifact goes, and where one it pushes a version of must still live
  // (after a reassignment, or once moved out, it is the one not-found: Warden, #14524). Opened for a new one if
  // there is none yet; an existing one can't live in a DM that doesn't exist.
  let home = await channelService.findHumanAgentDmChannelId(input.serverId, input.ownerUserId, input.agentId);
  if (!home && input.request.artifact !== undefined) return OWNER_ARTIFACT_NOT_FOUND;
  if (!home) home = (await channelService.findOrCreateDM(input.serverId, input.ownerUserId, input.agentId))?.id ?? null;
  if (!home) return { ok: false, status: 409, code: "owner_dm_unavailable", error: "Raft could not open your DM with your owner to publish into. Send your owner a message first, then publish again." };
  const answer = await publishAs({
    serverId: input.serverId,
    author: { type: "agent", id: input.agentId },
    publishedByAssistantAgentId: input.agentId,
    home,
    request: input.request,
    outbox: input.outbox,
  });
  if (answer.kind === "error") {
    if (answer.status === 404 && answer.body.code === "NOT_VISIBLE") return OWNER_ARTIFACT_NOT_FOUND;
    return {
      ok: false,
      status: answer.status,
      code: answer.body.code,
      error: answer.body.error,
      ...(answer.body.details ? { details: answer.body.details } : {}),
      ...(answer.retryAfterSeconds !== undefined ? { retryAfterSeconds: answer.retryAfterSeconds } : {}),
      ...(answer.paywallHit ? { paywallHit: answer.paywallHit } : {}),
    };
  }
  const { itemId, url, version, unchanged, homeConversationId } = answer.body;
  return { ok: true, status: answer.status, body: { artifact: { id: itemId, url, version, unchanged, homeConversationId } } };
}
