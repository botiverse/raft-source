// "This Computer" self-row — the local machine's entry in the Computers list.
// Rendered ONLY in the Raft Desktop app (which is also the local Computer host);
// inert on web (no bridge). It reuses ComputerRow's exact row shape so the self
// machine looks and clicks like every other computer (click → detail/Manage),
// distinguished only by a "This device" badge and a set of LOCAL controls —
// Restart / Stop / Start / Update — because only the machine this app runs on
// can be controlled locally.
//
// This component lives in the desktop app and is portaled into the reused web
// Sidebar's Computers list by DesktopSelfComputerMount, so packages/web (shared
// with web + mobile) stays untouched. It imports the web's real UI/stores via
// the @web alias.
//
// Local controls (same plane as each other, all via the bridge → local service):
//   - service running → Restart + Stop
//   - service stopped → Start
//   - a newer version on the CDN → Update (orange)
//   - an operation in flight → inline progress, controls hidden
import { Monitor } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuthStore } from "@web/store/authStore";
import { useServerStore } from "@web/store/serverStore";
import { RUNTIME_API_ORIGIN } from "@web/desktopRuntimeEnvironment";
import { useAppNavigate } from "@web/hooks/useAppNavigate";
import { getComputerRowDotStatus, getComputerRowDotTone } from "@web/utils/computerUpgradeIndicator";
import Button from "@web/components/ui/Button";
import StatusDot from "@web/components/ui/StatusDot";
import { MachineRunLabel } from "@web/components/machine/MachineRunLabel";
import { getComputerBridge, useSelfMachine } from "./useSelfComputer";
import {
  deriveControls,
  freshInstallCommand,
  routeUpdateAction,
  type ComputerStatusReport,
  type ManagementModel,
} from "./thisComputerLogic";

type Operation = "start" | "stop" | "restart" | "upgrade" | "enable";

/** Turn a raw error (incl. Electron IPC strings) into one short, human line. */
function friendlyError(raw: string): string {
  if (/requires_admin|not_authorized|admin|authoriz/i.test(raw)) return "You need admin access on this server.";
  if (/no_update_available/i.test(raw)) return "Already up to date.";
  if (/service_not_running|service_unreachable/i.test(raw)) return "The local service isn't reachable.";
  if (/No handler registered|host unavailable|not.?armed/i.test(raw)) return "Computer host isn't available.";
  if (/network|fetch|timeout|ECONN/i.test(raw)) return "Network error — try again.";
  return "Couldn't complete that — try again.";
}

export default function ThisComputerCard() {
  const bridge = getComputerBridge();
  const currentServer = useServerStore((s) => s.current);
  const selfMachine = useSelfMachine();
  const nav = useAppNavigate();
  const [status, setStatus] = useState<ComputerStatusReport | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [management, setManagement] = useState<ManagementModel>("unknown");
  const [confirmFresh, setConfirmFresh] = useState(false);
  const [manualCmd, setManualCmd] = useState<string | null>(null);
  const [busy, setBusy] = useState<Operation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let alive = true;
    const apply = (s: unknown) => {
      if (alive) setStatus(s as ComputerStatusReport);
    };
    void bridge.getStatus().then(apply).catch(() => {});
    const unsubscribe = bridge.onStatus(apply);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [bridge]);

  useEffect(() => {
    if (!bridge?.getUpgradeInfo) return;
    let alive = true;
    void bridge.getUpgradeInfo().then((info) => {
      if (alive) setLatestVersion(info?.latestVersion ?? null);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [bridge]);

  // How the local computer is managed — decides the [Update] route (app-embedded
  // upgrades with the app; a standalone gets remote or app-run fresh install).
  useEffect(() => {
    if (!bridge?.getManagement) return;
    let alive = true;
    void bridge.getManagement().then((m) => {
      if (alive) setManagement(m?.model ?? "unknown");
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [bridge]);

  const runAction = useCallback((op: Operation, action: () => Promise<unknown>) => {
    setBusy(op);
    setError(null);
    void action()
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  }, []);

  const onEnable = useCallback(() => {
    if (!bridge || !currentServer) return;
    const { accessToken, refreshToken, user } = useAuthStore.getState();
    if (!accessToken || !refreshToken) {
      setError("Please sign in first.");
      return;
    }
    runAction("enable", () =>
      bridge.enable({
        serverSlug: currentServer.slug,
        serverUrl: RUNTIME_API_ORIGIN,
        accessToken,
        refreshToken,
        // Persist identity into the shared session (so the local Computer knows
        // who it is), matching what a device-code login writes.
        ...(user?.id ? { userId: user.id } : {}),
        ...(user?.email ? { userEmail: user.email } : {}),
        ...(user?.name ? { userName: user.name } : {}),
        ...(user?.displayName ? { userDisplayName: user.displayName } : {}),
      }),
    );
  }, [bridge, currentServer, runAction]);

  // Inert on web / non-host builds, and until a server is active.
  if (!bridge || !currentServer) return null;

  const isMac = (globalThis as { raftDesktop?: { platform?: string } }).raftDesktop?.platform === "darwin";
  const deviceName = isMac ? "This Mac" : "This computer";

  // STATE 1 — adopted: this machine is a real row in the list. Render it like a
  // ComputerRow (clickable → detail), with a "This device" badge and hover-in
  // local controls.
  if (selfMachine) {
    const dotTone = getComputerRowDotTone(getComputerRowDotStatus(selfMachine));
    // All the control-visibility decisions (running/upgrading/updateAvailable),
    // incl. the local-version compare, the "Updating…" staleness bound, and the
    // rolled-back-version guard, live in the pure `deriveControls` (ablation-tested).
    const { running, upgrading, updateAvailable } = deriveControls({
      service: status?.service,
      upgrade: status?.upgrade,
      latestVersion,
      serverVersion: selfMachine.computerVersion ?? null,
    });
    const openDetail = () => nav.toComputer(selfMachine.id);

    const actionLabel = (op: Operation, label: string) => (busy === op ? "…" : label);

    // Route the single [Update]: app-embedded upgrades with the app (no button
    // here — the top-bar pill owns it); a standalone goes remote when the server
    // allows it, else the app runs the official installer itself.
    const eligibility =
      (selfMachine as { computerBroadcastPolicy?: { eligibility?: "eligible" | "no_broadcast" } })
        .computerBroadcastPolicy?.eligibility ?? null;
    const updateAction = routeUpdateAction({ managementModel: management, eligibility, updateAvailable });
    const freshTarget = latestVersion;

    // Fresh install (standalone, remote-ineligible): run the official installer;
    // on failure, reveal the manual command so the user is never stuck.
    const runFreshInstall = () => {
      if (!bridge.upgradeViaFreshInstall || !freshTarget) return;
      setConfirmFresh(false);
      setManualCmd(null);
      runAction("upgrade", async () => {
        try {
          await bridge.upgradeViaFreshInstall!(freshTarget);
        } catch (e) {
          setManualCmd(freshInstallCommand(freshTarget));
          throw e;
        }
      });
    };

    // A clean bordered self-card: a clickable identity row (→ detail, exactly
    // like a ComputerRow) above an always-visible strip of LOCAL controls — this
    // is the only computer this app can control locally. No heavy shadow; the
    // permanent border + "This device" badge mark it as ours.
    return (
      <div className="mb-1.5 w-full border-2 border-black bg-white" data-testid="this-computer-card">
        <div
          role="button"
          tabIndex={0}
          onClick={openDetail}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openDetail();
            }
          }}
          className="flex cursor-pointer items-center gap-2.5 px-2.5 py-2 transition-colors hover:bg-soft-signal/25"
        >
          <div className="relative flex size-9 shrink-0 items-center justify-center border-2 border-black bg-soft-signal">
            <Monitor size={18} />
            <StatusDot className="absolute -right-1 -top-1" tone={dotTone} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 truncate text-sm font-bold text-black">{selfMachine.name}</span>
              <span className="shrink-0 border border-black bg-soft-signal px-1 text-[10px] font-bold uppercase tracking-wide text-black">
                This device
              </span>
            </div>
            <div className="mt-0.5 truncate font-mono text-[11px] text-black/50">
              <MachineRunLabel machine={selfMachine} />
            </div>
          </div>
        </div>
        <div className="border-t-2 border-black/10 px-2.5 py-1.5">
          {error ? (
            <div className="mb-1 text-[11px] font-medium text-brutal-orange">{friendlyError(error)}</div>
          ) : null}
          {upgrading ? (
            <div className="text-[11px] font-medium text-brutal-orange">
              Updating… {upgrading.phase}
              {upgrading.percent != null ? ` ${upgrading.percent}%` : ""}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              {updateAction === "remote" && bridge.upgrade ? (
                <Button
                  tone="orange"
                  size="xs"
                  disabled={busy != null}
                  title={`Update to v${latestVersion}`}
                  onClick={() => runAction("upgrade", () => bridge.upgrade!())}
                >
                  {actionLabel("upgrade", "Update")}
                </Button>
              ) : updateAction === "fresh-install" && bridge.upgradeViaFreshInstall ? (
                confirmFresh ? (
                  <>
                    <Button tone="orange" size="xs" disabled={busy != null} onClick={runFreshInstall}>
                      {busy === "upgrade" ? "…" : `Install v${freshTarget}`}
                    </Button>
                    <Button size="xs" disabled={busy != null} onClick={() => setConfirmFresh(false)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    tone="orange"
                    size="xs"
                    disabled={busy != null}
                    title={`Reinstall v${latestVersion} via the official installer (this source can't self-upgrade)`}
                    onClick={() => setConfirmFresh(true)}
                  >
                    {actionLabel("upgrade", "Update")}
                  </Button>
                )
              ) : null}
              {running ? (
                <>
                  <Button size="xs" disabled={busy != null} onClick={() => runAction("restart", () => bridge.restart())}>
                    {actionLabel("restart", "Restart")}
                  </Button>
                  <Button size="xs" disabled={busy != null} onClick={() => runAction("stop", () => bridge.stop())}>
                    {actionLabel("stop", "Stop")}
                  </Button>
                </>
              ) : (
                <Button size="xs" disabled={busy != null} onClick={() => runAction("start", () => bridge.start())}>
                  {actionLabel("start", "Start")}
                </Button>
              )}
            </div>
          )}
          {manualCmd ? (
            <div className="mt-1.5 border-t border-black/10 pt-1.5">
              <div className="mb-1 text-[10px] font-medium text-black/50">
                Automatic update failed — run this in Terminal:
              </div>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(manualCmd)}
                title="Copy"
                className="block w-full truncate border border-black/20 bg-black/[0.03] px-1.5 py-1 text-left font-mono text-[10px] text-black/70 transition-colors hover:bg-black/[0.06]"
              >
                {manualCmd}
              </button>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // STATE 2/3 — not attached to the active server: a lightweight enable row.
  const hasInstall = (status?.servers?.length ?? 0) > 0 || !!status?.service?.running;
  return (
    <div
      className="mb-1.5 flex w-full items-center gap-2.5 border-2 border-transparent px-2.5 py-2"
      data-testid="this-computer-card"
    >
      <div className="relative flex size-9 shrink-0 items-center justify-center border-2 border-black bg-soft-signal">
        <Monitor size={18} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-bold text-black">{deviceName}</div>
        <div className="mt-0.5 truncate text-[11px] text-black/50">
          {error ? friendlyError(error) : hasInstall ? `Not connected to ${currentServer.name}` : "Not enabled"}
        </div>
      </div>
      <Button
        tone="pink"
        emphasis="high"
        size="xs"
        disabled={busy != null}
        onClick={onEnable}
        className="shrink-0"
      >
        {busy === "enable" ? "Enabling…" : "Enable"}
      </Button>
    </div>
  );
}
