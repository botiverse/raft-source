// This device (design §4.3): the machine Raft Desktop runs on, managed with
// buttons and never a command. One component, two shells: embedded in the
// machine's detail panel when this machine is one of the current server's
// computers (it replaces every command block there), and the standalone
// /computers/this-device page when it is not (ThisDevicePanel).
//
// Raft Desktop does not embed Computer: it drives the one official Raft
// Computer install on this machine through its CLI.
//
// ① Status: a status light, the state and how it starts ("Running · Starts
//   when Raft Desktop opens at login"), then at most one Banner for the most
//   urgent problem (thisDeviceLogic.ts).
// ② Controls: Restart / Stop, or Start. Stop while agents are mid-turn asks,
//   and by default waits for the turns to finish (product decision 7).
// ③ Servers (ThisDeviceServers.tsx). ④ Updates: its own version, Update now
//   (Computer's own `upgrade`), and the minimum this Raft Desktop needs.
// ⑤ Troubleshoot, collapsed unless something is wrong (ThisDeviceDiagnostics.tsx).
import { useCallback, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import {
  Banner,
  BannerAction,
  BannerDescription,
  BannerTitle,
  Button,
  EmptyState,
  EmptyStateActions,
  EmptyStateDescription,
  EmptyStateTitle,
  Progress,
  ProgressIndicator,
  ProgressTrack,
  Separator,
  Spinner,
  Status,
  Text,
  TextLink,
} from "@botiverse/raft-ui";
import type { DesktopThisDeviceSection } from "@botiverse/raft-shared";
import SectionEyebrow from "../../ui/SectionEyebrow";
import type { Machine } from "../../../store/machineStore";
import { useMachineStore } from "../../../store/machineStore";
import ComputerReleaseNotesAffordance from "../ComputerReleaseNotesAffordance";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { localComputerErrorMessage } from "./localComputerCopy";
import { missingFeaturesText, thisDeviceMigratingPhrase, thisDevicePresence, thisDeviceStatusPhrase } from "./thisDeviceCopy";
import { startsWithMessageId, missingFeatures } from "./thisDeviceLogic";
import { ThisDeviceServers } from "./ThisDeviceServers";
import { ThisDeviceTroubleshoot } from "./ThisDeviceDiagnostics";
import type { DiagnosticsState } from "./ThisDeviceDiagnostics";
import { DisclosureTitle, TechnicalDetails, ThisDeviceConfirm } from "./thisDeviceParts";
import { useAddThisComputer } from "./useAddThisComputer";

type Operation = "start" | "stop" | "restart" | "update" | "retry-migration";

/** A section of the panel, shaped like its neighbours: content in px-5 py-4, then a Separator. */
function Section({ title, children, testId }: { title?: string; children: ReactNode; testId?: string }) {
  return (
    <>
      <div className="px-5 py-4" data-testid={testId}>
        {title ? <SectionEyebrow as="div" className="mb-2">{title}</SectionEyebrow> : null}
        {children}
      </div>
      <Separator />
    </>
  );
}

export function ThisDeviceSections({ host, machine, currentServer, variant, initialSection }: {
  host: LocalComputerHost;
  /** This machine's row on the current server, when it is one of its computers. */
  machine: Machine | null;
  currentServer: { id: string; slug: string; name: string } | null;
  variant: "embedded" | "standalone";
  /** Opened from the tray, the Dock menu, Help or a notification: that section open. */
  initialSection?: DesktopThisDeviceSection | null;
}) {
  const intl = useIntl();
  const { formatMessage, formatNumber } = intl;
  const { self, bridge } = host;
  const { state } = self;
  const hostState = self.host;
  const mac = self.deviceKind === "mac";
  const latestComputerVersion = useMachineStore((s) => s.latestComputerVersion);
  const latestComputerReleaseNotes = useMachineStore((s) => s.latestComputerReleaseNotes);
  const setShowAddMachine = useMachineStore((s) => s.setShowAddMachine);

  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Troubleshoot follows the device (open while something is wrong, or when
  // opened for it) until the person opens or closes it themselves.
  const [troubleshootChoice, setTroubleshootOpen] = useState<boolean | null>(null);
  const [sectionSeen, setSectionSeen] = useState(initialSection ?? null);
  if ((initialSection ?? null) !== sectionSeen) {
    setSectionSeen(initialSection ?? null);
    setTroubleshootOpen(null);
  }
  const troubleshootOpen = troubleshootChoice ?? (initialSection === "troubleshoot" || state.problem);
  const [diagnostics, setDiagnostics] = useState<DiagnosticsState>({ running: false, report: null, failed: false });
  // Stop / Restart while agents are mid-turn, and a Stop waiting for them.
  const [confirmStop, setConfirmStop] = useState<number | null>(null);
  const [confirmRestart, setConfirmRestart] = useState<number | null>(null);
  const [waitingStop, setWaitingStop] = useState<number | null>(null);
  const troubleshootId = `this-device-troubleshoot-${useId()}`;

  const run = useCallback((op: Operation, action: (() => Promise<unknown>) | null) => {
    if (!action) return;
    setBusy(op);
    setError(null);
    void action()
      .catch((e: unknown) => setError(e ?? new Error("unknown")))
      .finally(() => setBusy(null));
  }, []);

  const busyAgents = useCallback(async (): Promise<number> => {
    if (!host.getTurnActivity) return 0;
    const activity = await host.getTurnActivity().catch(() => null);
    return activity?.busyAgents ?? 0;
  }, [host]);
  const start = useCallback(() => run("start", () => host.start()), [host, run]);
  const stopNow = useCallback(() => {
    setConfirmStop(null);
    setWaitingStop(null);
    run("stop", () => host.stop());
  }, [host, run]);
  const stopWhenFinished = useCallback(() => {
    const count = confirmStop;
    setConfirmStop(null);
    if (!host.stopWhenIdle) return;
    setWaitingStop(count ?? 0);
    setError(null);
    void host.stopWhenIdle()
      .catch((e: unknown) => setError(e ?? new Error("unknown")))
      .finally(() => setWaitingStop(null));
  }, [confirmStop, host]);
  const cancelWaitingStop = useCallback(() => {
    void bridge.cancelStopWhenIdle?.();
    setWaitingStop(null);
  }, [bridge]);
  const stop = useCallback(() => {
    void busyAgents().then((count) => {
      if (count > 0) setConfirmStop(count);
      else stopNow();
    });
  }, [busyAgents, stopNow]);
  const restartNow = useCallback(() => {
    setConfirmRestart(null);
    run("restart", () => host.restart());
  }, [host, run]);
  const restart = useCallback(() => {
    void busyAgents().then((count) => {
      if (count > 0) setConfirmRestart(count);
      else restartNow();
    });
  }, [busyAgents, restartNow]);
  const closeStop = useCallback(() => setConfirmStop(null), []);
  const closeRestart = useCallback(() => setConfirmRestart(null), []);
  const updateNow = useCallback(() => run("update", host.updateComputer), [host, run]);
  const retryMigration = useCallback(() => run("retry-migration", host.retryMigration), [host, run]);

  const runDiagnostics = useCallback((options?: { cleanup?: boolean }) => {
    const diagnose = host.runDiagnostics;
    if (!diagnose) return;
    setTroubleshootOpen(true);
    setDiagnostics((d) => ({ ...d, running: true, failed: false }));
    void diagnose(options).then(
      (report) => setDiagnostics({ running: false, report, failed: false }),
      () => setDiagnostics((d) => ({ ...d, running: false, failed: true })),
    );
  }, [host]);
  const runDiagnosticsLink = useCallback(() => runDiagnostics(), [runDiagnostics]);
  const installElsewhere = useCallback(() => setShowAddMachine(true, "another-computer"), [setShowAddMachine]);

  // One add flow: every Add to this server (the hero, the Servers row) is Add
  // Computer's: one click starts it and the "Setting up this Mac" dialog
  // shows the steps and their failure.
  const openAdd = useAddThisComputer();

  const stopNowLabel = formatMessage({ id: "computerHost.thisDevice.stop.now" });
  const stopNowChoice = useMemo(() => (host.stopWhenIdle ? { label: stopNowLabel, onClick: stopNow } : undefined), [host.stopWhenIdle, stopNowLabel, stopNow]);
  const canAdd = currentServer !== null && host.canAttach && (state.kind === "not-installed" || state.flags.notAttachedHere);
  const disabled = busy !== null || waitingStop !== null;
  const migrating = state.kind === "migrating";

  // ── ① Status ───────────────────────────────────────────────────────────
  // What the person cares about is that it comes back on its own, and when.
  const startsWith = state.kind === "running" && hostState ? formatMessage({ id: startsWithMessageId(hostState.startsWith) }) : null;
  const migratingStep = hostState?.migration.state === "running" ? hostState.migration.step : null;
  const statusFacts = [migrating ? thisDeviceMigratingPhrase(migratingStep, intl) : thisDeviceStatusPhrase(state, self.deviceKind, currentServer?.name ?? "", intl), startsWith]
    .filter((fact): fact is string => !!fact);

  const notice = (() => {
    switch (state.kind) {
      case "migration-failed":
        return (
          <Banner status="warning" size="sm" data-testid="this-device-notice-migration-failed">
            <BannerTitle>{formatMessage({ id: "computerHost.thisDevice.notice.migrationFailedTitle" })}</BannerTitle>
            <BannerDescription>{formatMessage({ id: "computerHost.thisDevice.notice.migrationFailedBody" })}</BannerDescription>
            {/* The recovery is here, once: Try again, and Run diagnostics to see why. */}
            {host.retryMigration || host.runDiagnostics ? (
              <BannerAction>
                {host.retryMigration ? (
                  <Button
                    variant="default"
                    size="md"
                    onClick={retryMigration}
                    loading={busy === "retry-migration"}
                    disabled={busy !== null}
                    loadingLabel={formatMessage({ id: "computerHost.thisDevice.tryAgain" })}
                    data-computer-op="retry-migration"
                  >
                    {formatMessage({ id: "computerHost.thisDevice.tryAgain" })}
                  </Button>
                ) : null}
                {host.runDiagnostics ? (
                  <Button variant="outline" size="md" onClick={runDiagnosticsLink} data-computer-op="run-diagnostics">
                    {formatMessage({ id: "computerHost.thisDevice.troubleshoot.runDiagnostics" })}
                  </Button>
                ) : null}
              </BannerAction>
            ) : null}
          </Banner>
        );
      case "unreadable":
        return (
          <Banner status="warning" size="sm" data-testid="this-device-notice-unreadable">
            <BannerTitle>{formatMessage({ id: "computerHost.thisDevice.notice.unreadableTitle" })}</BannerTitle>
            <BannerDescription>{formatMessage({ id: "computerHost.thisDevice.notice.unreadableBody" })}</BannerDescription>
            {host.runDiagnostics ? (
              <BannerAction>
                <Button variant="default" size="md" onClick={runDiagnosticsLink} data-computer-op="run-diagnostics">
                  {formatMessage({ id: "computerHost.thisDevice.troubleshoot.runDiagnostics" })}
                </Button>
              </BannerAction>
            ) : null}
          </Banner>
        );
      case "duplicate-key":
        return (
          <Banner status="warning" size="sm" data-testid="this-device-notice-duplicate-key">
            <BannerTitle>{formatMessage({ id: "computerHost.thisDevice.notice.duplicateKeyTitle" })}</BannerTitle>
            <BannerDescription>
              {formatMessage({ id: "computerHost.thisDevice.notice.duplicateKeyBody" })}
              {self.lastErrorRaw ? <TechnicalDetails text={self.lastErrorRaw} /> : null}
            </BannerDescription>
            {host.runDiagnostics ? (
              <BannerAction>
                <Button variant="default" size="md" onClick={runDiagnosticsLink} data-computer-op="run-diagnostics">
                  {formatMessage({ id: "computerHost.thisDevice.troubleshoot.runDiagnostics" })}
                </Button>
              </BannerAction>
            ) : null}
          </Banner>
        );
      default:
        return null;
    }
  })();

  // An operation's own failure, unless the state already says it (a duplicate key).
  const operationError = error && state.kind !== "duplicate-key" ? (
    <Banner status="warning" size="sm" data-testid="this-device-error" role="alert">
      <BannerDescription>{localComputerErrorMessage(error, intl)}</BannerDescription>
    </Banner>
  ) : null;

  // ── ② Controls ─────────────────────────────────────────────────────────
  const opButton = (op: "start" | "stop" | "restart", onClick: () => void) => {
    const label = formatMessage({ id: `computerHost.${op}` });
    return (
      <Button variant="outline" size="md" data-computer-op={op} disabled={disabled} loading={busy === op} loadingLabel={label} onClick={onClick}>
        {label}
      </Button>
    );
  };
  // While it updates, its progress shows in one place (Updates, under the
  // version) and there are no lifecycle buttons.
  const lifecycle = state.controllable && self.management === "host" && state.kind !== "updating";
  const controls = !lifecycle ? null : waitingStop !== null ? (
    <Banner status="info" size="sm" className="mt-3" data-testid="this-device-stop-waiting">
      <BannerDescription>
        {formatMessage({ id: "computerHost.thisDevice.stop.waiting" }, { count: waitingStop })}
        <span className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <TextLink variant="strong" onClick={cancelWaitingStop} data-computer-op="cancel-stop">
            {formatMessage({ id: "computerHost.thisDevice.stop.cancelWaiting" })}
          </TextLink>
        </span>
      </BannerDescription>
      <BannerAction>
        <Button variant="default" size="md" onClick={stopNow} data-computer-op="stop-now">
          {formatMessage({ id: "computerHost.thisDevice.stop.now" })}
        </Button>
      </BannerAction>
    </Banner>
  ) : (
    <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="this-computer-local-controls">
      {self.running ? (
        <>
          {opButton("restart", restart)}
          {opButton("stop", stop)}
        </>
      ) : state.kind === "stopped" || state.kind === "update-required" ? (
        opButton("start", start)
      ) : null}
    </div>
  );

  // ── ④ Updates ──────────────────────────────────────────────────────────
  const showUpdates = self.management === "host" && (state.controllable || state.kind === "update-required");
  const belowMinimum = state.kind === "update-required";
  const latest = latestComputerVersion && state.flags.updateAvailable ? latestComputerVersion : null;
  const releaseNotes = latest && latestComputerReleaseNotes?.version === latest ? latestComputerReleaseNotes : null;
  const updating = self.updating !== null || state.kind === "updating";
  const updateLabel = formatMessage({ id: "computerHost.thisDevice.updateNow" });

  // ⑤ Troubleshoot: the move from the embedded Computer stopped partway; the
  // banner offers Try again, Troubleshoot keeps the failed step's details.
  const failedMigration = hostState?.migration.state === "failed" ? hostState.migration : null;
  const migrationDetails = failedMigration?.message ?? null;

  const standaloneEmpty = variant === "standalone" && state.kind === "not-installed";
  const unsupported = hostState !== null && !hostState.installed && !hostState.installSupported;

  return (
    <div data-testid="this-device-sections" data-state={state.kind}>
      <Section testId="this-device-status">
        {variant === "embedded" ? <SectionEyebrow as="div" className="mb-2">{formatMessage({ id: "computerHost.thisDevice" })}</SectionEyebrow> : null}
        {standaloneEmpty ? (
          <EmptyState className="py-6" data-testid="this-device-empty">
            <EmptyStateTitle>{formatMessage({ id: mac ? "computerHost.thisDevice.empty.titleMac" : "computerHost.thisDevice.empty.titleOther" })}</EmptyStateTitle>
            <EmptyStateDescription>
              {formatMessage({ id: unsupported ? "computerHost.thisDevice.empty.unsupported" : "computerHost.thisDevice.empty.body" })}
            </EmptyStateDescription>
            {canAdd ? (
              <EmptyStateActions>
                <Button variant="primary" size="md" onClick={openAdd} data-computer-op="enable" data-testid="this-device-add">
                  {formatMessage({ id: "computerHost.thisDevice.addToServer" })}
                </Button>
              </EmptyStateActions>
            ) : unsupported ? (
              <EmptyStateActions>
                <Button variant="outline" size="md" onClick={installElsewhere} data-testid="this-device-install-elsewhere">
                  {formatMessage({ id: "computerHost.thisDevice.installAnother" })}
                </Button>
              </EmptyStateActions>
            ) : null}
          </EmptyState>
        ) : (
          <div className="flex items-start gap-2" data-testid="this-device-status-line">
            {migrating ? (
              <Spinner size="sm" aria-hidden="true" className="mt-0.5" />
            ) : (
              <Status presence={thisDevicePresence(state.kind, state.problem, state.flags.awaitingListing)} className="lead-dot" aria-hidden />
            )}
            <Text.Sans size="body" className="min-w-0">{statusFacts.join(" · ")}</Text.Sans>
          </div>
        )}
        {notice || operationError ? <div className="mt-3 flex flex-col gap-2">{notice}{operationError}</div> : null}
        {controls}
      </Section>

      {/* Nothing installed, or being moved: the status alone says it; Servers come once Raft Computer is here. */}
      {standaloneEmpty || migrating ? null : (
        <Section title={formatMessage({ id: "computerHost.thisDevice.section.servers" })}>
          {variant === "standalone" || self.servers.length > 0 || state.flags.notAttachedHere ? (
            <ThisDeviceServers host={host} machine={machine} currentServer={currentServer} onAdd={canAdd && state.kind !== "setting-up" ? openAdd : null} />
          ) : null}
        </Section>
      )}

      {showUpdates ? (
        <Section title={formatMessage({ id: "computerHost.thisDevice.section.updates" })} testId="this-device-updates">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <Text.Sans size="body" className="block" data-testid="this-device-version">
                {self.version ? formatMessage({ id: "computerHost.thisDevice.version" }, { version: self.version }) : formatMessage({ id: "computerHost.thisDevice.versionUnknown" })}
              </Text.Sans>
              {updating || belowMinimum ? null : (
                <Text.Sans size="caption" variant="muted" className="block">
                  {latest
                    ? formatMessage({ id: "computerHost.thisDevice.updateAvailable" }, { version: latest })
                    : formatMessage({ id: "computerHost.thisDevice.upToDate" })}
                  {releaseNotes ? <span className="ml-2"><ComputerReleaseNotesAffordance notes={releaseNotes} /></span> : null}
                </Text.Sans>
              )}
            </div>
            {/* While it updates, the progress below is the answer: no second Update now. */}
            {host.updateComputer && latest && !updating && !belowMinimum ? (
              <Button variant="outline" size="md" onClick={updateNow} disabled={disabled} loading={busy === "update"} loadingLabel={updateLabel} data-computer-op="update-now">
                {updateLabel}
              </Button>
            ) : null}
          </div>
          {belowMinimum && !updating ? (
            <Banner status="warning" size="sm" className="mt-3" data-testid="this-device-update-required">
              <BannerTitle>{formatMessage({ id: "computerHost.thisDevice.notice.updateRequiredTitle" }, { features: missingFeaturesText(missingFeatures(hostState), intl) })}</BannerTitle>
              <BannerDescription>{formatMessage({ id: "computerHost.thisDevice.notice.updateRequiredBody" })}</BannerDescription>
              {host.updateComputer ? (
                <BannerAction>
                  <Button variant="default" size="md" onClick={updateNow} disabled={disabled} loading={busy === "update"} loadingLabel={formatMessage({ id: "computerHost.thisDevice.update" })} data-computer-op="update-required">
                    {formatMessage({ id: "computerHost.thisDevice.update" })}
                  </Button>
                </BannerAction>
              ) : null}
            </Banner>
          ) : null}
          {updating ? (
            <div className="mt-3" data-testid="this-device-updating">
              <Progress value={self.updating?.percent ?? null} aria-label={formatMessage({ id: "computerHost.updating" })}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <Text.Sans size="caption" variant="muted">{formatMessage({ id: "computerHost.updating" })} {self.updating?.phase ?? ""}</Text.Sans>
                  {self.updating?.percent != null ? (
                    <Text.Mono size="meta" variant="muted">{formatNumber(self.updating.percent / 100, { style: "percent" })}</Text.Mono>
                  ) : null}
                </div>
                <ProgressTrack><ProgressIndicator /></ProgressTrack>
              </Progress>
            </div>
          ) : null}
        </Section>
      ) : null}

      {state.kind !== "checking" && !migrating ? (
        <div className="px-5 py-4" data-testid="this-device-troubleshoot-section">
          <DisclosureTitle open={troubleshootOpen} onOpenChange={setTroubleshootOpen} controls={troubleshootId} testId="this-device-troubleshoot-toggle">
            {formatMessage({ id: "computerHost.thisDevice.section.troubleshoot" })}
          </DisclosureTitle>
          {troubleshootOpen ? (
            <div id={troubleshootId}>
              <ThisDeviceTroubleshoot
                host={host}
                diagnostics={diagnostics}
                onRunDiagnostics={runDiagnostics}
                migrationDetails={migrationDetails}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {variant === "embedded" ? <Separator /> : null}

      {confirmStop !== null ? (
        <ThisDeviceConfirm
          testId="this-device-stop-confirm"
          title={formatMessage({ id: "computerHost.thisDevice.stop.title" })}
          body={formatMessage({ id: host.stopWhenIdle ? "computerHost.thisDevice.stop.body" : "computerHost.thisDevice.stop.bodyNow" }, { count: confirmStop })}
          confirmLabel={formatMessage({ id: host.stopWhenIdle ? "computerHost.thisDevice.stop.whenFinished" : "computerHost.stop" })}
          onConfirm={host.stopWhenIdle ? stopWhenFinished : stopNow}
          secondary={stopNowChoice}
          onClose={closeStop}
        />
      ) : null}
      {confirmRestart !== null ? (
        <ThisDeviceConfirm
          testId="this-device-restart-confirm"
          title={formatMessage({ id: "computerHost.thisDevice.restart.title" })}
          body={formatMessage({ id: "computerHost.thisDevice.restart.body" }, { count: confirmRestart })}
          confirmLabel={formatMessage({ id: "computerHost.restart" })}
          onConfirm={restartNow}
          onClose={closeRestart}
        />
      ) : null}
    </div>
  );
}
