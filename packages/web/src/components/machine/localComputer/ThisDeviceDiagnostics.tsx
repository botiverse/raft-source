// This device › Troubleshoot (design §4.3 ⑤), lightest first, as Docker
// Desktop orders it: open the logs (Raft Computer's and Raft Desktop's), run
// the diagnostics here (`raft-computer doctor`: nothing is uploaded; each
// check passed or failed, its raw detail only under Technical details), and,
// when the move from an older Raft Desktop's embedded Computer stopped
// partway, retry it. No factory reset (product decision 5). Every action is a
// bridge capability; a missing one is hidden.
import { useCallback } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { missingFeatures } from "./thisDeviceLogic";
import { missingFeaturesText } from "./thisDeviceCopy";
import {
  Banner,
  BannerDescription,
  Button,
  DescriptionDetails,
  DescriptionItem,
  DescriptionList,
  DescriptionTerm,
  Text,
} from "@botiverse/raft-ui";
import type { DesktopComputerDiagnosticsReport } from "@botiverse/raft-shared";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { TechnicalDetails } from "./thisDeviceParts";

export interface DiagnosticsState {
  running: boolean;
  report: DesktopComputerDiagnosticsReport | null;
  failed: boolean;
}

/** One troubleshooting step: what it does, and its button. */
function Step({ title, description, children, testId }: { title: string; description: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3" data-testid={testId}>
      <div className="min-w-0 flex-1">
        <Text.Sans size="body" className="block">{title}</Text.Sans>
        <Text.Sans size="caption" variant="muted" className="block">{description}</Text.Sans>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function DiagnosticsResult({ report }: { report: DesktopComputerDiagnosticsReport }) {
  const { formatMessage } = useIntl();
  const checks = report.checks.filter((check) => !check.section);
  const failed = checks.filter((check) => !check.ok).length;
  const details = report.checks.map((check) => `${check.section ? "## " : check.ok ? "ok   " : "FAIL "}${check.name}${check.detail ? `: ${check.detail}` : ""}`).join("\n");
  return (
    <div className="mt-3" data-testid="this-device-diagnostics-result">
      <Text.Sans size="body" className="mb-2 block font-semibold" role="status">
        {failed === 0
          ? formatMessage({ id: "computerHost.thisDevice.diagnostics.allPassed" })
          : formatMessage({ id: "computerHost.thisDevice.diagnostics.someFailed" }, { count: failed })}
      </Text.Sans>
      <DescriptionList direction="horizontal">
        {checks.map((check, index) => (
          <DescriptionItem key={`${index}-${check.name}`} data-check-ok={check.ok ? "true" : "false"}>
            <DescriptionTerm>{check.name}</DescriptionTerm>
            <DescriptionDetails className={check.ok ? undefined : "text-warning-strong"}>
              {formatMessage({ id: check.ok ? "computerHost.thisDevice.diagnostics.passed" : "computerHost.thisDevice.diagnostics.failed" })}
            </DescriptionDetails>
          </DescriptionItem>
        ))}
        {report.installedVersion ? (
          <DescriptionItem>
            <DescriptionTerm>{formatMessage({ id: "computerHost.thisDevice.diagnostics.installedVersion" })}</DescriptionTerm>
            <DescriptionDetails className="font-mono text-mono-meta">{report.installedVersion}</DescriptionDetails>
          </DescriptionItem>
        ) : null}
      </DescriptionList>
      {report.cleaned ? (
        <Text.Sans size="caption" variant="muted" className="mt-2 block">
          {formatMessage({ id: "computerHost.thisDevice.diagnostics.cleaned" }, { count: report.cleaned.removed })}
        </Text.Sans>
      ) : null}
      <TechnicalDetails text={details} />
    </div>
  );
}

/** The move from the embedded Computer stopped partway: Retry, its message under Technical details. */
export function ThisDeviceTroubleshoot({ host, diagnostics, onRunDiagnostics, migrationDetails }: {
  host: LocalComputerHost;
  diagnostics: DiagnosticsState;
  onRunDiagnostics: (options?: { cleanup?: boolean }) => void;
  /** The failed move's raw error (the banner above offers Try again). */
  migrationDetails: string | null;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const { state } = host.self;
  // This Computer cannot run diagnostics for Raft Desktop yet: say what brings it.
  const diagnosticsMissing = missingFeatures(host.self.host).includes("diagnostics");
  const runDiagnostics = useCallback(() => onRunDiagnostics(), [onRunDiagnostics]);
  const cleanUp = useCallback(() => onRunDiagnostics({ cleanup: true }), [onRunDiagnostics]);
  return (
    <div className="mt-3 flex flex-col gap-4" data-testid="this-device-troubleshoot">
      {migrationDetails ? (
        <div data-testid="this-device-migration-details">
          <TechnicalDetails text={migrationDetails} />
        </div>
      ) : null}
      {host.openComputerLogs || host.openDesktopLogs ? (
        <Step
          title={formatMessage({ id: "computerHost.thisDevice.troubleshoot.logsTitle" })}
          description={formatMessage({ id: "computerHost.thisDevice.troubleshoot.logsBody" })}
        >
          {host.openComputerLogs ? (
            <Button variant="outline" size="md" onClick={host.openComputerLogs} data-computer-op="open-logs">
              {formatMessage({ id: "computerHost.thisDevice.troubleshoot.openComputerLogs" })}
            </Button>
          ) : null}
          {host.openDesktopLogs ? (
            <Button variant="outline" size="md" onClick={host.openDesktopLogs} data-computer-op="open-desktop-logs">
              {formatMessage({ id: "computerHost.thisDevice.troubleshoot.openDesktopLogs" })}
            </Button>
          ) : null}
        </Step>
      ) : null}
      {host.runDiagnostics ? (
        <div>
          <Step
            title={formatMessage({ id: "computerHost.thisDevice.troubleshoot.diagnosticsTitle" })}
            description={diagnosticsMissing
              ? formatMessage({ id: "computerHost.thisDevice.notice.updateRequiredTitle" }, { features: missingFeaturesText(["diagnostics"], intl) })
              : formatMessage({ id: "computerHost.thisDevice.troubleshoot.diagnosticsBody" })}
          >
            {diagnosticsMissing ? null : <Button
              variant="outline"
              size="md"
              onClick={runDiagnostics}
              loading={diagnostics.running}
              disabled={diagnostics.running}
              loadingLabel={formatMessage({ id: "computerHost.thisDevice.troubleshoot.runDiagnostics" })}
              data-computer-op="run-diagnostics"
            >
              {formatMessage({ id: "computerHost.thisDevice.troubleshoot.runDiagnostics" })}
            </Button>}
            {diagnostics.report && !diagnostics.report.allOk && state.controllable ? (
              <Button variant="outline" size="md" onClick={cleanUp} disabled={diagnostics.running} data-computer-op="clean-up">
                {formatMessage({ id: "computerHost.thisDevice.troubleshoot.cleanUp" })}
              </Button>
            ) : null}
          </Step>
          {diagnostics.failed ? (
            <Banner status="warning" size="sm" className="mt-2">
              <BannerDescription>{formatMessage({ id: "computerHost.thisDevice.diagnostics.couldNotRun" })}</BannerDescription>
            </Banner>
          ) : null}
          {diagnostics.report ? <DiagnosticsResult report={diagnostics.report} /> : null}
        </div>
      ) : null}
    </div>
  );
}
