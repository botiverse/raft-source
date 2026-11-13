import assert from "node:assert/strict";
import {
  getServerSwitcherTarget,
  openServerSwitcherAuxClickTarget,
} from "../src/utils/serverSwitcherNavigation";

test("server switcher rows expose remembered targets for new-tab actions", () => {
  const calls: Array<[string, "_blank", "noopener,noreferrer"]> = [];
  let prevented = 0;
  let stopped = 0;
  const readSurface = (slug: string) => slug === "ops" ? "/s/ops/tasks?view=mine" : null;
  const openNewTab = (...args: [string, "_blank", "noopener,noreferrer"]) => {
    calls.push(args);
  };

  assert.equal(getServerSwitcherTarget("ops", readSurface), "/s/ops/tasks?view=mine");
  assert.equal(getServerSwitcherTarget("new-server", readSurface), "/s/new-server");

  const ignored = openServerSwitcherAuxClickTarget(
    {
      button: 0,
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; },
    },
    "ops",
    { readSurface, openNewTab },
  );
  assert.equal(ignored, false);
  assert.deepEqual(calls, []);
  assert.equal(prevented, 0);
  assert.equal(stopped, 0);

  const opened = openServerSwitcherAuxClickTarget(
    {
      button: 1,
      preventDefault: () => { prevented += 1; },
      stopPropagation: () => { stopped += 1; },
    },
    "ops",
    { readSurface, openNewTab },
  );
  assert.equal(opened, true);
  assert.deepEqual(calls, [["/s/ops/tasks?view=mine", "_blank", "noopener,noreferrer"]]);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});
