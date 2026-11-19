import type {
  AgentApiAssistantOwnerArtifactPublishAsOwnerBody,
  AgentApiAssistantOwnerArtifactPublishAsOwnerResponse,
  AgentApiAssistantOwnerArtifactPublishBody,
  ServerId,
} from "@botiverse/raft-shared";
import type { Server as SocketServer } from "socket.io";
import { firstPartyApps } from "../apps/firstPartyApps";
import type { AppNoticeOutbox, AppPublishAsAnswer } from "../platform/apps";
import { postableConversation } from "../platform/conversations";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import type { AgentOrchestrator } from "./agentOrchestrator";
import * as channelService from "./channelService";
import * as messageService from "./messageService";
import { assistantReadsOwnerDms, dmScopeOf } from "./assistantDmScope";
import { OWNER_RESOLVE_AMBIGUOUS_CODE, resolveNameForOwner } from "./assistantService";
import { assistantSendsAsOwner, isBridgedConversation } from "./assistantSendAsOwnerService";
import { OWNER_ARTIFACT_NOT_FOUND, type OwnerArtifactPublishResult } from "./assistantOwnerArtifacts";
import { recordIntegrationAuditEventBestEffort } from "./integrationAuditService";
import { recordTraceEvent } from "../tracing/semanticTrace";

/**
 * #proj-assistant:#33: a personal assistant publishes an Artifact AS its
 * owner. The owner is the author (Artifacts' publishAs person door: the
 * owner's own rules, the assistant's mark, its read position for the
 * unseen-comments hold); this adds the rules of sending a message as the
 * owner (assistantSendAsOwnerService), all checked before anything is written:
 * - the owner comes from the assistant's own record (the route's
 *   requireAssistantOwner), never from the request, and is a member (not a guest);
 * - "send as me" is on, checked on every request;
 * - the home is named as the owner names it (`#channel`, `dm:@peer`: their
 *   existing DM, never a new one) or by id, and must be a conversation the
 *   owner may post in now (platform/conversations postableConversation), not
 *   the assistant's own DM with the owner (it publishes there as itself), a
 *   DM only while the owner lets the assistant read DMs, never one bridged
 *   to an external chat;
 * - a new version: the Artifact as the owner sees it, whose home passes the
 *   same checks, and which the assistant published (the mark).
 * Every home it can't use answers the one TARGET_NOT_FOUND, so the answer
 * never tells a conversation that doesn't exist from one the owner can't post
 * in (Tenny, #32). A held push (409 UNSEEN_CHANGES) says no comment text: the
 * assistant reads with owner-artifact, as the owner sees it (Warden, #14679).
 *
 * A hold moves no read position (publishAs's person door): only a request
 * carrying `seen` gets past it, so a plain retry can't publish over comments
 * never shown (Tenny, #33).
 *
 * v1: joint (shared) channels are not supported. A new Artifact whose home is
 * a joint channel, and a new version of one homed in a joint's canonical
 * channel, both answer the one not-found: the canonical channel belongs to
 * the joint's storage namespace, not to a server, so postableConversation
 * refuses it even on the host. A later relaxation should ask whether the
 * owner may post in their own server's projection of that joint, never relax
 * the server check (Warden, #14681).
 *
 * After a publish that made a version, Raft records it (integration audit
 * `assistant.publish_artifact_as_owner`, trace
 * `server.assistant.publish_artifact_as_owner`, as send-as-owner does) and
 * posts one receipt in the owner's DM with the assistant naming the Artifact,
 * the home and the link. It has no Retract (Tenny, #33): the Artifact is the
 * owner's, to delete or move.
 */

export const OWNER_HOME_NOT_FOUND = {
  ok: false as const,
  status: 404,
  code: "TARGET_NOT_FOUND",
  error: "No conversation your owner can post in has that name or id, or you can't publish there for them. Name it as your owner does (#channel, dm:@peer, or its id); not your own DM with them, a DM only while they let you read DMs, never one bridged to an external chat.",
};

const SEND_AS_OWNER_OFF = {
  ok: false as const,
  status: 403,
  code: "assistant_send_as_owner_off",
  error: "Your owner has not turned on sending as them. Publish as yourself into your DM with them instead (owner-artifact).",
};

type Refusal = Extract<OwnerArtifactPublishResult, { ok: false }>;

export type OwnerArtifactPublishAsOwnerResult =
  | { ok: true; status: number; body: AgentApiAssistantOwnerArtifactPublishAsOwnerResponse }
  | Refusal;

interface UsableHome {
  /** The home an Artifact put there names (a joint's canonical channel). */
  homeChannelId: string;
  /** As the owner names it. */
  ref: string;
}

/** A conversation the assistant may publish into as its owner, or null (the one not-found, whatever the reason). */
async function usableHome(input: { agentId: string; serverId: ServerId; ownerUserId: string; conversationId: string }): Promise<UsableHome | null> {
  const postable = await postableConversation({ userId: input.ownerUserId, serverId: input.serverId }, input.conversationId);
  if (!postable) return null;
  const channel = await channelService.getChannel(postable.conversationId);
  if (!channel) return null;
  const scope = await dmScopeOf(channel);
  if (scope.dm) {
    if (scope.rootChannelId === null) return null;
    const ownDm = await channelService.findHumanAgentDmChannelId(input.serverId, input.ownerUserId, input.agentId);
    if (ownDm !== null && scope.rootChannelId === ownDm) return null;
    if (!await assistantReadsOwnerDms(input.agentId)) return null;
  }
  if (await isBridgedConversation(channel)) return null;
  const ref = scope.dm
    ? `dm:@${await channelService.resolveUserFacingDmPeerRef(input.serverId, input.ownerUserId, channel.id) ?? "someone"}`
    : `#${channel.name}`;
  return { homeChannelId: postable.homeChannelId, ref };
}

/** `home` as the owner names it, to a conversation id; null when it names none they can see. */
async function homeIdOf(serverId: ServerId, ownerUserId: string, home: string): Promise<{ id: string } | { ambiguous: true } | null> {
  const trimmed = home.trim();
  if (trimmed.startsWith("#") || trimmed.startsWith("dm:")) {
    const resolved = await resolveNameForOwner(serverId, ownerUserId, trimmed);
    if (!resolved.ok) return resolved.code === OWNER_RESOLVE_AMBIGUOUS_CODE ? { ambiguous: true } : null;
    return resolved.type === "channel" || resolved.type === "dm" ? { id: resolved.id } : null;
  }
  return { id: trimmed };
}

/** The publish's refusal as this route answers it: one not-found per subject, and a hold without comment text. */
function refusalOf(answer: Extract<AppPublishAsAnswer, { kind: "error" }>): Refusal {
  if (answer.status === 404 && answer.body.code === "NOT_VISIBLE") return OWNER_ARTIFACT_NOT_FOUND;
  if (answer.status === 404 && answer.body.code === "TARGET_NOT_FOUND") return OWNER_HOME_NOT_FOUND;
  if (answer.body.code === "UNSEEN_CHANGES") {
    // The excerpts are of comments in a home the assistant may not be in itself: counts and the position only.
    const details = answer.body.details ?? {};
    const unseen = (details.unseen ?? {}) as { commentCount?: unknown; unread?: unknown };
    return {
      ok: false,
      status: answer.status,
      code: "UNSEEN_CHANGES",
      error: "Held, not published: since you last looked, others commented on this Artifact. Read it with owner-artifact, then send the same publish with seen = the position it returned, if the comments don't change what you meant.",
      details: {
        unseen: { commentCount: unseen.commentCount ?? null, unread: unseen.unread ?? null },
        ...(details.seen !== undefined ? { seen: details.seen } : {}),
      },
    };
  }
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

/** The receipt's line: a new Artifact, or a new version of one (Tenny, #33). */
export function publishAsOwnerReceiptText(input: { title: string; where: string; url: string; version: number; newArtifact: boolean }): string {
  const what = input.newArtifact ? input.title : `v${input.version} of ${input.title}`;
  return `Published ${what} in ${input.where} as you: ${input.url}`;
}

async function postReceipt(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  serverId: ServerId;
  agentId: string;
  ownerUserId: string;
  content: string;
}): Promise<void> {
  try {
    const ownDm = await channelService.findHumanAgentDmChannelId(input.serverId, input.ownerUserId, input.agentId);
    if (!ownDm) return;
    // A plain line: no delegatedReceipt metadata, so the web offers no Retract (the Artifact is the owner's).
    await messageService.broadcastSystemMessage(input.io, input.orchestrator, ownDm, input.content, {
      inboxFactPolicy: {
        mode: "record",
        producer: "assistant.delegated_receipt",
        reason: "the owner sees every Artifact their assistant published as them",
        causalActor: { type: "agent", id: input.agentId },
      },
      // Never delivered to the assistant: it caused it and already knows.
      targetAgentIds: [],
    });
  } catch (err) {
    console.error("[assistantOwnerArtifactAsOwner] receipt failed:", err instanceof Error ? err.message : err);
  }
}

export async function publishOwnerArtifactAsOwner(input: {
  io: SocketServer;
  orchestrator: AgentOrchestrator;
  agentId: string;
  serverId: ServerId;
  ownerUserId: string;
  request: AgentApiAssistantOwnerArtifactPublishAsOwnerBody;
  outbox: AppNoticeOutbox;
}): Promise<OwnerArtifactPublishAsOwnerResult> {
  const { home: homeName, ...publish } = input.request;
  const newArtifact = publish.artifact === undefined;
  if (!newArtifact && homeName !== undefined) {
    return { ok: false, status: 400, code: "invalid_request", error: "home is only for a new Artifact: a new version stays where the Artifact is. Send artifact without home." };
  }
  if (newArtifact && homeName === undefined) {
    return { ok: false, status: 400, code: "HOME_REQUIRED", error: "A new Artifact needs home, the conversation it goes in, as your owner names it (#channel, dm:@peer, or its id)." };
  }
  const notFound = newArtifact ? OWNER_HOME_NOT_FOUND : OWNER_ARTIFACT_NOT_FOUND;
  const role = await getActorServerRoleInServer(input.serverId, "user", input.ownerUserId);
  if (!role || role === "guest") return notFound;
  if (!await assistantSendsAsOwner(input.agentId)) return SEND_AS_OWNER_OFF;
  const apps = firstPartyApps();
  const publishAs = apps.find((app) => app.actingFor?.publishAs)?.actingFor?.publishAs;
  const readAsUser = apps.find((app) => app.actingFor?.readAsUser)?.actingFor?.readAsUser;
  if (!publishAs || !readAsUser) return notFound;

  let home: UsableHome | null = null;
  let title = publish.title ?? "";
  if (newArtifact) {
    const named = await homeIdOf(input.serverId, input.ownerUserId, homeName!);
    if (named !== null && "ambiguous" in named) {
      return { ok: false, status: 409, code: OWNER_RESOLVE_AMBIGUOUS_CODE, error: "A person and an agent share that name: add ~human or ~agent (dm:@name~human)." };
    }
    home = named === null ? null : await usableHome({ agentId: input.agentId, serverId: input.serverId, ownerUserId: input.ownerUserId, conversationId: named.id });
    if (home === null) return OWNER_HOME_NOT_FOUND;
  } else {
    // The Artifact as the owner sees it; its home passes the same checks before anything else is read or written.
    const read = await readAsUser({
      serverId: input.serverId,
      userId: input.ownerUserId,
      ref: publish.artifact!,
      comments: false,
      homeAllowed: async (found) => {
        if (found.kind !== "conversation" || found.channelId === null) return false;
        home = await usableHome({ agentId: input.agentId, serverId: input.serverId, ownerUserId: input.ownerUserId, conversationId: found.channelId });
        return home !== null;
      },
    });
    if (read.kind === "error" || home === null) return OWNER_ARTIFACT_NOT_FOUND;
    title = publish.title ?? read.body.item.title;
  }
  const usable = home as UsableHome;

  const answer = await publishAs({
    serverId: input.serverId,
    author: { type: "user", id: input.ownerUserId },
    publishedByAssistantAgentId: input.agentId,
    home: usable.homeChannelId,
    request: publish as AgentApiAssistantOwnerArtifactPublishBody,
    outbox: input.outbox,
  });
  if (answer.kind === "error") return refusalOf(answer);
  const { itemId, url, version, unchanged } = answer.body;
  if (!unchanged) {
    recordTraceEvent("server.assistant.publish_artifact_as_owner", {
      agent_id: input.agentId,
      subject_user_id: input.ownerUserId,
      artifact_id: itemId,
      version,
      home_channel_id: usable.homeChannelId,
      new_artifact: newArtifact,
    });
    await recordIntegrationAuditEventBestEffort({
      serverId: input.serverId,
      eventType: "assistant.publish_artifact_as_owner",
      outcome: "success",
      source: "api",
      actor: { type: "agent", id: input.agentId },
      subject: { type: "human", id: input.ownerUserId },
      // The target is the home it was published in; the item's id (pt_…) is not a uuid, so it goes in the metadata.
      target: { type: "channel", id: usable.homeChannelId },
      metadata: { artifactId: itemId, version, homeChannelId: usable.homeChannelId, newArtifact },
    });
    await postReceipt({
      io: input.io,
      orchestrator: input.orchestrator,
      serverId: input.serverId,
      agentId: input.agentId,
      ownerUserId: input.ownerUserId,
      content: publishAsOwnerReceiptText({ title, where: usable.ref, url, version, newArtifact }),
    });
  }
  return {
    ok: true,
    status: answer.status,
    body: { artifact: { id: itemId, url, version, unchanged }, home: { id: usable.homeChannelId, ref: usable.ref } },
  };
}
