/**
 * What the Delete Account page and its verify dialog share: the request's
 * outcome as a step sees it, how a step words a failed request, and the
 * sign-out a scheduled deletion (or Sign In Again) ends in. Also how the
 * deletion pages write the deletion date and the days left (v7).
 */
import { useCallback } from "react";
import { useIntl } from "react-intl";

import { useTimeFormatter } from "../../../hooks/useTimeFormatter";
import { cachedDateTimeFormat } from "../../../utils/timeFormatting";
import { secondFactorFailureOf } from "../../../components/settings/secondFactorApi";
import { useFailureCopy } from "../../../components/settings/secondFactorAnswer";
import type { FailureCopy } from "../../../components/settings/secondFactorAnswer";
import { clearAccountDeletionPending } from "../../../store/accountDeletionPending";
import { useAuthStore } from "../../../store/authStore";
import type { AccountDeletionProof } from "./accountDeletionApi";

/** What a step does with a failed request: another step took over, Sign In Again, or the error to show. */
export type Outcome = { kind: "moved" } | { kind: "sign_in_again" } | { kind: "failed"; err: unknown };

/** Sends the request; "moved" once another phase took over, the scheduled confirmation included. */
export type Submit = (proof: AccountDeletionProof) => Promise<Outcome>;

/** The failures the existing step-up copy words (a wrong password, a lock); anything else is "couldn't delete". */
const STEP_UP_FAILURE_CODES = new Set(["password_incorrect", "reauth_locked", "second_factor_locked"]);

/**
 * Every sign-in is gone once the deletion is scheduled: sign out the way Sign
 * Out does. That logout (explicit_user_logout) is also what tells a host shell,
 * the App's in-app WebView, with `session:logout` (embed/hostBridge.ts).
 */
export function signOutAfterDeletion(): void {
  useAuthStore.getState().logout();
  // The confirmation (or the pending page) gives way to the sign-in page.
  clearAccountDeletionPending();
}

/** Where a step shows a failed request: the field's error and a banner, or Sign In Again. */
export function useStepFailure() {
  const { formatMessage } = useIntl();
  const describeStepUp = useFailureCopy();
  return useCallback((outcome: Outcome | null, answer: "password" | "totp"): { failure: FailureCopy; signInAgain: boolean } => {
    if (!outcome || outcome.kind === "moved") return { failure: {}, signInAgain: false };
    if (outcome.kind === "sign_in_again") return { failure: {}, signInAgain: true };
    const code = secondFactorFailureOf(outcome.err).code;
    if (code === "email_code_invalid") return { failure: { field: formatMessage({ id: "accountDeletion.emailCodeInvalid" }) }, signInAgain: false };
    if (code && STEP_UP_FAILURE_CODES.has(code)) return { failure: describeStepUp(outcome.err, answer), signInAgain: false };
    return { failure: { banner: formatMessage({ id: "accountDeletion.failed" }) }, signInAgain: false };
  }, [describeStepUp, formatMessage]);
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * The deletion date as v7 writes it, the day alone ("November 9"), in the
 * person's time zone; "" for none. The date always comes from the server's
 * `scheduledFor`, never from a grace period counted here.
 */
export function useDeletionDate(): (scheduledFor: string | null | undefined) => string {
  const { options } = useTimeFormatter();
  return useCallback((scheduledFor) => {
    const date = scheduledFor ? new Date(scheduledFor) : null;
    if (!date || Number.isNaN(date.getTime())) return "";
    return cachedDateTimeFormat(options.locale, { month: "long", day: "numeric", timeZone: options.timeZone || undefined }).format(date);
  }, [options.locale, options.timeZone]);
}

/** Whole days until `scheduledFor`, rounded up (a deletion later today is 1 day away); null for none. */
export function daysUntilDeletion(scheduledFor: string | null | undefined, now: Date): number | null {
  const at = scheduledFor ? new Date(scheduledFor).getTime() : Number.NaN;
  if (Number.isNaN(at)) return null;
  return Math.max(Math.ceil((at - now.getTime()) / DAY_MS), 0);
}
