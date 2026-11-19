/**
 * Step-up for sensitive actions (design v8 §3, dlg-stepup; server
 * services/secondFactor/stepUpGate.ts): with two-step verification on, the
 * server refuses changing the password, connecting or disconnecting a sign-in
 * method, creating an agent key or bootstrap token, executing an action card
 * whose kind needs a second factor (and later, more) with 403
 * `second_factor_step_up_required` and the methods, unless this sign-in
 * passed the second step in the last 10 minutes.
 *
 * `withSecondFactorStepUp(request)` runs the request; on that refusal it
 * opens the one "Verify it's you" dialog (SecondFactorStepUpHost, mounted
 * once in the app shell), and once POST /auth/second-factor/step-up passed it
 * runs the request once more and settles with that. Closing the dialog
 * rejects with SecondFactorStepUpCancelled: callers check
 * isSecondFactorStepUpCancelled and do nothing (no error shown). People
 * without two-step verification are never refused, so for them this is just
 * the request.
 *
 * `lostDevice` (a lost device's `lost_device` revoke, #triage:#386): the
 * dialog's Can't verify? offers resetting the password by email (or setting
 * one: every sign-in is revoked at once) and, with `signOut`, signing the
 * device(s) out with the password alone (`sign_out` needs no second step).
 * Choosing that rejects with SecondFactorStepUpSignOutInstead; the caller
 * sends `sign_out` instead.
 */
import { create } from "zustand";

import type { SignInSecondFactorMethod } from "../auth/secondFactorSignIn";
import { secondFactorFailureOf } from "./secondFactorApi";

/** What the dialog says the step-up is for (its description). */
export type StepUpReason = "signInMethod" | "agentKey" | "appAccess" | "agentAccess" | "secret" | "actionCard" | "signOutDevice" | "other";

export class SecondFactorStepUpCancelled extends Error {
  constructor() {
    super("second_factor_step_up_cancelled");
    this.name = "SecondFactorStepUpCancelled";
  }
}

export function isSecondFactorStepUpCancelled(err: unknown): err is SecondFactorStepUpCancelled {
  return err instanceof SecondFactorStepUpCancelled;
}

/** Can't verify? › Sign it out now with your password: nothing was sent; the caller signs out with `sign_out`. */
export class SecondFactorStepUpSignOutInstead extends Error {
  constructor() {
    super("second_factor_step_up_sign_out_instead");
    this.name = "SecondFactorStepUpSignOutInstead";
  }
}

export function isSecondFactorStepUpSignOutInstead(err: unknown): err is SecondFactorStepUpSignOutInstead {
  return err instanceof SecondFactorStepUpSignOutInstead;
}

/** Can't verify? for a lost device: what it may sign out with the password alone, and whether there is a password. */
export interface LostDeviceStepUp {
  /** One device, every other one, or none (no password, or nothing left to sign out). */
  signOut: "one" | "others" | null;
  /** false: the account has no password; the email sets a first one. */
  password: boolean;
}

/** true: this sign-in passed the second step (or no longer needs to); false: closed; "signOutInstead": see above. */
export type StepUpOutcome = boolean | "signOutInstead";

export interface PendingStepUp {
  methods: SignInSecondFactorMethod[];
  reason: StepUpReason;
  lostDevice?: LostDeviceStepUp;
  settle: (outcome: StepUpOutcome) => void;
}

export const useSecondFactorStepUpStore = create<{ pending: PendingStepUp | null }>(() => ({ pending: null }));

let mountedHosts = 0;
let inFlight: Promise<void> | null = null;

/** SecondFactorStepUpHost registers itself; without one, a refusal goes to the caller as before. */
export function registerSecondFactorStepUpHost(): () => void {
  mountedHosts += 1;
  return () => {
    mountedHosts -= 1;
  };
}

/** The methods of a 403 `second_factor_step_up_required`, or null for any other outcome. */
export function stepUpRequiredMethods(err: unknown): SignInSecondFactorMethod[] | null {
  const failure = secondFactorFailureOf(err);
  return failure.status === 403 && failure.code === "second_factor_step_up_required" ? failure.methods : null;
}

/** Opens the dialog, or joins the one already open (two refused requests, one step-up). */
function verifyItsYou(methods: SignInSecondFactorMethod[], reason: StepUpReason, lostDevice?: LostDeviceStepUp): Promise<void> {
  if (inFlight) return inFlight;
  const asked = new Promise<void>((resolve, reject) => {
    useSecondFactorStepUpStore.setState({
      pending: {
        methods,
        reason,
        ...(lostDevice ? { lostDevice } : {}),
        settle: (outcome) => {
          inFlight = null;
          useSecondFactorStepUpStore.setState({ pending: null });
          if (outcome === true) resolve();
          else reject(outcome === "signOutInstead" ? new SecondFactorStepUpSignOutInstead() : new SecondFactorStepUpCancelled());
        },
      },
    });
  });
  inFlight = asked;
  return asked;
}

/**
 * `request`, and after a step-up the same request once more (a second
 * refusal goes to the caller like any other error).
 */
export async function withSecondFactorStepUp<T>(
  request: () => Promise<T>,
  reason: StepUpReason = "other",
  options: { lostDevice?: LostDeviceStepUp } = {},
): Promise<T> {
  try {
    return await request();
  } catch (err) {
    const methods = stepUpRequiredMethods(err);
    if (!methods || mountedHosts === 0) throw err;
    await verifyItsYou(methods, reason, options.lostDevice);
    return request();
  }
}

/** Tests: no dialog left open between them. */
export function resetSecondFactorStepUpForTests(): void {
  useSecondFactorStepUpStore.getState().pending?.settle(false);
  inFlight = null;
  useSecondFactorStepUpStore.setState({ pending: null });
}
