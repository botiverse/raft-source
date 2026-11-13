import assert from "node:assert/strict";
import { createRaft } from "./index";

function client(response: () => Response) {
  return createRaft({ serverUrl: "https://fixture.invalid", credential: "sk_agent_fixture", fetch: async () => response() });
}

test("tasks.list preserves a positive completeness assertion but does not invent one on an old server or failure", async () => {
  const complete = await client(() => Response.json({ tasks: [], scope: "channel", pagination: { mode: "complete", truncated: false } })).tasks.list({ target: "#board", status: "all" });
  assert.equal(complete.ok, true);
  if (complete.ok) assert.deepEqual(complete.data.pagination, { mode: "complete", truncated: false });
  const old = await client(() => Response.json({ tasks: [], scope: "channel" })).tasks.list({ target: "#board", status: "all" });
  assert.equal(old.ok, true);
  if (old.ok) assert.equal(old.data.pagination, undefined, "missing is unknown, not complete");
  const mine = await client(() => Response.json({
    tasks: [], scope: "mine", pagination: { mode: "complete", truncated: false },
    coverage: { status: "incomplete", visibleChannelTypes: ["channel"], includesArchived: true, inaccessibleScope: "not_asserted", reason: "inaccessible channels are not asserted" },
  })).tasks.list({ mine: true, status: "all" });
  assert.equal(mine.ok, true);
  if (mine.ok) {
    assert.equal(mine.data.coverage?.status, "incomplete", "complete output does not expand visibility");
    assert.deepEqual(mine.data.pagination, { mode: "complete", truncated: false });
  }
  const wrongScope = client(() => Response.json({ tasks: [], scope: "mine", pagination: { mode: "complete", truncated: false } }));
  const wrongBoard = await wrongScope.tasks.list({ target: "#board", status: "all" });
  assert.equal(wrongBoard.ok, true);
  if (wrongBoard.ok) assert.equal(wrongBoard.data.pagination, undefined, "another scope cannot assert this channel is complete");
  const wrongShow = await wrongScope.tasks.show({ target: "#board", taskNumber: 1 });
  assert.equal(wrongShow.ok, false);
  if (!wrongShow.ok) assert.match(wrongShow.error.message, /did not assert the list is complete/);
  const limited = client(() => Response.json({
    tasks: [], scope: "channel", pagination: { mode: "complete", truncated: false },
    coverage: { status: "incomplete", visibleChannelTypes: ["channel"], includesArchived: true, inaccessibleScope: "not_asserted", reason: "scope omitted" },
  }));
  const limitedShow = await limited.tasks.show({ target: "#board", taskNumber: 1 });
  assert.equal(limitedShow.ok, false);
  if (!limitedShow.ok) assert.match(limitedShow.error.message, /did not assert the list is complete/);
  const failed = await client(() => Response.json({ error: "failed to list tasks" }, { status: 500 })).tasks.list({ target: "#board", status: "all" });
  assert.equal(failed.ok, false, "a failed read cannot become an empty board");
});
