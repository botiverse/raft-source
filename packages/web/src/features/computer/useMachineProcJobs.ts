import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProcJobsReadResponse, ProcJobsSnapshotJob } from "@botiverse/raft-shared";

import api from "../../api/client";
import { startVisiblePoll } from "../../utils/visiblePoll";

/** How often the Computer page reads the jobs again while it is on screen (the Computer reports every 5 minutes and on each change). */
export const MACHINE_PROC_JOBS_POLL_MS = 30_000;

export interface MachineProcJobs {
  /** null: not read (offline, or the read failed); `unknown`: no report from the Computer (never "no jobs"). */
  status: "known" | "unknown" | null;
  /** The agent's jobs, running first then newest; absent when it has none. */
  jobsByAgent: ReadonlyMap<string, readonly ProcJobsSnapshotJob[]>;
  refresh: () => Promise<void>;
  /**
   * A Stop the Computer confirmed: shows the job as ended at once, until a
   * report says so itself (the report the Computer sends after a stop can
   * reach the server after the stop's answer), and reads again 3 s later.
   */
  markStopped: (job: ProcJobsSnapshotJob) => void;
}

/** How long after a confirmed Stop the page reads the jobs again. */
export const MACHINE_PROC_JOBS_AFTER_STOP_MS = 3_000;

const jobKey = (job: Pick<ProcJobsSnapshotJob, "agentId" | "name" | "startedAt">) => `${job.agentId}\u0000${job.name}\u0000${job.startedAt}`;

const EMPTY = new Map<string, readonly ProcJobsSnapshotJob[]>();

function byAgent(jobs: readonly ProcJobsSnapshotJob[]): Map<string, ProcJobsSnapshotJob[]> {
  const grouped = new Map<string, ProcJobsSnapshotJob[]>();
  for (const job of jobs) {
    const list = grouped.get(job.agentId) ?? [];
    list.push(job);
    grouped.set(job.agentId, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => (a.state === b.state ? Date.parse(b.startedAt) - Date.parse(a.startedAt) : a.state === "running" ? -1 : 1));
  }
  return grouped;
}

/**
 * `raft proc` jobs of the agents on one Computer (GET …/proc-jobs,
 * docs/contracts/proc-jobs.md): read only while the Computer is online and
 * the page is visible, every 30 s and on focus (visiblePoll).
 */
export function useMachineProcJobs(serverId: string | null, machineId: string, online: boolean): MachineProcJobs {
  const [answer, setAnswer] = useState<ProcJobsReadResponse | null>(null);
  // Stops confirmed here, by job (agent, name, start), with when.
  const [stopped, setStopped] = useState<ReadonlyMap<string, string>>(new Map());
  // Only the latest read lands: a slow earlier answer never replaces a newer one.
  const readSeq = useRef(0);
  const afterStopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const seq = ++readSeq.current;
    if (!serverId || !online) {
      setAnswer(null);
      return;
    }
    try {
      const { data } = await api.get<ProcJobsReadResponse>(`/servers/${serverId}/machines/${machineId}/proc-jobs`);
      if (seq === readSeq.current) setAnswer(data?.status === "known" || data?.status === "unknown" ? data : null);
    } catch {
      if (seq === readSeq.current) setAnswer(null);
    }
  }, [machineId, online, serverId]);

  const markStopped = useCallback((job: ProcJobsSnapshotJob) => {
    setStopped((prev) => new Map(prev).set(jobKey(job), new Date().toISOString()));
    if (afterStopTimer.current) clearTimeout(afterStopTimer.current);
    afterStopTimer.current = setTimeout(() => {
      afterStopTimer.current = null;
      void refresh();
    }, MACHINE_PROC_JOBS_AFTER_STOP_MS);
  }, [refresh]);

  useEffect(() => () => {
    if (afterStopTimer.current) clearTimeout(afterStopTimer.current);
  }, []);

  useEffect(() => {
    void refresh();
    if (!serverId || !online || typeof window === "undefined") return;
    return startVisiblePoll(() => void refresh(), { intervalMs: MACHINE_PROC_JOBS_POLL_MS, refreshOnFocus: true });
  }, [online, refresh, serverId]);

  return useMemo(() => {
    let jobs = answer?.status === "known" ? answer.jobs : null;
    if (jobs && stopped.size > 0) {
      jobs = jobs.map((job) => {
        const at = job.state === "running" ? stopped.get(jobKey(job)) : undefined;
        return at ? { ...job, state: "exited" as const, exitedAt: at, exitReason: "owner_stop", exitCode: null, exitSignal: null, rssBytes: null } : job;
      });
    }
    return {
      status: answer?.status ?? null,
      jobsByAgent: jobs ? byAgent(jobs) : EMPTY,
      refresh,
      markStopped,
    };
  }, [answer, markStopped, refresh, stopped]);
}
