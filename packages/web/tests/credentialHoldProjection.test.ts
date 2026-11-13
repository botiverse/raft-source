import assert from "node:assert/strict";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { useServerStore } from "../src/store/serverStore";
import { credentialInvalidReasonOf } from "../src/utils/activity";

// #proj-raft-computer:#48 (reconciler step 4b): the web keeps the daemon's
// typed credential-hold reason next to the idle status it rides, and only
// there; the latest frame is the state.

const originalGet = api.get;

afterEach(() => {
  api.get = originalGet;
  useAgentStore.setState(useAgentStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
});

function pushActivity(seq: number, activity: string, detail: string, detailKind: string, credentialHold?: { reason: "user_reauth" | "user_model_access" | "billing" }) {
  useAgentStore.getState().updateActivity(
    "agent-held", activity, detail, seq, 500 + seq, { launchId: "launch-1", clientSeq: seq }, activity, detailKind,
    { clientEventId: `evt-${seq}` }, false, false, undefined, undefined, undefined, undefined, credentialHold,
  );
  return useAgentStore.getState().agentActivities["agent-held"];
}

test("the store keeps credentialHold on the idle status and drops it with the next frame that lacks it", () => {
  assert.deepEqual(pushActivity(1, "online", "held notice", "idle", { reason: "user_reauth" })?.credentialHold, { reason: "user_reauth" });
  assert.deepEqual(pushActivity(2, "online", "held notice", "idle", { reason: "billing" })?.credentialHold, { reason: "billing" }, "a new reason with the same text is a change");
  assert.equal(pushActivity(3, "online", "Process idle", "idle")?.credentialHold, undefined, "the release's idle frame clears it");
  assert.equal(pushActivity(4, "working", "Starting…", "starting", { reason: "user_reauth" })?.credentialHold, undefined, "only an idle frame carries it");
});

test("the reason comes from typed data only: the held carrier, or the stored error the live error is", () => {
  const held = { activity: "online", activityDetail: "anything", activityDetailKind: "idle" } as const;
  assert.equal(credentialInvalidReasonOf({ ...held, credentialHold: { reason: "user_model_access" } }), "user_model_access");
  assert.equal(credentialInvalidReasonOf(held), null, "an older daemon's held notice: no reason");
  assert.equal(credentialInvalidReasonOf({ ...held, activityDetailKind: "other", credentialHold: { reason: "billing" } }), null);
  const error = { activity: "error", activityDetail: "boom", activityDetailKind: "runtime_error" } as const;
  assert.equal(credentialInvalidReasonOf({ ...error, lastRuntimeError: { message: "boom", errorClass: "ModelConfigError", requiredAction: "user_model_access" } }), "user_model_access");
  assert.equal(credentialInvalidReasonOf({ ...error, lastRuntimeError: { message: "boom", errorClass: "AuthError", requiredAction: "user_model_access" } }), "user_model_access", "requiredAction comes first");
  assert.equal(credentialInvalidReasonOf({ ...error, lastRuntimeError: { message: "boom", errorClass: "AuthError" } }), "user_reauth");
  assert.equal(credentialInvalidReasonOf({ ...error, lastRuntimeError: { message: "boom", errorClass: "BillingError" } }), "billing");
  assert.equal(credentialInvalidReasonOf({ ...error, lastRuntimeError: { message: "boom", errorClass: "ModelConfigError" } }), null);
  assert.equal(credentialInvalidReasonOf({ ...error, lastRuntimeError: { message: "older", errorClass: "AuthError" } }), null, "not the error shown");
  assert.equal(credentialInvalidReasonOf({ ...error, activity: "online", activityDetailKind: "idle", lastRuntimeError: { message: "boom", errorClass: "AuthError" } }), null, "recovered: Online");
});

test("a refreshed agent list keeps the held reason on the idle snapshot only", async () => {
  useServerStore.setState({ current: { id: "server-1", slug: "s", name: "S", role: "owner" }, serverEpoch: 1 } as never);
  const row = (id: string, extra: Record<string, unknown>) => ({ id, name: id, runtime: "codex", model: "gpt-x", status: "active", ...extra });
  api.get = (async (url: string) => {
    assert.equal(url, "/agents");
    return { data: [
      row("held", { activity: "online", activityDetail: "held notice", activityDetailKind: "idle", credentialHold: { reason: "user_reauth" } }),
      row("busy", { activity: "working", activityDetail: "Running", activityDetailKind: "running_command", credentialHold: { reason: "user_reauth" } }),
      row("old-daemon", { activity: "online", activityDetail: "held notice", activityDetailKind: "idle" }),
    ] };
  }) as typeof api.get;
  await useAgentStore.getState().loadAgents();
  const activities = useAgentStore.getState().agentActivities;
  assert.deepEqual(activities.held?.credentialHold, { reason: "user_reauth" });
  assert.equal(activities.busy?.credentialHold, undefined);
  assert.equal(activities["old-daemon"]?.credentialHold, undefined);
  assert.equal("credentialHold" in (useAgentStore.getState().agents.find((agent) => agent.id === "held") ?? {}), false, "not left on the agent row");
});
