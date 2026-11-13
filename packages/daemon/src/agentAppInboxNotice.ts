import type { AgentConfig, AgentInboxAppItem } from "@botiverse/raft-shared";
import { formatInboxUpdateRuntimeInput, type InboxUpdateRenderOptions } from "./agentRuntimeInput";
import type { RuntimeDriver } from "./drivers/types";

/**
 * The notice that tells a running agent its Computer-local app Inbox has
 * items; shared by every agent host, idle (it starts a turn) or busy (written
 * into the running turn) alike.
 *
 * RFC 081, inbox items on (the Server lists the reminders of a runner that
 * declares `reminder-server-ack@1`, which this build always does): the
 * wake-up notice itself
 * (formatInboxUpdateRuntimeInput). Each new reminder is its item row with its
 * `ack:` lines, when it fired at or after inbox items launched
 * (AgentConfig.inboxItemsLaunchAt, read by inboxItemsLaunchAtMs); the items
 * the Server does not list (the cleaner's, a reminder from before the launch
 * or any reminder while the launch time is unknown, RFC 081 D9) are the section
 * `raft inbox check` prints for them. Off: the count notice, byte
 * for byte as before.
 */
export function appInboxNoticeText(input: {
  /** Every item in the agent's app Inbox. */
  items: readonly AgentInboxAppItem[];
  /** The ones not noticed yet. */
  undelivered: readonly AgentInboxAppItem[];
  /** Messages the host holds for the agent, counted in the notice's header as its message wake-ups count them. */
  pendingMessages: number;
  driver: RuntimeDriver;
  options: InboxUpdateRenderOptions;
  /**
   * When inbox items launched (inboxItemsLaunchAtMs of the config or server
   * features the `options` flag came from), or null when the daemon is not
   * told: every reminder then stays in the daemon section, never a row whose
   * read fails.
   */
  inboxItemsLaunchAtMs: number | null;
  nowMs: number;
}): string {
  const { items, undelivered, options } = input;
  if (options.inboxItems !== true || undelivered.length === 0) {
    return `[Raft Inbox notice:\nApp items pending: ${items.length}\nRun \`raft inbox check\` to inspect them.]`;
  }
  // Each app item counts once: a reminder revision not yet acked, another app's item.
  return formatInboxUpdateRuntimeInput([], input.driver, input.pendingMessages + items.length, {
    ...options,
    appItems: { changed: undelivered, pending: items },
    inboxItemsLaunchAtMs: input.inboxItemsLaunchAtMs,
    nowMs: input.nowMs,
  });
}

/**
 * Whether a host already told its agent of this app Inbox item. `noticed` is
 * the host's memo: item id → the `createdAtMs` the item had when the agent
 * was told. An item id is stable per (app, class, source), so an item that
 * was removed (acked, dismissed, withdrawn by its app) and minted again has
 * the id it had before; its `createdAtMs` is new (the store keeps it only
 * across an update of an item it still holds), so that one counts as not yet
 * noticed. An item updated in place keeps it and is not announced again.
 */
export function appInboxItemNoticed(
  noticed: ReadonlyMap<string, number | undefined>,
  item: AgentInboxAppItem,
): boolean {
  return noticed.has(item.itemId) && noticed.get(item.itemId) === item.createdAtMs;
}

/**
 * When inbox items launched, in ms, from the same config or server features
 * whose `inboxItems` flag the notice reads (so the two never disagree): the
 * Server's `inboxItemsLaunchAt` (ISO 8601) beside `inboxItems: true`. Null
 * when the flag is off or the value is missing, not a string or unparseable,
 * which keeps every reminder in the daemon section.
 */
export function inboxItemsLaunchAtMs(
  config: Pick<AgentConfig, "inboxItems" | "inboxItemsLaunchAt"> | null | undefined,
): number | null {
  if (config?.inboxItems !== true) return null;
  const raw: unknown = config.inboxItemsLaunchAt;
  if (typeof raw !== "string") return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}
