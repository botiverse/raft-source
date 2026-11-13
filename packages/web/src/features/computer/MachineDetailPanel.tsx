import { Input, Textarea, Card, ScrollArea, Button, CopyableCode, CopyableCodeAction, InlineCode, Separator, Spinner } from "@botiverse/raft-ui";
import { useCallback, useId, useMemo, useState } from "react";
import { useIntl } from "react-intl";
import { useLocation } from "react-router-dom";
import { Trash2, Pencil } from "lucide-react";
import Banner from "../../components/ui/Banner";
import { machineDiskLowPresentation } from "../../utils/machineDiskPresentation";
import { formatMachinePlatformLine, sameMachinePeers } from "../../utils/machinePlatformLine";
import { useMachineStore } from "../../store/machineStore";
import type { Machine } from "../../store/machineStore";
import { useAgentStore } from "../../store/agentStore";
import { useServerStore } from "../../store/serverStore";
import { useProfileStore } from "../../store/profileStore";
import { useAuthStore } from "../../store/authStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { getServerUrl } from "../../utils/server";
import { formatRelativeTime } from "../../utils/relativeTime";
import { getComputerCommands } from "../../utils/computerSetupCommand";
import { useComputerRestart, useComputerUpgradeCard } from "../../components/machine/useComputerUpgradeCard";
import { canManageMachine } from "../../utils/canManageMachine";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import { ComputerActionConfirms } from "../../components/machine/ComputerActionConfirms";
import Tooltip from "../../components/ui/Tooltip";
import MachinePanelHeader from "../../components/machine/MachinePanelHeader";
import { MachineProfileHead } from "../../components/machine/MachineProfileHead";
import SectionEyebrow from "../../components/ui/SectionEyebrow";
import ComputerVersionNotice from "../../components/machine/ComputerVersionNotice";
import { CommandCopyRoot } from "../../components/machine/CommandCopyRoot";
import { useRuntimeRescan } from "../../components/machine/useRuntimeRescan";
import { ComputerDeviceIcon } from "../../components/machine/ComputerDeviceIcon";
import { useLocalComputerHost } from "../../components/machine/localComputer/useLocalComputerHost";
import { ThisDeviceSections } from "../../components/machine/localComputer/ThisDeviceSections";
import { isThisDeviceMachine } from "../../components/machine/localComputer/thisDeviceLogic";
import { localComputerErrorMessage } from "../../components/machine/localComputer/localComputerCopy";
import { thisDeviceSectionParam } from "../../components/machine/localComputer/thisDeviceRoute";
import { DETAIL_HELP_CLASS_NAME, DETAIL_PROBLEM_CLASS_NAME, DETAIL_STEP_LABEL_CLASS_NAME, COMMAND_LINE_CLASS_NAME } from "./machineDetailClassNames";
import type { CommandCopyTarget } from "./machineDetailTypes";
import { WorkspacesSection } from "./WorkspacesSection";
import { MachineAgentList } from "./MachineAgentList";
import { DeleteComputerDialog } from "./DeleteComputerDialog";
import ConfirmDialog from "../../components/ConfirmDialog";
import { ComputerMigrationLogLink } from "./ComputerMigrationLogLink";
import { MachineInfoSection } from "./MachineInfoSection";
import { ComputerRecoveryCard } from "./ComputerRecoveryCard";
import { ComputerServiceActionsCard } from "./ComputerServiceActionsCard";
import { ComputerRecoveryGuideCard } from "./ComputerRecoveryGuideCard";
import { useMachineNameEditor, useMachineDescriptionEditor } from "./useMachineDetailEditors";

export function MachineDetailPanel({
  machine,
  hideHeader = false,
  deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV,
}: {
  machine: Machine;
  hideHeader?: boolean;
  deploymentEnv?: string;
}) {
  const intl = useIntl();
  const { formatDate, formatList, formatMessage, locale } = intl;
  const renameMachine = useMachineStore((s) => s.renameMachine);
  const updateMachineDetails = useMachineStore((s) => s.updateMachineDetails);
  const latestComputerReleaseNotes = useMachineStore((s) => s.latestComputerReleaseNotes);
  const machines = useMachineStore((s) => s.machines);
  const platformLine = formatMachinePlatformLine(machine);
  const sameMachineNames = useMemo(
    () => sameMachinePeers(machine, machines).map((peer) => peer.name),
    [machine, machines],
  );
  // "Is it up to date" is the web's own comparison with the latest published
  // version, independent of whether web upgrade is switched on.
  const upgradeCard = useComputerUpgradeCard(machine);
  const computerVersionFact = upgradeCard.computerVersionFact;
  const diskLow = machineDiskLowPresentation(machine, formatMessage);
  // "What's new" follows the "v… available" hint, with or without an
  // Upgrade button (artin). Online: in the action row. Offline (no action
  // row): beside the hint. Display only.
  // Only notes for exactly the version the page offers (the policy's upgrade
  // target when it has one, else the latest published version). Shared by
  // both placements so the offline one can't show mismatched notes.
  const releaseNotesForUpdate = computerVersionFact.kind === "outdated"
    && latestComputerReleaseNotes
    && latestComputerReleaseNotes.version === computerVersionFact.availableVersion
    ? latestComputerReleaseNotes
    : null;
  const openProfile = useProfileStore((s) => s.openProfile);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const allAgents = useAgentStore((s) => s.agents);
  const { capabilities } = useServerPermissions();
  const machineAgents = useMemo(() => allAgents.filter((a) => !a.deletedAt && a.machineId === machine.id), [allAgents, machine.id]);
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const computerHost = useLocalComputerHost();
  // This device (Raft Desktop's own machine): its panel replaces every
  // command block below with a button (design §4.4). Never in a browser.
  const isThisDevice = isThisDeviceMachine(computerHost, machine.id);
  // Raft Computer does not run here (stopped, removed): the chip says Offline
  // at once, before the server's next update.
  const thisDeviceNotRunning = isThisDevice && computerHost !== null && !computerHost.self.running;
  const thisDeviceSection = thisDeviceSectionParam(useLocation().search);
  const serverName = useServerStore((s) => s.current?.name ?? null);
  const thisDeviceServer = useMemo(
    () => (serverId && serverSlug ? { id: serverId, slug: serverSlug, name: serverName ?? serverSlug } : null),
    [serverId, serverSlug, serverName],
  );
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [disconnectError, setDisconnectError] = useState<unknown>(null);
  // Collapsed-by-default install/setup fallback on the offline Computer
  // recovery card. The primary path remains start/status/doctor, while this
  // plainly labelled escape hatch also works when the binary is not installed.
  const [showRecoverySetup, setShowRecoverySetup] = useState(false);
  const toggleRecoverySetup = useCallback(() => setShowRecoverySetup((v) => !v), []);
  const [recoveryGuideContext, setRecoveryGuideContext] = useState<{
    machineId: string;
    status: Machine["status"];
  }>({ machineId: machine.id, status: machine.status });
  const [recoveryGuideDisclosure, setRecoveryGuideDisclosure] = useState<boolean | null>(null);
  const recoveryGuideContentId = `computer-recovery-guide-content-${useId()}`;
  if (recoveryGuideContext.machineId !== machine.id || recoveryGuideContext.status !== machine.status) {
    setRecoveryGuideContext({ machineId: machine.id, status: machine.status });
    setRecoveryGuideDisclosure(null);
  }
  const [copiedCommand, setCopiedCommand] = useState<CommandCopyTarget | null>(null);
  const {
    editingName,
    draftName,
    savingName,
    nameError,
    nameInputRef,
    handleStartRename,
    handleSaveRenameClick,
    handleCancelRename,
    handleNameChange,
    handleNameKeyDown,
  } = useMachineNameEditor(machine, renameMachine, formatMessage);
  const {
    editingDescription,
    draftDescription,
    savingDescription,
    descriptionError,
    descriptionInputRef,
    handleStartEditDescription,
    handleSaveDescriptionClick,
    handleCancelDescription,
    handleDescriptionChange,
    handleDescriptionKeyDown,
  } = useMachineDescriptionEditor(machine, updateMachineDetails, formatMessage);

  const serverUrl = getServerUrl();
  const setupMachineId = machine.isComputer ? null : machine.id;
  const computerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    // Identity-carried migration (task #239): this page knows WHICH row the
    // computer is, so the setup command adopts it directly (--machine <id>) —
    // no fingerprint matching, works after key rotation. Legacy rows only;
    // Computer rows keep the plain setup command.
    machineId: setupMachineId,
  });
  const windowsMachine = machine.os?.toLowerCase().startsWith("win") ?? false;
  const windowsComputerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    machineId: setupMachineId,
    platform: "windows",
  });
  const computerFreshInstallCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    machineId: setupMachineId,
    // No version pin: the installer resolves the latest release itself, and a
    // pin copied from a page opened before a release would install the older one.
    platform: windowsMachine ? "windows" : "mac-linux",
  });
  const machineComputerCommands = windowsMachine ? windowsComputerCommands : computerCommands;
  const computerSetupCommand = machineComputerCommands?.setup ?? null;
  const computerInstall = machineComputerCommands?.install ?? null;
  const computerFreshInstall = computerFreshInstallCommands?.install ?? null;
  const computerInstallRestartCommand = computerFreshInstallCommands?.restartService ?? null;
  // Address recovery to the current server. Restart handles both local
  // failure shapes the server sees as "offline": a stopped service (stop is
  // a no-op, then start) and a live runner whose server connection is stuck.
  // The CLI's supervisor restart can cycle other managed runners in the same
  // home; taking this from the command bundle keeps staging/slockdev on their
  // per-server RAFT_HOME + binary path.
  const computerRecoveryRestartCommand = machineComputerCommands?.restart ?? null;
  const terminalRestartCommand = machineComputerCommands?.restart ?? null;
  // A user choice applies only to the current machine + current health state.
  // When either changes, fall back to the product default immediately: healthy
  // Computers stay collapsed, while an offline Computer exposes recovery.
  const showRecoveryGuide = recoveryGuideDisclosure ?? machine.status !== "online";
  const canManageMachines = canManageMachine(machine, currentUserId, capabilities);
  const canViewRuntimeAccountUsage = canViewMachineRuntimeAccountUsage(machine, currentUserId, capabilities);
  // task #1268: explicit detection state from the server (never inferred from an empty list).
  const rescanRuntimes = useMachineStore((s) => s.rescanRuntimes);
  const { state: rescanState, rescan: onRescanRuntimes } = useRuntimeRescan(machine.id, rescanRuntimes);
  const runtimeDetection = machine.runtimeDetection ?? null;
  // Endpoint-equivalent eligibility (servers.ts rescan route: machine creator
  // or the editMachines capability) — never the broader canManageMachines.
  const canRescanRuntimes = capabilities.editMachines
    || machine.computerAttachedByCurrentUser === true
    || (currentUserId !== null && machine.creator?.id === currentUserId);
  const openDeleteConfirm = useCallback(() => setShowDeleteConfirm(true), []);
  // This device (product decision 3): "Delete Computer" becomes "Disconnect
  // This Device from <server>" (B4 detach: its key there revoked, its local
  // attachment removed, its data kept), while Raft Desktop can drive it
  // (otherwise, being moved or needing an update, the server-side delete stays).
  const detachThisDevice = computerHost?.detach ?? null;
  const canDisconnectThisDevice = isThisDevice && detachThisDevice !== null && serverId !== null
    && computerHost?.self.state.controllable === true;
  const openDisconnectConfirm = useCallback(() => setShowDisconnectConfirm(true), []);
  const closeDisconnectConfirm = useCallback(() => setShowDisconnectConfirm(false), []);
  const handleDisconnectThisDevice = useCallback(async () => {
    if (!detachThisDevice || !serverId) return;
    setDisconnectError(null);
    try {
      await detachThisDevice(serverId);
    } catch (error) {
      setDisconnectError(error ?? new Error("unknown"));
    }
    setShowDisconnectConfirm(false);
  }, [detachThisDevice, serverId]);
  const closeDeleteConfirm = useCallback(() => setShowDeleteConfirm(false), []);

  const handleCopy = useCallback((target: CommandCopyTarget) => {
    setCopiedCommand(target);
    setTimeout(() => {
      setCopiedCommand((current) => (current === target ? null : current));
    }, 2000);
  }, []);



  // Upgrade state and the one-click Upgrade, shared with the Computers
  // overview rows (useComputerUpgradeCard); Restart likewise.
  const {
    cardState,
    versionTier,
    webUpgradeOn,
    upgradeRefusal,
    recommendRepair,
    upgradeRequest,
    requestOutcomeStillTrue,
    upgradeFailureHint,
    noResponseMessageId,
    upgradeInFlight,
    upgradeReconnecting,
    upgradeReconnectOverdue,
    startUpgrade: handleRemoteUpgradeV2Click,
  } = upgradeCard;
  // Offered as the card offers it: online and not mid-upgrade.
  const computerRestart = useComputerRestart(machine.id, machine.status === "online" && upgradeCard.cardState.kind !== "upgrading");
  const { progress: computerOperationProgress, restart: handleComputerRestartClick } = computerRestart;
  // A runtime this Computer predates offers the page's own one-click Upgrade.
  const runtimeChipsUpgradeAction = useMemo(
    // Same gate as the Actions card's Upgrade button.
    () => canManageMachines && !isThisDevice && machine.isComputer && machine.status === "online" && cardState.kind === "oneClick"
      ? { label: formatMessage({ id: "machine.detail.upgradeToVersion" }, { version: cardState.version }), onClick: handleRemoteUpgradeV2Click }
      : null,
    [canManageMachines, isThisDevice, cardState, formatMessage, handleRemoteUpgradeV2Click, machine.isComputer, machine.status],
  );
  const statusCommandText = machineComputerCommands?.status ?? "raft-computer status";
  const statusCommand = <InlineCode>{statusCommandText}</InlineCode>;
  const upgradeCommandText = machineComputerCommands?.upgrade ?? "raft-computer upgrade";
  // The no-response line names the status check, or for a Computer that
  // cannot report the installer's result live, the upgrade itself.
  const noResponseLine = formatMessage(
    { id: noResponseMessageId },
    {
      command: noResponseMessageId === "machine.detail.upgradeStatus.noResponseOldComputer"
        ? <InlineCode>{upgradeCommandText}</InlineCode>
        : statusCommand,
    },
  );


  const createdDate = formatDate(machine.createdAt, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const lastHeartbeatText = formatRelativeTime(machine.lastHeartbeat, locale);
  const lastHeartbeatParenthetical = lastHeartbeatText
    ? formatMessage({ id: "machine.detail.lastSeenParenthetical" }, { time: lastHeartbeatText })
    : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col font-sans">
      {!hideHeader && (
        <MachinePanelHeader machine={machine} />
      )}

      <ScrollArea className="flex-1 bg-layer-canvas">
        {/* Profile info: the same head as This device's own page (MachineProfileHead). */}
        <MachineProfileHead
          icon={<ComputerDeviceIcon machine={machine} />}
          name={machine.name}
          tone={machine.status === "online" && !thisDeviceNotRunning ? "online" : upgradeReconnecting ? "busy" : "offline"}
          statusLabel={machine.status === "online" && !thisDeviceNotRunning
            ? formatMessage({ id: "activity.status.online" })
            : upgradeReconnecting
              ? formatMessage({ id: "machine.detail.upgradeV2.inProgress" })
              : formatMessage({ id: "machine.detail.offline" })}
          hostname={machine.hostname}
          platformLine={platformLine}
        >
          {sameMachineNames.length > 0 && (
            <div className="text-caption text-foreground-hint" data-testid="machine-detail-same-machine">
              {formatMessage(
                { id: "machine.detail.sameMachineAs" },
                { names: formatList(sameMachineNames, { type: "conjunction" }) },
              )}
            </div>
          )}
          <ComputerMigrationLogLink machineId={machine.id} />
        </MachineProfileHead>
        <Separator />

        {/* The machine the host app (Raft Desktop) runs on: This device, its
            status, controls, servers, updates, permissions and troubleshooting
            (ThisDeviceSections). Never in a browser. */}
        {computerHost && isThisDevice ? (
          <ThisDeviceSections host={computerHost} machine={machine} currentServer={thisDeviceServer} variant="embedded" initialSection={thisDeviceSection} />
        ) : null}

        {versionTier.kind !== "none" && !isThisDevice && (
          <div className="px-(--surface-inset) pt-4">
            <ComputerVersionNotice
              tier={versionTier}
              computerVersion={machine.computerVersion ?? null}
              canManage={canManageMachines}
              platform={windowsMachine ? "windows" : "mac-linux"}
              commands={computerFreshInstallCommands}
              upgradeTargetVersion={machine.status === "online" && cardState.kind === "oneClick" ? cardState.version : null}
              manualUpgrade={cardState.kind === "manualUpgrade"}
              onUpgrade={handleRemoteUpgradeV2Click}
            />
          </div>
        )}

        {diskLow && (
          <div className="px-(--surface-inset) pt-4">
            <Banner
              intent="warning"
              density="sm"
              title={formatMessage({ id: "machine.diskLow.bannerTitle" }, { free: diskLow.free, total: diskLow.total })}
              data-testid="machine-detail-disk-low"
            >
              {formatMessage({ id: "machine.diskLow.bannerBody" })}
            </Banner>
          </div>
        )}

        {/* Name */}
        <div className="px-(--surface-inset) py-4">
          <div className="flex items-center gap-2 mb-1">
            <SectionEyebrow as="div">
              {formatMessage({ id: "machine.detail.name" })}
            </SectionEyebrow>
            {canManageMachines && !editingName && (
              <Tooltip content={formatMessage({ id: "machine.detail.editComputerName" })}>
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                onClick={handleStartRename}
                aria-label={formatMessage({ id: "machine.detail.editComputerName" })}
              >
                <Pencil size={14} />
              </Button>
              </Tooltip>
            )}
          </div>
          {canManageMachines && editingName ? (
            <div className="stack-y-2">
              <Input
                ref={nameInputRef}
                value={draftName}
                onChange={handleNameChange}
                onKeyDown={handleNameKeyDown}
                className="w-full"
                placeholder={formatMessage({ id: "machine.detail.computerName" })}
                autoFocus
                disabled={savingName}
              />
            <div className="flex items-center gap-1.5">
              <Button size="md"
                  variant="accent"
                  onClick={handleSaveRenameClick}
                  disabled={savingName}
                >
                  {formatMessage({ id: "machine.detail.save" })}
                </Button>
                <Button size="md"
                  variant="default"
                  onClick={handleCancelRename}
                  disabled={savingName}
                >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
            </div>
            {nameError && (
              <div className="text-caption text-danger-strong">
                {nameError}
              </div>
            )}
            </div>
          ) : (
            <p className="text-callout text-foreground">{machine.name}</p>
          )}
        </div>
        <Separator />

        {/* Description */}
        <div className="px-(--surface-inset) py-4">
          <div className="flex items-center gap-2 mb-1">
            <SectionEyebrow as="div">
              {formatMessage({ id: "machine.detail.description" })}
            </SectionEyebrow>
            {canManageMachines && !editingDescription && (
              <Tooltip content={formatMessage({ id: "machine.detail.editComputerDescription" })}>
              <Button
                type="button"
                size="icon-md"
                variant="ghost"
                onClick={handleStartEditDescription}
                aria-label={formatMessage({ id: "machine.detail.editComputerDescription" })}
              >
                <Pencil size={14} />
              </Button>
              </Tooltip>
            )}
          </div>
          {canManageMachines && editingDescription ? (
            <div className="stack-y-2">
              <Textarea
                ref={descriptionInputRef}
                value={draftDescription}
                onChange={handleDescriptionChange}
                onKeyDown={handleDescriptionKeyDown}
                className="min-h-20 w-full resize-y"
                placeholder={formatMessage({ id: "machine.detail.descriptionPlaceholder" })}
                maxLength={500}
                autoFocus
                disabled={savingDescription}
              />
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <Button size="md"
                    variant="accent"
                    onClick={handleSaveDescriptionClick}
                    disabled={savingDescription}
                  >
                    {formatMessage({ id: "machine.detail.save" })}
                  </Button>
                  <Button size="md"
                    variant="default"
                    onClick={handleCancelDescription}
                    disabled={savingDescription}
                  >
                    {formatMessage({ id: "common.confirm.cancel" })}
                  </Button>
                </div>
                <span className="font-mono text-mono-meta text-foreground-hint">
                  {draftDescription.length}/500
                </span>
              </div>
              {descriptionError && (
                <div className="text-caption text-danger-strong">
                  {descriptionError}
                </div>
              )}
            </div>
          ) : (
            <p className={`whitespace-pre-wrap text-callout ${machine.description ? "text-foreground" : "text-foreground-hint"}`}>
              {machine.description || formatMessage({ id: "machine.detail.noDescription" })}
            </p>
          )}
        </div>
        <Separator />

        {/* Info */}
        <MachineInfoSection
          machine={machine}
          computerVersionFact={computerVersionFact}
          releaseNotesForUpdate={releaseNotesForUpdate}
          versionTier={versionTier}
          canManageMachines={canManageMachines}
          runtimeDetection={runtimeDetection}
          canRescanRuntimes={canRescanRuntimes}
          rescanState={rescanState}
          onRescanRuntimes={onRescanRuntimes}
          serverId={serverId}
          canViewRuntimeAccountUsage={canViewRuntimeAccountUsage}
          runtimeChipsUpgradeAction={runtimeChipsUpgradeAction}
          createdDate={createdDate}
          openProfile={openProfile}
        />
        <Separator />

        <div className="px-(--surface-inset) py-4 stack-y-6">
          {/* Rows connected with the retired standalone daemon: the only
              offered action is migrating to Raft Computer (task #239 v2.3
              §19.web). The former "keep using the legacy daemon" section is
              gone with the daemon's npm release; the structure stays
              intent-stable and never restructures on credential state (the
              generate-jump defect class, #wg-raft-computer:5473a4ca). */}
          {/* #proj-raft-computer task #38 (Raft DS Banner, warning): an older
              Raft left this machine's key where its agents could read it. The
              server sends the time to the owner only; the way out is the move
              to Raft Computer below, which retires the old key. */}
          {!machine.isComputer && machine.credentialExposureFoundAt && (
            <Banner
              intent="warning"
              live={false}
              withIcon
              data-testid="computer-credential-exposure"
              title={formatMessage({ id: "machine.detail.credentialExposure.title" })}
            >
              {formatMessage(
                { id: "machine.detail.credentialExposure.body" },
                { date: formatDate(machine.credentialExposureFoundAt, { year: "numeric", month: "short", day: "numeric" }) },
              )}
            </Banner>
          )}
          {!machine.isComputer && canManageMachines && !isThisDevice && (
            <div className="stack-y-6">
              {computerSetupCommand && computerInstall && (
                <div data-testid="computer-migrate-block">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <SectionEyebrow as="div">
                      {formatMessage(
                        { id: "machine.detail.migrateToComputer" },
                        { platform: windowsMachine ? formatMessage({ id: "machine.detail.windowsX64Suffix" }) : "" },
                      )}
                    </SectionEyebrow>
                  </div>
                  <p className={`mb-2 ${DETAIL_HELP_CLASS_NAME}`}>
                    {formatMessage(
                      { id: "machine.detail.migrateDescription" },
                      {
                        platform: windowsMachine
                          ? formatMessage({ id: "machine.detail.windowsPowerShell" })
                          : formatMessage({ id: "machine.detail.macLinux" }),
                      },
                    )}
                  </p>
                  <div className="stack-y-3">
                    {([
                      ["computer-install", formatMessage({ id: "machine.detail.installStep" }), computerInstall],
                      ["computer-setup", formatMessage({ id: "machine.detail.setupStep" }), computerSetupCommand],
                    ] as const).map(([target, label, command]) => (
                      <div key={target}>
                        <div className={`mb-1 ${DETAIL_STEP_LABEL_CLASS_NAME}`}>{label}</div>
                        <CommandCopyRoot target={target} copied={copiedCommand === target} onCopy={handleCopy}>
                          <CopyableCode className={COMMAND_LINE_CLASS_NAME}>
                            {command}
                          </CopyableCode>
                          <Tooltip content={formatMessage({ id: "machine.detail.copyCommandLabel" }, { label })}>
                            <CopyableCodeAction
                              aria-label={formatMessage({ id: "machine.detail.copyCommandLabel" }, { label })}
                              className="shrink-0"
                            />
                          </Tooltip>
                        </CommandCopyRoot>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {!machine.isComputer && !canManageMachines && machine.status === "offline" && (
            <div>
              <SectionEyebrow as="div" className="mb-2">
                {formatMessage({ id: "machine.detail.connection" })}
              </SectionEyebrow>
              <div className={DETAIL_HELP_CLASS_NAME}>
                {formatMessage({ id: "machine.detail.connectCommandsAdminOnly" })}
              </div>
            </div>
          )}

          {/* Read-before-acting notice (Raft DS Banner, info): the computer is
              restarting into the new version. Part of the page, not news. */}
          {upgradeReconnecting && (
            <Banner
              intent="info"
              live={false}
              data-testid="computer-upgrade-reconnecting"
              icon={<Spinner aria-hidden="true" />}
              title={formatMessage(
                { id: "machine.detail.upgradeStatus.reconnecting" },
                { version: upgradeInFlight?.targetVersion ?? "" },
              )}
            >
              {canManageMachines && !isThisDevice
                ? formatMessage(
                  { id: "machine.detail.upgradeStatus.reconnectingHint" },
                  { command: statusCommand },
                )
                : null}
            </Banner>
          )}

          {machine.isComputer && machine.status !== "online" && !upgradeReconnecting && !isThisDevice && (
            <ComputerRecoveryCard
              machine={machine}
              canManageMachines={canManageMachines}
              upgradeReconnectOverdue={upgradeReconnectOverdue}
              upgradeInFlight={upgradeInFlight}
              requestOutcomeStillTrue={requestOutcomeStillTrue}
              upgradeRequest={upgradeRequest}
              statusCommand={statusCommand}
              noResponseLine={noResponseLine}
              windowsMachine={windowsMachine}
              computerFreshInstallCommands={computerFreshInstallCommands}
              computerRecoveryRestartCommand={computerRecoveryRestartCommand}
              serverSlug={serverSlug}
              copiedCommand={copiedCommand}
              handleCopy={handleCopy}
              machineComputerCommands={machineComputerCommands}
              lastHeartbeatText={lastHeartbeatText}
              lastHeartbeatParenthetical={lastHeartbeatParenthetical}
              showRecoverySetup={showRecoverySetup}
              toggleRecoverySetup={toggleRecoverySetup}
              computerInstall={computerInstall}
              computerSetupCommand={computerSetupCommand}
            />
          )}

          {/* Agents on this machine — isolated to prevent activity re-renders */}
          <MachineAgentList machine={machine} canManageMachines={canManageMachines} canViewRuntimeAccountUsage={canViewRuntimeAccountUsage} />

          {/* Agent Workspaces — only when machine is online */}
          {machine.status === "online" && (
            <div className="mt-2">
              <Separator className="mb-4" />
              <WorkspacesSection machineId={machine.id} canManageMachines={canManageMachines} />
            </div>
          )}

          {/* Actions */}
          {canManageMachines && (
            <div className="mt-2">
              <Separator className="mb-4" />
              <SectionEyebrow as="div" className="mb-3">
                {formatMessage({ id: "machine.detail.actions" })}
              </SectionEyebrow>
              {/* Remote restart / upgrade — managed Computer only (a raw
                  daemon has no remotely-controllable service). Online-only:
                  offline recovery is the recovery card's job (task #247). */}
              {machine.isComputer && machine.status === "online" && !isThisDevice && (
                <ComputerServiceActionsCard
                  machine={machine}
                  computerOperationProgress={computerOperationProgress}
                  handleComputerRestartClick={handleComputerRestartClick}
                  cardState={cardState}
                  versionTier={versionTier}
                  webUpgradeOn={webUpgradeOn}
                  upgradeRefusal={upgradeRefusal}
                  recommendRepair={recommendRepair}
                  upgradeRequest={upgradeRequest}
                  requestOutcomeStillTrue={requestOutcomeStillTrue}
                  upgradeFailureHint={upgradeFailureHint}
                  handleRemoteUpgradeV2Click={handleRemoteUpgradeV2Click}
                  computerFreshInstallCommands={computerFreshInstallCommands}
                  statusCommand={statusCommand}
                  noResponseLine={noResponseLine}
                  releaseNotesForUpdate={releaseNotesForUpdate}
                  windowsMachine={windowsMachine}
                  copiedCommand={copiedCommand}
                  handleCopy={handleCopy}
                  machineComputerCommands={machineComputerCommands}
                  terminalRestartCommand={terminalRestartCommand}
                />
              )}
              {machine.isComputer && !isThisDevice && machineComputerCommands && computerFreshInstall && computerInstallRestartCommand && terminalRestartCommand && (
                <ComputerRecoveryGuideCard
                  showRecoveryGuide={showRecoveryGuide}
                  setRecoveryGuideDisclosure={setRecoveryGuideDisclosure}
                  recoveryGuideContentId={recoveryGuideContentId}
                  copiedCommand={copiedCommand}
                  handleCopy={handleCopy}
                  terminalRestartCommand={terminalRestartCommand}
                  windowsMachine={windowsMachine}
                  computerFreshInstall={computerFreshInstall}
                  computerInstallRestartCommand={computerInstallRestartCommand}
                />
              )}
              {canDisconnectThisDevice ? (
                <Card className="p-4" data-testid="this-device-disconnect-card">
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="text-subhead font-bold text-foreground">
                        {formatMessage({ id: "computerHost.thisDevice.detail.disconnectTitle" }, { server: thisDeviceServer?.name ?? "" })}
                      </div>
                      <p className={`mt-0.5 ${DETAIL_HELP_CLASS_NAME}`}>
                        {formatMessage({ id: "computerHost.thisDevice.detail.disconnectDescription" }, { server: thisDeviceServer?.name ?? "" })}
                      </p>
                      {disconnectError ? (
                        <p className={`mt-1 ${DETAIL_PROBLEM_CLASS_NAME}`} role="alert">{localComputerErrorMessage(disconnectError, intl)}</p>
                      ) : null}
                    </div>
                    <Button size="md" variant="warning" onClick={openDisconnectConfirm} className="ml-4 shrink-0" data-computer-op="disconnect">
                      {formatMessage({ id: "computerHost.thisDevice.detail.disconnect" })}
                    </Button>
                  </div>
                </Card>
              ) : (
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  {/* The text gives way to the button in a narrow panel. */}
                  <div className="min-w-0 flex-1">
                    <div className="text-subhead font-bold text-foreground">
                      {formatMessage({ id: "machine.detail.deleteComputer" })}
                    </div>
                    <p className={`mt-0.5 ${DETAIL_HELP_CLASS_NAME}`}>
                      {formatMessage({ id: "machine.detail.deleteComputerDescription" })}
                    </p>
                  </div>
                  <Button size="md"
                    variant="danger"
                    onClick={openDeleteConfirm}
                    className="ml-4 shrink-0"
                  >
                    <Trash2 size={16} />
                    {formatMessage({ id: "machine.detail.deleteComputer" })}
                  </Button>
                </div>
              </Card>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      <ComputerActionConfirms name={machine.name} agentCount={machineAgents.length} upgrade={upgradeCard} restart={computerRestart} />

      {showDisconnectConfirm && (
        <ConfirmDialog
          title={formatMessage({ id: "computerHost.thisDevice.disconnect.title" }, { server: thisDeviceServer?.name ?? "" })}
          message={formatMessage({ id: "computerHost.thisDevice.detail.disconnectBody" }, { server: thisDeviceServer?.name ?? "" })}
          confirmLabel={formatMessage({ id: "computerHost.thisDevice.disconnect.confirm" })}
          confirmVariant="warning"
          confirmTestId="this-device-detail-disconnect-confirm"
          onConfirm={handleDisconnectThisDevice}
          onClose={closeDisconnectConfirm}
        />
      )}

      {showDeleteConfirm && <DeleteComputerDialog machine={machine} agents={machineAgents} onClose={closeDeleteConfirm} />}

    </div>
  );
}
