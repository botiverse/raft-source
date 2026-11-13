import api from "../api/client";
import { useAuthStore } from "../store/authStore";
import type { Locale } from "./locale";

// Writeback half of the display_language loop. When called from the Settings
// display-language select (it applies at once), applies the chosen UI locale via `setLocale` (context +
// localStorage), then persists it to the user's account and merges the server's
// echo back so a subsequent read is consistent.
//
// Correctness under concurrency (the reason this is more than a one-liner):
//   - PRINCIPAL isolation: the target user id is snapshotted before the PATCH.
//     A response is only published if that same principal is still signed in —
//     so a request left in flight across a logout/login can never splice user A's
//     `/me` echo into user B's auth state.
//   - LAST-INTENT wins: each call takes a per-principal monotonic intent number;
//     a response is only published if it is still the latest intent for that
//     principal, so a stale echo can't clobber a newer selection.
//   - SERVER ordering: same-principal writes are serialized so the server's final
//     stored value is the last intent, not whichever request happened to land
//     last. Serialization is per-principal, so a hung request for one user never
//     blocks writes for another.
//
// A failed server write does not undo the local switch here; the result tells
// the caller, which decides (Settings puts the select back and says so).
//   "saved"      the account holds `next`
//   "local"      nobody is signed in: only this browser holds it
//   "superseded" a newer selection was made while this one was in flight
//   "failed"     the account write failed
export type PersistDisplayLanguageResult = "saved" | "local" | "superseded" | "failed";

// Per-principal monotonic intent counter and write chain. Keyed by user id;
// module-level so concurrent calls coordinate.
const latestIntentByPrincipal = new Map<string, number>();
const writeChainByPrincipal = new Map<string, Promise<void>>();

export async function persistDisplayLanguage(
  next: Locale,
  setLocale: (locale: Locale) => void,
): Promise<PersistDisplayLanguageResult> {
  // Optimistic local switch (context + storage) regardless of auth state.
  setLocale(next);

  const principalId = useAuthStore.getState().user?.id ?? null;
  // Not signed in → nothing to persist (PATCH /me requires auth). The local
  // switch stands and will persist once the user logs in and changes it.
  if (principalId == null) return "local";

  const myIntent = (latestIntentByPrincipal.get(principalId) ?? 0) + 1;
  latestIntentByPrincipal.set(principalId, myIntent);

  const prior = writeChainByPrincipal.get(principalId) ?? Promise.resolve();
  const run = prior
    .catch(() => {})
    .then(async (): Promise<PersistDisplayLanguageResult> => {
      try {
        const { data } = await api.patch("/auth/me", { displayLanguage: next });
        // Cross-principal guard: never publish into a different signed-in user.
        if ((useAuthStore.getState().user?.id ?? null) !== principalId) return "superseded";
        // Last-intent guard: a newer selection for this principal superseded us.
        if (latestIntentByPrincipal.get(principalId) !== myIntent) return "superseded";
        useAuthStore.setState((state) => ({ user: state.user ? { ...state.user, ...data } : data }));
        return "saved";
      } catch {
        // The local switch stays; the caller is told so it can put it back.
        return latestIntentByPrincipal.get(principalId) === myIntent ? "failed" : "superseded";
      }
    });
  writeChainByPrincipal.set(principalId, run.then(() => undefined));
  return run;
}
