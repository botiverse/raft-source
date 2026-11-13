// Held-send drafts. The policy (one draft per target, TTL, rehold counter,
// seen snapshot with sparse exact seqs) is shared
// (shared/src/agentOps/seenPolicy/drafts.ts); this module is the CLI's
// synchronous facade over it, backed by the agent ledger
// (`src/state/commandStateStore.ts` over `src/state/agentLedger.ts`, RFC 072
// R1). Legacy tmpdir state is imported once on first ledger miss. The ledger's
// atomic keyed delete replaces the old file lock: no cross-process mutex is
// needed to keep compare-and-clear safe.
import {
  clearSavedDraft as clearSharedSavedDraft,
  clearSavedDraftIfIdempotencyKeyMatches as clearSharedSavedDraftIfIdempotencyKeyMatches,
  expectSync,
  LOCAL_DRAFT_TTL_MINUTES,
  lookupSavedDraft as lookupSharedSavedDraft,
  savedDraftCauseOf,
  setSavedDraft as setSharedSavedDraft,
  type CommandStateDraftEntry,
  type SavedDraft,
  type SavedDraftCause,
  type SavedDraftLookup,
} from "@botiverse/raft-shared/src/agentOps/seenPolicy/index";

import { createCliCommandStateStore } from "../../state/commandStateStore";

export { LOCAL_DRAFT_TTL_MINUTES, type SavedDraft, type SavedDraftCause, type SavedDraftLookup };

const store = (agentId: string) => createCliCommandStateStore(agentId, process.env);

/** Who a draft found expired was, without its body (`cli.draft.resolved`). */
export interface ExpiredDraftIdentity {
  idempotencyKey?: string;
  savedAt: number;
  reholdCount: number;
  cause?: SavedDraftCause;
}

export type OnDraftExpired = (draft: ExpiredDraftIdentity) => void;

export function getSavedDraft(agentId: string, target: string, onExpired?: OnDraftExpired): SavedDraft | null {
  const lookup = lookupSavedDraft(agentId, target, onExpired);
  return lookup.status === "found" ? lookup.draft : null;
}

/**
 * `onExpired` hears about a draft this lookup found past its TTL (and
 * discarded). The shared lookup reports only the body of an expired draft, so
 * the entry it read is kept here for the draft's key and rehold count.
 */
export function lookupSavedDraft(agentId: string, target: string, onExpired?: OnDraftExpired): SavedDraftLookup {
  const ledger = store(agentId);
  const read: { draft?: CommandStateDraftEntry } = {};
  const lookup = expectSync(lookupSharedSavedDraft(
    onExpired ? { ...ledger, readDraft: (key) => (read.draft = ledger.readDraft(key)) } : ledger,
    target,
    () => Date.now(),
  ));
  if (onExpired && lookup.status === "expired") {
    const stored = read.draft;
    const idempotencyKey = typeof stored?.idempotencyKey === "string" ? stored.idempotencyKey.trim() : "";
    const cause = savedDraftCauseOf(stored?.cause);
    onExpired({
      ...(idempotencyKey ? { idempotencyKey } : {}),
      savedAt: lookup.savedAt,
      reholdCount: stored && Number.isFinite(stored.reholdCount) ? stored.reholdCount : 0,
      ...(cause ? { cause } : {}),
    });
  }
  return lookup;
}

export function setSavedDraft(agentId: string, target: string, draft: SavedDraft): void {
  expectSync(setSharedSavedDraft(store(agentId), target, draft));
}

export function clearSavedDraft(agentId: string, target: string): void {
  expectSync(clearSharedSavedDraft(store(agentId), target));
}

/** Clear the draft only when it still carries this idempotency key (#7646). */
export function clearSavedDraftIfIdempotencyKeyMatches(
  agentId: string,
  target: string,
  idempotencyKey: string,
): boolean {
  return expectSync(clearSharedSavedDraftIfIdempotencyKeyMatches(store(agentId), target, idempotencyKey));
}

/** Clear the draft only when it is still the one saved at `savedAt` (`--discard-draft` without a key). */
export function clearSavedDraftIfSavedAt(agentId: string, target: string, savedAt: number): boolean {
  return expectSync(store(agentId).deleteDraftIfSavedAt(target, savedAt));
}
