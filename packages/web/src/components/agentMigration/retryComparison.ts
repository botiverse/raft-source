import type { IntlShape } from "react-intl";
import { formatMigrationSize } from "./errors";
import type { AgentMigrationNotice } from "./realtime";
import { isCompletedMigrationState, isFailedMigrationState } from "./state";

/**
 * The agent's own retry of a migration that failed for size (`raft migration
 * retry`): the server started it on behalf of the person who started the
 * failed one (CTO requirement, #wg-agent-migration 7746de27). On the card it is
 * one block: the retry line directly above the size rows (Kirby, msg 485ccb14).
 */
export function isAgentMigrationRetry(notice: AgentMigrationNotice): boolean {
  return Boolean(notice.retryOfMigrationId);
}

export interface MigrationRetryComparisonRows {
  /** What the failed attempt measured, or null when it measured nothing. */
  failedAttempt: string | null;
  /** What this attempt packed, or null while it is still packing. */
  thisAttempt: string | null;
}

/**
 * The two size rows. Both sides count the same thing: the source's entry limit
 * and this attempt's packed count are both the files (and symlinks) the
 * source would pack; folders are counted on neither side. Sizes are binary
 * (GiB), like the size-limit copy. While this attempt is still packing only
 * the failed attempt shows (the status line already says what is packed so far).
 */
export function migrationRetryComparisonRows(
  notice: AgentMigrationNotice,
  formatMessage: IntlShape["formatMessage"],
): MigrationRetryComparisonRows {
  const comparison = notice.retryComparison;
  if (!comparison) return { failedAttempt: null, thisAttempt: null };
  const failure = comparison.previousFailure;
  const failedAttempt = failure?.entries != null
    ? formatMessage({ id: "agent.migration.retry.files" }, { files: failure.entries })
    : failure?.bytes != null
      ? failure.bytesIsLowerBound
        ? formatMessage({ id: "agent.migration.retry.atLeast" }, { size: formatMigrationSize(failure.bytes) })
        : formatMigrationSize(failure.bytes)
      : null;
  const packed = comparison.packed;
  const values = packed ? { files: packed.files, size: formatMigrationSize(packed.bytes) } : null;
  const thisAttempt = !values
    ? null
    : packed?.final || isCompletedMigrationState(notice.state)
      ? formatMessage({ id: "agent.migration.retry.packed" }, values)
      // It stopped before its bundle was complete: what it had packed then.
      : isFailedMigrationState(notice.state)
        ? formatMessage({ id: "agent.migration.retry.packedWhenStopped" }, values)
        : null;
  return { failedAttempt, thisAttempt };
}

/** Whether the retry block has a size row to show. */
export function hasMigrationRetryComparison(
  notice: AgentMigrationNotice,
  formatMessage: IntlShape["formatMessage"],
): boolean {
  const rows = migrationRetryComparisonRows(notice, formatMessage);
  return Boolean(rows.failedAttempt || rows.thisAttempt);
}
