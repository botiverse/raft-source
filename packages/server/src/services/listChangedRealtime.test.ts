import { dbTest as test } from "../test/integration/dbTest";
import assert from "node:assert/strict";
import { vi } from "vitest";
import { SEAT_JOIN_BLOCKS_CHANGED_EVENT } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { announceSeatJoinBlocksChanged, coalesceListChanges, setListChangedRealtimeIO } from "./listChangedRealtime";

// The list-changed pings are hints sent after a write commits: one that is
// sent late must still arrive (F1), and one whose emit throws must not fail
// the committed write or stop the other pings (F2; review of #12939).

/** A fake socket server: records `room` per send, throws for the rooms in `failing`. */
function fakeEmitter(failing: ReadonlySet<string> = new Set()) {
  const sent: string[] = [];
  setListChangedRealtimeIO({ to: (room: string) => ({ emit: (event: string) => {
    if (failing.has(room)) throw new Error(`emit to ${room} failed`);
    if (event === SEAT_JOIN_BLOCKS_CHANGED_EVENT) sent.push(room);
    return true;
  } }) } as never);
  return sent;
}

afterEach(() => {
  setListChangedRealtimeIO(null);
  vi.restoreAllMocks();
});

test("coalesceListChanges: work it started that announces after it ended sends directly, not into the flushed map (F1)", async ({ db: _db }) => {
  const sent = fakeEmitter();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let late: Promise<void> | undefined;
  await coalesceListChanges(async () => {
    announceSeatJoinBlocksChanged(["held"]);
    // Detached: keeps the coalescing store after the operation returns.
    late = gate.then(() => announceSeatJoinBlocksChanged(["late"]));
    assert.deepEqual(sent, [], "held while the operation runs");
  });
  assert.deepEqual(sent, ["server:held"], "flushed when it ends");
  release();
  await late;
  assert.deepEqual(sent, ["server:held", "server:late"], "the late ping is sent, not lost");
});

test("an emit that throws is logged: no transaction, after a commit and in the coalesced flush, the write stands and the other pings go (F2)", async ({ db: _db }) => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const sent = fakeEmitter(new Set(["server:bad"]));

  // No transaction open (an autocommit writer such as the expiry sweep): sent now.
  assert.doesNotThrow(() => announceSeatJoinBlocksChanged(["bad", "good-now"]));
  assert.deepEqual(sent, ["server:good-now"]);

  // After a commit: the transaction's value is returned.
  sent.length = 0;
  const value = await getDb().transaction(async () => {
    announceSeatJoinBlocksChanged(["bad", "good-after-commit"]);
    return "committed";
  });
  assert.equal(value, "committed");
  assert.deepEqual(sent, ["server:good-after-commit"]);

  // The coalesced flush: neither the operation's result nor its error is replaced.
  sent.length = 0;
  assert.equal(await coalesceListChanges(async () => {
    announceSeatJoinBlocksChanged(["bad", "good-flushed"]);
    return "done";
  }), "done");
  assert.deepEqual(sent, ["server:good-flushed"]);
  sent.length = 0;
  await assert.rejects(coalesceListChanges(async () => {
    announceSeatJoinBlocksChanged(["bad", "good-after-error"]);
    throw new Error("the operation's own error");
  }), /the operation's own error/);
  assert.deepEqual(sent, ["server:good-after-error"]);

  assert.equal(errors.mock.calls.filter(([message]) => String(message).includes("server:bad")).length, 4, "each failed send is logged");
});
