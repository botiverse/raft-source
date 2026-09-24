import { cliError } from "../core/errors.js";

export const REVIEWER_ISOLATION_ENV = "RAFT_REVIEWER_ISOLATION";

export interface ReviewerIsolationOpts {
  reviewerIsolation?: boolean;
}

export const reviewerIsolationOption = {
  flags: "--reviewer-isolation",
  description:
    "Blind-review seat: keep freshness holds body-free (also enabled by RAFT_REVIEWER_ISOLATION=1)",
} as const;

export function reviewerIsolationEnabled(
  opts: ReviewerIsolationOpts,
  env: NodeJS.ProcessEnv,
): boolean {
  if (opts.reviewerIsolation === true) return true;

  const raw = env[REVIEWER_ISOLATION_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  throw cliError(
    "INVALID_ARG",
    `${REVIEWER_ISOLATION_ENV} must be one of: 1, true, 0, false; got ${env[REVIEWER_ISOLATION_ENV]}`,
  );
}
