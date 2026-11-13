import type { Socket } from "socket.io";
import { syncResumeTotal } from "../metrics";
import * as messageService from "../services/messageService";
import { getHistoryCutoff, getServerPlan } from "../services/planService";
import { parseSyncHorizon, readSyncHorizon, type SyncHorizon } from "../services/syncHorizon";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { errorClassOf, recordTraceEvent } from "../tracing/semanticTrace";

export const RESUME_LIMIT = 500;

/**
 * Socket catch-up (services/syncHorizon.ts has the full contract).
 *
 * `sync:resume` { lastSeq, sinceHorizon? } -> `sync:resume:response`
 *   { messages, currentSeq, hasMore, horizon, horizonReset }.
 * Older clients send { lastSeq } and read { messages, currentSeq, hasMore }:
 * for them the rows are unchanged; `horizon` / `horizonReset` are additive.
 * Each message also carries the `conversationContext` its `message:new`
 * carries (additive), so a client can place a replayed message (thread
 * parent, task, DM) without first holding its conversation.
 * Paging rule: send `sinceHorizon` only on a round's FIRST resume; the next
 * round's sinceHorizon is the `horizon` of this round's first response; a
 * `hasMore` follow-up of the same round omits it. With sinceHorizon, the
 * response also carries "late" messages (seq <= lastSeq whose transaction
 * finished after that horizon); `currentSeq` never moves below lastSeq. If more
 * than SYNC_LATE_CAP late messages qualify, none are sent and
 * `horizonReset: true` tells the client to refetch its visible scope instead.
 * An invalid sinceHorizon is ignored (traced): the resume runs as an old one.
 *
 * `sync:horizon` (ack) -> { horizon }: the current horizon only, no message
 * access; a client that already holds its messages (a fresh page load) takes
 * it as its first round's since-horizon.
 */
export function attachSyncHandlers(
  socket: Pick<Socket, "on" | "emit" | "connected">,
  context: { userId: string; serverId: string | null | undefined },
): void {
  const { userId, serverId } = context;

  socket.on("sync:resume", async (payload: unknown) => {
    // Same guard as before the horizon: older clients' payloads behave as they did.
    const { lastSeq, sinceHorizon: rawSinceHorizon } = (payload ?? {}) as { lastSeq: number; sinceHorizon?: unknown };
    if (!lastSeq || lastSeq <= 0) return;
    if (!serverId) return;
    const sinceHorizon: SyncHorizon | null = rawSinceHorizon === undefined ? null : parseSyncHorizon(rawSinceHorizon);
    const sinceHorizonInvalid = rawSinceHorizon !== undefined && !sinceHorizon;

    try {
      // The plan's history window, as on every other read: a Free server's
      // replay must not page through the messages its 30 days leave out.
      const historyCutoff = getHistoryCutoff(await getServerPlan(serverId));
      const result = await messageService.syncMessagesWithHorizon(
        lastSeq,
        undefined, // all channels
        RESUME_LIMIT,
        serverId,
        historyCutoff,
        userId,
        serverId,
        { sinceHorizon },
      );
      const missed = await messageService.withStorageConversationContexts(result.messages);
      // Late messages sit at or below lastSeq, so the cursor never moves back.
      const currentSeq = missed.length > 0 ? Math.max(lastSeq, ...missed.map((m) => m.seq)) : lastSeq;
      // Only the page (seq > lastSeq) counts toward the limit.
      const pageCount = missed.filter((m) => m.seq > lastSeq).length;
      const hasMore = pageCount >= RESUME_LIMIT;
      syncResumeTotal.labels(hasMore ? "has_more" : "ok").inc();
      recordTraceEvent("server.socket.sync_resume", {
        outcome: "ok",
        horizon_requested: Boolean(sinceHorizon),
        since_horizon_invalid: sinceHorizonInvalid,
        late_count: result.lateCount,
        horizon_reset: result.horizonReset,
        ...(result.snapshotXidSpan === null ? {} : { snapshot_xid_span: result.snapshotXidSpan }),
        messages_count: missed.length,
        has_more: hasMore,
      });
      if (socket.connected) {
        socket.emit("sync:resume:response", {
          messages: missed,
          currentSeq,
          hasMore,
          horizon: result.horizon,
          horizonReset: result.horizonReset,
        });
      }
    } catch (err) {
      syncResumeTotal.labels("error").inc();
      recordTraceEvent("server.socket.sync_resume", {
        outcome: "error",
        horizon_requested: Boolean(sinceHorizon),
        since_horizon_invalid: sinceHorizonInvalid,
        error_class: errorClassOf(err),
      });
      console.error("[Socket] sync:resume failed:", serializeErrorForLog(err));
    }
  });

  socket.on("sync:horizon", async (...args: unknown[]) => {
    // `emit("sync:horizon", ack)` or `emit("sync:horizon", {}, ack)`.
    const ack = args[args.length - 1];
    if (typeof ack !== "function") return;
    if (!serverId) {
      ack({ error: "server_required" });
      return;
    }
    try {
      // readSyncHorizon runs on the PRIMARY (getDb), never the read replica:
      // a standby's snapshot describes its replay state, not the writer's
      // in-flight transactions.
      const { horizon, snapshotXidSpan } = await readSyncHorizon();
      recordTraceEvent("server.socket.sync_horizon", {
        outcome: "ok",
        ...(snapshotXidSpan === null ? {} : { snapshot_xid_span: snapshotXidSpan }),
      });
      ack({ horizon });
    } catch (err) {
      recordTraceEvent("server.socket.sync_horizon", { outcome: "error", error_class: errorClassOf(err) });
      console.error("[Socket] sync:horizon failed:", serializeErrorForLog(err));
      ack({ error: "horizon_unavailable" });
    }
  });
}
