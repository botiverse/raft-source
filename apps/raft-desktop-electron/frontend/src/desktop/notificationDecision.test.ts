// Desktop notification-filtering decision. The bridge used to notify for ANY
// unread increase; these prove it now respects the web's follow/join/mute model
// and opens threads with parent context.
import assert from "node:assert/strict";
import test from "node:test";
import { decideNotification } from "./notificationDecision.js";

test("joined + unmuted channel → notify (channel)", () => {
  assert.deepEqual(
    decideNotification("c1", [{ id: "c1", joined: true }], [], []),
    { notify: true, kind: "channel" },
  );
});

test("UN-joined channel → skip (don't notify for channels you aren't in)", () => {
  assert.equal(decideNotification("c1", [{ id: "c1", joined: false }], [], []).notify, false);
});

test("muted channel → skip", () => {
  assert.equal(
    decideNotification("c1", [{ id: "c1", joined: true, activityMuted: true }], [], []).notify,
    false,
  );
});

test("DM → notify (kind dm)", () => {
  assert.deepEqual(decideNotification("dm1", [], [{ id: "dm1" }], []), { notify: true, kind: "dm" });
});

test("muted DM → skip", () => {
  assert.equal(decideNotification("dm1", [], [{ id: "dm1", activityMuted: true }], []).notify, false);
});

test("FOLLOWED thread → notify with PARENT context (fixes bare #thread-<id> render)", () => {
  assert.deepEqual(
    decideNotification("t1", [], [], [{ threadChannelId: "t1", parentChannelId: "pc", parentMessageId: "pm" }]),
    { notify: true, kind: "thread", parentChannelId: "pc", parentMessageId: "pm" },
  );
});

test("UNfollowed thread channel → skip (the reported bug)", () => {
  // A thread channel id that is neither a known channel nor a followed thread.
  assert.equal(decideNotification("t2", [], [], []).notify, false);
});

test("unknown id → skip", () => {
  assert.equal(decideNotification("x", [], [], []).notify, false);
});
