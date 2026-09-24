import assert from "node:assert/strict";
import test from "node:test";
import { createAuthTokenSync } from "../src/utils/authTokenSync.js";

class FakeBroadcastChannel extends EventTarget {
  public sent: unknown[] = [];

  postMessage(data: unknown) {
    this.sent.push(data);
  }

  emit(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  close() {}
}

test("auth token sync publishes refreshed tokens across tabs", () => {
  const channel = new FakeBroadcastChannel() as unknown as BroadcastChannel;
  const sync = createAuthTokenSync({
    channel,
    addStorageListener: () => {},
    removeStorageListener: () => {},
    readAccessToken: () => "at_2",
    readRefreshToken: () => "rt_2",
  });
  const received: Array<{ accessToken: string; refreshToken: string }> = [];
  sync.subscribe((tokens) => received.push(tokens));

  sync.publish({ accessToken: "at_2", refreshToken: "rt_2" });

  assert.equal((channel as unknown as FakeBroadcastChannel).sent.length, 1);
  assert.deepEqual(received, [{ accessToken: "at_2", refreshToken: "rt_2" }]);
  sync.close();
});

test("auth token sync receives tokens from another tab", () => {
  const channel = new FakeBroadcastChannel();
  const sync = createAuthTokenSync({
    channel: channel as unknown as BroadcastChannel,
    addStorageListener: () => {},
    removeStorageListener: () => {},
    readAccessToken: () => "at_1",
    readRefreshToken: () => "rt_1",
  });
  const received: Array<{ accessToken: string; refreshToken: string }> = [];
  sync.subscribe((tokens) => received.push(tokens));

  channel.emit({
    type: "tokens-updated",
    sourceId: "other-tab",
    accessToken: "at_2",
    refreshToken: "rt_2",
  });

  assert.deepEqual(received, [{ accessToken: "at_2", refreshToken: "rt_2" }]);
  sync.close();
});

test("auth token sync falls back to storage events", () => {
  let storageListener: ((event: StorageEvent) => void) | null = null;
  const sync = createAuthTokenSync({
    channel: undefined,
    addStorageListener: (listener) => {
      storageListener = listener;
    },
    removeStorageListener: () => {
      storageListener = null;
    },
    readAccessToken: () => "at_3",
    readRefreshToken: () => "rt_3",
  });
  const received: Array<{ accessToken: string; refreshToken: string }> = [];
  sync.subscribe((tokens) => received.push(tokens));

  storageListener?.({ key: "slock_refresh_token" } as StorageEvent);

  assert.deepEqual(received, [{ accessToken: "at_3", refreshToken: "rt_3" }]);
  sync.close();
});
