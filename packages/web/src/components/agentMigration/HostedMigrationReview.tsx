import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  TextMono,
} from "@botiverse/raft-ui";
import type { AgentMigrationHostedImportSummary, AgentMigrationHostedSkipReason } from "@botiverse/raft-shared";
import api from "../../api/client";
import Banner from "../ui/Banner";
import type { MessageId } from "../../i18n/messages";
import { formatFileSizeBytes } from "../../utils/fileSizePresentation";
import type { MigrationErrorPresentation } from "./errors";
import { migrationErrorPresentation } from "./errors";
import type { AgentMigrationNotice } from "./realtime";
import { canCancelMigration } from "./state";
import { MigrationErrorContent } from "./MigrationErrorContent";

/** How many of a reason's largest skipped paths the review names. */
const PATHS_PER_REASON = 5;

const SKIP_REASON_IDS = {
  symlink: "agent.migration.hosted.skip.symlink",
  git: "agent.migration.hosted.skip.git",
  raft_state: "agent.migration.hosted.skip.raftState",
  path_rule: "agent.migration.hosted.skip.pathRule",
  reserved: "agent.migration.hosted.skip.reserved",
  file_too_large: "agent.migration.hosted.skip.fileTooLarge",
  not_text: "agent.migration.hosted.skip.notText",
  over_budget: "agent.migration.hosted.skip.overBudget",
  provider_rejected: "agent.migration.hosted.skip.providerRejected",
} as const satisfies Record<AgentMigrationHostedSkipReason, MessageId>;

function migrationErrorCode(error: unknown): string | undefined {
  return (error as { response?: { data?: { code?: string } } } | null)?.response?.data?.code;
}

/**
 * What a move to the cloud brings over and what it leaves behind, with the
 * final Confirm. The revision the review was shown at goes with the confirm;
 * a stale one re-reads the status so the user confirms what is current.
 */
export function HostedMigrationReview({
  notice,
  summary,
  source,
  deadline,
  onShowCancel,
  onRefresh,
}: {
  notice: AgentMigrationNotice;
  summary: AgentMigrationHostedImportSummary;
  source: string;
  deadline: string | null;
  onShowCancel: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<MigrationErrorPresentation | null>(null);
  const skipped = summary.skipped.filter((group) => group.count > 0);

  const confirm = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/agents/${notice.agentId}/migration/confirm-hosted`, {
        migrationRef: notice.migrationRef,
        expectedRevision: notice.revision,
      });
      await onRefresh();
    } catch (err: unknown) {
      const code = migrationErrorCode(err);
      const e = err as { response?: { data?: { error?: string } }; message?: string } | null;
      setError(migrationErrorPresentation({
        code,
        rawMessage: e?.response?.data?.error ?? e?.message,
        context: "status",
      }, formatMessage));
      // Stale or no longer waiting: show what the migration is now.
      await onRefresh();
    } finally {
      setSubmitting(false);
    }
  }, [formatMessage, notice.agentId, notice.migrationRef, notice.revision, onRefresh]);

  return (
    // DS Card + stacked PropertyList (labels above values) for the narrow profile column.
    <Card aria-labelledby="hosted-migration-review-title" data-testid="hosted-migration-review">
      <CardHeader>
        <CardTitle id="hosted-migration-review-title">
          {formatMessage({ id: "agent.migration.hosted.reviewTitle" })}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <DescriptionList>
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "agent.migration.hosted.reviewImportedTerm" })}</DescriptionTerm>
            <DescriptionDetails data-testid="hosted-migration-review-imported">
              {formatMessage(
                { id: "agent.migration.hosted.reviewFileCount" },
                { files: summary.importedFileCount, size: formatFileSizeBytes(summary.importedBytes, formatMessage) },
              )}
            </DescriptionDetails>
          </DescriptionItem>
          {skipped.length === 0 ? (
            <DescriptionItem>
              <DescriptionTerm>{formatMessage({ id: "agent.migration.hosted.reviewSkippedNone" })}</DescriptionTerm>
              <DescriptionDetails>{formatMessage({ id: "agent.migration.hosted.reviewNothingSkipped" })}</DescriptionDetails>
            </DescriptionItem>
          ) : skipped.map((group) => {
            const shown = group.largestPaths.slice(0, PATHS_PER_REASON);
            const more = group.count - shown.length;
            return (
              <DescriptionItem key={group.reason} data-testid="hosted-migration-review-skipped">
                <DescriptionTerm>
                  {formatMessage(
                    { id: "agent.migration.hosted.reviewSkippedTerm" },
                    { reason: formatMessage({ id: SKIP_REASON_IDS[group.reason] ?? "agent.migration.hosted.skip.other" }) },
                  )}
                </DescriptionTerm>
                <DescriptionDetails>
                  {formatMessage(
                    { id: "agent.migration.hosted.reviewFileCount" },
                    { files: group.count, size: formatFileSizeBytes(group.bytes, formatMessage) },
                  )}
                </DescriptionDetails>
                {shown.length > 0 ? (
                  // Plain list: raft-ui has no non-markdown list primitive; each path is DS mono meta text.
                  <dd className="m-0">
                    <ul className="stack-y-0.5">
                      {shown.map((path) => (
                        <TextMono key={path} size="meta" variant="muted" className="break-all" render={<li />}>
                          {path}
                        </TextMono>
                      ))}
                      {more > 0 ? (
                        <li className="text-caption text-foreground-hint">
                          {formatMessage({ id: "agent.migration.hosted.reviewMorePaths" }, { count: more })}
                        </li>
                      ) : null}
                    </ul>
                  </dd>
                ) : null}
              </DescriptionItem>
            );
          })}
        </DescriptionList>
        <p className="text-callout text-foreground">
          {formatMessage({ id: "agent.migration.hosted.reviewFinal" }, { source })}
        </p>
        {deadline ? (
          <p className="text-caption text-foreground-hint">
            {formatMessage({ id: "agent.migration.hosted.reviewDeadline" }, { deadline, source })}
          </p>
        ) : null}
        {error ? (
          <Banner intent="warning" density="sm">
            <MigrationErrorContent presentation={error} />
          </Banner>
        ) : null}
      </CardContent>
      <CardFooter className="flex justify-end gap-2">
        <Button variant="outline" size="md" type="button" onClick={onShowCancel} disabled={submitting || !canCancelMigration(notice)}>
          {formatMessage({ id: "agent.detail.cancel" })}
        </Button>
        <Button variant="accent" size="md" type="button" onClick={confirm} disabled={submitting} aria-busy={submitting}>
          {submitting
            ? formatMessage({ id: "agent.migration.hosted.confirming" })
            : formatMessage({ id: "agent.migration.hosted.confirm" })}
        </Button>
      </CardFooter>
    </Card>
  );
}
