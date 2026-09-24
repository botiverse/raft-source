/**
 * Per-server Activity unread counts for the unread-summary batch (task #235).
 *
 * The count authority is exactly what the in-server Home surface reads:
 * `getInboxItems(filter=all).totalUnreadCount` — a whole-scope SQL aggregate
 * that does not vary with limit/offset. The counts for ALL memberships are
 * computed by ONE set-based query (`getActivityUnreadTotalsBatch`), the keyed
 * batch extraction of the same serving-rows totals chain; the per-server
 * authority path stays alive as the test oracle, and oracle-equality tests
 * keep the two from drifting (contract v2.3.1 DoD 9d).
 *
 * Failure semantics are the honest grouped-batch ones (contract §5): a batch
 * query failure makes the WHOLE batch unknown — every entry keeps legacy
 * fields and omits `activityUnreadCount`. A member server with an empty inbox
 * is present-0 (the query anchors on the input server list). Per-server
 * absence still exists for provable per-server causes: a group whose computed
 * value fails validation here is omitted alone. On the wire, absent means
 * unknown — never 0, and never the broader `unreadCount` substituted.
 * `serverPushMuted` must not influence the number: count is fact, mute is
 * presentation.
 */

import * as channelService from "./channelService.js";

export interface ActivityUnreadInput {
  serverId: string;
  historyCutoff?: Date;
}

/**
 * The slice of the batch this computation depends on, injectable for tests.
 * Each group deliberately carries BOTH aggregates so the contract's
 * provenance tooth (DoD #11) can inject a result where they diverge and
 * prove this service selects `totalUnreadCount` — a wrong implementation
 * reading `activeUnreadCount` has something to read and fails the tooth,
 * rather than being unrepresentable.
 */
export type ActivityUnreadBatchLoader = (
  inputs: ActivityUnreadInput[],
  userId: string,
) => Promise<Map<string, { totalUnreadCount: number; activeUnreadCount: number }>>;

export async function computeActivityUnreadCounts(
  inputs: ActivityUnreadInput[],
  userId: string,
  loadBatchTotals: ActivityUnreadBatchLoader = channelService.getActivityUnreadTotalsBatch,
): Promise<Map<string, number>> {
  if (inputs.length === 0) return new Map();
  let batch: Awaited<ReturnType<ActivityUnreadBatchLoader>>;
  try {
    batch = await loadBatchTotals(inputs, userId);
  } catch {
    // Whole-batch unknown (contract §5): one set-based query means one
    // failure domain; pretending per-server isolation here would be a lie.
    return new Map();
  }
  const counts = new Map<string, number>();
  for (const input of inputs) {
    const totals = batch.get(input.serverId);
    const value = totals?.totalUnreadCount;
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0) {
      counts.set(input.serverId, value);
    }
  }
  return counts;
}
