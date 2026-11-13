/**
 * Socket bridge reinstall: a bridge installed again under the same name
 * replaces its handlers instead of stacking them.
 */

import { strict as assert } from "node:assert";
import { installSocketBridge } from "../src/store/socketBridge";
import type { SocketLike } from "../src/store/socketBridge";

class FakeSocket implements SocketLike {
  handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  on(event: string, handler: (...args: unknown[]) => void) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return this;
  }
  off(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }
  emit(event: string, payload: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }
  listenerCount(event: string) {
    return this.handlers.get(event)?.size ?? 0;
  }
}

test("bridge reinstall under the same name never double-subscribes", () => {
  const socket = new FakeSocket();
  let calls = 0;
  const binding = [{ event: "message:new", handler: () => { calls += 1; } }];
  installSocketBridge(socket, "test-bridge", binding);
  installSocketBridge(socket, "test-bridge", binding);
  socket.emit("message:new", {});
  assert.equal(calls, 1, "second install replaces the first, not stacks on it");
});
