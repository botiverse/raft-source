/**
 * Events a Raft system app (no OAuth client) sends to an agent through
 * `third_party_agent_events`: the system-app twin of `createThirdPartyAgentEvent`.
 *
 * Two steps so a caller can insert inside its own transaction and deliver
 * after it commits: `createSystemAppAgentEvent` writes the queued row (pass
 * `executor` to write it in the caller's transaction), then
 * `deliverSystemAppAgentEvent` claims it, pushes it to the agent and puts it
 * back in the queue when the push fails (the next /events pull or push sweep
 * picks it up). A system app with a delivery guard
 * (`systemAppDeliveryGuards`) can veto the push; every redelivery path runs
 * the same guard.
 *
 * No `externalEventId` dedupe: the unique index (client_id, agent_id,
 * external_event_id) treats NULL client_ids as distinct, so it never matches a
 * system row.
 */
import { coalesceWakeIntoUnreadItem } from "./appItemWakeCoalescing";
import { createHash } from "node:crypto";
import { AGENT_INBOX_OBJECT_REF_MAX_CHARS, AGENT_INBOX_OBJECT_REF_PATTERN, currentDate } from "@botiverse/raft-shared";
import { getDb, type DatabaseExecutor } from "../db/index";
import { thirdPartyAgentEvents } from "../db/schema";
import type { AgentOrchestrator } from "./agentOrchestrator";
import {
  buildThirdPartyAgentMessage,
  claimQueuedThirdPartyAgentEventForDelivery,
  getAgentInboundOAuthResource,
  releaseThirdPartyAgentEventDeliveryClaim,
} from "./oauthService";
import { partitionDeliverableSystemAppEvents, type SystemApp, type SystemAppAgentEvent } from "./systemAppDeliveryGuards";

export type { SystemApp, SystemAppAgentEvent };
export type SystemAppAgentEventDeliverer = Pick<AgentOrchestrator, "deliverMessage">;

export async function createSystemAppAgentEvent(input: {
  serverId: string;
  agentId: string;
  systemApp: SystemApp;
  kind?: SystemAppAgentEvent["kind"];
  summary: string;
  payload: Record<string, unknown>;
  ttlMs: number;
  now?: Date;
  executor?: DatabaseExecutor;
  /** RFC 081 §4: the inbox item key (`object.ref`); absent: the app's fallback item. */
  objectRef?: string | null;
  /** RFC 081 D8: the conversation the notice is about. */
  relatedChannelId?: string | null;
  /**
   * The app's own name for what the event reports (AppNoticeOutbox `key`),
   * kept in `external_event_id`. Never deduped by the unique index (below):
   * the notice outbox reads it (services/firstPartyAppHost.ts).
   */
  eventKey?: string | null;
}): Promise<SystemAppAgentEvent> {
  const now = input.now ?? currentDate();
  if (input.objectRef != null && (input.objectRef.length > AGENT_INBOX_OBJECT_REF_MAX_CHARS || !AGENT_INBOX_OBJECT_REF_PATTERN.test(input.objectRef))) {
    throw new Error(`${input.systemApp}: objectRef ${JSON.stringify(input.objectRef.slice(0, 40))} is not an inbox object ref`);
  }
  const [created] = await (input.executor ?? getDb()).insert(thirdPartyAgentEvents).values({
    serverId: input.serverId,
    agentId: input.agentId,
    clientId: null,
    systemApp: input.systemApp,
    externalEventId: input.eventKey ?? null,
    kind: input.kind ?? "event",
    summary: input.summary,
    payload: input.payload,
    payloadHash: createHash("sha256").update(JSON.stringify(input.payload)).digest("hex"),
    resource: getAgentInboundOAuthResource(input.serverId),
    status: "queued",
    expiresAt: new Date(now.getTime() + input.ttlMs),
    createdAt: now,
    updatedAt: now,
    objectRef: input.objectRef ?? null,
    relatedChannelId: input.relatedChannelId ?? null,
  }).returning();
  // INSERT ... RETURNING with no conflict clause returns the row or throws.
  if (!created) throw new Error("system app agent event insert returned no row");
  return created;
}

/** The agent-facing message for a system-app event (the app is both its key and its name). */
export function buildSystemAppAgentMessage(event: SystemAppAgentEvent) {
  if (!event.systemApp) throw new Error(`third_party_agent_event ${event.id} is not a system app event`);
  return buildThirdPartyAgentMessage({ event, clientKey: event.systemApp, clientName: event.systemApp });
}

/**
 * Claims a queued system-app event and pushes it to its agent. Returns false
 * when it joined an inbox item that is already unread (no new wake,
 * coalesceWakeIntoUnreadItem), when another delivery already claimed it, or when its system app's delivery
 * guard did not allow it (vetoed: expired; withheld: back in the queue). A
 * failed push puts the event back in the queue, then calls `onDeliveryError`
 * (and returns false) or, without one, rethrows.
 */
export async function deliverSystemAppAgentEvent(input: {
  event: SystemAppAgentEvent;
  deliverer: SystemAppAgentEventDeliverer;
  onDeliveryError?: (err: unknown) => void;
}): Promise<boolean> {
  // An event on an inbox item that is already unread joins it without a new wake (#wg-ax:#24).
  if (input.event.systemApp && await coalesceWakeIntoUnreadItem(input.event, input.event.systemApp)) return false;
  const claimed = await claimQueuedThirdPartyAgentEventForDelivery(input.event.id);
  if (!claimed) return false;
  // Vetoed: expired by the guard check. Withheld (fail closed): back in the
  // queue for a later attempt.
  const { deliverable, withheld } = await partitionDeliverableSystemAppEvents([claimed], (event) => event);
  if (withheld.length > 0) await releaseThirdPartyAgentEventDeliveryClaim(claimed.id);
  if (deliverable.length === 0) return false;
  try {
    // Built after the claim and inside the try, as the inline callers did: a
    // build failure releases the claim like a failed push.
    await input.deliverer.deliverMessage(input.event.agentId, buildSystemAppAgentMessage(input.event));
    return true;
  } catch (err) {
    await releaseThirdPartyAgentEventDeliveryClaim(input.event.id);
    if (!input.onDeliveryError) throw err;
    input.onDeliveryError(err);
    return false;
  }
}
