import assert from "node:assert/strict";

import {
  __resetDeferredUiForTest,
  afterFirstScreen,
  armFirstScreenGate,
  fetchDeferredUi,
  openFirstScreenGate,
} from "../src/boot/deferredUi";

/** Web perf: first-screen-optional requests wait for the first screen (main.tsx arms the gate). */

const idle = () => new Promise((resolve) => setTimeout(resolve, 5));

test("unarmed (tests, embeds): work runs at once", () => {
  __resetDeferredUiForTest();
  let ran = 0;
  afterFirstScreen(() => { ran += 1; });
  assert.equal(ran, 1);
});

test("armed: work waits for the first screen, then runs once in idle time", async () => {
  __resetDeferredUiForTest();
  armFirstScreenGate();
  const ran: string[] = [];
  afterFirstScreen(() => ran.push("saved"));
  afterFirstScreen(() => ran.push("announcements"));
  await idle();
  assert.deepEqual(ran, [], "held until the first screen");
  fetchDeferredUi();
  await idle();
  assert.deepEqual(ran, ["saved", "announcements"]);
  afterFirstScreen(() => ran.push("later"));
  assert.deepEqual(ran, ["saved", "announcements", "later"], "after the gate opened: at once");
  __resetDeferredUiForTest();
});

test("the fallback opens the gate for a load that shows no conversation", async () => {
  __resetDeferredUiForTest();
  armFirstScreenGate();
  let ran = 0;
  afterFirstScreen(() => { ran += 1; });
  openFirstScreenGate();
  openFirstScreenGate();
  await idle();
  assert.equal(ran, 1);
  __resetDeferredUiForTest();
});

test("work queued twice under one key runs once", async () => {
  __resetDeferredUiForTest();
  armFirstScreenGate();
  let ran = 0;
  afterFirstScreen(() => { ran += 1; }, "bootstrap");
  afterFirstScreen(() => { ran += 1; }, "bootstrap");
  openFirstScreenGate();
  await idle();
  assert.equal(ran, 1);
  __resetDeferredUiForTest();
});
