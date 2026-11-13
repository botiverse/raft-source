// Onboarding's "connect a computer" step inside an app that is itself the
// Computer host (useLocalComputerHost.ts), when the offline computer
// onboarding is waiting for is this one. The same card shape and header as
// AddThisMac, never a command: its state in one sentence and the one action
// that brings it back (Start, Restart, Update, Try again) through the bridge.
// Nothing installed here: bringing it back is adding it (AddThisMac, the one
// "Add This Mac" flow).
import { useCallback, useState } from "react";
import { useIntl } from "react-intl";
import type { IntlShape } from "react-intl";
import { Banner, BannerDescription, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Spinner, Text } from "@botiverse/raft-ui";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { localComputerErrorMessage } from "./localComputerCopy";
import type { MessageId } from "../../../i18n/messages";
import { missingFeaturesText, thisDeviceStatePhrase } from "./thisDeviceCopy";
import { missingFeatures } from "./thisDeviceLogic";
import type { ThisDeviceStateKind } from "./thisDeviceLogic";
import { AddThisMac } from "./AddThisMac";

export default function UseThisComputerCard({ host, serverSlug, serverName }: {
  host: LocalComputerHost;
  serverSlug: string;
  serverName: string;
}) {
  // Nothing installed here: bringing it back is adding it, the one "Add This
  // Mac" flow, not a second add path.
  if (host.self.state.kind === "not-installed") {
    return <AddThisMac host={host} serverSlug={serverSlug} serverName={serverName} testId="onboarding-desktop-recover" />;
  }
  return <RecoverThisComputerCard host={host} serverName={serverName} />;
}

/** The one action that brings this device back, per state (design §4.5); null: nothing to press, it is on its way. */
interface RecoveryPlan {
  sentence: string | null;
  action: { label: MessageId; op: string; run: () => Promise<unknown> } | null;
  /** Something is in progress: a spinner beside the state. */
  pending?: boolean;
}

function recoveryPlan(kind: ThisDeviceStateKind, host: LocalComputerHost, intl: Pick<IntlShape, "formatMessage" | "formatList">): RecoveryPlan {
  const { formatMessage } = intl;
  // Positional, so the ids stay arguments rather than object-literal copy.
  const plan = (sentence: MessageId | null, action: RecoveryPlan["action"], pending = false): RecoveryPlan => ({ sentence: sentence ? formatMessage({ id: sentence }) : null, action, pending });
  const button = (label: MessageId, op: string, run: (() => Promise<unknown>) | null): RecoveryPlan["action"] => (run ? { label, op, run } : null);
  switch (kind) {
    case "stopped":
      return plan("computerHost.onboarding.recoverStopped", button("computerHost.start", "start", () => host.start()));
    case "running":
      return plan("computerHost.onboarding.recoverRunning", button("computerHost.restart", "restart", () => host.restart()));
    case "update-required":
      return {
        sentence: formatMessage({ id: "computerHost.thisDevice.notice.updateRequiredTitle" }, { features: missingFeaturesText(missingFeatures(host.self.host), intl) }),
        action: button("computerHost.thisDevice.update", "update-required", host.updateComputer),
      };
    case "migration-failed":
      return plan("computerHost.thisDevice.notice.migrationFailedBody", button("computerHost.thisDevice.tryAgain", "retry-migration", host.retryMigration));
    case "duplicate-key":
      return plan("computerHost.thisDevice.notice.duplicateKeyBody", button("computerHost.thisDevice.openLogs", "open-logs", host.openComputerLogs ? async () => host.openComputerLogs?.() : null));
    case "unreadable":
      return plan("computerHost.thisDevice.notice.unreadableBody", button("computerHost.thisDevice.openLogs", "open-logs", host.openComputerLogs ? async () => host.openComputerLogs?.() : null));
    // Added through AddThisMac (UseThisComputerCard), never here.
    case "not-installed":
      return plan(null, null);
    case "updating":
    case "migrating":
    case "setting-up":
    case "checking":
      return plan(null, null, true);
  }
}

/** C4: the offline computer is this one: its state and the button that brings it back. */
function RecoverThisComputerCard({ host, serverName }: { host: LocalComputerHost; serverName: string }) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const mac = host.self.deviceKind === "mac";
  const { kind } = host.self.state;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Started (or restarted) from here and running again: it is on its way back
  // to the server, so the card waits with it instead of offering Restart.
  const [acted, setActed] = useState(false);
  const reconnecting = acted && host.self.running && !host.self.state.problem;
  const plan: RecoveryPlan = reconnecting ? { sentence: null, action: null, pending: true } : recoveryPlan(kind, host, intl);
  const act = useCallback(() => {
    if (!plan.action) return;
    setBusy(true);
    setError(null);
    void plan.action.run()
      .then(() => setActed(true))
      .catch((e: unknown) => setError(e ?? new Error("unknown")))
      .finally(() => setBusy(false));
  }, [plan.action]);
  const waiting = formatMessage({ id: mac ? "computerHost.thisDevice.awaitingListingMac" : "computerHost.thisDevice.awaitingListingOther" }, { server: serverName });
  return (
    <Card variant="inset" data-testid="onboarding-desktop-recover" data-state={kind}>
      <CardHeader>
        <CardTitle>{formatMessage({ id: mac ? "computerHost.onboarding.recoverTitleMac" : "computerHost.onboarding.recoverTitleOther" })}</CardTitle>
        <CardDescription>
          {reconnecting ? (
            // Waiting for the server: the line carries the spinner; there is no action row.
            <span className="inline-flex items-center gap-2" data-testid="onboarding-desktop-recover-waiting">
              <Spinner size="sm" aria-hidden="true" />
              {waiting}
            </span>
          ) : plan.sentence ?? thisDeviceStatePhrase(kind, intl)}
        </CardDescription>
      </CardHeader>
      {plan.action || (plan.pending && !reconnecting) ? (
        <CardContent className="flex items-center gap-3">
          {plan.action ? (
            <Button onClick={act} disabled={busy} loading={busy} data-computer-op={plan.action.op} data-testid="onboarding-desktop-recover-action">
              {formatMessage({ id: plan.action.label })}
            </Button>
          ) : (
            <>
              <Spinner aria-hidden="true" />
              <Text.Sans size="caption" variant="muted" data-testid="onboarding-desktop-recover-pending">{thisDeviceStatePhrase(kind, intl)}</Text.Sans>
            </>
          )}
        </CardContent>
      ) : null}
      {error ? (
        <Banner status="warning" size="sm">
          <BannerDescription>{localComputerErrorMessage(error, intl)}</BannerDescription>
        </Banner>
      ) : null}
    </Card>
  );
}
