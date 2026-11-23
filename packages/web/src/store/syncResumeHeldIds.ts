// Messages this page received live (`message:new`) since it adopted its
// current syncHorizon (#triage:#553). The next `sync:resume` sends them as
// `heldIds` so its late arm leaves them out instead of sending them back.
// Tied to the horizon value: replacing the horizon (a resume response, the
// starting horizon, a server reset) starts a new set (messageStore calls
// resetLiveHeldIds). Over the cap the set overflows and sends none (the full
// late arm) until the horizon is replaced. Module state, never persisted.
export const SYNC_HELD_IDS_CAP = 200;
const liveHeldIds = new Set<string>();
let liveHeldIdsOverflowed = false;

// The server ignores the whole list if one id is not a UUID: odd ids are not held.
const HELD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function noteLiveHeldMessage(id: string): void {
  if (liveHeldIdsOverflowed || !HELD_ID_RE.test(id) || liveHeldIds.has(id)) return;
  liveHeldIds.add(id);
  if (liveHeldIds.size > SYNC_HELD_IDS_CAP) {
    liveHeldIds.clear();
    liveHeldIdsOverflowed = true;
  }
}

export function resetLiveHeldIds(): void {
  liveHeldIds.clear();
  liveHeldIdsOverflowed = false;
}

/** The ids to send as `heldIds` with the current horizon; null = send none. */
export function liveHeldIdsForResume(): string[] | null {
  if (liveHeldIdsOverflowed || liveHeldIds.size === 0) return null;
  return [...liveHeldIds];
}

/** The `sync:resume` payload for this page, or null when it has nothing to resume from. */
export function syncResumePayload({ lastSeq, syncHorizon }: { lastSeq: number; syncHorizon: string | null }) {
  if (lastSeq <= 0) return null;
  if (syncHorizon === null) return { lastSeq };
  // heldIds only with sinceHorizon: they are relative to it.
  const heldIds = liveHeldIdsForResume();
  return { lastSeq, sinceHorizon: syncHorizon, ...(heldIds ? { heldIds } : {}) };
}
