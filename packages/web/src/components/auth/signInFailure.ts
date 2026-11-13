/**
 * A password sign-in that failed in the page, not at the API (#triage:#165):
 * the server answered, then the page threw while reading that answer, and all
 * anyone saw was "Sign-in failed" with nothing in any trace. Such a failure is
 * reported (slock.client_error, capture_source `sign_in`; the site says
 * whether the second step's challenge couldn't be read, as error names are a
 * closed set), and its trace id
 * stays with the error so the sign-in page can show it.
 */
import { isAxiosError } from "axios";

import { reportClientError } from "../../utils/clientErrorTrace";
import { accountLinkErrorCode } from "../../utils/pendingAccountLink";
import { traceIdFromError } from "../../utils/requestTraceId";
import { SecondFactorChallengeUnreadableError } from "./secondFactorSignIn";

const reportedTraceIds = new WeakMap<object, string>();

/** Where it failed: reading the first step's answer, or storing the session the second step's answer carries. */
export type SignInFailureSite = "login.answer" | "login.second_factor_answer";

export function noteSignInFailure(error: unknown, site: SignInFailureSite = "login.answer"): void {
  if (!error || typeof error !== "object") return;
  // The request failed (no answer, or an error answer): the request's own trace and the server's message cover it.
  if (isAxiosError(error) || (error as { response?: unknown }).response) return;
  // An account link that wasn't made is an answer, shown as such (useAccountLinkSignIn).
  if (accountLinkErrorCode(error)) return;
  console.error("[sign-in] reading the sign-in answer failed", error);
  const reportedSite = error instanceof SecondFactorChallengeUnreadableError ? "login.second_factor_challenge" : site;
  const traceId = reportClientError({ source: "sign_in", site: reportedSite, error });
  if (traceId) reportedTraceIds.set(error, traceId);
}

/** The trace id to show under a failed sign-in: the page's own report, else the request's. */
export function signInFailureTraceId(error: unknown): string | null {
  const reported = error && typeof error === "object" ? reportedTraceIds.get(error) : undefined;
  return reported ?? traceIdFromError(error);
}
