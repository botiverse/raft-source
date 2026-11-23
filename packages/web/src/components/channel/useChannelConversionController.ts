import { useCallback, useEffect, useRef, useState } from "react";
import { useIntl } from "react-intl";
import { toast } from "@botiverse/raft-ui";
import { clearClockTimeout, setClockTimeout } from "@botiverse/raft-shared";
import type { ChannelConversionJobView as ConversionJobState } from "@botiverse/raft-shared";
import { useChannelStore } from "../../store/channelStore";
import { beginConversionObservation } from "../../store/conversionObservationStore";
import type { ConversionAttemptBaseline, ConversionObservationToken } from "../../store/conversionObservationStore";
import { channelConversionState, conversionObservationResult, conversionResponseState } from "../../store/channelConversionState";
import { useChannelConversionState } from "../../hooks/useChannelConversionState";
import { reportConversionFailure } from "../../utils/conversionDiagnostics";
import { jointConversionGuestRefusalMessage, jointFreeHostLimitMessage } from "../../utils/jointChannelLimit";
import { useConversionObservationNotice } from "./useConversionObservationNotice";

/**
 * How often a running conversion is read, as a fallback. The server already
 * pushes `channel:updated` with the conversion state to the channel's room
 * after every phase the worker commits and when the job ends (server.ts,
 * startChannelConversionWorker → emitChannelConversionState /
 * emitChannelConversionCompletion), and channelRealtimeSync patches the store
 * with it; the strip follows the store. The poll only covers a missed event
 * (a reconnect, a room joined late), so it is slow, and it pauses while the
 * tab is hidden.
 */
export const CONVERSION_POLL_MS = 10_000;

/** Waits `ms`, then, while the tab is hidden, until it is visible again (a read follows at once). */
function waitVisible(ms: number, onCancel: (cancel: () => void) => void): Promise<void> {
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setClockTimeout> | null = null;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisibility);
      resolve();
    };
    timer = setClockTimeout(() => {
      timer = null;
      if (document.visibilityState === "visible") resolve();
      else document.addEventListener("visibilitychange", onVisibility);
    }, ms);
    onCancel(() => {
      if (timer !== null) clearClockTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    });
  });
}

/**
 * The client side of a channel's conversion to an external channel, once it
 * is under way: the durable receipt, the polling loop that follows it, Retry
 * and Cancel. Conversion now starts on its own (the external-channel invite
 * flow), so there is no Start here. It used to live in the channel details;
 * the conversation's ChannelConversionStrip owns it now, so it follows the
 * conversion while the channel is open rather than only while the details
 * are. `enabled` is false for who may not see the strip: then nothing polls.
 */

export function useChannelConversionController(channelId: string, channelName: string, enabled: boolean) {
  const { formatMessage } = useIntl();
  const { state: serverConversion, observationScope, pendingCommand, finishObservation } = useChannelConversionState(channelId, enabled);
  const serverCommand = serverConversion.command;
  const {
    warning: connectionWarning,
    pending: requestPending,
    settled: observationSettled,
    setWarning: setConnectionWarning,
    setPending: setRequestPending,
  } = useConversionObservationNotice(pendingCommand?.startedAt, serverCommand?.status === "pending");
  const [observationRefresh, setObservationRefresh] = useState(0);
  const awaitingReceipt = !!pendingCommand && pendingCommand.kind !== "cancel";
  const cancelObservationId = pendingCommand?.kind === "cancel" ? pendingCommand.jobId : null;
  const [convertBusy, setConvertBusy] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [conversionJob, setConversionJob] = useState<ConversionJobState | null>(null);
  const [convertError, setConvertError] = useState("");
  const conversionRunRef = useRef(0);
  // The job this mount canceled: state for the render, a ref for the polling
  // loop that has to see it between renders.
  const [canceledJobId, setCanceledJobId] = useState<string | null>(null);
  const conversionCanceledJobRef = useRef<string | null>(null);
  const markCanceledJob = useCallback((jobId: string | null) => {
    conversionCanceledJobRef.current = jobId;
    setCanceledJobId(jobId);
  }, []);
  // Before a Retry is acknowledged, its old failed receipt is only evidence
  // of the preceding attempt, never a terminal answer for this command.
  const conversionAttemptBaselineRef = useRef<ConversionJobState | null>(null);
  const getChannelConversionJob = useChannelStore((s) => s.getChannelConversionJob);
  const retryChannelConversionJob = useChannelStore((s) => s.retryChannelConversionJob);
  const cancelChannelConversionJob = useChannelStore((s) => s.cancelChannelConversionJob);
  const convertChannelToJoint = useChannelStore((s) => s.convertChannelToJoint);
  const persistedConversionJob = serverConversion.job;
  // The channel response is the durable source of truth across mounts. Local
  // state only owns what this mount has read or started since. This
  // render-time fallback also covers a late async channel hydrate without a
  // prop-to-state effect or a one-shot channel-id guard.
  // A restored failure no longer blocks sending, but its error and Retry
  // remain visible until cancellation or a successful retry.
  const persistedConversionReceipt = persistedConversionJob
    && ["pending", "running", "failed"].includes(persistedConversionJob.status)
    && canceledJobId !== persistedConversionJob.id
      ? persistedConversionJob
      : null;
  // A local retry/start response is newer than the stale channel snapshot that
  // caused this mount. Prefer it until the store holds the same job: from then
  // on the store is the newer one (polls and realtime events both patch it,
  // in order), including when it says the job is done or canceled.
  const conversionReceipt = conversionJob && persistedConversionJob?.id === conversionJob.id
    ? persistedConversionReceipt
    : conversionJob ?? persistedConversionReceipt;
  const conversionReceiptRef = useRef<ConversionJobState | null>(null);
  // Before the polling effect below, which reads it when it starts.
  useEffect(() => {
    conversionReceiptRef.current = conversionReceipt;
  });
  const conversionReceiptId = conversionReceipt?.id;
  const conversionReceiptStatus = conversionReceipt?.status;
  const inProgress = convertBusy || awaitingReceipt || Boolean(cancelObservationId) || Boolean(
    conversionReceipt && ["pending", "running", "failed"].includes(conversionReceipt.status),
  );

  const finishCanceledConversion = useCallback((jobId: string, token?: ConversionObservationToken) => {
    markCanceledJob(jobId);
    conversionAttemptBaselineRef.current = null;
    finishObservation(token);
    setConnectionWarning(false);
    setConversionJob(null);
    setConvertError("");
  }, [markCanceledJob, setConnectionWarning, finishObservation]);

  /*
   * A channel poll replaces the receipt object on every read. Keep the polling
   * effect keyed only by the job identity/status so phase/progress updates do
   * not spawn a second loop or reset its timer. A conversion that is already
   * running when this mounts resumes the same durable polling loop; one this
   * mount just retried is polled by handleRetry while convertBusy is true.
   */
  useEffect(() => {
    if (!enabled) return;
    const receipt = awaitingReceipt ? null : conversionReceiptRef.current;
    if (convertBusy || cancelBusy) return;
    if (!cancelObservationId && !awaitingReceipt && (!receipt || !["pending", "running"].includes(receipt.status))) return;
    let cancelled = false;
    let stopWaiting: (() => void) | null = null;
    const runId = ++conversionRunRef.current;
    const isCurrent = () => !cancelled && conversionRunRef.current === runId;
    const poll = async () => {
      let current = receipt;
      // A running job's next read can wait for the fallback cadence; a command
      // still looking for its receipt (start, retry, cancel) reads sooner.
      let retryDelay = receipt && !cancelObservationId ? CONVERSION_POLL_MS : 1000;
      while (isCurrent() && (cancelObservationId || !current || ["pending", "running"].includes(current.status))) {
        await waitVisible(retryDelay, (stop) => { stopWaiting = stop; });
        stopWaiting = null;
        if (!isCurrent() || (current && conversionCanceledJobRef.current === current.id)) return;
        try {
          if (current || cancelObservationId) {
            // Own this read's last confirmed receipt before its store hydrate
            // can replace the active fallback and invalidate the observer.
            if (current) setConversionJob(current);
            current = conversionResponseState(await getChannelConversionJob(cancelObservationId ?? current!.id)).job;
          } else {
            // A lost start response gives us no job ID. Read the source channel
            // afresh, rather than assuming the command failed or replaying it.
            const refreshed = await useChannelStore.getState().ensureChannel(channelId, { refresh: true });
            if (!isCurrent()) return;
            if (!refreshed) throw new Error("Conversion status unavailable");
            const refreshedConversion = channelConversionState(refreshed);
            current = refreshedConversion.job;
            const observed = refreshedConversion.command;
            const observation = conversionObservationResult(refreshed, pendingCommand, pendingCommand?.baseline ?? conversionAttemptBaselineRef.current);
            if (observation === "pending") {
              current = null;
              setRequestPending();
              retryDelay = observationSettled ? 5000 : 1000;
              continue;
            }
            if (observation === "canceled") {
              finishCanceledConversion(current?.id ?? observed?.jobId ?? observed!.id, pendingCommand?.token);
              return;
            }
            if (observation === "done") {
              // Done: the strip goes away by itself, with no toast.
              finishObservation(pendingCommand?.token);
              setConnectionWarning(false);
              setConversionJob(null);
              return;
            }
            if (observation === "commandFailed") {
              finishObservation();
              setConnectionWarning(false);
              setConversionJob(current);
              setConvertError(observed?.error || formatMessage({ id: "channel.edit.failedConvertJoint" }));
              return;
            }
            if (observation === "unconfirmed") {
              // The original command may still be waiting for admission/lock.
              // An absent job or the pre-Retry failure cannot end observation.
              current = null;
              setConnectionWarning(true);
              retryDelay = observationSettled ? 5000 : 1000;
              continue;
            }
            conversionAttemptBaselineRef.current = null;
          }
          if (!isCurrent()) return;
          if (current?.status === "canceled") {
            finishCanceledConversion(current.id);
            return;
          }
          if (cancelObservationId && current?.status !== "done" && current?.canCancel !== false) {
            // Cancel has a known job identity. Continue reading even a failed
            // snapshot until cancellation commits or becomes impossible.
            setConversionJob(current);
            setConnectionWarning(true);
            retryDelay = observationSettled ? 5000 : 1000;
            continue;
          }

          setConnectionWarning(false);
          setConvertError(cancelObservationId
            ? formatMessage({ id: "channel.edit.cancelConversionUnavailable" })
            : current?.status === "failed" ? current.error || "" : "");
          setConversionJob(current);
          finishObservation();
          if (!current || current.status === "done") return;
          retryDelay = CONVERSION_POLL_MS;
        } catch (error) {
          if (!isCurrent()) return;
          reportConversionFailure("observe", channelId, pendingCommand?.token, error);
          // Connectivity is an observation failure, not a new job state.
          setConnectionWarning(true);
          retryDelay = observationSettled ? 5000 : 1000;
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      (stopWaiting as (() => void) | null)?.();
    };
  }, [enabled, channelId, conversionReceiptId, conversionReceiptStatus, awaitingReceipt, cancelObservationId, observationSettled, observationRefresh, convertBusy, cancelBusy, getChannelConversionJob, formatMessage, setConnectionWarning, setRequestPending, finishCanceledConversion, finishObservation, pendingCommand]);

  // Invalidate the mounted conversion runner on unmount. Without this, a
  // runner left mid-poll can keep issuing reads and later overwrite the next
  // mount's receipt.
  useEffect(() => () => {
    conversionRunRef.current += 1;
  }, []);

  const handleRetry = useCallback(async () => {
    const runId = ++conversionRunRef.current;
    conversionAttemptBaselineRef.current = conversionReceiptRef.current;
    if (!observationScope || pendingCommand) return;
    const previous = conversionReceiptRef.current;
    const baseline: ConversionAttemptBaseline | null = previous ? {
      id: previous.id, status: previous.status,
      progress: { failedAt: typeof previous.progress?.failedAt === "string" ? previous.progress.failedAt : undefined,
        relockedAt: typeof previous.progress?.relockedAt === "string" ? previous.progress.relockedAt : undefined },
    } : null;
    const command = beginConversionObservation(observationScope, previous?.status === "failed" ? "retry" : "start", baseline, serverCommand?.id ?? null);
    if (!command) return;
    setConvertError("");
    setConnectionWarning(false);
    markCanceledJob(null);
    setConvertBusy(true);
    setRequestPending();
    try {
      const started = conversionReceiptRef.current?.status === "failed"
        ? await retryChannelConversionJob(conversionReceiptRef.current.id, command.token)
        : await convertChannelToJoint(channelId, { observeProgress: true, commandId: command.token });
      if (conversionRunRef.current !== runId) return;
      conversionAttemptBaselineRef.current = null;
      const startedConversion = conversionResponseState(started);
      if (startedConversion.status === "pending") {
        // Admission is durable on the server, but the source lock may still
        // be waiting. Keep the scoped observation record for remount/reload.
        setRequestPending();
        setConversionJob(null);
        return;
      }
      finishObservation(command.token);
      setConnectionWarning(false);
      const currentJob = startedConversion.job;
      setConversionJob(currentJob);
      if (currentJob?.status === "failed") {
        setConvertError(currentJob.error || formatMessage({ id: "channel.edit.failedConvertJoint" }));
      }
      // Running jobs are observed by the mounted polling effect above.
    } catch (err: unknown) {
      reportConversionFailure(command.kind === "retry" ? "retry" : "start", channelId, command.token, err);
      if (conversionRunRef.current !== runId) return;
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; code?: string; conversionJob?: ConversionJobState } } };
      const responseData = axiosErr.response?.data;
      if (responseData?.conversionJob) {
        finishObservation(command.token);
        setConversionJob(responseData.conversionJob);
        setConvertError(responseData.conversionJob.status === "failed" ? responseData.conversionJob.error || responseData.error || "" : "");
      } else if (!axiosErr.response || (axiosErr.response.status !== undefined && axiosErr.response.status >= 500)) {
        setConnectionWarning(true);
        // Retry may have succeeded even when its response was lost. Discard
        // the old failed snapshot and rediscover the authoritative receipt.
        setConversionJob(null);
        // Keep the pending command record for reopen, refresh and read-only recovery.
      } else {
        finishObservation(command.token);
        setConnectionWarning(false);
        setConvertError(jointConversionGuestRefusalMessage(err, channelName, formatMessage)
          ?? jointFreeHostLimitMessage(err, formatMessage)
          ?? (responseData?.error || formatMessage({ id: "channel.edit.failedConvertJoint" })));
      }
    } finally {
      setConvertBusy(false);
    }
  }, [
    observationScope,
    pendingCommand,
    serverCommand?.id,
    setConnectionWarning,
    setRequestPending,
    retryChannelConversionJob,
    convertChannelToJoint,
    markCanceledJob,
    channelId,
    channelName,
    finishObservation,
    formatMessage,
  ]);

  const handleCancel = useCallback(async () => {
    if (!conversionReceipt) return;
    const cancelingJobId = conversionReceipt.id;
    if (!observationScope || cancelObservationId) return;
    const runId = ++conversionRunRef.current;
    const command = beginConversionObservation(observationScope, "cancel", { id: cancelingJobId, status: conversionReceipt.status }, serverCommand?.id ?? null);
    if (!command) return;
    setConvertError("");
    setConnectionWarning(false);
    setCancelBusy(true);
    try {
      await cancelChannelConversionJob(cancelingJobId, command.token);
      if (conversionRunRef.current !== runId) return;
      finishCanceledConversion(cancelingJobId, command.token);
      toast.success(formatMessage({ id: "channel.edit.conversionCanceled" }));
    } catch (err: unknown) {
      reportConversionFailure("cancel", channelId, command.token, err);
      if (conversionRunRef.current !== runId) return;
      const axiosErr = err as { response?: { status?: number; data?: { error?: string; code?: string } } };
      const uncertain = !axiosErr.response || (axiosErr.response.status !== undefined && axiosErr.response.status >= 500);
      markCanceledJob(null);
      setConversionJob(conversionReceipt);
      let latest: ConversionJobState | null = null;
      try { latest = conversionResponseState(await getChannelConversionJob(cancelingJobId)).job; }
      catch (error) { reportConversionFailure("cancel-observe", channelId, command.token, error); }
      if (conversionRunRef.current !== runId) return;
      if (latest?.status === "canceled") {
        finishCanceledConversion(latest.id, command.token);
        toast.success(formatMessage({ id: "channel.edit.conversionCanceled" }));
        return;
      }
      if (latest) setConversionJob(latest);
      if (uncertain && latest?.status !== "done" && latest?.canCancel !== false) {
        conversionAttemptBaselineRef.current = null;
        // Keep the known-job cancellation record until a conclusive read.
        setConnectionWarning(true);
        return;
      }
      finishObservation(command.token);
      setConnectionWarning(false);
      setConvertError(uncertain
        ? formatMessage({ id: "channel.edit.cancelConversionUnavailable" })
        : axiosErr.response?.data?.error || formatMessage({ id: "channel.edit.failedCancelConversion" }));
    } finally {
      if (conversionRunRef.current === runId) setCancelBusy(false);
    }
  }, [
    conversionReceipt,
    observationScope,
    cancelObservationId,
    serverCommand?.id,
    setConnectionWarning,
    cancelChannelConversionJob,
    finishCanceledConversion,
    markCanceledJob,
    formatMessage,
    channelId,
    getChannelConversionJob,
    finishObservation,
  ]);

  const retry = useCallback(() => {
    void handleRetry().catch(() => undefined);
  }, [handleRetry]);
  const cancel = useCallback(() => handleCancel(), [handleCancel]);
  const checkStatus = useCallback(() => setObservationRefresh((n) => n + 1), []);

  const job = conversionReceipt;
  const canCancel = !!job && ["pending", "running", "failed"].includes(job.status)
    && (job.canCancel ?? (job.phase === "prepare" && job.progress?.canonicalCopyStarted !== true));
  return {
    job,
    inProgress,
    /** Admitted on the server but no job yet (waiting for the source lock). */
    admissionPending: requestPending,
    connectionWarning,
    /** The connection warning has lasted long enough that the outcome is unknown, not only late. */
    observationSettled,
    error: connectionWarning || requestPending ? undefined : convertError || job?.error || undefined,
    retryBusy: convertBusy,
    cancelBusy,
    retry: cancelObservationId || (awaitingReceipt && !convertBusy) ? undefined : retry,
    cancel: cancelObservationId || !canCancel ? undefined : cancel,
    checkStatus: connectionWarning ? checkStatus : undefined,
  };
}

export type ChannelConversionController = ReturnType<typeof useChannelConversionController>;
