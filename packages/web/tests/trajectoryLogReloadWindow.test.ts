import assert from "node:assert/strict";

import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { MAX_TRAJECTORY_ENTRIES } from "../src/store/events/agentActivityEvents";

afterEach(() => {
  vi.restoreAllMocks();
});

// #proj-runtime:#43: the Sub-agents list is built from the trajectory log, so
// a reload must ask for as many rows as the live log keeps, or the page shows
// fewer sub-agents after a refresh than before it.
test("a trajectory log reload asks for as many rows as the live log keeps", async () => {
  const get = vi.spyOn(api, "get").mockResolvedValue({ data: [] });
  await useAgentStore.getState().loadTrajectoryLog("agent-window");
  assert.equal(get.mock.calls.length, 1);
  const [url, config] = get.mock.calls[0]!;
  assert.equal(url, "/agents/agent-window/activity-log");
  assert.deepEqual((config as { params?: unknown }).params, { limit: MAX_TRAJECTORY_ENTRIES });
});
