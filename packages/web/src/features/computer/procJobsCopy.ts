import type { IntlShape } from "react-intl";
import { isValidProcStoppedBy } from "@botiverse/raft-shared";
import type { ProcJobsSnapshotJob } from "@botiverse/raft-shared";

import { formatFileSizeBytes } from "../../utils/fileSizePresentation";
import { formatShortRelativeTime } from "../../utils/relativeTime";

type FormatMessage = IntlShape["formatMessage"];

/** How long a job has run: "45s", "12m", "3h 5m", "2d 4h". */
export function formatProcJobUptime(formatMessage: FormatMessage, ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return formatMessage({ id: "machine.procJobs.duration.seconds" }, { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return formatMessage({ id: "machine.procJobs.duration.minutes" }, { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return formatMessage({ id: "machine.procJobs.duration.hours" }, { hours, minutes: minutes % 60 });
  return formatMessage({ id: "machine.procJobs.duration.days" }, { days: Math.floor(hours / 24), hours: hours % 24 });
}

/** How a job ended, in the words the agent reads (`raft proc list`): who stopped it, its cap, its code or signal. */
export function formatProcJobExit(formatMessage: FormatMessage, job: ProcJobsSnapshotJob): string {
  if (job.exitReason === "owner_stop") {
    return isValidProcStoppedBy(job.stoppedBy)
      ? formatMessage({ id: "machine.procJobs.exit.ownerStop" }, { handle: job.stoppedBy })
      : formatMessage({ id: "machine.procJobs.exit.ownerStopUnknown" });
  }
  if (job.exitReason === "memory_limit") return formatMessage({ id: "machine.procJobs.exit.memoryLimit" });
  if (typeof job.exitCode === "number") return formatMessage({ id: "machine.procJobs.exit.code" }, { code: job.exitCode });
  if (job.exitSignal) return formatMessage({ id: "machine.procJobs.exit.signal" }, { signal: job.exitSignal });
  return formatMessage({ id: "machine.procJobs.exit.plain" });
}

/** "Running 3h 5m", or "Stopped by @tygg · 5m ago". */
export function formatProcJobState(formatMessage: FormatMessage, locale: string, job: ProcJobsSnapshotJob, nowMs: number): string {
  if (job.state === "running") {
    return formatMessage({ id: "machine.procJobs.running" }, { duration: formatProcJobUptime(formatMessage, nowMs - Date.parse(job.startedAt)) });
  }
  const reason = formatProcJobExit(formatMessage, job);
  const ago = formatShortRelativeTime(job.exitedAt ?? null, locale);
  return ago ? formatMessage({ id: "machine.procJobs.exitedAgo" }, { reason, ago }) : reason;
}

/** "300.0 MB of 4.0 GB" (running, sampled), "4.0 GB cap", or null (no cap, nothing read). */
export function formatProcJobMemory(formatMessage: FormatMessage, job: ProcJobsSnapshotJob): string | null {
  const cap = job.memoryMaxBytes ? formatFileSizeBytes(job.memoryMaxBytes, formatMessage) : null;
  const used = job.state === "running" && typeof job.rssBytes === "number" ? formatFileSizeBytes(job.rssBytes, formatMessage) : null;
  if (used && cap) return formatMessage({ id: "machine.procJobs.memoryOfCap" }, { used, cap });
  if (used) return formatMessage({ id: "machine.procJobs.memory" }, { used });
  if (cap) return formatMessage({ id: "machine.procJobs.memoryCap" }, { cap });
  return null;
}
