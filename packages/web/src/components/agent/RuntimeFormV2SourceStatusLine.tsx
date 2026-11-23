import type { RuntimeFormV2OptionSourceReason, runtimeFormV2SourceStatus } from "@botiverse/raft-runtime-form";
import { lazy, Suspense, useCallback, useContext } from "react";
import { useIntl } from "react-intl";
import { FieldAction } from "./RuntimeConfigFields";
import { withInlineActionTail } from "./inlineActionTail";
// Loaded only when an upgrade is offered: it reaches the API client and the
// auth store, which this line (also rendered in plain node tests) must not load.
const RuntimeFormV2OutdatedUpgrade = lazy(() => import("./RuntimeFormV2OutdatedUpgrade").then((m) => ({ default: m.RuntimeFormV2OutdatedUpgrade })));
import { RuntimeUpgradeTargetContext } from "../../features/computer/runtimeUpgradeTarget";

/** `option_source.status` reasons → copy; an unknown reason gets the generic line. */
const RUNTIME_FORM_V2_SOURCE_REASON_MESSAGE = {
  probe_timeout: "agent.runtimeFormV2.sourceStatus.probeTimeout",
  probe_failed: "agent.runtimeFormV2.sourceStatus.probeFailed",
  missing_config: "agent.runtimeFormV2.sourceStatus.missingConfig",
  no_models: "agent.runtimeFormV2.sourceStatus.noModels",
  unsupported: "agent.runtimeFormV2.sourceStatus.unsupported",
  machine_offline: "agent.runtimeFormV2.sourceStatus.machineOffline",
  not_signed_in: "agent.runtimeFormV2.sourceStatus.notSignedIn",
  runtime_outdated: "agent.runtimeFormV2.sourceStatus.runtimeOutdated",
} as const satisfies Record<RuntimeFormV2OptionSourceReason, string>;

type RuntimeFormV2SourceStatusInfo = NonNullable<ReturnType<typeof runtimeFormV2SourceStatus>>;

/**
 * A non-live source (`option_source.status`): why, and a retry when the server
 * says it may help. A stale list (`state: stale`, the Computer's last list
 * because it did not answer in time) says so instead of the timeout reason.
 * A CLI too old to list them (`runtime_outdated`) gets Upgrade where it is
 * offered for the form's runtime (RuntimeUpgradeTargetContext).
 */
export function RuntimeFormV2SourceStatusLine({
  status,
  sourceId,
  testId,
  onRetrySource,
  retrying,
}: {
  status: RuntimeFormV2SourceStatusInfo;
  sourceId: string;
  testId: string;
  onRetrySource?: (sourceId: string) => void;
  retrying: boolean;
}) {
  const { formatMessage } = useIntl();
  const upgradeTarget = useContext(RuntimeUpgradeTargetContext);
  const handleRetry = useCallback(() => onRetrySource?.(sourceId), [onRetrySource, sourceId]);
  const reasonId = status.reason && status.reason in RUNTIME_FORM_V2_SOURCE_REASON_MESSAGE
    ? RUNTIME_FORM_V2_SOURCE_REASON_MESSAGE[status.reason as keyof typeof RUNTIME_FORM_V2_SOURCE_REASON_MESSAGE]
    : "agent.runtimeFormV2.sourceStatus.unknown";
  const retry = status.retryable && onRetrySource ? (
    <FieldAction
      tone="link"
      type="button"
      onClick={handleRetry}
      disabled={retrying}
      data-testid={`${testId}-retry`}
    >
      {formatMessage({ id: "agent.runtimeFormV2.retry" })}
    </FieldAction>
  ) : null;
  const line = (
    <p>
      {withInlineActionTail(
        status.stale ? formatMessage({ id: "agent.runtimeFormV2.sourceStatus.stale" }) : (
          status.status === "fallback"
            ? [formatMessage({ id: reasonId }), " ", formatMessage({ id: "agent.runtimeFormV2.sourceStatus.fallback" })]
            : formatMessage({ id: reasonId })
        ),
        retry,
      )}
    </p>
  );
  return (
    <div className="mt-2 border-l border-line-hairline pl-2 text-caption text-foreground-muted" data-testid={`${testId}-status`} data-source-status={status.status} data-source-state={status.stale ? "stale" : undefined}>
      {status.reason === "runtime_outdated" && !status.stale && upgradeTarget ? (
        <Suspense fallback={line}>
          <RuntimeFormV2OutdatedUpgrade
            target={upgradeTarget}
            suffix={status.status === "fallback" ? formatMessage({ id: "agent.runtimeFormV2.sourceStatus.fallback" }) : null}
            retry={retry}
          >
            {line}
          </RuntimeFormV2OutdatedUpgrade>
        </Suspense>
      ) : line}
    </div>
  );
}
