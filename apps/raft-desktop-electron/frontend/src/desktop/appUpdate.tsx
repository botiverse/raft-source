// Non-intrusive app self-update affordance for the desktop top bar.
//
// The main process (main/autoUpdater.ts) auto-downloads updates silently in the
// background and pushes status here. Best practice (VSCode / Slack / Cumora):
// never interrupt with a modal — once an update is downloaded, show a small,
// dismissible "Restart to update" pill. The update also applies automatically on
// the next natural quit (autoInstallOnAppQuit), so ignoring the pill is safe.
import { useEffect, useState } from "react";

export type AppUpdateStatus =
  | { state: "unsupported" }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "none" }
  | { state: "downloading"; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

interface AppUpdateBridge {
  getStatus(): Promise<AppUpdateStatus>;
  onStatus(handler: (status: AppUpdateStatus) => void): () => void;
  restartToApply(): void;
  checkNow(): void;
}

function getAppUpdateBridge(): AppUpdateBridge | null {
  return (globalThis as { raftDesktop?: { appUpdate?: AppUpdateBridge } }).raftDesktop?.appUpdate ?? null;
}

export function useAppUpdateStatus(): AppUpdateStatus {
  const [status, setStatus] = useState<AppUpdateStatus>({ state: "idle" });
  useEffect(() => {
    const bridge = getAppUpdateBridge();
    if (!bridge) return;
    let alive = true;
    void bridge.getStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {});
    const unsubscribe = bridge.onStatus((s) => { if (alive) setStatus(s); });
    return () => { alive = false; unsubscribe(); };
  }, []);
  return status;
}

// A single small button in the top bar. Appears only once an update is fully
// downloaded (the actionable moment) — never blocking (@WAWQAQ #kabi-desktop
// 6e2b4adf: one simple one-line button, no label/dismiss chrome). Ignoring it
// is safe; the update also applies on the next natural quit.
export function DesktopUpdatePill() {
  const status = useAppUpdateStatus();

  if (status.state !== "downloaded") return null;

  return (
    <button
      type="button"
      onClick={() => getAppUpdateBridge()?.restartToApply()}
      title={`Restart to update to ${status.version}`}
      className="inline-flex h-8 shrink-0 items-center border-2 border-black bg-soft-signal px-2.5 text-[12px] font-bold text-black shadow-brutal-sm transition-colors hover:bg-black hover:text-soft-signal"
    >
      Update
    </button>
  );
}
