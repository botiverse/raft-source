// Setting up this computer on Raft Desktop: Add Computer's dialog while a
// setup of this computer is in flight (picked in Add Computer's choice, or
// Add to this server: useAddThisComputer → addThisComputerStore).
// AddMachineDialog shows it only then. It shows the progress (Setting up this
// Mac, then This Mac is ready: AddThisDeviceFlow); closing it ends the setup's
// view (Continue in background keeps the setup running).
import { useCallback, useEffect, useMemo } from "react";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import { useMachineStore } from "../../../store/machineStore";
import { useServerStore } from "../../../store/serverStore";
import { useAgentStore } from "../../../store/agentStore";
import DialogCard from "../../ui/DialogCard";
import type { LocalComputerHost } from "./useLocalComputerHost";
import { ThisDeviceSetupFlow } from "./AddThisDeviceFlow";
import { resetAddThisComputer, setupForServer, startAddThisComputer, thisDeviceSetupView, useAddThisComputerStore } from "./addThisComputerStore";
import { thisDevicePath } from "./thisDeviceRoute";

const LISTING_POLL_MS = 3000;

export function AddThisComputerDialog({ host, onClose }: { host: LocalComputerHost; onClose: () => void }) {
  const { formatMessage } = useIntl();
  const navigate = useNavigate();
  const serverSlug = useServerStore((s) => s.current?.slug ?? null);
  const serverName = useServerStore((s) => s.current?.name ?? null);
  // This server's setup only (a setup started on another server is not this one's).
  const stored = useAddThisComputerStore();
  const { phase, progress, error } = setupForServer(stored, serverSlug);
  const mac = host.self.deviceKind === "mac";
  const setup = useMemo(() => ({ phase, progress, error }), [error, phase, progress]);

  const close = useCallback(() => {
    resetAddThisComputer();
    onClose();
  }, [onClose]);
  // Try again (keeps where Done goes).
  const run = useCallback(() => {
    if (serverSlug) startAddThisComputer(host, serverSlug);
  }, [host, serverSlug]);
  const runDiagnostics = useCallback(() => {
    close();
    if (serverSlug) navigate(thisDevicePath(serverSlug, host.self.machineId, "troubleshoot"));
  }, [close, host.self.machineId, navigate, serverSlug]);
  const finish = useCallback((finishedMachineId: string | null) => {
    const { then } = useAddThisComputerStore.getState();
    close();
    // Started from Create Agent (no computer yet): back to it, with this Mac to pick.
    if (then === "create-agent") {
      useAgentStore.getState().setShowCreateAgent(true);
      return;
    }
    if (serverSlug) navigate(thisDevicePath(serverSlug, finishedMachineId));
  }, [close, navigate, serverSlug]);

  // One derived view: "This Mac is ready" only once the server lists it.
  const view = thisDeviceSetupView(phase, host.self);
  // Waiting for the server to list it: `machine:*` socket events bring the
  // row; polling the list is the fallback for a dropped event (as
  // useComputerConnectionWatch does), so it never waits forever.
  const loadMachines = useMachineStore((s) => s.loadMachines);
  useEffect(() => {
    if (view !== "listing") return;
    const interval = setInterval(() => void loadMachines(), LISTING_POLL_MS);
    return () => clearInterval(interval);
  }, [loadMachines, view]);
  const title = view === "ready"
    ? formatMessage({ id: mac ? "computerHost.addDialog.readyTitleMac" : "computerHost.addDialog.readyTitleOther" })
    : formatMessage({ id: mac ? "computerHost.addDialog.settingUpTitleMac" : "computerHost.addDialog.settingUpTitleOther" });

  return (
    <DialogCard title={title} onClose={close} maxWidthClass="max-w-lg" narrow="sheet">
      {serverSlug ? (
        <ThisDeviceSetupFlow
          host={host}
          setup={setup}
          onRun={run}
          serverName={serverName ?? `/${serverSlug}`}
          onFinish={finish}
          onRunDiagnostics={runDiagnostics}
          onCancel={close}
        />
      ) : null}
    </DialogCard>
  );
}
