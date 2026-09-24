import { accountNeedsIdentitySetup } from "@botiverse/raft-shared";
import type { User } from "../store/authStore";

// `requiresSignupSurvey` used to live here, from when the survey was a page between email
// verification and identity setup. It has exactly one home now: the server-driven setup gate
// (ServerSetupProjectionGate), whose eligibility already answers "is this survey owed?" —
// owner-only, and only for a server completed through the real flow, so a grandfathered
// account is never asked. Keeping a second, client-side predicate on `signupSurveyCompletedAt
// === null` would be a rival opinion that can only ever drift: it would have forced a legacy
// user whose backfill row was missed into a signup question years after they signed up.
// One gate, one answer (@Dozy / @Jianwei, 2026-07-13).

export function requiresAccountProfileSetup(user: User | null): boolean {
  if (!user || !user.emailVerified) return false;
  // A NULL stamp on an account that already HAS a handle is a missing record, not a missing
  // person: the 0170 backfill missed the row. Forcing them back through signup would ask a
  // long-standing user to re-pick a username they cannot change (@Jianwei, 2026-07-13).
  return accountNeedsIdentitySetup(user);
}
