import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  buildMainLayoutSocketBindings,
} from "../src/store/socketBridge";
import type {
  MainLayoutSocketBridgeSocket,
} from "../src/store/socketBridge";
import { useAnnouncementStore } from "../src/store/announcementStore";

afterEach(() => {
  useAnnouncementStore.getState().reset();
});

test("publishing does not push every open tab into announcement discovery", () => {
  const socket: MainLayoutSocketBridgeSocket = {
    connected: true,
    emit: () => undefined,
    on: () => undefined,
    off: () => undefined,
    onAny: () => undefined,
    offAny: () => undefined,
    disconnect: () => undefined,
    connect: () => undefined,
  };
  const bindings = buildMainLayoutSocketBindings(
    socket,
    () => undefined,
    async () => undefined,
    () => undefined,
    () => undefined,
  );
  const announcementBinding = bindings.find((binding) => binding.event === "announcement:new");
  assert.equal(announcementBinding, undefined, "publish must wait for entry or focus discovery");
  assert.deepEqual(
    useAnnouncementStore.getState().pending,
    [],
    "a publish event must not mutate an already-open tab's announcement state",
  );
});
