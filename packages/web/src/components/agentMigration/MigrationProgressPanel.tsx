import { useLayoutEffect, useState } from "react";
import { useIntl } from "react-intl";
import { Button, DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm, Spinner, Step, Steps } from "@botiverse/raft-ui";
import type { StepStatus } from "@botiverse/raft-ui";
import Banner from "../ui/Banner";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { Machine } from "../../store/machineStore";
import {
  endedComputerMigration,
  hostedArrivalAttentionReason,
  migrationNoticePresentation,
  migrationNoticeTargetLabel,
  migrationTargetLabel,
} from "./presentation";
import type { AgentMigrationNotice } from "./realtime";
import {
  HOSTED_MIGRATION_PROGRESS_STEPS,
  MIGRATION_PROGRESS_STEPS,
  canCancelMigration,
  hostedMigrationProgressStep,
  isActiveMigrationState,
  isCanceledMigrationState,
  isCompletedMigrationState,
  isFailedMigrationState,
  isHostedMigration,
  isHostedReviewPending,
  migrationProgressStep,
} from "./state";
import { HostedMigrationReview } from "./HostedMigrationReview";
import { MigrationErrorContent } from "./MigrationErrorContent";
import { MigrationReference, MigrationReferenceValue } from "./MigrationReference";
import { MigrationRetryComparisonItems, MigrationRetryNote } from "./MigrationRetry";
import { hasMigrationRetryComparison, isAgentMigrationRetry } from "./retryComparison";

// A move to the cloud names its target in the copy itself ("the cloud" reads
// differently from a computer name in both locales), so it has its own headers.
const COMPUTER_HEADER_IDS = {
  completed: "agent.detail.movedToTarget",
  canceled: "agent.detail.migrationToTargetCanceled",
  needsAttention: "agent.detail.migrationToTargetNeedsAttention",
  canceling: "agent.detail.cancelingMigrationToTarget",
  active: "agent.detail.movingToTarget",
  idle: "agent.detail.migrationToTarget",
  progress: "agent.detail.migrationProgressToTarget",
} as const;
const HOSTED_HEADER_IDS = {
  completed: "agent.migration.hosted.headerCompleted",
  canceled: "agent.migration.hosted.headerCanceled",
  needsAttention: "agent.migration.hosted.headerNeedsAttention",
  canceling: "agent.migration.hosted.headerCanceling",
  active: "agent.migration.hosted.headerActive",
  idle: "agent.migration.hosted.headerIdle",
  progress: "agent.migration.hosted.progressLabel",
} as const;

export function MigrationProgressPanel({
  notice,
  agentName,
  machines,
  onShowCancel,
  onRefresh,
}: {
  notice: AgentMigrationNotice;
  /** The agent as its page names it, for the line on what the source waits for. */
  agentName: string;
  machines: Machine[];
  onShowCancel: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime, formatClock } = useTimeFormatter();
  // Steps lie in a row only when every label fits beside the others; otherwise
  // (phones, narrow profile panels, longer translations) they stack. The fit is
  // measured against the panel, never the window (raft-ui 0.23).
  // A callback ref, not a ref object: the panel can mount on an ended move
  // (no Steps) and show Steps once a new move starts, and the fit must be
  // measured whenever the list appears (Artea, task #62).
  const [stepsList, setStepsList] = useState<HTMLOListElement | null>(null);
  const rowFits = useStepsRowFits(stepsList);
  const narrow = !rowFits;
  const hosted = isHostedMigration(notice);
  const headerIds = hosted ? HOSTED_HEADER_IDS : COMPUTER_HEADER_IDS;
  const steps = hosted ? HOSTED_MIGRATION_PROGRESS_STEPS : MIGRATION_PROGRESS_STEPS;
  const target = migrationNoticeTargetLabel(formatMessage, machines, notice);
  const source = migrationTargetLabel(formatMessage, machines, notice.sourceMachineId);
  const reviewSummary = isHostedReviewPending(notice) ? notice.hosted?.importSummary ?? null : null;
  const presentation = migrationNoticePresentation(formatMessage, notice, machines, formatShortDateTime, { agentName, formatClock });
  const completed = isCompletedMigrationState(notice.state);
  // A switched move to the cloud that stalled is not over, but it needs attention like a failure.
  const failed = isFailedMigrationState(notice.state)
    || (notice.state === "starting" && notice.failureReason === "auto_start_failed")
    || hostedArrivalAttentionReason(notice) !== null;
  const canceled = isCanceledMigrationState(notice.state);
  const active = isActiveMigrationState(notice.state);
  const currentStep = hosted ? hostedMigrationProgressStep(notice) : migrationProgressStep(notice);
  const cancelRequested = notice.state.startsWith("cancel_requested_");
  const agentRetry = isAgentMigrationRetry(notice);
  const stepStatus: StepStatus = completed
    ? "finish"
    : failed || notice.cancelNeedsAttention
      ? "error"
      : canceled
        ? "wait"
        : "process";
  // The step the move is working on spins in place of its number, as on
  // mobile (AgentMigrationStepsModel); a move waiting for the user's review
  // is not working, so it keeps the number.
  const runningStep = active && !isHostedReviewPending(notice) && stepStatus === "process" ? currentStep : null;
  const headerMessageId = completed
    ? headerIds.completed
    : canceled
      ? headerIds.canceled
      : failed || notice.cancelNeedsAttention
        ? headerIds.needsAttention
        : cancelRequested
          ? headerIds.canceling
          : active
            ? headerIds.active
            : headerIds.idle;

  const stepList = (
    <Steps
      ref={setStepsList}
      vertical={narrow}
      current={completed ? steps.length : currentStep + 1}
      status={stepStatus}
      finishLabel={formatMessage({ id: "agent.migration.stepDone" })}
      errorLabel={formatMessage({ id: "agent.migration.stepFailed" })}
      aria-label={formatMessage({ id: headerIds.progress }, { target })}
    >
      {steps.map((labelId, index) => (
        <Step
          key={labelId}
          title={formatMessage({ id: labelId })}
          icon={index === runningStep ? <Spinner size="xs" aria-hidden="true" data-testid="agent-migration-step-spinner" /> : undefined}
        />
      ))}
    </Steps>
  );

  // A failed move between computers (the expanded "Last migration" section):
  // the steps, stopped at the one that failed, then why, then the reference.
  // The section's summary line already names the move, so the banner has no title.
  if (endedComputerMigration(notice) === "failed") {
    return (
      <div className="flex flex-col gap-3" data-testid="agent-migration-ended">
        {stepList}
        <Banner intent="warning" density="sm" withIcon live={false}>
          {/* Where the agent is now, then why: a late failure leaves it on the target. */}
          {presentation.placement ? <p>{presentation.placement}</p> : null}
          <p>{presentation.message}</p>
          {/* The agent had one retry and this was it: the next move is a person's. */}
          {agentRetry ? <p>{formatMessage({ id: "agent.migration.retry.alsoFailed" }, { agent: agentName })}</p> : null}
        </Banner>
        {/* The retry block: its line directly above the size rows. */}
        {agentRetry ? <MigrationRetryNote notice={notice} agentName={agentName} /> : null}
        <DescriptionList direction="horizontal">
          <MigrationRetryComparisonItems notice={notice} />
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "agent.migration.referenceLabel" })}</DescriptionTerm>
            <DescriptionDetails><MigrationReferenceValue notice={notice} /></DescriptionDetails>
          </DescriptionItem>
        </DescriptionList>
      </div>
    );
  }

  return (
    <section aria-label={formatMessage({ id: headerIds.idle }, { target })}>
      <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-start justify-between gap-3">
        <h3 className="min-w-0 break-words text-subhead font-semibold text-foreground">
          {formatMessage({ id: headerMessageId }, { target })}
        </h3>
      </div>

      {stepList}

      {/* Problems keep the warning banner; normal progress is plain text. */}
      {failed || notice.cancelNeedsAttention ? (
        <Banner
          intent="warning"
          density="sm"
          title={failed || cancelRequested ? presentation.title : undefined}
          aria-live="polite"
        >
          <MigrationErrorContent presentation={presentation} />
        </Banner>
      ) : (
        <div aria-live="polite" className="text-callout text-foreground-muted">
          {cancelRequested && presentation.title ? <p className="font-semibold text-foreground">{presentation.title}</p> : null}
          <p>{presentation.message}</p>
        </div>
      )}
      {/* The retry block, after the status line so the Steps stay under the title. */}
      {agentRetry ? <MigrationRetryNote notice={notice} agentName={agentName} /> : null}
      {agentRetry && hasMigrationRetryComparison(notice, formatMessage) ? (
        <DescriptionList direction="horizontal" data-testid="agent-migration-retry-comparison">
          <MigrationRetryComparisonItems notice={notice} />
        </DescriptionList>
      ) : null}
      {/* The reference is for support, so it only appears when something needs attention. */}
      {failed || notice.cancelNeedsAttention ? <MigrationReference notice={notice} /> : null}
      {reviewSummary ? (
        <HostedMigrationReview
          notice={notice}
          summary={reviewSummary}
          source={source}
          deadline={notice.transferDeadlineAt ? formatShortDateTime(notice.transferDeadlineAt) : null}
          onShowCancel={onShowCancel}
          onRefresh={onRefresh}
        />
      ) : null}
      {/* While the review waits, its own Cancel sits beside Confirm. */}
      {active && !reviewSummary && canCancelMigration(notice) ? (
        <div className="flex justify-end">
          <Button variant="outline" size="md" type="button" onClick={onShowCancel}>
            {formatMessage({ id: "agent.detail.cancel" })}
          </Button>
        </div>
      ) : null}
      </div>
    </section>
  );
}

/**
 * Whether the Steps fit on one row: the labels' natural widths plus markers,
 * gaps and the minimum connectors, against the width available to the list.
 * Measured the same way in both layouts, so switching cannot oscillate.
 */
function useStepsRowFits(list: HTMLOListElement | null): boolean {
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const host = list?.parentElement;
    if (!list || !host || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const styles = getComputedStyle(list);
      const px = (name: string) => Number.parseFloat(styles.getPropertyValue(name)) || 0;
      const steps = [...list.querySelectorAll<HTMLElement>('[data-slot="step"]')];
      if (steps.length === 0) return;
      let needed = (steps.length - 1) * (px("--r-steps-connector-min-width") + 2 * px("--r-steps-connector-gap"));
      const range = document.createRange();
      // Text extent, not box width: a stacked title stretches to the row.
      const textWidth = (el: HTMLElement | null) => {
        if (!el) return 0;
        range.selectNodeContents(el);
        return range.getBoundingClientRect().width;
      };
      for (const step of steps) {
        const indicator = step.querySelector<HTMLElement>('[data-slot="step-indicator"]');
        const title = step.querySelector<HTMLElement>('[data-slot="step-title"]');
        needed += (indicator?.offsetWidth ?? 0) + px("--r-steps-gap") + textWidth(title);
      }
      setFits(needed <= host.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [list]);
  return fits;
}
