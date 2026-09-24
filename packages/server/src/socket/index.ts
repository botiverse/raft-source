import { serializeErrorForLog } from "../tracing/safeErrorLog.js";
import type http from "node:http";
import { hostname } from "node:os";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { verifyActiveAccessToken, verifyToken } from "../middleware/auth.js";
import { isRedisAvailable, getRedisPub, getRedisSub } from "../redis.js";
import * as serverService from "../services/serverService.js";
import * as channelService from "../services/channelService.js";
import * as messageService from "../services/messageService.js";
import { socketConnectedClients, socketDisconnects, syncResumeTotal } from "../metrics.js";
import { parseSocketClientKind, socketClientKindRoom, socketUserServerRoom, type SocketClientKind } from "./platformScope.js";
import { fanoutWithAck } from "./fanout.js";
import { onSocketAccessRevoked, type SocketAccessRevocation } from "./accessRevocation.js";
import { publishLocalChannelUpdate } from "../services/channelRealtimeEvents.js";
import { getActorServerRoleInServer } from "../lib/actorPermissions.js";

const HEARTBEAT_INTERVAL_MS = 15_000;
const RESUME_LIMIT = 500;
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
          && (!revocation.familyId || socket.data.familyId === revocation.familyId);
      }
      if (!affected) continue;
      socket.data.accessRevoked = true;
      if (socket.connected) socket.conn.close();
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
  io.on("channel:publish", async (
    channel: { id: string; serverId: string },
    acknowledge: (result: { ok: boolean }) => void,
  ) => {
    try {
      await publishLocalChannelUpdate(io, channel);
      acknowledge({ ok: true });
    } catch (error) {
      console.error("[Socket] Channel publication failed:", serializeErrorForLog(error));
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
      const payload = await verifyActiveAccessToken(token);
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
          return next(new Error("Not a member of this server"));
        }
        // Scoped revocations (guest policy changes) evict by role.
        socket.data.serverRole = await getActorServerRoleInServer(serverId, "user", payload.sub);
      }

      if (socket.data.accessRevoked) {
        pendingHandshakes.delete(socket);
        return next(new Error("Authentication changed; reconnect required"));
      }
      next();
    } catch {
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

    const { userId, serverId, clientKind } = socket.data;
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

    // Auto-join server room + all user's channel/DM rooms
    if (serverId) {
      socket.join(`server:${serverId}`);
      socket.join(socketUserServerRoom(userId, serverId));

      // Join all channels and DMs so the client receives message:new for unread tracking
      (async () => {
        try {
          const [chans, dms] = await Promise.all([
            channelService.listChannels(serverId, userId),
            channelService.listDMChannels(serverId, userId),
          ]);
          if (!socket.connected) return;
          for (const ch of [...chans, ...dms]) {
            socket.join(`channel:${ch.id}`);
          }
        } catch (err) {
          console.error("[Socket] Failed to join channel rooms:", serializeErrorForLog(err));
        }
        // Signal client that room setup is complete — safe to gap-sync
        if (socket.connected) socket.emit("rooms:joined");
      })();
    }

    // P0: Session resume — client sends last known seq, server replays missed messages
    socket.on("sync:resume", async ({ lastSeq }: { lastSeq: number }) => {
      if (!lastSeq || lastSeq <= 0) return;
      if (!serverId) return;

      try {
        const missed = await messageService.syncMessages(
          lastSeq,
          undefined, // all channels
          RESUME_LIMIT,
          serverId,
          undefined,
          userId,
        );

        const currentSeq = missed.length > 0
          ? Math.max(...missed.map(m => m.seq))
          : lastSeq;

        const hasMore = missed.length >= RESUME_LIMIT;
        syncResumeTotal.labels(hasMore ? "has_more" : "ok").inc();
        if (socket.connected) socket.emit("sync:resume:response", { messages: missed, currentSeq, hasMore });
      } catch (err) {
        syncResumeTotal.labels("error").inc();
        console.error("[Socket] sync:resume failed:", serializeErrorForLog(err));
      }
    });

    // P2: Application-layer heartbeat with current max seq. Redis sync is kept
    // once per replica/server instead of once per connected socket.
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    if (serverId) {
      messageService.startMaxSeqRedisSync(serverId);
      heartbeatTimer = setInterval(() => {
        socket.emit("heartbeat", { seq: messageService.getMaxSeq(serverId), ts: Date.now() });
      }, HEARTBEAT_INTERVAL_MS);
    }

    socket.on("join:channel", async (channelId: string) => {
      if (typeof channelId !== "string" || !serverId) return;
      try {
        if (!await channelService.canUserAccessChannel(channelId, userId, serverId)) return;
        if (socket.connected) socket.join(`channel:${channelId}`);
      } catch {
        // Malformed IDs and failed authorization reads must fail closed.
      }
    });

    socket.on("leave:channel", (channelId: string) => {
      socket.leave(`channel:${channelId}`);
    });

    socket.on("disconnect", (reason) => {
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
