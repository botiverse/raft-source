// Setting up this computer on Raft Desktop (This Mac picked in Add Computer's
// choice, or Add to this server): it connects to the current server with no
// placeholder machine row (`registerMachine`); the attach goes straight to
// the bridge (host.attach). "Setting up this Mac"
// shows the real steps as they happen (`onEnableProgress`; a single spinner
// on a shell without it): Install Raft Computer (done at once when it is
// already installed) → Connect to <server> → Start Raft Computer → Online
// (the server lists this Mac), and "This Mac is ready" names it. Never a
// command: a failure is one sentence, Try again, and links to the logs and to
// Diagnostics; the raw error only under Technical details. Another machine is
// Add Computer's "Another computer" (the command flow).
//
// Raft Design System: progress is raft-ui Steps (vertical); the rest is raft-ui.
import { useCallback, useState } from "react";
import type { ChangeEvent, ReactNode } from "react";
import { useIntl } from "react-intl";
import { CircleCheck } from "lucide-react";
import { Button, Input, Spinner, Step, Steps, TextLink } from "@botiverse/raft-ui";
import type { StepStatus } from "@botiverse/raft-ui";
import { useMachineStore } from "../../../store/machineStore";
import Banner from "../../ui/Banner";
import FormField from "../../ui/FormField";
import { DialogCardFooter, DialogCommit } from "../../ui/NarrowDialog";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { localComputerErrorMessage } from "./localComputerCopy";
import { TechnicalDetails } from "./thisDeviceParts";
import { ENABLE_STEPS } from "./addThisDeviceChoice";
import type { EnableStepKey, EnableStepProgress } from "./addThisDeviceChoice";
import { thisDeviceSetupView } from "./addThisComputerStore";
import type { ThisDeviceSetupState } from "./addThisComputerStore";

function stepStatus(step: EnableStepProgress): StepStatus {
  switch (step.state) {
    case "done": return "finish";
    case "active": return "process";
    case "failed": return "error";
    default: return "wait";
  }
}

/**
 * Setting up this Mac, then This Mac is ready (the click on Add Computer
 * started it: addThisComputerStore). `onFinish` is Done.
 */
export function ThisDeviceSetupFlow({ host, setup, onRun: run, serverName, onFinish, onRunDiagnostics, onCancel, presentation = "dialog", errorText }: {
  host: LocalComputerHost;
  /**
   * dialog: Add Computer's dialog (Continue in background, Done). inline: in a
   * page or a step (onboarding): the same steps, failure and Ready, with its
   * own buttons in place and no dialog footer; the surrounding step moves on.
   */
  presentation?: "dialog" | "inline";
  /** How a failure reads where it is shown (onboarding has its own words for a few). */
  errorText?: (error: unknown) => string;
  setup: Pick<ThisDeviceSetupState, "phase" | "progress" | "error">;
  /** Try again. */
  onRun: () => void;
  serverName: string;
  onFinish: (machineId: string | null) => void;
  /** Absent where This device's page can't be opened (onboarding): no Run diagnostics link. */
  onRunDiagnostics?: () => void;
  onCancel: () => void;
}) {
  const intl = useIntl();
  const { formatMessage } = intl;
  const { bridge } = host;
  const supportsProgress = typeof bridge.onEnableProgress === "function";
  const { progress: setupProgress, error } = setup;
  const view = thisDeviceSetupView(setup.phase, host.self);
  const phase = view;
  // Waiting for the server to list it: the last step (online) is the one in progress.
  const progress = view === "listing" ? { ...setupProgress, online: { ...setupProgress.online, state: "active" as const } } : setupProgress;
  const retry = useCallback(() => run(), [run]);
  const openLogs = useCallback(() => { void bridge.openComputerLogs?.(); }, [bridge]);

  if (phase === "ready") {
    return <ThisDeviceReady host={host} serverName={serverName} onFinish={onFinish} presentation={presentation} />;
  }

  const errorSentence = error ? (errorText ? errorText(error) : localComputerErrorMessage(error, intl)) : null;
  const titles: Record<EnableStepKey, string> = {
    install: formatMessage({ id: "computerHost.addDialog.stepInstall" }),
    attach: formatMessage({ id: "computerHost.addDialog.stepAttach" }, { server: serverName }),
    start: formatMessage({ id: "computerHost.addDialog.stepStart" }),
    online: formatMessage({ id: "computerHost.addDialog.stepOnline" }),
  };
  const describe = (key: EnableStepKey, step: EnableStepProgress): ReactNode => {
    if (step.state === "failed" && errorSentence) return <span role="alert" data-testid="add-this-device-error">{errorSentence}</span>;
    if (key === "install" && step.state === "done" && step.version) {
      return formatMessage({ id: step.skipped ? "computerHost.addDialog.installed" : "computerHost.thisDevice.version" }, { version: step.version });
    }
    if (key === "online" && view === "listing") {
      return (
        <span data-testid="add-this-device-awaiting-listing">
          {formatMessage({ id: host.self.deviceKind === "mac" ? "computerHost.thisDevice.awaitingListingMac" : "computerHost.thisDevice.awaitingListingOther" }, { server: serverName })}
        </span>
      );
    }
    return undefined;
  };
  const current = ENABLE_STEPS.findIndex((key) => progress[key].state !== "done");

  return (
    <div data-testid="add-this-device-setup">
      {supportsProgress ? (
        <Steps vertical current={current === -1 ? ENABLE_STEPS.length : current + 1} className="mb-4" data-testid="add-this-device-steps">
          {ENABLE_STEPS.map((key) => (
            <Step key={key} title={titles[key]} description={describe(key, progress[key])} status={stepStatus(progress[key])} data-step={key} data-state={progress[key].state} />
          ))}
        </Steps>
      ) : phase === "working" || phase === "listing" ? (
        <div className="mb-4 flex items-center gap-2 text-callout text-foreground-muted" data-testid="add-this-device-spinner">
          <Spinner aria-hidden="true" />
          {phase === "listing" ? (
            <span data-testid="add-this-device-awaiting-listing">
              {formatMessage({ id: host.self.deviceKind === "mac" ? "computerHost.thisDevice.awaitingListingMac" : "computerHost.thisDevice.awaitingListingOther" }, { server: serverName })}
            </span>
          ) : formatMessage({ id: "computerHost.thisDevice.state.settingUp" })}
        </div>
      ) : null}
      {phase === "failed" && !supportsProgress && errorSentence ? (
        <Banner intent="warning" className="mb-4">
          <span role="alert" data-testid="add-this-device-error">{errorSentence}</span>
        </Banner>
      ) : null}
      {phase === "failed" ? (
        <div className="mb-4">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {typeof bridge.openComputerLogs === "function" ? (
              <TextLink onClick={openLogs} data-testid="add-this-device-open-logs">{formatMessage({ id: "computerHost.thisDevice.openLogs" })}</TextLink>
            ) : null}
            {onRunDiagnostics ? (
              <TextLink onClick={onRunDiagnostics} data-testid="add-this-device-run-diagnostics">{formatMessage({ id: "computerHost.thisDevice.troubleshoot.runDiagnostics" })}</TextLink>
            ) : null}
          </div>
          {error instanceof Error && error.message ? <TechnicalDetails text={error.message} /> : null}
        </div>
      ) : null}
      {presentation === "inline" ? (
        phase === "failed" ? (
          <div className="flex flex-wrap gap-2">
            <Button size="md" variant="primary" type="button" onClick={retry} data-testid="add-this-device-retry">
              {formatMessage({ id: "computerHost.thisDevice.tryAgain" })}
            </Button>
          </div>
        ) : null
      ) : (
      <DialogCardFooter>
        <Button size="lg" variant="ghost" type="button" onClick={onCancel}>
          {formatMessage({ id: phase === "failed" ? "common.confirm.cancel" : "computerHost.addDialog.continueInBackground" })}
        </Button>
        {phase === "failed" ? (
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"} variant="primary" type="button" onClick={retry} data-testid="add-this-device-retry">
                {formatMessage({ id: "computerHost.thisDevice.tryAgain" })}
              </Button>
            )}
          </DialogCommit>
        ) : null}
      </DialogCardFooter>
      )}
    </div>
  );
}

/** The last step: it is on this server; name it. */
function ThisDeviceReady({ host, serverName, onFinish, presentation }: {
  host: LocalComputerHost;
  serverName: string;
  onFinish: (machineId: string | null) => void;
  presentation: "dialog" | "inline";
}) {
  const { formatMessage } = useIntl();
  const machineId = host.self.machineId;
  const machine = useMachineStore((s) => (machineId ? s.machines.find((m) => m.id === machineId) ?? null : null));
  const renameMachine = useMachineStore((s) => s.renameMachine);
  const [name, setName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mac = host.self.deviceKind === "mac";
  const handleName = useCallback((event: ChangeEvent<HTMLInputElement>) => setName(event.target.value), []);
  const finish = useCallback(async () => {
    const finalName = name?.trim() ?? "";
    if (machine && finalName && finalName !== machine.name) {
      setSaving(true);
      try {
        await renameMachine(machine.id, finalName);
      } catch {
        // The name stays as it was; it can be changed on the Computer page.
      } finally {
        setSaving(false);
      }
    }
    onFinish(machineId);
  }, [machine, machineId, name, onFinish, renameMachine]);

  return (
    <div data-testid="add-this-device-ready">
      <Banner
        intent="success"
        live={false}
        className="mb-4"
        icon={<CircleCheck size={20} aria-hidden="true" />}
        title={formatMessage({ id: mac ? "computerHost.addDialog.readyBodyMac" : "computerHost.addDialog.readyBodyOther" }, { server: serverName })}
      />
      {machine && presentation === "dialog" ? (
        <FormField
          label={formatMessage({ id: "machine.add.computerName" })}
          className="mb-4"
        >
          <Input type="text" value={name ?? machine.name} onChange={handleName} className="w-full" autoFocus data-testid="add-this-device-name" />
        </FormField>
      ) : null}
      {/* Inline (onboarding): the surrounding step moves on by itself; no Done. */}
      {presentation === "dialog" ? (
        <DialogCardFooter>
          <DialogCommit>
            {(inHead) => (
              <Button size={inHead ? "md" : "lg"} variant="primary" type="button" onClick={finish} disabled={saving} data-testid="add-this-device-done">
                {formatMessage({ id: saving ? "machine.add.saving" : "machine.add.done" })}
              </Button>
            )}
          </DialogCommit>
        </DialogCardFooter>
      ) : null}
    </div>
  );
}
