import { serverNeedsAttention, shouldShowComputerUpgradeIndicator } from "./computerUpgradeIndicator";
import type { ComputerAttentionMachine } from "./computerUpgradeIndicator";

/**
 * Raft DS › Attention dots (raft-design #620, design/products/raft-chat
 * "Attention dots"): a Computer's attention dot marks a change you have not
 * seen, not a lasting state.
 *
 * The model is a "seen" set of (computerId, attentionState) pairs:
 *   - each machine contributes one pair per attention state it is in
 *     (`upgrade`: an update waiting; `offline`) — the same conditions
 *     `countMachinesNeedingAttention` counts;
 *   - the dot is lit while any current pair is not in the seen set;
 *   - opening the Computers page marks every current pair seen;
 *   - a pair that is no longer current is dropped from the seen set, so a
 *     computer that comes back online and later goes offline again lights
 *     the dot again.
 *
 * Seeing only hides the dot. The Computers page rows and counts do not read
 * any of this.
 */
export type ComputerAttentionState = "upgrade" | "offline" | "attention";

const PAIR_SEPARATOR = "\u0000";
const KEY_SEPARATOR = "\n";

function attentionPair(machineId: string, state: ComputerAttentionState): string {
  return `${machineId}${PAIR_SEPARATOR}${state}`;
}

/** Every (id, state) pair the machines are in now, sorted for stable keys. */
export function computerAttentionPairs(
  machines: readonly ComputerAttentionMachine[],
): string[] {
  const pairs: string[] = [];
  for (const machine of machines) {
    // #68: the server's summary, when sent, is the one attention state.
    const needs = serverNeedsAttention(machine);
    if (needs !== undefined) {
      if (needs) pairs.push(attentionPair(machine.id, "attention"));
      continue;
    }
    if (shouldShowComputerUpgradeIndicator(machine)) pairs.push(attentionPair(machine.id, "upgrade"));
    if (machine.status === "offline") pairs.push(attentionPair(machine.id, "offline"));
  }
  return pairs.sort();
}

/**
 * The current pairs as one string: a primitive store selector, so a
 * subscriber re-renders only when the set of attention pairs changes, not on
 * every machine heartbeat.
 */
export function computerAttentionKey(machines: readonly ComputerAttentionMachine[]): string {
  return computerAttentionPairs(machines).join(KEY_SEPARATOR);
}

export function parseComputerAttentionKey(key: string): string[] {
  return key === "" ? [] : key.split(KEY_SEPARATOR);
}

/** The dot: any current pair not yet seen. */
export function hasUnseenComputerAttention(
  currentPairs: readonly string[],
  seen: readonly string[],
): boolean {
  if (currentPairs.length === 0) return false;
  const seenSet = new Set(seen);
  return currentPairs.some((pair) => !seenSet.has(pair));
}

/** Opening Computers: everything in view now is seen. */
export function markComputerAttentionSeen(currentPairs: readonly string[]): string[] {
  return [...currentPairs];
}

/**
 * Drop seen pairs that are no longer current, so leaving an attention state
 * and re-entering it lights the dot again. Only call with a loaded machine
 * list; an empty pre-load list would forget everything.
 */
export function pruneComputerAttentionSeen(
  seen: readonly string[],
  currentPairs: readonly string[],
): string[] {
  const current = new Set(currentPairs);
  return seen.filter((pair) => current.has(pair));
}

export function sameComputerAttentionPairs(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((pair) => set.has(pair));
}

// ── Persistence: per user, per server, per device (localStorage) ──────────
// Same best-effort stance as mobileAppBadge.ts: a storage failure falls to
// "unseen" (a dot that reappears), never to a dot that cannot show.

const STORAGE_PREFIX = "slock:computers-attention:seen";

export function computerAttentionSeenStorageKey(userId: string, serverId: string): string {
  return `${STORAGE_PREFIX}:${userId}:${serverId}`;
}

export function readComputerAttentionSeen(storageKey: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((pair): pair is string => typeof pair === "string") : [];
  } catch {
    return [];
  }
}

export function writeComputerAttentionSeen(storageKey: string, pairs: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    if (pairs.length === 0) window.localStorage.removeItem(storageKey);
    else window.localStorage.setItem(storageKey, JSON.stringify(pairs));
  } catch {
    // Best-effort: the in-memory store already holds the change for this session.
  }
}
