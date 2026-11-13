import assert from "node:assert/strict";
import "./helpers/domSetup";
import type { NotificationTestDevice } from "../src/notifications/notificationApi";
import { isDesktopNativeNotificationsAvailable, runDesktopTestNotification } from "../src/utils/desktopNativeNotifications";
import { getSocket, resetSocket } from "../src/api/socket";

// Settings' desktop test notification is a real one (contract §6): the server
// sends it to THIS page's socket, the consumer posts it through the shell and
// acks the result. Availability is only "the shell can post".
const savedRaftDesktop = Object.getOwnPropertyDescriptor(window, "raftDesktop");

afterEach(() => {
  if (savedRaftDesktop) Object.defineProperty(window, "raftDesktop", savedRaftDesktop); else Reflect.deleteProperty(window, "raftDesktop");
  resetSocket();
});

test("availability: only a shell with notifications.show", () => {
  Reflect.deleteProperty(window, "raftDesktop");
  assert.equal(isDesktopNativeNotificationsAvailable(), false);
  Object.defineProperty(window, "raftDesktop", { configurable: true, value: { isDesktop: true } });
  assert.equal(isDesktopNativeNotificationsAvailable(), false);
  Object.defineProperty(window, "raftDesktop", { configurable: true, value: { isDesktop: true, notifications: { show: () => {}, clearGroup: () => {} } } });
  assert.equal(isDesktopNativeNotificationsAvailable(), true);
});

test("the test targets this page's connected socket id", async () => {
  const devices: NotificationTestDevice[] = [];
  const outcome = await runDesktopTestNotification({
    socket: () => ({ connected: true, id: "sock-1" }),
    run: async (device) => {
      devices.push(device);
      return { state: "shown" };
    },
  });
  assert.deepEqual(devices, [{ kind: "desktop", socketId: "sock-1" }]);
  assert.deepEqual(outcome, { state: "shown" });
});

test("without a connected socket nothing is requested: failed / no_socket", async () => {
  let called = false;
  const run = async () => {
    called = true;
    return { state: "shown" } as const;
  };
  assert.equal(getSocket().connected, false, "the app's socket, never connected in tests");
  assert.deepEqual(await runDesktopTestNotification({ run }), { state: "failed", reason: "no_socket" });
  assert.deepEqual(await runDesktopTestNotification({ run, socket: () => ({ connected: false, id: "stale" }) }), { state: "failed", reason: "no_socket" });
  assert.equal(called, false);
});
