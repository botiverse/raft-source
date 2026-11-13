import { useIntl } from "react-intl";
import { DescriptionDetails, DescriptionItem, DescriptionTerm } from "@botiverse/raft-ui";
import { useAuthStore } from "../../store/authStore";
import type { AgentMigrationNotice } from "./realtime";
import { migrationRetryComparisonRows } from "./retryComparison";

/**
 * The agent's own retry on the card: the retry line directly above the size
 * rows (Kirby, #wg-agent-migration 7746de27 msg 485ccb14). Logic: ./retryComparison.
 */

/** The line that says the agent retried this migration, and for whom. */
export function MigrationRetryNote({ notice, agentName, className }: {
  notice: AgentMigrationNotice;
  agentName: string;
  className?: string;
}) {
  const { formatMessage } = useIntl();
  const currentUserId = useAuthStore((state) => state.user?.id ?? null);
  const starter = notice.initiatedBy ?? null;
  const starterName = starter ? starter.displayName || starter.name : "";
  return (
    <p className={["text-callout text-foreground-muted", className].filter(Boolean).join(" ")} data-testid="agent-migration-retry-note">
      {formatMessage(
        { id: "agent.migration.retry.note" },
        {
          agent: agentName,
          // The copy selects on who it is, not on the name: a name could be anything.
          starter: !starter ? "none" : starter.id === currentUserId ? "you" : "named",
          name: starterName,
        },
      )}
    </p>
  );
}

/** The size rows, as items of the card's DescriptionList. */
export function MigrationRetryComparisonItems({ notice }: { notice: AgentMigrationNotice }) {
  const { formatMessage } = useIntl();
  const rows = migrationRetryComparisonRows(notice, formatMessage);
  return (
    <>
      {rows.failedAttempt ? (
        <DescriptionItem>
          <DescriptionTerm>{formatMessage({ id: "agent.migration.retry.failedAttempt" })}</DescriptionTerm>
          <DescriptionDetails data-testid="agent-migration-retry-failed-size">{rows.failedAttempt}</DescriptionDetails>
        </DescriptionItem>
      ) : null}
      {rows.thisAttempt ? (
        <DescriptionItem>
          <DescriptionTerm>{formatMessage({ id: "agent.migration.retry.thisAttempt" })}</DescriptionTerm>
          <DescriptionDetails data-testid="agent-migration-retry-packed-size">{rows.thisAttempt}</DescriptionDetails>
        </DescriptionItem>
      ) : null}
    </>
  );
}
