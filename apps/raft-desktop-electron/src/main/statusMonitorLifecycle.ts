import { app, BrowserWindow, powerMonitor } from "electron";

// Display demand only: this never starts/stops the Computer service or changes
// renderer/socket throttling. Install once before creating the first window.
export function installStatusMonitorLifecycle(
  monitor: { setActive(active: boolean): void },
  isQuitting: () => boolean,
): void {
  let suspended = false;
  let stopped = false;
  const update = () => monitor.setActive(
    !stopped && !suspended && !isQuitting() && BrowserWindow.getAllWindows().some(
      (window) => !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
    ),
  );
  const watch = (window: BrowserWindow) => {
    window.on("show", update);
    window.on("hide", update);
    window.on("minimize", update);
    window.on("restore", update);
    window.on("closed", update);
  };
  for (const window of BrowserWindow.getAllWindows()) watch(window);
  app.on("browser-window-created", (_event, window) => { watch(window); update(); });
  app.on("before-quit", () => { stopped = true; update(); });
  powerMonitor.on("suspend", () => { suspended = true; update(); });
  powerMonitor.on("resume", () => { suspended = false; update(); });
  update();
}
