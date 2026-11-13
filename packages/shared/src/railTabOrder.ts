/**
 * The rail's navigation tabs, in their default order. A person can drag them
 * into their own order; that order is stored on their account (one order for
 * every server) and both server and web normalize it here.
 *
 * `assistant` is the personal assistant (RFC 075). It shows only where the
 * server's `personal_assistant` flag is on; elsewhere it keeps its place in the
 * saved order without being drawn, like a guest's Members.
 *
 * `apps` (2026-10-28, #proj-apps task #22): the server's Apps page, after
 * Computers; guests don't see it.
 *
 * `artifacts` (2026-11-04, #proj-workspace:#133): the Artifacts home page,
 * after Tasks; shown only where the server's `workspace_artifacts_v0` flag is on.
 */
export const RAIL_TAB_IDS = ["search", "chat", "activity", "tasks", "artifacts", "members", "computers", "apps", "assistant"] as const;

export type RailTabId = (typeof RAIL_TAB_IDS)[number];

const RAIL_TAB_ID_SET: ReadonlySet<string> = new Set(RAIL_TAB_IDS);

export function isRailTabId(value: unknown): value is RailTabId {
  return typeof value === "string" && RAIL_TAB_ID_SET.has(value);
}

/**
 * Tabs added after people had saved orders, and the tab they follow by
 * default: a saved order without one gets it right after that tab, where the
 * default order has it, instead of at the end.
 */
const INSERTED_AFTER: Partial<Record<RailTabId, RailTabId>> = {
  apps: "computers",
  artifacts: "tasks",
};

/**
 * A stored or requested order as a full order of every tab: known ids in the
 * given order (first occurrence wins), then the tabs it leaves out in their
 * default order. Unknown ids are dropped, so a tab a newer build adds lands in
 * its default place and a retired one disappears. A left-out tab listed in
 * INSERTED_AFTER goes right after its tab instead. Anything but an array is
 * the default order.
 */
export function normalizeRailTabOrder(order: unknown): RailTabId[] {
  const listed = Array.isArray(order) ? order.filter(isRailTabId) : [];
  const seen = new Set<RailTabId>();
  const result: RailTabId[] = [];
  for (const id of listed) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  for (const id of RAIL_TAB_IDS) {
    if (seen.has(id)) continue;
    const anchor = INSERTED_AFTER[id];
    const at = anchor ? result.indexOf(anchor) : -1;
    if (at >= 0) result.splice(at + 1, 0, id);
    else result.push(id);
  }
  return result;
}
