import assert from "node:assert/strict";
import type { LocalEventRecord } from "./otlp";
import { sanitizeWebAgentActivityJoinKeys } from "./webAgentActivityJoinKeys";

const LAUNCH_ID = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

function event(name: string, attrs: Record<string, unknown>): LocalEventRecord {
  return { type: "event", schema_version: 1, name, surface: "web", time: "2026-05-07T08:00:00.000Z", attrs: attrs as LocalEventRecord["attrs"] };
}

test("a UUID launch_id and a non-negative integer client_seq pass through unchanged", () => {
  const record = event("slock.agent_activity.socket_received", { launch_id: LAUNCH_ID, client_seq: 0, launch_id_present: true });
  assert.deepEqual(sanitizeWebAgentActivityJoinKeys(record), record);
  const upper = event("slock.agent_activity.store_decision", { launch_id: LAUNCH_ID.toUpperCase(), client_seq: 123456 });
  assert.deepEqual(sanitizeWebAgentActivityJoinKeys(upper).attrs, { launch_id: LAUNCH_ID.toUpperCase(), client_seq: 123456 });
});

test("an ill-shaped launch_id or client_seq is dropped; the event and its presence booleans stay", () => {
  for (const launchId of ["agent-1", "unbound:" + LAUNCH_ID, `${LAUNCH_ID}x`, "", 7, null, { id: LAUNCH_ID }]) {
    const out = sanitizeWebAgentActivityJoinKeys(event("slock.agent_activity.store_decision", { launch_id: launchId, launch_id_present: true, client_seq: 3 }));
    assert.equal(out.name, "slock.agent_activity.store_decision");
    assert.deepEqual(out.attrs, { launch_id_present: true, client_seq: 3 }, String(launchId));
  }
  for (const clientSeq of [-1, 1.5, "7", Number.NaN, Number.MAX_SAFE_INTEGER + 2, null, true]) {
    const out = sanitizeWebAgentActivityJoinKeys(event("slock.agent_activity.socket_received", { launch_id: LAUNCH_ID, client_seq: clientSeq, client_seq_present: true }));
    assert.deepEqual(out.attrs, { launch_id: LAUNCH_ID, client_seq_present: true }, String(clientSeq));
  }
});

test("only slock.agent_activity.* events are checked", () => {
  const other = event("web.page.visible", { launch_id: "not-a-uuid", client_seq: -1 });
  assert.equal(sanitizeWebAgentActivityJoinKeys(other), other);
  const noAttrs: LocalEventRecord = { type: "event", schema_version: 1, name: "slock.agent_activity.status_dot_applied", surface: "web", time: "t" };
  assert.equal(sanitizeWebAgentActivityJoinKeys(noAttrs), noAttrs);
});
