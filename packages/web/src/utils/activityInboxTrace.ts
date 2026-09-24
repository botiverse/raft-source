import { currentTimeMs } from "@botiverse/raft-shared";
import { emitStateTransitionTrace } from "./stateTransitionTrace";

type ActivityInboxTraceSource =
  | "socket_thread_reply"
  | "http_reset"
  | "read_intent"
  | "read_ack"
  | "focus_scroll";

type ActivityInboxTraceInput = {
  source: ActivityInboxTraceSource;
  itemKey: string;
  marker?: string | null;
  fromIndex?: number;
  toIndex?: number;
  unreadCount?: number;
  focusOwner?: boolean;
};

const TRACE_CYCLE_TTL_MS = 2_000;
let traceCycleCounter = 0;
const activeTraceCycles = new Map<string, { clientEventId: string; expiresAt: number }>();

export function activityInboxTraceScope(
  identity: { serverId?: string | null; principalId?: string | null; generation?: number | null },
  itemKey: string,
): string | null {
  if (!identity.serverId || !identity.principalId || !Number.isSafeInteger(identity.generation) || !itemKey) return null;
  return `${identity.serverId}:${identity.principalId}:${identity.generation}:${itemKey}`;
}

function mintTraceCycleId(nowMs: number): string {
  traceCycleCounter = (traceCycleCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `activity-${nowMs.toString(36)}-${traceCycleCounter.toString(36)}`;
}

export function beginActivityInboxTraceCycle(scope: string | null, nowMs = currentTimeMs()): string | undefined {
  if (!scope) return undefined;
  const clientEventId = mintTraceCycleId(nowMs);
  activeTraceCycles.set(scope, { clientEventId, expiresAt: nowMs + TRACE_CYCLE_TTL_MS });
  return clientEventId;
}

export function currentActivityInboxTraceCycle(scope: string | null, nowMs = currentTimeMs()): string | undefined {
  if (!scope) return undefined;
  const activeTraceCycle = activeTraceCycles.get(scope);
  if (!activeTraceCycle || nowMs > activeTraceCycle.expiresAt) {
    activeTraceCycles.delete(scope);
    return undefined;
  }
  return activeTraceCycle.clientEventId;
}

export function traceActivityInboxTransition(
  input: ActivityInboxTraceInput,
  clientEventId?: string,
): void {
  const marker = input.marker ? `;marker=${input.marker}` : "";
  const fromIndex = input.fromIndex == null ? "na" : String(input.fromIndex);
  const toIndex = input.toIndex == null ? "na" : String(input.toIndex);
  const unread = input.unreadCount == null ? "na" : String(Math.max(0, input.unreadCount));
  emitStateTransitionTrace({
    domain: "inbox",
    event: `activity:${input.source}`,
    entityId: input.itemKey,
    outcome: "applied",
    outcomeDetail: `from=${fromIndex};to=${toIndex};unread=${unread};focus=${input.focusOwner ? 1 : 0}${marker}`,
    touched: 1,
    timestamp: currentTimeMs(),
    join: clientEventId ? { clientEventId } : undefined,
  });
}

export function resetActivityInboxTraceForTests(): void {
  traceCycleCounter = 0;
  activeTraceCycles.clear();
}
