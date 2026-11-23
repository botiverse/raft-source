import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { clearClockInterval, currentDate, noopTracer, setClockInterval, type Tracer } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { channelMembershipRoleEvents, channels } from "../db/schema";
import { withTraceRoot } from "../tracing/semanticTrace";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Right after a committed channel role change (the web route's or the Agent
 * API's): the channel's audience rereads its members, the member gets its new
 * authority, and the event is marked sent. A failure here leaves the event
 * pending for the outbox worker below rather than failing the request.
 */
export async function deliverChannelMembershipRoleChange(
  io: SocketServer | undefined,
  channel: { id: string; serverId: string; type: string },
  change: { targetType: "user" | "agent"; targetId: string; channelRole: "admin" | "member"; authorityRevision: number; eventId: string | null },
): Promise<void> {
  if (change.targetType === "user") {
    io?.to(`user:${change.targetId}`).emit("channel:updated", { channel: { ...channel, joined: true } });
  }
  io?.to(channel.type === "private" ? `channel:${channel.id}` : `server:${channel.serverId}`)
    .emit("channel:members-updated", { channelId: channel.id });
  io?.to(`${change.targetType}:${change.targetId}`).emit("channel:authority-updated", {
    channelId: channel.id,
    channelRole: change.channelRole,
    authorityRevision: change.authorityRevision,
  });
  if (!change.eventId) return;
  try {
    await getDb().update(channelMembershipRoleEvents).set({
      deliveryStatus: "sent",
      deliveryAttempts: sql`${channelMembershipRoleEvents.deliveryAttempts} + 1`,
      deliveredAt: currentDate(),
      lastDeliveryError: null,
    }).where(eq(channelMembershipRoleEvents.id, change.eventId));
  } catch (deliveryError) {
    // The role mutation and durable outbox row are already committed.
    // Leave the event pending for retry rather than turning a successful
    // authority change into an ambiguous HTTP 500.
    console.error("Failed to mark channel role event delivered:", deliveryError);
  }
}

export async function drainChannelMembershipRoleOutbox(input: {
  io: SocketServer;
  batchSize?: number;
}): Promise<{ attempted: number; sent: number; failed: number; deadLettered: number }> {
  const db = getDb();
  const candidates = await db.select()
    .from(channelMembershipRoleEvents)
    .where(and(
      eq(channelMembershipRoleEvents.deliveryStatus, "pending"),
      lt(channelMembershipRoleEvents.deliveryAttempts, MAX_DELIVERY_ATTEMPTS),
    ))
    .orderBy(asc(channelMembershipRoleEvents.createdAt))
    .limit(input.batchSize ?? DEFAULT_BATCH_SIZE);

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let deadLettered = 0;
  for (const candidate of candidates) {
    const nextAttempt = candidate.deliveryAttempts + 1;
    const [claimed] = await db.update(channelMembershipRoleEvents)
      .set({ deliveryAttempts: nextAttempt })
      .where(and(
        eq(channelMembershipRoleEvents.id, candidate.id),
        eq(channelMembershipRoleEvents.deliveryStatus, "pending"),
        eq(channelMembershipRoleEvents.deliveryAttempts, candidate.deliveryAttempts),
      ))
      .returning();
    if (!claimed) continue;
    attempted += 1;

    try {
      const [channel] = await db.select({ type: channels.type })
        .from(channels)
        .where(eq(channels.id, claimed.channelId))
        .limit(1);
      if (!channel) throw new Error("CHANNEL_ROLE_OUTBOX_CHANNEL_MISSING");

      const audienceRoom = channel.type === "private"
        ? `channel:${claimed.channelId}`
        : `server:${claimed.serverId}`;
      input.io.to(audienceRoom).emit("channel:members-updated", { channelId: claimed.channelId });
      input.io
        .to(`${claimed.targetType}:${claimed.targetId}`)
        .emit("channel:authority-updated", {
          channelId: claimed.channelId,
          channelRole: claimed.nextRole,
          authorityRevision: claimed.authorityRevision,
        });

      await db.update(channelMembershipRoleEvents).set({
        deliveryStatus: "sent",
        deliveredAt: currentDate(),
        lastDeliveryError: null,
      }).where(and(
        eq(channelMembershipRoleEvents.id, claimed.id),
        eq(channelMembershipRoleEvents.deliveryStatus, "pending"),
        eq(channelMembershipRoleEvents.deliveryAttempts, nextAttempt),
      ));
      sent += 1;
    } catch (error) {
      const dead = nextAttempt >= MAX_DELIVERY_ATTEMPTS;
      await db.update(channelMembershipRoleEvents).set({
        deliveryStatus: dead ? "dead_letter" : "pending",
        lastDeliveryError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      }).where(and(
        eq(channelMembershipRoleEvents.id, claimed.id),
        eq(channelMembershipRoleEvents.deliveryStatus, "pending"),
        eq(channelMembershipRoleEvents.deliveryAttempts, nextAttempt),
      ));
      failed += 1;
      if (dead) deadLettered += 1;
    }
  }
  return { attempted, sent, failed, deadLettered };
}

export function startChannelMembershipRoleOutboxWorker(input: {
  io: SocketServer;
  intervalMs?: number;
  batchSize?: number;
  drain?: typeof drainChannelMembershipRoleOutbox;
  tracer?: Tracer;
}): { stop(): void } {
  let stopped = false;
  let running = false;
  const drain = input.drain ?? drainChannelMembershipRoleOutbox;
  const tracer = input.tracer ?? noopTracer;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // Each drain is a root span. A failure also records the
      // `server.channel_membership_role_outbox.error` event inside it.
      await withTraceRoot(
        tracer,
        "server.channel_membership_role_outbox.drain",
        { surface: "server", kind: "internal" },
        () => drain({ io: input.io, batchSize: input.batchSize }),
        "server.channel_membership_role_outbox.error",
      );
    } catch (error) {
      console.error("[ChannelMembershipRoleOutbox] Drain failed:", error);
    } finally {
      running = false;
    }
  };
  const timer = setClockInterval(() => void tick(), input.intervalMs ?? DEFAULT_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  void tick();
  return {
    stop() {
      stopped = true;
      clearClockInterval(timer);
    },
  };
}
