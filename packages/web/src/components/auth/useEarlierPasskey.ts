/**
 * The state behind "Use an earlier passkey" (EarlierPasskey.tsx) in the
 * sign-in's second step and every step-up (passkeyRpGroups.ts): when the
 * passkey prompt ends in NotAllowedError (nothing to pick under the RP ID it
 * asked for, or closed) and its options named `otherRps`, `earlier` is that
 * group and the caller shows the line; its click prompts once with options
 * for it (`prompt(start, earlier)`). Never a second prompt on its own. 404
 * `passkey_rp_unavailable` for that group clears it; the error itself is the
 * caller's, as any other.
 */
import { useCallback, useState } from "react";

import { getApiErrorResponse } from "../../utils/apiErrorResponse";
import type { PasskeyRpGroup, StartedPasskeyAssertion } from "./passkeyRpGroups";
import { getPasskeyAssertion } from "./webauthn";
import type { PasskeyAssertionJSON } from "./webauthn";

/** Fetches assertion options: the server's default group, or `rp`. */
export type StartPasskeyAssertion = (rp?: PasskeyRpGroup) => Promise<StartedPasskeyAssertion>;

export function useEarlierPasskey() {
  // The group the line offers; null: no line.
  const [earlier, setEarlier] = useState<PasskeyRpGroup | null>(null);

  /** The browser's prompt for options from `start` (the default group, or `rp`); rejects as the prompt does. */
  const prompt = useCallback(async (start: StartPasskeyAssertion, rp?: PasskeyRpGroup): Promise<PasskeyAssertionJSON> => {
    let started: StartedPasskeyAssertion;
    try {
      started = await start(rp);
    } catch (err) {
      if (rp && getApiErrorResponse(err)?.code === "passkey_rp_unavailable") setEarlier(null);
      throw err;
    }
    try {
      return await getPasskeyAssertion(started.options);
    } catch (err) {
      const other = started.otherRps[0];
      if (!rp && other && err instanceof Error && err.name === "NotAllowedError") setEarlier(other);
      throw err;
    }
  }, []);

  return { earlier, prompt };
}
