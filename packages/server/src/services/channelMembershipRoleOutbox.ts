import { and, asc, eq, lt } from "drizzle-orm";
import type { Server as SocketServer } from "socket.io";
import { clearClockInterval, currentDate, setClockInterval } from "@botiverse/raft-shared";
import { getDb } from "../db/index.js";
import { channelMembershipRoleEvents, channels } from "../db/schema.js";

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_DELIVERY_ATTEMPTS = 5;

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
}): { stop(): void } {
  let stopped = false;
  let running = false;
  const drain = input.drain ?? drainChannelMembershipRoleOutbox;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await drain({ io: input.io, batchSize: input.batchSize });
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
