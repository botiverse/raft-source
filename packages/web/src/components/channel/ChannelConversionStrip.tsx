import { useCallback, useRef, useState } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Check, Circle } from "lucide-react";
import {
  Button,
  PanelNotice,
  PanelNoticeActions,
  PanelNoticeContent,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  Progress,
  ProgressIndicator,
  ProgressTrack,
  Spinner,
} from "@botiverse/raft-ui";
import { PopoverActions, PopoverBody } from "@botiverse/raft-ui/wip";
import { EXTERNAL_CHANNELS_FEATURE_FLAG_KEY } from "@botiverse/raft-shared";
import ConfirmDialog from "../ConfirmDialog";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { useServerFeatureFlag } from "../../store/serverFeatureFlags";
import { useChannelConversionController } from "./useChannelConversionController";
import type { ChannelConversionController } from "./useChannelConversionController";

/**
 * A channel being made an external channel, at the top of its conversation
 * (Kirby, design DRI, 2026-11-19). Conversion starts on its own when someone
 * connects outside people or another server, so it is a status of the
 * channel, not a setting: it lives beside the messages, not in the details.
 *
 * - Running: a strip like the announcement strip (raft-design channel.md
 *   "The announcement"), on paper with one seam under it, one line at every
 *   width and 40px tall with a mouse: a spinner, the title (truncates first),
 *   a short bar (hidden under a 560px wide conversation), the percentage in
 *   tabular figures, and View. View opens a popover anchored to the strip
 *   with the five steps and Cancel, which asks before it cancels.
 * - Failed, or its status can't be read: a PanelNotice (something in this
 *   panel needs attention) with Retry or Check status.
 * - Done: the strip goes away by itself.
 *
 * Shown to whoever could follow the conversion in the channel details
 * before: who may federate channels, while external channels are on, on any
 * channel but #all.
 */
export function ChannelConversionStrip({ channelId, channelName }: { channelId: string; channelName: string }) {
  const { capabilities } = useServerPermissions();
  const externalChannels = useServerFeatureFlag(EXTERNAL_CHANNELS_FEATURE_FLAG_KEY);
  const enabled = Boolean(capabilities.federateChannels) && externalChannels.enabled && channelName !== "all";
  const conversion = useChannelConversionController(channelId, channelName, enabled);
  if (!enabled || !conversion.inProgress) return null;
  return <ChannelConversionStatus channelName={channelName} conversion={conversion} />;
}

/** The strip and its notices for a conversion under way; the controller's state in, nothing fetched here. */
export function ChannelConversionStatus({ channelName, conversion }: {
  channelName: string;
  conversion: Pick<ChannelConversionController,
    "job" | "admissionPending" | "connectionWarning" | "observationSettled" | "error"
    | "retryBusy" | "cancelBusy" | "retry" | "cancel" | "checkStatus">;
}) {
  const { formatMessage, formatNumber } = useIntl();
  const stripRef = useRef<HTMLDivElement>(null);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const { job, admissionPending, connectionWarning, error, cancel, retry, checkStatus } = conversion;
  const failed = job?.status === "failed";
  const phase = job?.phase ?? (admissionPending ? "prepare" : "");
  const stage = conversionStageIndex(phase);
  const value = !job && admissionPending ? 0 : conversionProgress(phase);
  const percent = formatNumber(value / 100, { style: "percent", maximumFractionDigits: 0 });
  const title = formatMessage({ id: "channel.conversionStrip.title" });
  const displayError = conversionErrorMessage(error, job?.progress, formatMessage);

  const openCancelConfirm = useCallback(() => {
    setStepsOpen(false);
    setConfirmingCancel(true);
  }, []);
  const closeCancelConfirm = useCallback(() => setConfirmingCancel(false), []);
  const confirmCancel = useCallback(async () => {
    await cancel?.();
  }, [cancel]);

  return (
    <>
      {connectionWarning ? (
        <PanelNotice status="warning" data-testid="channel-conversion-connection-warning">
          <PanelNoticeContent>
            {formatMessage({ id: conversion.observationSettled ? "channel.edit.conversionOutcomeUnknown" : "channel.edit.conversionStatusUnavailable" })}
          </PanelNoticeContent>
          {checkStatus ? (
            <PanelNoticeActions>
              <Button type="button" variant="ghost" size="md" onClick={checkStatus} data-testid="channel-conversion-check-status">
                {formatMessage({ id: "channel.edit.checkConversionStatus" })}
              </Button>
            </PanelNoticeActions>
          ) : null}
        </PanelNotice>
      ) : null}
      {displayError ? (
        <PanelNotice status="warning" role="alert" data-testid="channel-conversion-error">
          <PanelNoticeContent>
            {failed ? formatMessage({ id: "channel.conversionStrip.failed" }, { error: displayError }) : displayError}
          </PanelNoticeContent>
          {(failed && retry) || (failed && cancel) ? (
            <PanelNoticeActions>
              {failed && cancel ? (
                <Button type="button" variant="ghost" size="md" onClick={openCancelConfirm} disabled={conversion.cancelBusy || conversion.retryBusy} data-testid="channel-conversion-cancel">
                  {formatMessage({ id: "channel.conversionStrip.cancel" })}
                </Button>
              ) : null}
              {failed && retry ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  onClick={retry}
                  disabled={conversion.retryBusy || conversion.cancelBusy}
                  loading={conversion.retryBusy}
                  loadingLabel={formatMessage({ id: "channel.edit.retryingConversion" })}
                  data-testid="channel-conversion-retry"
                >
                  {formatMessage({ id: "channel.edit.retryConversion" })}
                </Button>
              ) : null}
            </PanelNoticeActions>
          ) : null}
        </PanelNotice>
      ) : null}
      {!failed ? (
        <div ref={stripRef} className="@container relative shrink-0 border-b border-line-seam bg-layer-canvas" data-testid="channel-conversion-strip">
          <div className="flex h-10 items-center gap-2.5 ps-4 pe-2 md:ps-5 md:pe-3">
            <span className="flex size-4 shrink-0 items-center justify-center text-foreground-muted">
              <Spinner size="sm" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1 truncate text-callout font-semibold text-foreground" data-testid="channel-conversion-strip-title">
              {title}
            </span>
            <Progress
              value={value}
              size="sm"
              aria-label={title}
              className="w-20 shrink-0 @max-[560px]:hidden"
              data-testid="channel-conversion-strip-progress"
            >
              <ProgressTrack><ProgressIndicator /></ProgressTrack>
            </Progress>
            <span aria-hidden="true" className="min-w-[4ch] shrink-0 text-end font-mono text-mono-meta tabular-nums text-foreground-muted" data-testid="channel-conversion-strip-percent">
              {percent}
            </span>
            <Popover open={stepsOpen} onOpenChange={setStepsOpen}>
              <PopoverTrigger
                render={(
                  <Button type="button" variant="ghost" size="md" className="shrink-0" data-testid="channel-conversion-strip-view">
                    {formatMessage({ id: "channel.conversionStrip.view" })}
                  </Button>
                )}
              />
              <PopoverContent
                anchor={stripRef}
                side="bottom"
                align="end"
                sideOffset={4}
                className="w-[300px] max-w-[calc(100vw-2rem)]"
                data-testid="channel-conversion-popover"
              >
                <PopoverBody>
                  <PopoverTitle>{title}</PopoverTitle>
                  <PopoverDescription>{formatMessage({ id: "channel.conversionStrip.description" })}</PopoverDescription>
                  <ConversionSteps stage={stage} paused={connectionWarning} />
                </PopoverBody>
                {cancel ? (
                  <PopoverActions>
                    <Button
                      type="button"
                      variant="default"
                      size="md"
                      onClick={openCancelConfirm}
                      disabled={conversion.cancelBusy}
                      loading={conversion.cancelBusy}
                      loadingLabel={formatMessage({ id: "channel.edit.cancelingConversion" })}
                      data-testid="channel-conversion-cancel"
                    >
                      {formatMessage({ id: "channel.conversionStrip.cancel" })}
                    </Button>
                  </PopoverActions>
                ) : null}
              </PopoverContent>
            </Popover>
          </div>
        </div>
      ) : null}
      {confirmingCancel ? (
        <ConfirmDialog
          title={formatMessage({ id: "channel.conversionStrip.cancelTitle" })}
          message={formatMessage({ id: "channel.conversionStrip.cancelBody" }, { name: channelName })}
          confirmLabel={formatMessage({ id: "channel.conversionStrip.cancel" })}
          cancelLabel={formatMessage({ id: "channel.conversionStrip.keepConnecting" })}
          loadingLabel={formatMessage({ id: "channel.edit.cancelingConversion" })}
          confirmVariant="warning"
          initialFocus="cancel"
          confirmTestId="channel-conversion-cancel-confirm"
          onConfirm={confirmCancel}
          onClose={closeCancelConfirm}
        />
      ) : null}
    </>
  );
}

/**
 * The five steps, one icon family at the 16px icon size (Kirby): done a
 * check, the current one the spinner, the ones ahead an empty circle. Not
 * raft-ui Steps, whose numbered square stickers are for a flow people walk
 * through; this is a job's steps read at a glance in a 300px popover.
 */
function ConversionSteps({ stage, paused }: { stage: number; paused: boolean }) {
  const { formatMessage } = useIntl();
  return (
    <ol
      className="mt-3 stack-y-2"
      aria-label={formatMessage({ id: "channel.conversionStrip.steps" })}
      data-testid="channel-conversion-stages"
    >
      {CONVERSION_STAGES.map((entry, index) => {
        const completed = index < stage;
        const current = !paused && index === stage;
        // Only the current step reads as under way ("Verifying history…"); the
        // others are what the step is ("Verify history").
        const label = formatMessage({ id: current ? entry.currentId : entry.nameId });
        return (
          <li
            key={entry.key}
            className={`flex items-start gap-2 text-callout ${completed ? "text-foreground-muted" : current ? "text-foreground" : "text-foreground-hint"}`}
            aria-current={current ? "step" : undefined}
            data-stage={entry.key}
            data-stage-state={completed ? "complete" : current ? "current" : "pending"}
            aria-label={formatMessage({ id: "channel.conversionStrip.stepLabel" }, {
              step: label,
              state: formatMessage({
                id: completed
                  ? "channel.edit.convertStageComplete"
                  : current
                    ? "channel.edit.convertStageInProgress"
                    : "channel.edit.convertStagePending",
              }),
            })}
          >
            <span aria-hidden="true" className="flex h-[1lh] w-4 shrink-0 items-center justify-center">
              {completed ? <Check className="size-4" /> : current ? <Spinner size="sm" /> : <Circle className="size-4" />}
            </span>
            <span className="min-w-0">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

const CONVERSION_STAGES = [
  { key: "prepare", nameId: "channel.conversionStrip.step.prepare", currentId: "channel.conversionStrip.step.prepareCurrent" },
  { key: "preserve", nameId: "channel.conversionStrip.step.preserve", currentId: "channel.conversionStrip.step.preserveCurrent" },
  { key: "verify", nameId: "channel.conversionStrip.step.verify", currentId: "channel.conversionStrip.step.verifyCurrent" },
  { key: "access", nameId: "channel.conversionStrip.step.access", currentId: "channel.conversionStrip.step.accessCurrent" },
  { key: "done", nameId: "channel.conversionStrip.step.done", currentId: "channel.conversionStrip.step.doneCurrent" },
] as const;

function conversionStageIndex(phase = ""): number {
  if (phase === "done") return CONVERSION_STAGES.length - 1;
  if (phase === "verify") return 2;
  if (["audience_cutover", "residual_cleanup", "finalize"].includes(phase)) return 3;
  if (["prepare_tasks", "move_parent_messages", "prepare_threads", "move_thread_messages"].includes(phase)) return 1;
  return 0;
}

function conversionProgress(phase: string): number {
  switch (phase) {
    case "prepare": return 15;
    case "prepare_tasks": return 25;
    case "move_parent_messages": return 45;
    case "prepare_threads": return 60;
    case "move_thread_messages": return 72;
    case "verify": return 82;
    case "audience_cutover": return 90;
    case "residual_cleanup": return 95;
    case "finalize": return 98;
    case "done": return 100;
    default: return 10;
  }
}

type ConversionProgress = Record<string, unknown> | undefined;

function uploadCountFromProgress(progress: ConversionProgress): number {
  if (!progress) return 1;
  const persistedCount = progress.uploadCount;
  if (typeof persistedCount === "number" && Number.isInteger(persistedCount) && persistedCount > 0) {
    return persistedCount;
  }
  // Older retained jobs do not carry the logical count. Never infer a user
  // count from lifecycle rows (session/intent/reservation); use the safe
  // singular fallback until the server provides the aggregate.
  return 1;
}

function uploadCountFromError(error: string | undefined): number {
  const match = error?.match(/because\s+(\d+)\s+attachment uploads?/i);
  const count = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(count) && count > 0 ? count : 1;
}

function isUploadsInFlightError(error: string | undefined, progress: ConversionProgress): boolean {
  return progress?.errorCode === "channel_conversion_uploads_in_flight"
    || /attachment upload(?: records)? .*in flight/i.test(error ?? "")
    || /attachment upload(?:s)? .*in progress/i.test(error ?? "")
    || /uploads? (?:are|is) still in flight/i.test(error ?? "");
}

function conversionErrorMessage(
  error: string | undefined,
  progress: ConversionProgress,
  formatMessage: IntlShape["formatMessage"],
): string | undefined {
  if (!isUploadsInFlightError(error, progress)) return error;
  return formatMessage(
    { id: "channel.edit.convertUploadsInFlight" },
    { count: progress?.uploadCount ? uploadCountFromProgress(progress) : uploadCountFromError(error) },
  );
}
