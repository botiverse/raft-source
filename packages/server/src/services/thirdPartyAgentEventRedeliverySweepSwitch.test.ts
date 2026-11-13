import assert from "node:assert/strict";
import { test } from "vitest";

import {
  THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED_ENV,
  isThirdPartyEventRedeliverySweepEnabled,
  startThirdPartyEventRedeliveryWorker,
} from "./thirdPartyAgentEventRedelivery";

// The sweep cannot tell a lost delivery from an "Inbox update" notice the agent
// has not read, and each re-send to an idle agent is a paid wake (Tenny,
// #proj-o11y): it is off unless explicitly turned on. The reconnect pass is not
// gated by it.

test("the sweep switch is off unless explicitly turned on", () => {
  assert.equal(isThirdPartyEventRedeliverySweepEnabled({}), false);
  for (const off of ["", "false", "0", "off", "yes", "enabled"]) {
    assert.equal(isThirdPartyEventRedeliverySweepEnabled({ [THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED_ENV]: off }), false, off);
  }
  for (const on of ["true", "1", "on", " TRUE "]) {
    assert.equal(isThirdPartyEventRedeliverySweepEnabled({ [THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED_ENV]: on }), true, on);
  }
});

test("the sweep worker runs no pass while the switch is off, and runs one once it is on", async () => {
  let passes = 0;
  const env: NodeJS.ProcessEnv = {};
  const worker = startThirdPartyEventRedeliveryWorker({
    agentOrchestrator: { sweepPendingThirdPartyAgentEvents: async () => { passes += 1; } },
    intervalMs: 60 * 60_000,
    env,
  });
  try {
    worker.kick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(passes, 0, "off by default: no sweep pass");

    env[THIRD_PARTY_EVENT_REDELIVERY_SWEEP_ENABLED_ENV] = "true";
    worker.kick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(passes, 1, "read on every tick: turning it on takes effect without a restart");
  } finally {
    await worker.stop();
  }
});
