/**
 * Passkeys under two RP IDs while they move from raft.build to app.raft.build
 * (#proj-landing:3bfc5b9c; server services/secondFactor/webauthn.ts). Every
 * assertion options request takes `rp: "current" | "legacy"` (default: the
 * person's passkeys under the current RP ID if any, else the legacy ones);
 * 404 `passkey_rp_unavailable` when the group asked for has none.
 *
 * The second step's and step-up's options also say `otherRps`: the other
 * group, present only while a legacy RP ID is set and the person has a
 * passkey there. The prompt that found nothing offers it
 * (useEarlierPasskey.ts). Not on the sign-in page's anonymous options, whose
 * `rp` alone says a legacy RP ID is set (usePasskeySignIn.ts).
 */
import type { PasskeyRequestOptionsJSON } from "./webauthn";

/** Which RP ID's passkeys a prompt offers. */
export type PasskeyRpGroup = "current" | "legacy";

/** Assertion options and the other groups the person also has passkeys in (may be empty). */
export interface StartedPasskeyAssertion {
  options: PasskeyRequestOptionsJSON;
  otherRps: PasskeyRpGroup[];
}

/** An options body's `otherRps`; unknown entries dropped, absent is empty. */
export function otherRpsOf(value: unknown): PasskeyRpGroup[] {
  return Array.isArray(value)
    ? value.filter((rp): rp is PasskeyRpGroup => rp === "current" || rp === "legacy")
    : [];
}

/** The request body's `rp`: only when a group is asked for (the server's default otherwise). */
export function rpBody(rp: PasskeyRpGroup | undefined): { rp?: PasskeyRpGroup } {
  return rp ? { rp } : {};
}
