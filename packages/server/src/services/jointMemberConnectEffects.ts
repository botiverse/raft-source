/**
 * What connecting a server to a joint channel writes besides the connection
 * itself, in the connection's own transaction: one `channel.server_connected`
 * audit event on the joint's host, whichever way the server connected
 * (`mode`). Once per (operation, server): the connection that writes it is
 * the one that connects the server, and a replay of it finds it connected (or
 * its invite used). One per top-level channel: the thread and task copies the
 * connection backfills write none. The channel is told after commit, by the
 * system message every connection posts (announceExternalConnection); the
 * host's owners and admins get no DM (cindyz, #wg-rbac:#42 option A).
 */
import type { DatabaseExecutor } from "../db/index";
import { newAuditOperationId, recordIntegrationAuditEvent, serverAuditContextMetadata } from "./integrationAuditService";

/**
 * How the server connected:
 * - `self_connect`: a channel member connected a server of theirs (jointMemberConnectService);
 * - `invite`: an external invite's invitee connected a server they own or administer (an existing or a new one);
 * - `approval`: an owner or admin of the server approved the invitee's connect request;
 * - `host_direct`: a host owner or admin connected another server of theirs ("Your servers");
 * - `joint_invite`: the invited owner or admin accepted a joint invite (one or several at once);
 * - `same_admin`: a joint invite to the inviter's own server, accepted in the request that sent it.
 */
export type ServerConnectedMode = "self_connect" | "invite" | "approval" | "host_direct" | "joint_invite" | "same_admin";

/**
 * The audit event of one server connected, after every write of the
 * connection. The host's server row is KEY SHARE-locked before J by the
 * caller (the event references it). The row is the host's: `channelId` is the
 * host's copy, and the connecting server's own copy is never named.
 */
export async function recordServerConnected(tx: DatabaseExecutor, input: {
  mode: ServerConnectedMode;
  jointChannelId: string;
  hostServerId: string;
  hostChannelId: string;
  connectedServerId: string;
  /** Who authorized the connection: the member, the invitee, the approver or the host's admin. */
  actorUserId: string;
  /** self_connect only: the actor's Guest seat on the host ended with it. */
  guestReleased?: boolean;
}): Promise<void> {
  await recordIntegrationAuditEvent({
    serverId: input.hostServerId,
    eventType: "channel.server_connected",
    outcome: "success",
    source: "web",
    actor: { type: "human", id: input.actorUserId },
    target: { type: "server", id: input.connectedServerId },
    metadata: {
      mode: input.mode,
      jointChannelId: input.jointChannelId,
      hostServerId: input.hostServerId,
      channelId: input.hostChannelId,
      connectedServerId: input.connectedServerId,
      ...(input.guestReleased === undefined ? {} : { guestReleased: input.guestReleased }),
      ...serverAuditContextMetadata({ operationId: newAuditOperationId() }),
    },
  }, tx);
}
