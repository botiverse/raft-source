import assert from "node:assert/strict";
import { observeWindowAttention } from "../src/notifications/desktopNative/windowAttention";
import type { DesktopWindowActivity as WindowActivity } from "@botiverse/raft-shared";

test("late initial snapshot cannot undo hide; disposal rejects stale callbacks", async () => {
  let resolve!: (value: WindowActivity) => void;
  let listener!: (value: WindowActivity) => void;
  let removed = false;
  const attention = observeWindowAttention({
    getWindowActivity: () => new Promise((r) => { resolve = r; }),
    onWindowActivity: (cb) => { listener = cb; return () => { removed = true; }; },
  });
  listener({ revision: 2, visible: false, minimized: false, focused: true, away: false });
  resolve({ revision: 1, visible: true, minimized: false, focused: true, away: false });
  await Promise.resolve();
  assert.equal(attention.isAttended(), false);
  listener({ revision: 3, visible: true, minimized: false, focused: true, away: false });
  assert.equal(attention.isAttended(), true);
  attention.dispose();
  listener({ revision: 4, visible: false, minimized: false, focused: false, away: false });
  assert.equal(attention.isAttended(), true);
  assert.equal(removed, true);
});
