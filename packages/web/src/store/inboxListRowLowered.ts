/**
 * #triage:#244 diagnostic: a whole-list answer that leaves a row's unread
 * *below* what the answer served for it. Once on staging (run 3, 07:59Z, a
 * deploy's reconnect burst) a row went from 8 to 0 while every answer carried
 * 8, and it did not reproduce. When it happens, one
 * `activity:list_row_lowered` event names the first step of the answer's
 * application that lowered the row, with the counts and why the list was read.
 * Counts and step names only: no row, channel or title. Sent only when it
 * happens, so its count is the defect's rate.
 *
 * Steps, in the order loadInbox applies them: `ledger` (a newer accepted read
 * than the answer's), `local_read` (a Read here, or an open-read hold), `done`,
 * `read_hold` (an acknowledged read), `merge` (the per-row position merge and
 * the newer-activity keeps), `projection` (the loaded messages' read-state
 * projection). Remove once the defect is named and fixed.
 */
import { getInboxItemKey } from "./inboxItem";
import type { InboxItem } from "./inboxStore";
import { emitStateTransitionTrace } from "../utils/stateTransitionTrace";

export type ListRowStep = "ledger" | "local_read" | "done" | "read_hold" | "merge" | "projection";

function unreadByKey(items: readonly InboxItem[]): Map<string, number> {
  return new Map(items.filter((item) => item.kind !== "mention_action" && item.kind !== "object").map((item) => [getInboxItemKey(item), item.unreadCount]));
}

export function reportListRowsLowered(input: {
  served: readonly InboxItem[];
  before: readonly InboxItem[];
  stages: ReadonlyArray<readonly [ListRowStep, readonly InboxItem[]]>;
  reason: string | undefined;
  trigger: string | undefined;
  rowPosition: boolean;
  now?: number;
}): void {
  const stages = input.stages.map(([step, items]) => [step, unreadByKey(items)] as const);
  const final = stages[stages.length - 1]?.[1];
  if (!final) return;
  const before = unreadByKey(input.before);
  for (const [key, served] of unreadByKey(input.served)) {
    const after = final.get(key);
    if (after === undefined || after >= served) continue;
    const step = stages.find(([, counts]) => (counts.get(key) ?? served) < served)?.[0] ?? "merge";
    const now = input.now ?? Date.now();
    emitStateTransitionTrace({
      domain: "inbox",
      event: "activity:list_row_lowered",
      entityId: "list",
      outcome: "conflict",
      outcomeDetail: `step=${step};before=${before.get(key) ?? -1};served=${served};after=${after}`,
      touched: 1,
      timestamp: now,
    }, {
      "inbox.lowered.step": step,
      "inbox.lowered.before": String(before.get(key) ?? -1),
      "inbox.lowered.served": String(served),
      "inbox.lowered.after": String(after),
      "inbox.lowered.fetch_reason": input.reason ?? "none",
      "inbox.lowered.fetch_trigger": input.trigger ?? "none",
      "inbox.lowered.row_position": input.rowPosition ? "true" : "false",
    });
  }
}
