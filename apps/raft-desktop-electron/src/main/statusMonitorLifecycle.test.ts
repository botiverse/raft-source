import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

test("display demand follows window visibility and system sleep, never focus, and stays off after quit", async (t) => {
  const app = new EventEmitter();
  const powerMonitor = new EventEmitter();
  class Window extends EventEmitter {
    visible = false;
    minimized = false;
    destroyed = false;
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    isDestroyed() { return this.destroyed; }
  }
  const windows: Window[] = [];
  t.mock.module("electron", { namedExports: { app, powerMonitor, BrowserWindow: { getAllWindows: () => windows } } });
  const { installStatusMonitorLifecycle } = await import("./statusMonitorLifecycle.ts");
  let active = false;
  let quitting = false;
  installStatusMonitorLifecycle({ setActive: (next) => { active = next; } }, () => quitting);
  const first = new Window();
  windows.push(first);
  app.emit("browser-window-created", {}, first);
  assert.equal(active, false, "hidden first window must not poll before first show");
  first.visible = true; first.emit("show");
  assert.equal(active, true);
  first.emit("blur");
  assert.equal(active, true, "a visible unfocused window still needs status");
  first.minimized = true; first.emit("minimize");
  assert.equal(active, false);
  first.minimized = false; first.emit("restore");
  assert.equal(active, true);
  powerMonitor.emit("suspend");
  assert.equal(active, false);
  first.emit("show");
  assert.equal(active, false, "show cannot override suspension");
  powerMonitor.emit("resume");
  assert.equal(active, true);
  const second = new Window(); second.visible = true; windows.push(second);
  app.emit("browser-window-created", {}, second);
  first.visible = false; first.emit("hide");
  assert.equal(active, true, "another visible window still needs status");
  second.destroyed = true; second.emit("closed");
  assert.equal(active, false);
  first.visible = true; first.emit("show");
  quitting = true; first.emit("show");
  assert.equal(active, false, "quitAndInstall lifecycle flag prevents restart without before-quit");
  app.emit("before-quit");
  quitting = false;
  powerMonitor.emit("resume"); first.emit("show");
  assert.equal(active, false, "late events must not restart polling during quit");
});
