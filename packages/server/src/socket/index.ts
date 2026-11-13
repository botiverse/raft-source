import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { errorClassOf, safeAddTraceEvent } from "../tracing/semanticTrace";
import type http from "node:http";
import {
  AGENT_ACTIVITY_SUBSCRIBE_EVENT,
  AGENT_ACTIVITY_SUBSCRIBE_MAX_IDS,
  AGENT_ACTIVITY_SUBSCRIBED_EVENT,
  AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY,
  AGENT_ACTIVITY_UNSUBSCRIBE_EVENT,
  agentActivityCapableServerRoom,
  agentActivityRoom,
  READ_PROGRESS_UNWATCH_EVENT,
  READ_PROGRESS_WATCH_EVENT,
  SOCKET_NOT_SERVER_MEMBER_ERROR,
  SOCKET_SSO_REQUIRED_ERROR,
  socketHandshakeCapabilities,
} from "@botiverse/raft-shared";
import { hostname } from "node:os";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { verifyActiveAccessTokenWithAccount, verifyToken } from "../middleware/auth";
import { isRedisAvailable, getRedisPub, getRedisSub } from "../redis";
import * as serverService from "../services/serverService";
import * as channelService from "../services/channelService";
import * as agentService from "../services/agentService";
import type { AgentFinder } from "../services/agentMemberListPolicy";
import * as messageService from "../services/messageService";
import { socketConnectedClients, socketDisconnects } from "../metrics";
import { attachSyncHandlers } from "./syncResume";
import { isSocketClientKind, parseSocketClientKind, SOCKET_CLIENT_KINDS, socketClientKindRoom, socketServerGuestsRoom, socketUserServerRoom, type SocketClientKind } from "./platformScope";
import { fanoutWithAck } from "./fanout";
import { attachPresenceActivityHandler } from "./presenceEvents";
import { registerNotificationSocketServer } from "../services/notifications/dispatcher";
import { onSocketAccessRevoked, type SocketAccessRevocation } from "./accessRevocation";
import { socketsFailingSso, SSO_SOCKET_RECHECK_MS } from "../services/sso/ssoEnforcement";
import { publishLocalChannelUpdate } from "../services/channelRealtimeEvents";
import { getActorServerRoleInServer } from "../lib/actorPermissions";
import {
  registerAgentReadProgressSocketServer,
  unregisterAgentReadProgressSocketServer,
  unwatchAgentReadProgress,
  watchAgentReadProgress,
} from "../services/agentReadProgressService";

const HEARTBEAT_INTERVAL_MS = 15_000;
const socketHost = hostname();

type SocketHandshakeAuth =
  | { ok: true; token: string; serverId: string | null; clientKind: SocketClientKind }
  | { ok: false; reason: "auth_not_object" | "token_missing" | "server_id_invalid" | "client_kind_invalid" };

export function parseSocketHandshakeAuth(value: unknown): SocketHandshakeAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "auth_not_object" };
  }

  const input = value as Record<string, unknown>;
  if (typeof input.token !== "string" || input.token.trim() === "") {
    return { ok: false, reason: "token_missing" };
  }

  if (input.serverId === undefined || input.serverId === null) {
    const clientKind = parseSocketClientKind(input.clientKind);
    if (!clientKind) return { ok: false, reason: "client_kind_invalid" };
    return { ok: true, token: input.token, serverId: null, clientKind };
  }
  if (typeof input.serverId !== "string" || input.serverId.trim() === "") {
    return { ok: false, reason: "server_id_invalid" };
  }

  const clientKind = parseSocketClientKind(input.clientKind);
  if (!clientKind) return { ok: false, reason: "client_kind_invalid" };
  return { ok: true, token: input.token, serverId: input.serverId, clientKind };
}

export function stripSocketTraceMetadata(value: unknown, depth = 0): unknown {
  if (depth > 20) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripSocketTraceMetadata(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (key === "_trace") continue;
    output[key] = stripSocketTraceMetadata(child, depth + 1);
  }
  return output;
}

/** The connect-time member room lookup retries from this, doubling, up to the max (plus jitter). */
export const MEMBER_ROOM_JOIN_RETRY_BASE_MS = 1_000;
export const MEMBER_ROOM_JOIN_RETRY_MAX_MS = 60_000;
/** Emitted once when the first member room lookup fails: the socket is degraded until `rooms:joined`. */
export const SOCKET_ROOMS_JOIN_FAILED_EVENT = "rooms:join_failed";

/** The wait before retry `failures` (1-based): exponential, capped, with jitter in [50%, 100%]. */
export function memberRoomJoinRetryDelayMs(failures: number, random: () => number = Math.random): number {
  const capped = Math.min(MEMBER_ROOM_JOIN_RETRY_BASE_MS * 2 ** (failures - 1), MEMBER_ROOM_JOIN_RETRY_MAX_MS);
  return Math.round(capped * (0.5 + random() * 0.5));
}

type MemberRoomSocket = {
  readonly connected: boolean;
  join(room: string): unknown;
  emit(event: string, ...args: unknown[]): unknown;
};

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Join every channel and DM room the member belongs to, then emit
 * `rooms:joined` (the client's signal that a gap sync is safe). A failed
 * lookup is retried in the background for the socket's lifetime (1 s
 * doubling to 60 s, with jitter) and the socket stays connected: dropping it
 * would have every client reconnect, and query again, in a loop while the
 * database is slow. The first failure emits `rooms:join_failed` once; the
 * client treats the connection as degraded (no channel `message:new` yet)
 * and re-reads what is on screen on each heartbeat until `rooms:joined`.
 * Stops when the socket disconnects (`signal`).
 */
export async function joinMemberConversationRooms(
  socket: MemberRoomSocket,
  listConversations: () => Promise<Array<{ id: string }>>,
  options: {
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    random?: () => number;
    onAttemptFailed?: (attempt: number, error: unknown) => void;
  } = {},
): Promise<"joined" | "gone"> {
  const sleep = options.sleep ?? sleepUnlessAborted;
  const live = () => socket.connected && !options.signal?.aborted;
  for (let failures = 0; live(); ) {
    try {
      const conversations = await listConversations();
      if (!live()) return "gone";
      for (const conversation of conversations) socket.join(`channel:${conversation.id}`);
      // Signal client that room setup is complete — safe to gap-sync
      socket.emit("rooms:joined");
      return "joined";
    } catch (error) {
      failures += 1;
      options.onAttemptFailed?.(failures, error);
      if (!live()) return "gone";
      if (failures === 1) socket.emit(SOCKET_ROOMS_JOIN_FAILED_EVENT);
      await sleep(memberRoomJoinRetryDelayMs(failures, options.random), options.signal);
    }
  }
  return "gone";
}

/** Every channel type goes through canUserAccessChannel on join:channel;
 * kept as an explicit contract for the socket tests. */
export function requiresSocketChannelAccessCheck(_channelType: string): boolean {
  return true;
}

/** The agent ids of a subscribe/unsubscribe body (`{ agentIds }`): strings only, deduped, at most AGENT_ACTIVITY_SUBSCRIBE_MAX_IDS. */
export function parseAgentActivitySubscriptionIds(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const ids = (value as Record<string, unknown>).agentIds;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64))].slice(0, AGENT_ACTIVITY_SUBSCRIBE_MAX_IDS);
}

/**
 * Join this socket to the detailed-activity rooms of the agents it may see:
 * only a capable, non-guest member socket, and only agents of its own server
 * that its user may find (exactly the agents whose detail the server room
 * carries for them: another person's assistant is not one, agentEventRoom;
 * joint agents keep their stripped projection push). Answers with the ids
 * joined.
 */
export async function subscribeSocketToAgentActivity(
  socket: Pick<Socket, "join" | "emit" | "connected">,
  input: { userId: string; serverId: string | null; serverRole: string | null | undefined; capable: boolean; body: unknown },
  filterAgentIdsInServer: (serverId: string, ids: readonly string[], finder: AgentFinder) => Promise<Set<string>> = agentService.filterAgentIdsInServer,
): Promise<string[]> {
  const ids = parseAgentActivitySubscriptionIds(input.body);
  let joined: string[] = [];
  if (input.serverId && input.capable && input.serverRole !== "guest" && ids.length > 0) {
    try {
      const allowed = await filterAgentIdsInServer(input.serverId, ids, { userId: input.userId });
      joined = ids.filter((id) => allowed.has(id));
    } catch {
      // A failed read fails closed: nothing joined.
      joined = [];
    }
  }
  if (!socket.connected) return [];
  for (const id of joined) socket.join(agentActivityRoom(id));
  socket.emit(AGENT_ACTIVITY_SUBSCRIBED_EVENT, { agentIds: joined });
  return joined;
}

/** Sockets this process holds right now, by client kind, as flat trace attributes. */
export function countSocketClients(sockets: Iterable<{ data: { clientKind?: unknown } }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of SOCKET_CLIENT_KINDS) counts[`socket_clients_${kind}`] = 0;
  for (const socket of sockets) {
    const key = `socket_clients_${isSocketClientKind(socket.data.clientKind) ? socket.data.clientKind : "other"}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function setupSocket(server: http.Server, corsOrigin: string | string[]) {
  const io = new Server(server, {
    cors: {
      origin: corsOrigin,
      credentials: true,
    },
  });

  // Use Redis adapter for multi-replica broadcast when Redis is available
  if (isRedisAvailable()) {
    io.adapter(createAdapter(getRedisPub(), getRedisSub()));
    console.log("[Socket] Redis adapter enabled — multi-replica broadcasts active");
  }
  // The notification dispatcher's socket transports emit on this server.
  registerNotificationSocketServer(io);
  // Agent read progress frames go out on it too (agentReadProgressService).
  registerAgentReadProgressSocketServer(io);
  server.once("close", () => unregisterAgentReadProgressSocketServer(io));

  // Track only pending transports, not a global epoch or permanent per-user
  // tombstones. An unrelated user's revocation cannot poison this handshake.
  const pendingHandshakes = new Set<Socket>();
  const evict = (revocation: SocketAccessRevocation) => {
    const candidates = new Set([...pendingHandshakes, ...io.of("/").sockets.values()]);
    const members = "serverId" in revocation && revocation.scope === "non-members"
      ? new Set(revocation.memberUserIds)
      : null;
    for (const socket of candidates) {
      let affected: boolean;
      if ("serverId" in revocation) {
        affected = socket.data.serverId === revocation.serverId;
        // A handshake that has not resolved its role yet fails closed.
        if (affected && revocation.scope === "guests") affected = socket.data.serverRole === undefined || socket.data.serverRole === "guest";
        if (affected && members) affected = typeof socket.data.userId !== "string" || !members.has(socket.data.userId);
      } else {
        affected = socket.data.userId === revocation.userId
          && (!revocation.familyId || socket.data.familyId === revocation.familyId)
          && (!revocation.entryServerId || socket.data.serverId === revocation.entryServerId);
      }
      if (!affected) continue;
      socket.data.accessRevoked = true;
      if (!socket.connected) continue;
      // The route's own membership-removed emit comes after this close and
      // cannot reach the removed user, so the notice travels with the
      // eviction. It carries only the server id; the close that follows in
      // the same tick keeps revocation immediate.
      if ("userId" in revocation && revocation.removedFromServerId && socket.data.serverId === revocation.removedFromServerId) {
        socket.emit("server:membership-removed", { serverId: revocation.removedFromServerId });
      }
      socket.conn.close();
    }
  };
  io.on("access:revoked", (revocation: SocketAccessRevocation, acknowledge: () => void) => {
    evict(revocation);
    acknowledge();
  });
  const unsubscribeRevocation = onSocketAccessRevoked(async (revocation) => {
    evict(revocation);
    await fanoutWithAck(io, "access:revoked", revocation);
  });
  server.once("close", unsubscribeRevocation);
  // Require SSO (RFC 083 §6.2): this replica's own sockets, re-checked every few minutes.
  const ssoRecheck = setInterval(() => {
    const live = [...io.of("/").sockets.values()].filter((socket) => typeof socket.data.userId === "string" && typeof socket.data.familyId === "string");
    void socketsFailingSso(live.map((socket) => ({ socket, userId: socket.data.userId as string, familyId: socket.data.familyId as string })))
      .then((failing) => { for (const { socket } of failing) socket.conn.close(); })
      .catch((error) => console.error("[Socket] SSO re-check failed:", serializeErrorForLog(error)));
  }, SSO_SOCKET_RECHECK_MS);
  ssoRecheck.unref();
  server.once("close", () => clearInterval(ssoRecheck));
  io.on("channel:publish", async (
    channel: { id: string; serverId: string },
    acknowledge: (result: { ok: boolean }) => void,
  ) => {
    try {
      await publishLocalChannelUpdate(io, channel);
      acknowledge({ ok: true });
    } catch (error) {
      console.error("[Socket] Channel publication failed:", serializeErrorForLog(error));
      // Socket.IO handlers run outside request-scoped trace roots, so outside
      // one this is a deliberate no-op (same tradeoff as agentPermalinkRender).
      safeAddTraceEvent("socket.channel_publish.failed", () => ({
        event_kind: "socket_channel_publish",
        outcome: "error",
        reason: "publish_threw",
        error_class: errorClassOf(error),
      }));
      acknowledge({ ok: false });
    }
  });

  // Auth middleware — verify JWT + server membership
  io.use(async (socket, next) => {
    const auth = parseSocketHandshakeAuth(socket.handshake.auth);
    if (!auth.ok) {
      return next(new Error("Authentication required"));
    }
    const { token, serverId, clientKind } = auth;

    try {
      // Establish the signed identity synchronously before any DB await, so
      // revocation during live-token validation can find this pending socket.
      const identity = verifyToken(token);
      if (identity.type !== "access") return next(new Error("Invalid token type"));
      socket.data.userId = identity.sub;
      socket.data.familyId = identity.familyId;
      socket.data.serverId = serverId;
      pendingHandshakes.add(socket);
      socket.conn.once("close", () => pendingHandshakes.delete(socket));
      const verified = await verifyActiveAccessTokenWithAccount(token, { ssoFresh: true });
      const payload = verified?.payload ?? null;
      if (!payload) {
        pendingHandshakes.delete(socket);
        return next(new Error("Invalid or expired token"));
      }

      socket.data.userId = payload.sub;
      socket.data.serverId = serverId;
      socket.data.clientKind = clientKind;
      socket.data.familyId = payload.familyId;

      // Verify server membership if serverId provided
      if (serverId) {
        const member = await serverService.isMember(serverId, payload.sub);
        if (!member) {
          pendingHandshakes.delete(socket);
          return next(new Error(SOCKET_NOT_SERVER_MEMBER_ERROR));
        }
        socket.data.serverRole = await getActorServerRoleInServer(serverId, "user", payload.sub);
      }
      // Require SSO (RFC 083 §6.2), for every socket of the person (its user room carries every
      // Server's DMs and thread replies): refused here, and closed when the SSO sign-in stops counting.
      if (verified!.ssoRequiredBy) {
        pendingHandshakes.delete(socket);
        return next(new Error(SOCKET_SSO_REQUIRED_ERROR));
      }
      socket.data.ssoExpiresAt = verified!.ssoExpiresAt?.getTime() ?? null;

      if (socket.data.accessRevoked) {
        pendingHandshakes.delete(socket);
        return next(new Error("Authentication changed; reconnect required"));
      }
      next();
    } catch (error) {
      // The client-visible error stays the generic one; the real failure is
      // logged and traced first so a throw here is not silently misreported
      // as an expired token. Socket.IO handshakes run outside request-scoped
      // trace roots, so the trace event is a deliberate no-op outside one
      // (same tradeoff as agentPermalinkRender).
      console.error("[Socket] Auth middleware validation failed:", serializeErrorForLog(error));
      safeAddTraceEvent("socket.auth.failed", () => ({
        event_kind: "socket_auth",
        outcome: "error",
        reason: "auth_validation_threw",
        error_class: errorClassOf(error),
      }));
      pendingHandshakes.delete(socket);
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    // Socket.IO schedules connection after middleware completion. An eviction
    // can run in that gap, before the socket enters the namespace registry.
    pendingHandshakes.delete(socket);
    if (socket.data.accessRevoked) {
      socket.conn.close();
      return;
    }
    const ssoExpiresAt = typeof socket.data.ssoExpiresAt === "number" ? socket.data.ssoExpiresAt : null;
    // setTimeout caps at ~24.8 days; a longer max age is re-checked at the next reconnect.
    const ssoTimer = ssoExpiresAt ? setTimeout(() => socket.conn.close(), Math.min(Math.max(0, ssoExpiresAt - Date.now()), 2_147_000_000)) : null;
    socket.use((packet, next) => {
      for (let idx = 1; idx < packet.length; idx += 1) {
        packet[idx] = stripSocketTraceMetadata(packet[idx]);
      }
      next();
    });

    const transport = socket.conn.transport.name; // "websocket" or "polling"
    socketConnectedClients.labels(transport).inc();

    // Track transport upgrades (polling → websocket)
    socket.conn.on("upgrade", (newTransport: { name: string }) => {
      socketConnectedClients.labels(transport).dec();
      socketConnectedClients.labels(newTransport.name).inc();
    });

    const { userId, serverId, clientKind, serverRole } = socket.data;
    const agentActivityCapable = socketHandshakeCapabilities(socket.handshake.auth).has(AGENT_ACTIVITY_SUBSCRIPTIONS_CAPABILITY);
    const userRoom = `user:${userId}`;
    const clientKindRoom = socketClientKindRoom(userId, clientKind);

    // Join per-user room for targeted cross-replica operations (e.g. socketsJoin for new DMs/threads)
    socket.join(userRoom);
    socket.join(clientKindRoom);
    console.info("[Socket] user_rooms_joined", {
      host: socketHost,
      socketId: socket.id,
      serverId,
      clientKind,
      userRoom,
      clientKindRoom,
    });

    // Guests receive resource-scoped events only. The server room carries
    // metadata for public channels that may be hidden from them.
    if (serverId) {
      // Guests get their own room so publication paths that authorize per
      // socket (channelRealtimeEvents) can still reach every connection of
      // the server without exposing the server-room broadcasts to them.
      socket.join(serverRole === "guest" ? socketServerGuestsRoom(serverId) : `server:${serverId}`);
      socket.join(socketUserServerRoom(userId, serverId));
      // A client that declared the capability gets coarse agent state here
      // and detailed activity only for the agents it subscribes to.
      if (serverRole !== "guest" && agentActivityCapable) socket.join(agentActivityCapableServerRoom(serverId));

      // Join all channels and DMs so the client receives message:new for unread tracking
      const roomJoin = new AbortController();
      socket.once("disconnect", () => roomJoin.abort());
      void joinMemberConversationRooms(socket, async () => {
        const [chans, dms] = await Promise.all([
          channelService.listChannels(serverId, userId),
          channelService.listDMChannels(serverId, userId),
        ]);
        return [...chans, ...dms];
      }, {
        signal: roomJoin.signal,
        onAttemptFailed: (attempt, err) => {
          console.error("[Socket] Failed to join channel rooms:", { attempt, socketId: socket.id, serverId, error: serializeErrorForLog(err) });
        },
      });
    }

    // P0: Session resume — client sends last known seq (and its sync horizon),
    // server replays missed messages; `sync:horizon` returns the current
    // horizon. Contract and paging rule: ./syncResume.ts.
    attachSyncHandlers(socket, { userId, serverId });

    // P2: Application-layer heartbeat with current max seq. Redis sync is kept
    // once per replica/server instead of once per connected socket.
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (serverId) {
      messageService.startMaxSeqRedisSync(serverId);
      heartbeatTimer = setInterval(() => {
        socket.emit("heartbeat", { seq: messageService.getMaxSeq(serverId), ts: Date.now() });
      }, HEARTBEAT_INTERVAL_MS);
    }

    // Acknowledges every join attempt with `channel:joined` or `channel:join_denied`
    // ({ channelId }). Rooms joined here (thread rooms, rooms of channels the user
    // is not a member of) are not covered by `rooms:joined`.
    // `channel:joined` means only that this socket is now in `channel:<id>` and will
    // receive every later broadcast TO THAT ROOM. It does not say what is broadcast
    // there: thread replies reach `channel:<threadId>` only when the parent is a
    // public channel (messageService); under a private/dm/joint parent they go to
    // the followers' `user:<id>` rooms instead. Clients must combine the ack with
    // that rule (mobile treats it as a delivery signal for public-parent threads only).
    socket.on("join:channel", async (channelId: string) => {
      if (typeof channelId !== "string" || !serverId) return;
      let joined = false;
      try {
        if (await channelService.canUserAccessChannel(channelId, userId, serverId) && socket.connected) {
          socket.join(`channel:${channelId}`);
          joined = true;
        }
      } catch {
        // Malformed IDs and failed authorization reads must fail closed.
      }
      if (socket.connected) socket.emit(joined ? "channel:joined" : "channel:join_denied", { channelId });
    });

    socket.on("leave:channel", (channelId: string) => {
      socket.leave(`channel:${channelId}`);
    });

    socket.on(AGENT_ACTIVITY_SUBSCRIBE_EVENT, (body: unknown) => {
      void subscribeSocketToAgentActivity(socket, { userId, serverId, serverRole, capable: agentActivityCapable, body });
    });

    socket.on(AGENT_ACTIVITY_UNSUBSCRIBE_EVENT, (body: unknown) => {
      for (const id of parseAgentActivitySubscriptionIds(body)) socket.leave(agentActivityRoom(id));
    });

    // Agent read progress for the conversations this socket shows
    // (agentReadProgressService; contract in packages/shared/src/agentReadProgress.ts).
    socket.on(READ_PROGRESS_WATCH_EVENT, (body: unknown) => {
      void watchAgentReadProgress(socket, { userId, serverId, body }).catch(() => {});
    });

    socket.on(READ_PROGRESS_UNWATCH_EVENT, (body: unknown) => {
      unwatchAgentReadProgress(socket, body);
    });

    attachPresenceActivityHandler(socket, { userId, clientKind });

    socket.on("disconnect", (reason) => {
      if (ssoTimer) clearTimeout(ssoTimer);
      socketConnectedClients.labels(socket.conn.transport.name).dec();
      socketDisconnects.labels(reason).inc();
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (serverId) {
        messageService.stopMaxSeqRedisSync(serverId);
      }
    });
  });

  return io;
}
