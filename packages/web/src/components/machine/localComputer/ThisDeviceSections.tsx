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
// ② Actions: what thisDeviceActions offers for the state, the same for both
//   shells: never a dead end, never a button known to fail. Restart / Stop,
//   or Start; Install; Try again / Repair; Open logs; … Stop while agents
//   are mid-turn asks, and by default waits for the turns to finish
//   (product decision 7).
// ③ Servers (ThisDeviceServers.tsx). ④ Updates: its own version, Update now
//   (Computer's own `upgrade`), and the minimum this Raft Desktop needs.
// ⑤ Troubleshoot, collapsed unless something is wrong (ThisDeviceDiagnostics.tsx).
import { useCallback, useEffect, useId, useMemo, useState } from "react";
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
import type { MessageId } from "../../../i18n/messages";
import SectionEyebrow from "../../ui/SectionEyebrow";
import type { Machine } from "../../../store/machineStore";
import { useMachineStore } from "../../../store/machineStore";
import ComputerReleaseNotesAffordance from "../ComputerReleaseNotesAffordance";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { localComputerErrorMessage } from "./localComputerCopy";
import { missingFeaturesText, thisDeviceMigratingPhrase, thisDevicePresence, thisDeviceStatusPhrase } from "./thisDeviceCopy";
import { startsWithMessageId, missingFeatures } from "./thisDeviceLogic";
import { checkingStallMs, thisDeviceCanAdd, thisDevicePlanFor } from "./thisDevicePlan";
import type { ThisDeviceAction, ThisDeviceStateKind } from "./thisDeviceLogic";
import { ThisDeviceServers } from "./ThisDeviceServers";
import { ThisDeviceTroubleshoot } from "./ThisDeviceDiagnostics";
import type { DiagnosticsState } from "./ThisDeviceDiagnostics";
import { DisclosureTitle, TechnicalDetails, ThisDeviceConfirm } from "./thisDeviceParts";
import { useAddThisComputer } from "./useAddThisComputer";

type Operation = "start" | "stop" | "restart" | "update" | "retry-migration" | "install" | "repair" | "retry-read";

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
  // Still "Checking…" after a while (a read that never answers): say it is
  // unknown, with Try again. Reset whenever the state changes.
  const [checkingStalled, setCheckingStalled] = useState(false);
  const [kindSeen, setKindSeen] = useState<ThisDeviceStateKind>(state.kind);
  if (kindSeen !== state.kind) {
    setKindSeen(state.kind);
    setCheckingStalled(false);
  }
  useEffect(() => {
    if (state.kind !== "checking") return undefined;
    const timer = setTimeout(() => setCheckingStalled(true), checkingStallMs());
    return () => clearTimeout(timer);
  }, [state.kind]);

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
  const installNow = useCallback(() => run("install", host.updateComputer), [host, run]);
  const repair = useCallback(() => run("repair", host.updateComputer), [host, run]);
  const retryRead = useCallback(() => run("retry-read", host.retryRead), [host, run]);
  const openLogs = host.openComputerLogs ?? host.openDesktopLogs;

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
  const canAdd = thisDeviceCanAdd(host, currentServer);
  const disabled = busy !== null || waitingStop !== null;
  const migrating = state.kind === "migrating";
  const standaloneEmpty = variant === "standalone" && state.kind === "not-installed";
  const unsupported = hostState !== null && !hostState.installed && !hostState.installSupported;

  // ② What this state offers (thisDeviceLogic.ts), the same in both shells.
  const plan = thisDevicePlanFor(host, variant, { canAdd, checkingStalled });
  const statusActions = plan.actions.filter((candidate) => candidate.place === "status");
  const offers = (id: ThisDeviceAction["id"]) => plan.actions.some((candidate) => candidate.id === id);
  const couldNotRead = plan.statusMessageId === "computerHost.thisDevice.state.couldNotRead";

  // ── ① Status ───────────────────────────────────────────────────────────
  // What the person cares about is that it comes back on its own, and when.
  const startsWith = state.kind === "running" && hostState ? formatMessage({ id: startsWithMessageId(hostState.startsWith) }) : null;
  const migratingStep = hostState?.migration.state === "running" ? hostState.migration.step : null;
  const statusPhrase = plan.statusMessageId
    ? formatMessage({ id: plan.statusMessageId })
    : migrating ? thisDeviceMigratingPhrase(migratingStep, intl) : thisDeviceStatusPhrase(state, self.deviceKind, currentServer?.name ?? "", intl);
  const statusFacts = [statusPhrase, startsWith].filter((fact): fact is string => !!fact);

  const opButton = (op: "start" | "stop" | "restart", onClick: () => void) => {
    const label = formatMessage({ id: `computerHost.${op}` });
    return (
      <Button key={op} variant="outline" size="md" data-computer-op={op} disabled={disabled} loading={busy === op} loadingLabel={label} onClick={onClick}>
        {label}
      </Button>
    );
  };

  // One button per action; in a Banner the first step is "default", elsewhere "primary".
  const actionButton = (item: ThisDeviceAction, surface: "banner" | "row") => {
    const emphasis = item.primary ? (surface === "banner" ? "default" : "primary") : "outline";
    const operation = (op: Operation, id: string, labelId: MessageId, onClick: () => void) => {
      const label = formatMessage({ id: labelId });
      return (
        <Button key={id} variant={emphasis} size="md" onClick={onClick} disabled={disabled} loading={busy === op} loadingLabel={label} data-computer-op={id}>
          {label}
        </Button>
      );
    };
    switch (item.id) {
      case "start":
        return opButton("start", start);
      case "restart":
        return opButton("restart", restart);
      case "stop":
        return opButton("stop", stop);
      case "install":
        return operation("install", "install", "computerHost.thisDevice.install", installNow);
      case "finish-move":
        return operation("install", "finish-move", "computerHost.thisDevice.finishMove", installNow);
      case "repair":
        return operation("repair", "repair", "computerHost.thisDevice.repair", repair);
      case "retry-read":
        return operation("retry-read", "retry-read", "computerHost.thisDevice.tryAgain", retryRead);
      case "retry-migration":
        return (
          <Button
            key="retry-migration"
            variant={emphasis}
            size="md"
            onClick={retryMigration}
            loading={busy === "retry-migration"}
            disabled={busy !== null}
            loadingLabel={formatMessage({ id: "computerHost.thisDevice.tryAgain" })}
            data-computer-op="retry-migration"
          >
            {formatMessage({ id: "computerHost.thisDevice.tryAgain" })}
          </Button>
        );
      case "add":
        return (
          <Button key="add" variant={emphasis} size="md" onClick={openAdd} data-computer-op="enable" data-testid="this-device-add">
            {formatMessage({ id: "computerHost.thisDevice.addToServer" })}
          </Button>
        );
      case "install-elsewhere":
        return (
          <Button key="install-elsewhere" variant={emphasis} size="md" onClick={installElsewhere} data-computer-op="install-elsewhere" data-testid="this-device-install-elsewhere">
            {formatMessage({ id: "computerHost.thisDevice.installAnother" })}
          </Button>
        );
      case "run-diagnostics":
        return (
          <Button key="run-diagnostics" variant={emphasis} size="md" onClick={runDiagnosticsLink} loading={diagnostics.running} disabled={diagnostics.running} loadingLabel={formatMessage({ id: "computerHost.thisDevice.troubleshoot.runDiagnostics" })} data-computer-op="run-diagnostics">
            {formatMessage({ id: "computerHost.thisDevice.troubleshoot.runDiagnostics" })}
          </Button>
        );
      case "open-logs":
        return openLogs ? (
          <Button key="open-logs" variant={emphasis} size="md" onClick={openLogs} data-computer-op="open-logs">
            {formatMessage({ id: "computerHost.thisDevice.openLogs" })}
          </Button>
        ) : null;
      // In the Updates section (below).
      case "update":
      case "update-now":
        return null;
    }
  };
  const bannerActions = statusActions.length > 0 ? <BannerAction>{statusActions.map((item) => actionButton(item, "banner"))}</BannerAction> : null;

  // The state's notice holds its actions (the recovery is here, once).
  const notice = (() => {
    if (couldNotRead) {
      return (
        <Banner status="warning" size="sm" data-testid="this-device-notice-unreadable">
          <BannerDescription>
            {formatMessage({ id: state.kind === "checking" ? "computerHost.thisDevice.notice.checkingStalledBody" : "computerHost.thisDevice.notice.couldNotReadBody" })}
          </BannerDescription>
          {bannerActions}
        </Banner>
      );
    }
    switch (state.kind) {
      case "not-installed": {
        // The standalone page has its empty state (below); here this machine
        // is one of the server's computers and Raft Computer is missing.
        if (variant === "standalone") return null;
        const leftover = offers("finish-move");
        return (
          <Banner status={unsupported ? "warning" : "info"} size="sm" data-testid="this-device-notice-not-installed">
            <BannerTitle>
              {formatMessage({ id: leftover ? "computerHost.thisDevice.notice.finishMoveTitle" : "computerHost.thisDevice.notice.notInstalledTitle" })}
            </BannerTitle>
            <BannerDescription>
              {unsupported
                ? formatMessage({ id: "computerHost.thisDevice.empty.unsupported" })
                : leftover
                  ? formatMessage({ id: "computerHost.thisDevice.notice.finishMoveBody" })
                  : formatMessage({ id: "computerHost.thisDevice.notice.notInstalledBody" })}
            </BannerDescription>
            {bannerActions}
          </Banner>
        );
      }
      case "migration-failed":
        return (
          <Banner status="warning" size="sm" data-testid="this-device-notice-migration-failed">
            <BannerTitle>{formatMessage({ id: "computerHost.thisDevice.notice.migrationFailedTitle" })}</BannerTitle>
            <BannerDescription>{formatMessage({ id: "computerHost.thisDevice.notice.migrationFailedBody" })}</BannerDescription>
            {bannerActions}
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
            {bannerActions}
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
  // While it updates, its progress shows in one place (Updates, under the
  // version) and there are no lifecycle buttons (thisDeviceActions).
  const LIFECYCLE = new Set<ThisDeviceAction["id"]>(["start", "stop", "restart"]);
  const lifecycleActions = notice ? [] : statusActions.filter((item) => LIFECYCLE.has(item.id));
  const otherActions = notice || standaloneEmpty ? [] : statusActions.filter((item) => !LIFECYCLE.has(item.id));
  const controls = waitingStop !== null && state.controllable ? (
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
  ) : lifecycleActions.length === 0 && otherActions.length === 0 ? null : (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {/* Start / Stop / Restart, then the state's other steps (Open logs, …). */}
      <div className="contents" data-testid="this-computer-local-controls">
        {lifecycleActions.map((item) => actionButton(item, "row"))}
      </div>
      {otherActions.map((item) => actionButton(item, "row"))}
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


  return (
    <div data-testid="this-device-sections" data-state={state.kind}>
      <Section testId="this-device-status">
        {variant === "embedded" ? <SectionEyebrow as="div" className="mb-2">{formatMessage({ id: "computerHost.thisDevice" })}</SectionEyebrow> : null}
        {standaloneEmpty ? (
          <EmptyState className="py-6" data-testid="this-device-empty">
            <EmptyStateTitle>
              {formatMessage({ id: offers("finish-move") ? "computerHost.thisDevice.notice.finishMoveTitle" : mac ? "computerHost.thisDevice.empty.titleMac" : "computerHost.thisDevice.empty.titleOther" })}
            </EmptyStateTitle>
            <EmptyStateDescription>
              {formatMessage({ id: unsupported ? "computerHost.thisDevice.empty.unsupported" : offers("finish-move") ? "computerHost.thisDevice.notice.finishMoveBody" : "computerHost.thisDevice.empty.body" })}
            </EmptyStateDescription>
            {statusActions.length > 0 ? (
              <EmptyStateActions>{statusActions.map((item) => actionButton(item, "row"))}</EmptyStateActions>
            ) : null}
          </EmptyState>
        ) : (
          <div className="flex items-start gap-2" data-testid="this-device-status-line">
            {migrating ? (
              <Spinner size="sm" aria-hidden="true" className="mt-0.5" />
            ) : (
              <Status presence={couldNotRead ? "error" : thisDevicePresence(state.kind, state.problem, state.flags.awaitingListing)} className="lead-dot" aria-hidden />
            )}
            <Text.Sans size="body" className="min-w-0">{statusFacts.join(" · ")}</Text.Sans>
          </div>
        )}
        {notice || operationError ? <div className="mt-3 flex flex-col gap-2">{notice}{operationError}</div> : null}
        {controls}
      </Section>

      {/* Nothing installed, or being moved: the status alone says it; Servers come once Raft Computer is here. */}
      {/* Nothing to list (its status unread, no attachment): no empty heading either. */}
      {state.kind === "not-installed" || migrating || !(variant === "standalone" || self.servers.length > 0 || state.flags.notAttachedHere) ? null : (
        <Section title={formatMessage({ id: "computerHost.thisDevice.section.servers" })}>
          <ThisDeviceServers host={host} machine={machine} currentServer={currentServer} onAdd={canAdd && state.kind !== "setting-up" ? openAdd : null} />
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
            {host.updateComputer && latest && !updating && !belowMinimum && offers("update-now") ? (
              <Button variant="outline" size="md" onClick={updateNow} disabled={disabled} loading={busy === "update"} loadingLabel={updateLabel} data-computer-op="update-now">
                {updateLabel}
              </Button>
            ) : null}
          </div>
          {belowMinimum && !updating ? (
            <Banner status="warning" size="sm" className="mt-3" data-testid="this-device-update-required">
              <BannerTitle>{formatMessage({ id: "computerHost.thisDevice.notice.updateRequiredTitle" }, { features: missingFeaturesText(missingFeatures(hostState), intl) })}</BannerTitle>
              <BannerDescription>{formatMessage({ id: "computerHost.thisDevice.notice.updateRequiredBody" })}</BannerDescription>
              {host.updateComputer && offers("update") ? (
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
