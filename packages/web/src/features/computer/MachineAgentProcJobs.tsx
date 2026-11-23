import { useCallback, useId, useState } from "react";
import { useIntl } from "react-intl";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ListRow,
  ListRowBody,
} from "@botiverse/raft-ui";
import { currentTimeMs } from "@botiverse/raft-shared";
import type { ProcJobsSnapshotJob } from "@botiverse/raft-shared";

import { formatProcJobMemory, formatProcJobState } from "./procJobsCopy";

/**
 * The "Jobs" line under an agent on the Computer page: its `raft proc` jobs
 * (docs/contracts/proc-jobs.md), each with its state, how long it ran or how
 * it ended, and its memory against its cap. A display-only raft-ui ListRow
 * attached to the agent's row above (the agent's row is a button; a Stop
 * cannot sit inside it). Stop only for a viewer who controls the Computer,
 * after a size-sm Dialog (DS Feedback › Confirming); its confirm is orange
 * (warning): it interrupts the agent's work, and the agent can start the job
 * again.
 */
export function MachineAgentProcJobs({
  agentName,
  jobs,
  canStop,
  onStop,
}: {
  agentName: string;
  jobs: readonly ProcJobsSnapshotJob[];
  canStop: boolean;
  onStop: (job: ProcJobsSnapshotJob) => Promise<void>;
}) {
  const { formatMessage } = useIntl();
  const labelId = useId();
  const [confirming, setConfirming] = useState<ProcJobsSnapshotJob | null>(null);
  const [busy, setBusy] = useState(false);
  const nowMs = currentTimeMs();

  const handleOpenChange = useCallback((open: boolean) => {
    if (!open && !busy) setConfirming(null);
  }, [busy]);
  const confirm = useCallback(async () => {
    if (!confirming) return;
    setBusy(true);
    try {
      await onStop(confirming);
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }, [confirming, onStop]);

  if (jobs.length === 0) return null;
  return (
    <>
      <ListRow interactive={false} attached role="group" aria-labelledby={labelId} data-testid="machine-agent-proc-jobs">
        <ListRowBody className="pl-12">
          <span id={labelId} className="text-caption text-foreground-muted">{formatMessage({ id: "machine.procJobs.label" })}</span>
          <ul className="mt-1 grid gap-1">
            {jobs.map((job) => (
              <ProcJobLine key={job.name} job={job} canStop={canStop} nowMs={nowMs} onStop={setConfirming} />
            ))}
          </ul>
        </ListRowBody>
      </ListRow>
      <Dialog open={confirming !== null} onOpenChange={handleOpenChange}>
        <DialogContent size="sm" data-testid="proc-job-stop-dialog">
          <DialogHeader>
            <DialogTitle>{formatMessage({ id: "machine.procJobs.stopTitle" }, { name: confirming?.name ?? "" })}</DialogTitle>
            <DialogClose aria-label={formatMessage({ id: "common.confirm.closeDialog" })} />
          </DialogHeader>
          <DialogBody>
            <DialogDescription>{formatMessage({ id: "machine.procJobs.stopBody" }, { agent: agentName })}</DialogDescription>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="lg" disabled={busy} />}>{formatMessage({ id: "machine.procJobs.cancel" })}</DialogClose>
            <Button variant="warning" size="lg" loading={busy} onClick={confirm} data-testid="proc-job-stop-confirm">
              {formatMessage({ id: "machine.procJobs.stopConfirm" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** One job: its name, state, memory, and Stop while it runs (for a viewer who may). */
function ProcJobLine({
  job,
  canStop,
  nowMs,
  onStop,
}: {
  job: ProcJobsSnapshotJob;
  canStop: boolean;
  nowMs: number;
  onStop: (job: ProcJobsSnapshotJob) => void;
}) {
  const { formatMessage, locale } = useIntl();
  const memory = formatProcJobMemory(formatMessage, job);
  const handleStop = useCallback(() => onStop(job), [job, onStop]);
  return (
    <li className="flex min-w-0 items-center gap-2 text-caption" data-proc-job={job.name}>
      <span className="min-w-0 truncate font-mono text-mono-meta text-foreground">{job.name}</span>
      <span className="min-w-0 truncate text-foreground-muted">{formatProcJobState(formatMessage, locale, job, nowMs)}</span>
      {memory ? <span className="shrink-0 font-mono text-mono-meta text-foreground-hint">{memory}</span> : null}
      {canStop && job.state === "running" ? (
        <Button
          variant="ghost"
          size="md"
          className="ml-auto shrink-0"
          aria-label={formatMessage({ id: "machine.procJobs.stopAria" }, { name: job.name })}
          onClick={handleStop}
        >
          {formatMessage({ id: "machine.procJobs.stop" })}
        </Button>
      ) : null}
    </li>
  );
}
