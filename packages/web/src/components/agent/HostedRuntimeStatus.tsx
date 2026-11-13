import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import { Badge, Button } from "@botiverse/raft-ui";
import type { Presence } from "@botiverse/raft-ui";
import { Cloud } from "lucide-react";
import type { AgentHostedRuntimeSummary } from "@botiverse/raft-shared";
import StatusDot from "../ui/StatusDot";
import { AssistantPausedChip } from "../../assistant/AssistantPaused";
import { HostedModelChoice, useHostedRuntimeModels } from "./HostedModelChoice";

export type HostedRuntimeStateLabelId =
  | "agent.detail.hostedRuntime.state.provisioning"
  | "agent.detail.hostedRuntime.state.active"
  | "agent.detail.hostedRuntime.state.syncing"
  | "agent.detail.hostedRuntime.state.failed"
  | "agent.detail.hostedRuntime.state.deleting"
  | "agent.detail.hostedRuntime.state.deleted";

/** What the profile shows for a provisioning record; pure so it can be pinned by tests. */
export function describeHostedRuntime(summary: AgentHostedRuntimeSummary): {
  labelId: HostedRuntimeStateLabelId;
  inProgress: boolean;
  canRetry: boolean;
} {
  switch (summary.state) {
    case "provisioning":
      return { labelId: "agent.detail.hostedRuntime.state.provisioning", inProgress: true, canRetry: summary.lastError !== null };
    case "active":
      return summary.syncPending
        ? { labelId: "agent.detail.hostedRuntime.state.syncing", inProgress: true, canRetry: summary.lastError !== null }
        : { labelId: "agent.detail.hostedRuntime.state.active", inProgress: false, canRetry: summary.lastError !== null };
    case "failed":
      return { labelId: "agent.detail.hostedRuntime.state.failed", inProgress: false, canRetry: true };
    case "deleting":
      return { labelId: "agent.detail.hostedRuntime.state.deleting", inProgress: true, canRetry: false };
    case "deleted":
      return { labelId: "agent.detail.hostedRuntime.state.deleted", inProgress: false, canRetry: false };
  }
}

/**
 * Each provisioning state as a DS status chip: one of the fixed presence
 * lights plus its word (setting up / syncing / removing = busy, running =
 * online, setup failed = error, removed = offline).
 */
const STATE_CHIP: Record<HostedRuntimeStateLabelId, { variant: "success" | "warning" | "busy" | "muted"; presence: Presence }> = {
  "agent.detail.hostedRuntime.state.provisioning": { variant: "busy", presence: "busy" },
  "agent.detail.hostedRuntime.state.active": { variant: "success", presence: "online" },
  "agent.detail.hostedRuntime.state.syncing": { variant: "busy", presence: "busy" },
  "agent.detail.hostedRuntime.state.failed": { variant: "warning", presence: "error" },
  "agent.detail.hostedRuntime.state.deleting": { variant: "busy", presence: "busy" },
  "agent.detail.hostedRuntime.state.deleted": { variant: "muted", presence: "offline" },
};

export function HostedRuntimeStatus({
  summary,
  onRetry,
  paused = false,
}: {
  summary: AgentHostedRuntimeSummary;
  onRetry: (options?: { model?: string | null }) => Promise<void>;
  /**
   * A paused personal assistant (#10654): its runtime is up but runs nothing,
   * so "Running" would contradict the pause. Shows the Paused chip instead;
   * any other state (setting up, syncing, failed) keeps its own chip.
   */
  paused?: boolean;
}) {
  const { formatMessage } = useIntl();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const view = describeHostedRuntime(summary);
  // After the provider refused the picked model, a retry names the model again (never silently the default).
  const needsModel = view.canRetry && summary.retryNeedsModel;
  const models = useHostedRuntimeModels(summary.provider, needsModel);
  const modelsView = models.state.kind === "ready" ? models.state.view : null;
  const [modelPick, setModelPick] = useState<string | null>(null);
  const pickedModel = modelsView?.locked ? null : modelPick;
  const pickedLabel = pickedModel === null
    ? modelsView?.defaultLabel
      ? formatMessage({ id: "agent.detail.hostedModel.default" }, { label: modelsView.defaultLabel })
      : formatMessage({ id: "agent.detail.hostedModel.defaultUnnamed" })
    : modelsView?.models.find((option) => option.id === pickedModel)?.label ?? pickedModel;
  const reloadModels = models.reload;
  const handleModelsReload = useCallback(() => { void reloadModels(); }, [reloadModels]);
  const retry = useCallback(async () => {
    setRetrying(true);
    setRetryError(false);
    try {
      await onRetry(needsModel ? { model: pickedModel } : undefined);
    } catch {
      setRetryError(true);
    } finally {
      setRetrying(false);
    }
  }, [onRetry, needsModel, pickedModel]);
  const handleRetryClick = useCallback(() => void retry(), [retry]);
  const chip = STATE_CHIP[view.labelId];
  return (
    <div className="stack-y-2" data-testid="agent-hosted-runtime-status" data-state={summary.state}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {paused && view.labelId === "agent.detail.hostedRuntime.state.active" ? (
          <AssistantPausedChip />
        ) : (
          <Badge appearance="soft" variant={chip.variant}>
            <StatusDot presence={chip.presence} />
            {formatMessage({ id: view.labelId })}
          </Badge>
        )}
        {/* The provider's name is not shown to people: a cloud agent "runs in the cloud". */}
        <Badge appearance="soft" variant="information" data-testid="hosted-runtime-location">
          <Cloud size={14} aria-hidden="true" />
          {formatMessage({ id: "agent.detail.hostedRuntime.provider" })}
        </Badge>
        <span className="text-caption text-foreground-hint" data-testid="hosted-runtime-free">
          {formatMessage({ id: "agent.detail.hostedRuntime.freeForLimitedTime" })}
        </span>
      </div>
      {summary.state === "active" && summary.push && !summary.push.registered && (
        <p className="text-footnote font-semibold text-warning-strong">
          {formatMessage({ id: "agent.detail.hostedRuntime.pushNotRegistered" })}
          {summary.push.error ? <span className="ml-1">{summary.push.error}</span> : null}
        </p>
      )}
      {summary.lastError && (
        <p className="break-words text-footnote font-semibold text-warning-strong" data-testid="agent-hosted-runtime-error">
          {formatMessage(
            { id: "agent.detail.hostedRuntime.lastError" },
            { code: summary.lastError.code, message: summary.lastError.message || summary.lastError.code },
          )}
        </p>
      )}
      {needsModel && (
        <div className="stack-y-1.5" data-testid="agent-hosted-runtime-retry-model">
          <p className="text-callout text-foreground-muted">
            {formatMessage({ id: "agent.detail.hostedRuntime.retryNeedsModel" })}
          </p>
          <HostedModelChoice
            state={models.state}
            value={pickedModel}
            onChange={setModelPick}
            onReload={handleModelsReload}
            testId="agent-hosted-runtime-retry-model-select"
          />
        </div>
      )}
      {view.canRetry && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="md"
            type="button"
            disabled={retrying || (needsModel && models.state.kind === "loading")}
            onClick={handleRetryClick}
          >
            {needsModel
              ? formatMessage({ id: "agent.detail.hostedRuntime.retryWithModel" }, { model: pickedLabel })
              : formatMessage({ id: "agent.detail.hostedRuntime.retry" })}
          </Button>
          {retryError && (
            <span className="text-footnote font-semibold text-warning-strong">
              {formatMessage({ id: "agent.detail.hostedRuntime.retryFailed" })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
