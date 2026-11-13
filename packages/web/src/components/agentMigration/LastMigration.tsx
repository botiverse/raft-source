import { useCallback, useId, useState } from "react";
import { useIntl } from "react-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import { DescriptionDetails, DescriptionItem, DescriptionList, DescriptionTerm, ListRowGroup, TextLink } from "@botiverse/raft-ui";
import type { ReactNode } from "react";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useProfileStore } from "../../store/profileStore";
import { useTimeFormatter } from "../../hooks/useTimeFormatter";
import type { Machine } from "../../store/machineStore";
import { lastMigrationFacts } from "./presentation";
import type { AgentMigrationNotice } from "./realtime";
import { MigrationProgressPanel } from "./MigrationProgressPanel";
import { MigrationReferenceValue } from "./MigrationReference";
import { MigrationRetryComparisonItems, MigrationRetryNote } from "./MigrationRetry";
import { isAgentMigrationRetry } from "./retryComparison";
import { isFailedMigrationState, isHostedMigration } from "./state";

/**
 * The last move between computers, inside the migration section between its
 * description and buttons. Folded it is one line (Last migration: from → to ·
 * who · when · outcome); the whole line toggles the details. A failure opens
 * by default because the user has to read why before trying again.
 */
export function LastMigration({
  notice,
  agentName,
  machines,
  onShowCancel,
  onRefresh,
}: {
  notice: AgentMigrationNotice;
  agentName: string;
  machines: Machine[];
  onShowCancel: () => void;
  onRefresh: () => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const { formatShortDateTime } = useTimeFormatter();
  const failed = isFailedMigrationState(notice.state);
  const [open, setOpen] = useState(failed);
  const detailsId = useId();
  const facts = lastMigrationFacts(formatMessage, machines, notice, formatShortDateTime);
  const Chevron = open ? ChevronDown : ChevronRight;
  // A computer this person can see opens its page; one deleted or out of
  // reach (or the cloud) stays text. The person who started it opens their
  // profile (cindyz, #triage:#98).
  const computerLink = (machineId: string | null | undefined, label: string, testId: string): ReactNode =>
    machineId && machines.some((machine) => machine.id === machineId)
      ? <ComputerLink machineId={machineId} label={label} testId={testId} />
      : label;
  const initiatedBy = notice.initiatedBy;

  return (
    <div className="mt-3" data-testid="agent-last-migration-section">
      {/* One row is the toggle: chevron, label, summary (the DS collapsible group pattern). */}
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-1.5 text-left text-caption text-foreground-muted"
        data-testid="agent-last-migration-toggle"
      >
        <Chevron className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="flex min-w-0 flex-wrap gap-x-2">
          {/* A small label inside the migration section, not a second section heading. */}
          <span className="font-semibold">{formatMessage({ id: "agent.migration.lastTitle" })}</span>
          <span className="break-words" data-testid="agent-last-migration-summary">
          {formatMessage(
            { id: "agent.migration.lastSummary" },
            {
              source: facts.source,
              target: facts.target,
              // The copy selects on flags, not on the values: a name could be anything.
              hasBy: facts.startedBy ? "yes" : "no",
              by: facts.startedBy ?? "",
              hasTime: facts.endedAt ? "yes" : "no",
              time: facts.endedAt ?? "",
              // The outcome is a word, not a status dot: dots are for presence and tasks.
              outcome: (
                <span key="outcome" className={failed ? "font-semibold text-foreground" : undefined}>
                  {formatMessage({ id: failed ? "agent.detail.failed" : "agent.detail.completed" })}
                </span>
              ),
            },
          )}
          </span>
        </span>
      </button>
      {open ? (
        // The DS inset group (as "Agents they created" uses) holds the details,
        // so steps and banner read as this row's, not the section's.
        <ListRowGroup id={detailsId} className="mt-3 p-3" data-testid="agent-last-migration-body">
          {failed ? (
            <MigrationProgressPanel
              notice={notice}
              agentName={agentName}
              machines={machines}
              onShowCancel={onShowCancel}
              onRefresh={onRefresh}
            />
          ) : (
            <>
              {/* The retry block: its line directly above the size rows, which lead the details. */}
              {isAgentMigrationRetry(notice) ? <MigrationRetryNote notice={notice} agentName={agentName} className="mb-3" /> : null}
              <DescriptionList direction="horizontal" data-testid="agent-last-migration-details">
                <MigrationRetryComparisonItems notice={notice} />
                <DescriptionItem>
                  <DescriptionTerm>{formatMessage({ id: "agent.migration.lastSource" })}</DescriptionTerm>
                  <DescriptionDetails>{computerLink(notice.sourceMachineId, facts.source, "agent-last-migration-source-link")}</DescriptionDetails>
                </DescriptionItem>
                <DescriptionItem>
                  <DescriptionTerm>{formatMessage({ id: "agent.detail.targetComputer" })}</DescriptionTerm>
                  <DescriptionDetails>
                    {isHostedMigration(notice) ? facts.target : computerLink(notice.targetMachineId, facts.target, "agent-last-migration-target-link")}
                  </DescriptionDetails>
                </DescriptionItem>
                {facts.startedBy ? (
                  <DescriptionItem>
                    <DescriptionTerm>{formatMessage({ id: "agent.migration.lastStartedBy" })}</DescriptionTerm>
                    <DescriptionDetails>
                      {initiatedBy ? <StartedByLink userId={initiatedBy.id} label={facts.startedBy} /> : facts.startedBy}
                    </DescriptionDetails>
                  </DescriptionItem>
                ) : null}
                {facts.endedAt ? (
                  <DescriptionItem>
                    <DescriptionTerm>{formatMessage({ id: "agent.migration.lastFinishedAt" })}</DescriptionTerm>
                    <DescriptionDetails>{facts.endedAt}</DescriptionDetails>
                  </DescriptionItem>
                ) : null}
                <DescriptionItem>
                  <DescriptionTerm>{formatMessage({ id: "agent.migration.referenceLabel" })}</DescriptionTerm>
                  <DescriptionDetails><MigrationReferenceValue notice={notice} /></DescriptionDetails>
                </DescriptionItem>
              </DescriptionList>
            </>
          )}
        </ListRowGroup>
      ) : null}
    </div>
  );
}

function ComputerLink({ machineId, label, testId }: { machineId: string; label: string; testId: string }) {
  const nav = useAppNavigate();
  const open = useCallback(() => nav.toComputer(machineId), [machineId, nav]);
  // Strong: a value in a details list reads at the values' weight, not muted.
  return <TextLink variant="strong" onClick={open} data-testid={testId}>{label}</TextLink>;
}

function StartedByLink({ userId, label }: { userId: string; label: string }) {
  const open = useCallback(() => useProfileStore.getState().openProfile("human", userId), [userId]);
  return <TextLink variant="strong" onClick={open} data-testid="agent-last-migration-started-by-link">{label}</TextLink>;
}
