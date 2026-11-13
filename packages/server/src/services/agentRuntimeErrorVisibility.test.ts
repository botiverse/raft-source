import assert from "node:assert/strict";
import { GENERIC_RUNTIME_ERROR_MESSAGE, RUNTIME_ERROR_CODE_SENTENCES } from "@botiverse/raft-shared";

import { projectRuntimeErrorActivityDetail, projectRuntimeErrorState } from "./agentRuntimeErrorVisibility";

const OLD_ROW = { message: `boom sk-abcdefghijklmnop0123 /home/bob/x ${"w".repeat(900)}`, at: "2026-01-01T00:00:00.000Z", actionRequired: true };

test("#wg-rbac:#57: a row stored unscrubbed is scrubbed and capped on read for a manager; a member never reads it", () => {
  const manager = projectRuntimeErrorState(OLD_ROW, "manager")!;
  assert.ok(!manager.message.includes("sk-abcdefghijklmnop0123") && !manager.message.includes("/home/bob"));
  assert.ok(manager.message.length <= 512);
  assert.equal(manager.code, undefined);
  const member = projectRuntimeErrorState(OLD_ROW, "member")!;
  assert.equal(member.message, GENERIC_RUNTIME_ERROR_MESSAGE);
  assert.equal(projectRuntimeErrorState(null, "member"), null);
});

test("#wg-rbac:#57: the stored error's typed class decides the activity's code when it is the error shown", () => {
  const stored = { ...OLD_ROW, message: "Payment failed", errorClass: "BillingError" as const };
  assert.deepEqual(projectRuntimeErrorActivityDetail({ activity: "error", detail: "Payment failed", lastRuntimeError: stored }, "member"), {
    detail: RUNTIME_ERROR_CODE_SENTENCES.billing, errorCode: "billing",
  });
  assert.deepEqual(projectRuntimeErrorActivityDetail({ activity: "error", detail: "another failure", lastRuntimeError: stored }, "member"), {
    detail: GENERIC_RUNTIME_ERROR_MESSAGE,
  }, "a different error shown: its own text decides");
  assert.deepEqual(projectRuntimeErrorActivityDetail({ activity: "working", detail: "Editing", lastRuntimeError: stored }, "member"), { detail: "Editing" });
});

test("#wg-rbac:#57: a crash detail on a non-error activity is projected too", () => {
  assert.deepEqual(projectRuntimeErrorActivityDetail({ activity: "offline", detailKind: "runtime_crashed", detail: OLD_ROW.message }, "member"), {
    detail: GENERIC_RUNTIME_ERROR_MESSAGE,
  });
  const manager = projectRuntimeErrorActivityDetail({ activity: "offline", detailKind: "runtime_crashed", detail: OLD_ROW.message }, "manager");
  assert.ok(!manager.detail.includes("sk-abcdefghijklmnop0123") && manager.detail.length <= 512);
});
