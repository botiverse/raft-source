// The desktop tray's Pause notifications ▸ arrives as the host command
// {type: "pause-notifications", minutes}; the web PATCHes the account pausedUntil.
import assert from "node:assert/strict";
import "./helpers/domSetup";
import { executeHostCommand } from "../src/host/hostCommands";
import type { HostCommandDeps } from "../src/host/hostCommands";
import { useNotificationSettingsStore } from "../src/store/notificationSettingsStore";

const initial = useNotificationSettingsStore.getState();
const deps: HostCommandDeps = { navigate: () => {}, stepHistory: () => {}, layerOpen: () => false };

afterEach(() => {
  useNotificationSettingsStore.setState(initial, true);
  vi.useRealTimers();
});

test("pause-notifications PATCHes pausedUntil: minutes from now, or tomorrow 09:00 local", () => {
  const patches: unknown[] = [];
  useNotificationSettingsStore.setState({ patchAccount: async (patch) => { patches.push(patch); return { kind: "error" }; } });
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = new Date(2026, 9, 30, 18, 15, 0);
  vi.setSystemTime(now);
  executeHostCommand({ type: "pause-notifications", minutes: 30 }, deps);
  executeHostCommand({ type: "pause-notifications", minutes: "tomorrow" }, deps);
  assert.deepEqual(patches, [
    { pausedUntil: new Date(now.getTime() + 30 * 60_000).toISOString() },
    { pausedUntil: new Date(2026, 9, 31, 9, 0, 0).toISOString() },
  ]);
  executeHostCommand({ type: "pause-notifications", minutes: -5 }, deps);
  executeHostCommand({ type: "pause-notifications", minutes: Number.NaN }, deps);
  assert.equal(patches.length, 2, "a malformed duration does nothing");
});
