import { Input, Checkbox, Button, Field, FieldLabel, Spinner, TextLink } from "@botiverse/raft-ui";
import { ChoiceList } from "@botiverse/raft-ui/wip";
import type { ChoiceListItem } from "@botiverse/raft-ui/wip";
import { computerPlatformName } from "../../utils/computerDevice";
import { useState, useEffect, useRef, useCallback, useId, useMemo } from "react";
import type { ChangeEvent } from "react";
import { CircleCheck, Laptop, Monitor } from "lucide-react";
import { useIntl } from "react-intl";
import { useMachineStore } from "../../store/machineStore";
import { useComputerConnectionWatch } from "../../hooks/useComputerConnectionWatch";
import { useServerStore } from "../../store/serverStore";
import { useAppNavigate } from "../../hooks/useAppNavigate";
import { useNavigate } from "react-router-dom";
import { getServerUrl } from "../../utils/server";
// The baseline/resolver import staging still carries is gone here: this dialog's
// connect state machine lives in useComputerConnectionWatch now, shared with onboarding.
import { getComputerCommands } from "../../utils/computerSetupCommand";
import { PLAN_CONFIG, getEffectiveLimits } from "@botiverse/raft-shared";
import type { ServerPlan } from "@botiverse/raft-shared";
import DialogCard from "../ui/DialogCard";
import FormField from "../ui/FormField";
import Banner from "../ui/Banner";
import KeyValueRow from "../ui/KeyValueRow";
import ComputerCommandGuide from "./ComputerCommandGuide";
import MachineRuntimeChips from "./MachineRuntimeChips";
import { useAuthStore } from "../../store/authStore";
import { useServerPermissions } from "../../hooks/useServerPermissions";
import { canViewMachineRuntimeAccountUsage } from "../../utils/machineRuntimeUsageVisibility";
import { DialogCardFooter, DialogCommit } from "../ui/NarrowDialog";
import type { AddMachineIntent } from "../../store/machineStore";
import { useLocalComputerHost } from "./localComputer/useLocalComputerHost";
import type { LocalComputerHost } from "./localComputer/useLocalComputerHost";
import { AddThisComputerDialog } from "./localComputer/AddThisComputerDialog";
import { setupForServer, startAddThisComputer, useAddThisComputerStore } from "./localComputer/addThisComputerStore";
import { useAddComputerOnDesktop } from "./localComputer/useAddComputerOnDesktop";
import { thisDevicePath } from "./localComputer/thisDeviceRoute";

type DialogStep = "type" | "waiting" | "connected";
export const WAITING_HINT_DELAY_MS = 45_000;
/** Where the computer is: this one (Raft Desktop only), or another of the person's own (the command). */
type MachineType = "this" | "own";

/**
 * Add Computer. It asks where the computer is first, so a click never starts
 * installing anything on its own:
 * - This computer (Raft Desktop only, first): one click connects it, and the
 *   dialog shows the progress (AddThisComputerDialog). Already here, or can't
 *   be added right now: the option says so and links to This device's page.
 * - Your own computer (on Raft Desktop: another one): a laptop, a
 *   desktop or a cloud server (VPS); the command to run on it. In a browser
 *   that is the only choice, so the dialog opens on the command, with that
 *   line above it.
 * No "Cloud computer (coming soon)" option: someone with their own cloud
 * server read it as theirs and gave up, and agents Raft runs in the cloud are
 * Create Agent's cloud agent, not a computer added here.
 * The `another-computer` intent (This device's "Install on another computer"
 * when this computer can't run Raft Computer) opens straight on the command.
 */
export default function AddMachineDialog({ onClose, intent: intentProp }: { onClose: () => void; intent?: AddMachineIntent }) {
  const host = useLocalComputerHost();
  // How it was opened (setShowAddMachine's intent), unless the caller says.
  const storedIntent = useMachineStore((s) => s.addMachineIntent);
  const intent = intentProp ?? storedIntent;
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  // A setup of this computer in flight (just picked, Add to this server, or
  // Continue in Background): its progress.
  const settingUp = useAddThisComputerStore((s) => setupForServer(s, serverSlug).phase !== "idle");
  if (host && settingUp && intent !== "another-computer") return <AddThisComputerDialog host={host} onClose={onClose} />;
  return <AddMachineDialogBody onClose={onClose} host={host} />;
}

/**
 * The command step when there is nothing to choose (a browser: only the
 * person's own computer) or it was opened for another computer;
 * the choice otherwise. At the plan's limit, the first step (it says so).
 */
function initialStep(host: LocalComputerHost | null): DialogStep {
  const { addMachineIntent, machines } = useMachineStore.getState();
  if (host && addMachineIntent !== "another-computer") return "type";
  const plan = (useServerStore.getState().current?.plan || "free") as ServerPlan;
  const maxMachines = getEffectiveLimits(plan).maxMachines;
  return maxMachines !== -1 && machines.length >= maxMachines ? "type" : "waiting";
}

/** The choice, then the command flow; `host`: on Raft Desktop (This computer is an option, and the command is for another one). */
function AddMachineDialogBody({ onClose, host }: { onClose: () => void; host: LocalComputerHost | null }) {
  const anotherComputer = host !== null;
  const { formatMessage } = useIntl();
  const nav = useAppNavigate();
  const navigate = useNavigate();
  // A browser, or Raft Desktop's Install on another computer (the intent it
  // was opened with): straight to the command. Nothing is created on the
  // server until a machine actually connects.
  // oxlint-disable-next-line react-doctor/no-event-handler -- A one-time seed of the wizard's first step when the dialog opens (it mounts per open), not a mirror of `host`.
  const [step, setStep] = useState<DialogStep>(() => initialStep(host));
  // Picked by the person; until then This computer when it can be added, else their own.
  const [pickedType, setPickedType] = useState<MachineType | null>(null);
  const thisComputer = useAddComputerOnDesktop(host);
  const whichComputerId = useId();
  // The connected Computer's own row, once it shows up. Nothing is created on
  // the server before that: no placeholder row is registered for this attempt.
  const [machineId, setMachineId] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmedComputerMatch, setConfirmedComputerMatch] = useState(false);
  const connectedComputerConfirmationRef = useRef<{ machineId: string; requiresConfirmation: boolean } | null>(null);

  const renameMachine = useMachineStore((s) => s.renameMachine);
  const serverSlug = useServerStore((s) => s.current?.slug);
  const serverId = useServerStore((s) => s.current?.id ?? null);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const { capabilities } = useServerPermissions();
  const machines = useMachineStore((s) => s.machines);

  const plan = (useServerStore((s) => s.current?.plan) || "free") as ServerPlan;
  const maxMachines = getEffectiveLimits(plan).maxMachines;
  const atLimit = maxMachines !== -1 && machines.length >= maxMachines;
  const canAddThis = thisComputer?.kind === "connect";
  // Raft Desktop, before it has said what this computer is: nothing picked yet.
  // (This computer stops being a choice if it can no longer be added.)
  const picked = pickedType === "this" && !canAddThis ? null : pickedType;
  const machineType: MachineType | null = picked ?? (host ? (thisComputer === null ? null : canAddThis ? "this" : "own") : "own");
  const pickType = useCallback((value: string) => {
    if (value === "this" || value === "own") setPickedType(value);
  }, []);

  const serverUrl = getServerUrl();


  // Watch for the machine coming online. The detection, the baseline, and the
  // dropped-event polling fallback all live in the shared watch — the onboarding
  // setup gate asks the same questions and must not answer them differently.
  // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family: pre-existing non-bug site grandfathered; rule now gates new code (see docs/frontend/render-cost-contract.md)
  const pendingMachine = machineId ? machines.find((m) => m.id === machineId) : null;
  // oxlint-disable-next-line react-doctor/no-event-handler -- Same YMNNE-family async waiter as `pendingMachine` above: the watch observes daemon connect, it is not an event handler.
  const connectWatchActive = step === "waiting";
  // No pending row id: the Computer setup command creates the computer's own
  // row when it connects, and the watch finds it (as onboarding does). A
  // Computer that was already online when the attempt began is not the one
  // being added, so it never counts as this attempt's connection.
  const connectionProgress = useComputerConnectionWatch({
    active: connectWatchActive,
    includeAlreadyOnline: false,
  });

  // The browser cannot see the terminal, so a failed install or setup looks
  // like endless waiting. After a while, point the user at the terminal and at
  // the connect-only command (bug-triage task #22).
  const [waitingStalled, setWaitingStalled] = useState(false);
  useEffect(() => {
    if (step !== "waiting") return;
    const timer = setTimeout(() => setWaitingStalled(true), WAITING_HINT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [step]);
  const connectedMachine = connectionProgress.state === "connected" ? connectionProgress.machine : null;
  const connectedRequiresConfirmation = connectionProgress.state === "connected" &&
    connectionProgress.requiresConfirmation;
  const connectedComputerConfirmation = connectedComputerConfirmationRef.current;
  const needsComputerMatchConfirmation = step === "connected" &&
    Boolean(pendingMachine?.isComputer) &&
    (connectedComputerConfirmation?.machineId === machineId ? connectedComputerConfirmation.requiresConfirmation : true);
  const canFinishConnectedStep = step === "connected" && (!needsComputerMatchConfirmation || confirmedComputerMatch);

  // One-shot prefill waiter: during the Add Machine setup wizard, the daemon
  // registers and then comes online over the socket. When it does, advance
  // the wizard from "waiting" → "connected" and pre-fill the name field with
  // the daemon-reported hostname (saving the user a manual type). NOT a
  // mirror-prop pattern — it's a wait-for-async-event seed, and a
  // useState-initializer refactor would require remounting the dialog when
  // `isConnected` flips and would lose the wizard's place. Same shape as
  // CreateAgentDialog's `prefilledMachineId` waiter (PR #2524).
  // oxlint-disable-next-line react-doctor/no-cascading-set-state -- One-shot async waiter seeds wizard state after daemon/Computer connect; splitting would lose the modal progression contract.
  useEffect(() => {
    // oxlint-disable-next-line react-doctor/no-event-handler -- YMNNE-family async waiter, not a render mirror.
    if (connectedMachine && step === "waiting") {
      // oxlint-disable-next-line react-doctor/no-chain-state-updates, react-doctor/no-derived-state -- YMNNE-family: pre-existing non-bug site grandfathered; the wizard advances on a connect event, not a value derivable in render (see docs/frontend/render-cost-contract.md)
      setStep("connected");
      // The Computer setup command creates/resumes its own linked machine row.
      // When that row comes online, the wizard continues with it. A resumed or
      // ambiguous match asks the user to confirm it is the one they set up.
      connectedComputerConfirmationRef.current = {
        machineId: connectedMachine.id,
        requiresConfirmation: connectedRequiresConfirmation,
      };
      // oxlint-disable-next-line react-doctor/no-chain-state-updates, react-doctor/no-derived-state -- This is not render-derived state; it records the concrete connected row for Done/rename/navigation.
      setMachineId(connectedMachine.id);
      // Pre-fill name with hostname from daemon
      if (connectedMachine.hostname) {
        // oxlint-disable-next-line react-doctor/no-derived-state
        setName(connectedMachine.hostname);
      }
    }
  }, [connectedMachine, connectedRequiresConfirmation, step]);

  // The dropped-event polling fallback now lives in useComputerConnectionWatch,
  // alongside the baseline it belongs with.

  // Next only shows the command: nothing is written to the server until a
  // machine actually connects, so closing the tab or the browser mid-setup
  // leaves no row behind.
  const handleSelectType = useCallback(() => {
    if (machineType === "this") {
      // This computer: the one setup (AddMachineDialog shows its progress next).
      if (host && serverSlug && canAddThis) startAddThisComputer(host, serverSlug, "this-device");
      return;
    }
    setConfirmedComputerMatch(false);
    connectedComputerConfirmationRef.current = null;
    setMachineId("");
    setStep("waiting");
  }, [canAddThis, host, machineType, serverSlug]);
  const openThisDevice = useCallback(() => {
    onClose();
    if (host && serverSlug) navigate(thisDevicePath(serverSlug, host.self.machineId));
  }, [host, navigate, onClose, serverSlug]);

  // The choice (DS ChoiceList): This computer (Raft Desktop only), the person's
  // own (another one, on Raft Desktop). This computer that can't be added
  // says why, with a way to its page.
  const typeItems = useMemo<ChoiceListItem[]>(() => [
    ...(host ? [{
      value: "this",
      label: formatMessage({ id: host.self.deviceKind === "mac" ? "machine.add.thisComputerMac" : "machine.add.thisComputerOther" }),
      description: thisComputer === null
        ? formatMessage({ id: "computerHost.thisDevice.state.checking" })
        : thisComputer.kind === "connect"
          ? formatMessage({ id: "machine.add.thisComputerDescription" })
          : formatMessage({ id: thisComputer.reason === "attached" ? "machine.add.thisComputerAdded" : "machine.add.thisComputerBlocked" }),
      media: <Laptop size={20} aria-hidden="true" />,
      disabled: !canAddThis,
      action: thisComputer?.kind === "open-this-device" ? (
        <Button size="sm" variant="ghost" type="button" onClick={openThisDevice} data-testid="add-machine-type-this-open">
          {formatMessage({ id: "computerHost.addDialog.openThisDevice" })}
        </Button>
      ) : undefined,
    }] : []),
    {
      value: "own",
      label: formatMessage({ id: host ? "machine.add.anotherComputer" : "machine.add.yourComputer" }),
      description: formatMessage({ id: "machine.add.yourComputerDescription" }),
      media: <Monitor size={20} aria-hidden="true" />,
    },
  ], [canAddThis, formatMessage, host, openThisDevice, thisComputer]);

  const pendingHostname = pendingMachine?.hostname;
  const pendingName = pendingMachine?.name;
  const handleDone = useCallback(async () => {
    if (needsComputerMatchConfirmation && !confirmedComputerMatch) return;
    const finalName = name.trim() || pendingHostname || "";
    if (finalName && machineId && finalName !== pendingName) {
      setSaving(true);
      try {
        await renameMachine(machineId, finalName);
      } catch {
        // ignore — name stays as default
      } finally {
        setSaving(false);
      }
    }
    onClose();
    nav.toMachine(machineId);
  }, [
    confirmedComputerMatch,
    machineId,
    name,
    nav,
    needsComputerMatchConfirmation,
    onClose,
    pendingHostname,
    pendingName,
    renameMachine,
  ]);

  const handleNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => setName(e.target.value), []);
  const closeAndOpenBillingSettings = useCallback(() => {
    onClose();
    nav.toSettings("billing");
  }, [onClose, nav]);

  const deploymentEnv = import.meta.env?.VITE_DEPLOYMENT_ENV;
  const computerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl);
  const windowsComputerCommands = getComputerCommands(serverSlug, deploymentEnv, serverUrl, {
    platform: "windows",
  });
  const computerSetupCommand = computerCommands?.setup ?? null;
  const computerInstall = computerCommands?.install ?? null;
  const computerInstallAndSetup = computerCommands?.installAndSetup ?? null;
  const windowsComputerSetupCommand = windowsComputerCommands?.setup ?? null;
  const windowsComputerInstall = windowsComputerCommands?.install ?? null;

  // On Raft Desktop the command is for another computer: "Install on another
  // computer", until it is connected.
  const dialogTitle = anotherComputer && step === "waiting"
    ? formatMessage({ id: "computerHost.thisDevice.installAnother" })
    : step === "type"
      ? formatMessage({ id: "machine.add.title.add" })
      : step === "waiting"
        ? formatMessage({ id: "machine.add.title.connect" })
        : formatMessage({ id: "machine.add.title.connected" });

  // The shared product dialog shell (Raft DS Dialog): backdrop, Escape and the
  // close button all run the same handler the hand-rolled header used.
  return (
    <DialogCard
      title={dialogTitle}
      onClose={canFinishConnectedStep ? handleDone : onClose}
      maxWidthClass="max-w-lg"
      narrow="sheet"
    >

        {atLimit && step === "type" && (
          <Banner intent="warning" className="mb-4">
            {formatMessage(
              { id: "machine.add.limitReached" },
              { count: machines.length, max: maxMachines, plan: PLAN_CONFIG[plan].displayName },
            )}{" "}
            <TextLink
              onClick={closeAndOpenBillingSettings}
              variant="strong"
            >
              {formatMessage({ id: "machine.add.upgradeForMore" })}
            </TextLink>
          </Banner>
        )}
        {/* Step 1: Choose machine type */}
        {step === "type" && (
          <div>
            <Field className="mb-4">
              <FieldLabel id={whichComputerId}>{formatMessage({ id: "machine.add.whichComputer" })}</FieldLabel>
              <ChoiceList
                aria-labelledby={whichComputerId}
                items={typeItems}
                value={machineType}
                onValueChange={pickType}
                searchLabel={formatMessage({ id: "machine.add.whichComputer" })}
                clearSearchLabel={formatMessage({ id: "search.clearSearch" })}
              />
            </Field>

            <DialogCardFooter>
              <Button
                size="lg"
                variant="ghost"
                type="button"
                onClick={onClose}
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <DialogCommit>
                {(inHead) => (
                  <Button
                    size={inHead ? "md" : "lg"}
                    variant="primary"
                    type="button"
                    onClick={handleSelectType}
                    disabled={atLimit || machineType === null}
                    data-testid="add-machine-next"
                  >
                    {formatMessage({ id: "common.announcement.next" })}
                  </Button>
                )}
              </DialogCommit>
            </DialogCardFooter>
          </div>
        )}

        {/* Step 2: Waiting for connection */}
        {step === "waiting" && (
          <div>
            {/* On Raft Desktop the command is for the other computer, not this one. */}
            {/* In a browser: any machine of the person's own, a cloud server too. */}
            <p className="mb-2 text-callout text-foreground-muted" data-testid={anotherComputer ? "add-machine-other-computer-hint" : "add-machine-own-computer-hint"}>
              {formatMessage({ id: anotherComputer ? "computerHost.addDialog.otherComputerHint" : "machine.add.ownComputerHint" })}
            </p>
            <ComputerCommandGuide
              className="mb-4"
              computerCommand={computerSetupCommand}
              computerInstallCommand={computerInstall}
              computerInstallAndSetupCommand={computerInstallAndSetup}
              windowsComputerCommand={windowsComputerSetupCommand}
              windowsComputerInstallCommand={windowsComputerInstall}
            />

            {/* Waiting indicator */}
            <Banner
              intent="info"
              className="mb-4"
              // Raft DS Banner (raft-ui 0.22): while the computer has not
              // connected yet, a Spinner takes the icon's place in an info
              // banner; Banner centers it on the first line. Never a Status
              // light: a light does not say what kind of notice this is.
              icon={<Spinner aria-hidden="true" />}
            >
              <span className="font-bold text-foreground">
                {formatMessage({ id: "machine.add.waitingForConnect" })}
              </span>
            </Banner>
            {step === "waiting" && waitingStalled && (
              <p className="-mt-2 mb-4 text-footnote text-foreground-muted" data-testid="add-machine-still-waiting">
                {formatMessage({ id: "machine.add.stillWaitingHint" })}
              </p>
            )}

            <DialogCardFooter>
              <Button
                size="lg"
                variant="ghost"
                type="button"
                onClick={onClose}
              >
                {formatMessage({ id: "common.confirm.cancel" })}
              </Button>
              <DialogCommit>
                {(inHead) => (
                  <Button
                    size={inHead ? "md" : "lg"}
                    variant="primary"
                    type="button"
                    disabled
                  >
                    {formatMessage({ id: "machine.add.done" })}
                  </Button>
                )}
              </DialogCommit>
            </DialogCardFooter>
          </div>
        )}

        {/* Step 3: Connected — name the machine */}
        {step === "connected" && (
          <div>
            {/* Done: the Raft DS success Banner, part of this step rather than
                news, so it does not announce itself. */}
            <Banner
              intent="success"
              live={false}
              className="mb-4"
              icon={<CircleCheck size={20} aria-hidden="true" />}
              title={formatMessage({ id: "machine.add.connectedSuccessfully" })}
            >
              {pendingMachine?.hostname ? (
                <span className="font-mono text-mono-meta">
                  {pendingMachine.hostname} — {computerPlatformName(pendingMachine.os) || formatMessage({ id: "machine.add.unknownOs" })}
                </span>
              ) : null}
            </Banner>

            <FormField
              label={formatMessage({ id: "machine.add.computerName" })}
              className="mb-4"
            >
              <Input
                type="text"
                value={name}
                onChange={handleNameChange}
                className="w-full"
                placeholder={pendingMachine?.hostname || formatMessage({ id: "machine.add.computerNamePlaceholder" })}
                autoFocus
              />
            </FormField>

            {/* task #17: the same runtime badges as the Computer page, so a
                runtime that is signed out can be signed in right here. */}
            {pendingMachine && pendingMachine.runtimes.length > 0 ? (
              <KeyValueRow
                className="mb-4"
                label={formatMessage({ id: "machine.detail.detectedRuntimes" })}
                value={
                  <MachineRuntimeChips
                    // A Show All choice belongs to the Computer it was made on.
                    key={pendingMachine.id}
                    machineId={pendingMachine.id}
                    machineRuntimeIds={pendingMachine.runtimes}
                    runtimeVersions={pendingMachine.runtimeVersions}
                    serverId={serverId}
                    canViewRuntimeAccountUsage={canViewMachineRuntimeAccountUsage(pendingMachine, currentUserId, capabilities)}
                    testId="add-machine-detected-runtimes"
                  />
                }
              />
            ) : null}

            {needsComputerMatchConfirmation && (
              <label className="mb-4 flex items-start gap-3 rounded-control border-[1.5px] border-line-strong bg-layer-card p-3 text-callout font-semibold text-foreground">
                <Checkbox
                  checked={confirmedComputerMatch}
                  onCheckedChange={setConfirmedComputerMatch}
                  aria-label={formatMessage({ id: "machine.add.confirmComputerMatch" }, { hostname: pendingMachine?.hostname ? ` (${pendingMachine.hostname})` : "" })}
                />
                <span>
                  {formatMessage(
                    { id: "machine.add.confirmComputerMatch" },
                    { hostname: pendingMachine?.hostname ? ` (${pendingMachine.hostname})` : "" },
                  )}
                </span>
              </label>
            )}

            <DialogCardFooter>
              <DialogCommit>
                {(inHead) => (
                  <Button
                    size={inHead ? "md" : "lg"}
                    variant="primary"
                    type="button"
                    onClick={handleDone}
                    disabled={saving || (needsComputerMatchConfirmation && !confirmedComputerMatch)}
                  >
                    {saving
                      ? formatMessage({ id: "machine.add.saving" })
                      : formatMessage({ id: "machine.add.done" })}
                  </Button>
                )}
              </DialogCommit>
            </DialogCardFooter>
          </div>
        )}
    </DialogCard>
  );
}
