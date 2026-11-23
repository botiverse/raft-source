import type { Socket } from "socket.io";
import { observeSyncResumeReplay, syncResumeTotal } from "../metrics";
import * as messageService from "../services/messageService";
import { attachResolvedInlineQuotesForViewer } from "../services/quoteReplyService";
import { getHistoryCutoff, getServerPlan } from "../services/planService";
import { parseSyncHeldIds, parseSyncHorizon, readSyncHorizon, type SyncHorizon } from "../services/syncHorizon";
import { routeFailureAttrs } from "../routes/errorResponse";
import { serializeErrorForLog } from "../tracing/safeErrorLog";
import { errorClassOf, recordTraceEvent } from "../tracing/semanticTrace";

export const RESUME_LIMIT = 500;

function elapsedMs(since: number): number {
  return Math.round(performance.now() - since);
}

/**
 * Socket catch-up (services/syncHorizon.ts has the full contract).
 *
 * `sync:resume` { lastSeq, sinceHorizon?, heldIds? } -> `sync:resume:response`
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
 * `heldIds` (#triage:#553; only with sinceHorizon, so only on a round's first
 * resume): the ids of the messages the client received through `message:new`
 * since it adopted that horizon, at most SYNC_HELD_IDS_CAP (200; a client
 * with more sends none). The late messages leave exactly those out; the page
 * (seq > lastSeq) is unaffected. An invalid list (not an array of message
 * ids, or over the cap) is ignored as a whole (traced: held_ids_invalid), and
 * so is a list without a valid sinceHorizon. Older servers ignore the field;
 * older clients do not send it.
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
    const { lastSeq, sinceHorizon: rawSinceHorizon, heldIds: rawHeldIds } = (payload ?? {}) as {
      lastSeq: number;
      sinceHorizon?: unknown;
      heldIds?: unknown;
    };
    if (!lastSeq || lastSeq <= 0) return;
    if (!serverId) return;
    const sinceHorizon: SyncHorizon | null = rawSinceHorizon === undefined ? null : parseSyncHorizon(rawSinceHorizon);
    const sinceHorizonInvalid = rawSinceHorizon !== undefined && !sinceHorizon;
    const parsedHeldIds = rawHeldIds === undefined ? null : parseSyncHeldIds(rawHeldIds);
    const heldIdsInvalid = rawHeldIds !== undefined && !parsedHeldIds;
    // Held ids only mean something against the horizon they were held since.
    const heldIds = sinceHorizon ? parsedHeldIds ?? [] : [];

    // Time of the whole resume (plan, query, quotes, contexts) and of the
    // query alone, so a deploy's reconnect wave can be read in time, not only
    // in rows. The handler has no span: these ride on the event.
    const startedAt = performance.now();
    let queryMs: number | undefined;
    // The step a failure happened in: drizzle wraps a database error in a bare `Error`.
    let stage: "plan" | "query" | "context" | "answer" = "plan";

    try {
      // The plan's history window, as on every other read: a Free server's
      // replay must not page through the messages its 30 days leave out.
      const historyCutoff = getHistoryCutoff(await getServerPlan(serverId));
      stage = "query";
      const queryStartedAt = performance.now();
      const result = await messageService.syncMessagesWithHorizon(
        lastSeq,
        undefined, // all channels
        RESUME_LIMIT,
        serverId,
        historyCutoff,
        userId,
        serverId,
        { sinceHorizon, heldIds },
      );
      queryMs = elapsedMs(queryStartedAt);
      stage = "context";
      const missed = await attachResolvedInlineQuotesForViewer(
        await messageService.withStorageConversationContexts(result.messages),
        { serverId, userId, historyCutoff },
      );
      // Late messages sit at or below lastSeq, so the cursor never moves back.
      const currentSeq = missed.length > 0 ? Math.max(lastSeq, ...missed.map((m) => m.seq)) : lastSeq;
      // Only the page (seq > lastSeq) counts toward the limit.
      const pageCount = missed.filter((m) => m.seq > lastSeq).length;
      const hasMore = pageCount >= RESUME_LIMIT;
      stage = "answer";
      syncResumeTotal.labels(hasMore ? "has_more" : "ok").inc();
      observeSyncResumeReplay({ pageCount, lateCount: missed.length - pageCount, horizonReset: result.horizonReset });
      recordTraceEvent("server.socket.sync_resume", {
        outcome: "ok",
        horizon_requested: Boolean(sinceHorizon),
        since_horizon_invalid: sinceHorizonInvalid,
        late_count: result.lateCount,
        held_ids_invalid: heldIdsInvalid,
        held_ids_count: heldIds.length,
        held_ids_skipped: result.heldSkipped,
        horizon_reset: result.horizonReset,
        ...(result.snapshotXidSpan === null ? {} : { snapshot_xid_span: result.snapshotXidSpan }),
        messages_count: missed.length,
        has_more: hasMore,
        duration_ms: elapsedMs(startedAt),
        query_ms: queryMs,
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
        held_ids_invalid: heldIdsInvalid,
        held_ids_count: heldIds.length,
        // error_class, cause_class, sqlstate, error_code (incl. acquire_timeout),
        // constraint: from the whole cause chain, never the message.
        ...routeFailureAttrs(err),
        failed_stage: stage,
        duration_ms: elapsedMs(startedAt),
        ...(queryMs === undefined ? {} : { query_ms: queryMs }),
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
