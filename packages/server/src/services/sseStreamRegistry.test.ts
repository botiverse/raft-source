import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";

import { createSseStreamRegistry } from "./sseStreamRegistry";

/**
 * SSE streams never finish on their own, so without the registry
 * `server.close()` would hang on them until the shutdown deadline severed
 * them mid-stream (task #261). The registry is what lets the going-away
 * phase end them deliberately, one at a time across the drain spread. These
 * tests pin the two failure modes: double-ending a stream, and ending one
 * that was already unregistered.
 */

function fakeResponse() {
  let ended = false;
  const res = {
    get writableEnded() {
      return ended;
    },
    end() {
      ended = true;
    },
  } as unknown as ServerResponse;
  return { res, ended: () => ended };
}

test("end ends a stream exactly once and drops it from the registry", () => {
  const registry = createSseStreamRegistry();
  const a = fakeResponse();
  const b = fakeResponse();
  registry.register(a.res);
  registry.register(b.res);
  assert.deepEqual(registry.snapshot(), [a.res, b.res]);

  assert.equal(registry.end(a.res), true);
  assert.equal(a.ended(), true);
  assert.equal(b.ended(), false);
  assert.deepEqual(registry.snapshot(), [b.res]);

  // A second end is a no-op, not a double end().
  assert.equal(registry.end(a.res), false);
});

test("unregister removes a stream from the drain snapshot", () => {
  const registry = createSseStreamRegistry();
  const a = fakeResponse();
  const b = fakeResponse();
  registry.register(a.res);
  registry.register(b.res);
  registry.unregister(a.res);

  assert.deepEqual(registry.snapshot(), [b.res]);
  assert.equal(registry.size, 1);
});

test("end tolerates a stream the client already ended", () => {
  const registry = createSseStreamRegistry();
  const a = fakeResponse();
  registry.register(a.res);
  a.res.end();

  assert.equal(registry.end(a.res), false);
  assert.equal(a.ended(), true);
  assert.equal(registry.size, 0);
});
