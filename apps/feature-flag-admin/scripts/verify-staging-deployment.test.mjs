import assert from "node:assert/strict";
import { test } from "node:test";
import {
  selectVersionId,
  verifyObservabilitySettings,
  verifySecretList,
  verifyVersion,
} from "./verify-staging-deployment.mjs";

const sourceSha = "a".repeat(40);
const runKey = "12345:1";
const expected = {
  versionId: "version-staging-1",
  sourceSha,
  runKey,
  serverIds: "95f993fa-2a68-4797-b8ae-7beb7d984ada",
  hyperdriveId: "1".repeat(32),
  d1Id: "22222222-2222-4222-8222-222222222222",
};

const bindings = [
  { name: "RAFT_ORIGIN", type: "plain_text", text: "https://app.raft.build" },
  { name: "RAFT_API_ORIGIN", type: "plain_text", text: "https://api.raft.build" },
  { name: "RAFT_CLIENT_ID", type: "plain_text", text: "slock-feature-flag-admin-staging" },
  { name: "FEATURE_FLAG_ALLOWED_SERVER_IDS", type: "plain_text", text: expected.serverIds },
  { name: "FEATURE_FLAG_PG", type: "hyperdrive", id: expected.hyperdriveId },
  { name: "FEATURE_FLAG_AUDIT_DB", type: "d1", id: expected.d1Id },
  { name: "FEATURE_FLAG_SESSION_SECRET", type: "secret_text" },
  { name: "RAFT_CLIENT_SECRET", type: "secret_text" },
];

function validVersion() {
  return {
    id: expected.versionId,
    annotations: { "workers/message": `source_sha=${sourceSha};github_run=${runKey}` },
    resources: { bindings: structuredClone(bindings) },
  };
}

test("requires exactly the two staging secret names", () => {
  assert.doesNotThrow(() => verifySecretList(JSON.stringify([
    { name: "RAFT_CLIENT_SECRET", type: "secret_text" },
    { name: "FEATURE_FLAG_SESSION_SECRET", type: "secret_text" },
  ])));
  assert.throws(
    () => verifySecretList(JSON.stringify([{ name: "RAFT_CLIENT_SECRET", type: "secret_text" }])),
    /must be exactly/,
  );
  assert.throws(() => verifySecretList(JSON.stringify([
    { name: "RAFT_CLIENT_SECRET", type: "secret_text" },
    { name: "FEATURE_FLAG_SESSION_SECRET", type: "unexpected" },
  ])), /invalid entry/);
});

test("selects only an exact source deployment at 100 percent", () => {
  const payload = [{
    annotations: { "workers/message": `source_sha=${sourceSha};github_run=${runKey}` },
    versions: [{ version_id: expected.versionId, percentage: 100 }],
  }];
  assert.equal(selectVersionId(JSON.stringify(payload), sourceSha, runKey), expected.versionId);
  assert.throws(() => selectVersionId(JSON.stringify([]), sourceSha, runKey), /exactly one deployment/);
  payload[0].versions[0].percentage = 90;
  assert.throws(() => selectVersionId(JSON.stringify(payload), sourceSha, runKey), /100 percent/);
});

test("verifies exact source, vars, data bindings, and secret names", () => {
  const version = validVersion();
  assert.doesNotThrow(() => verifyVersion(JSON.stringify(version), expected));

  for (const mutation of [
    (candidate) => { candidate.annotations["workers/message"] = `source_sha=${"b".repeat(40)};github_run=${runKey}`; },
    (candidate) => { candidate.resources.bindings.find((binding) => binding.name === "RAFT_API_ORIGIN").text = "https://api-aws-staging.botiverse.dev"; },
    (candidate) => { candidate.resources.bindings.find((binding) => binding.name === "FEATURE_FLAG_PG").id = "2".repeat(32); },
    (candidate) => { candidate.resources.bindings.find((binding) => binding.name === "FEATURE_FLAG_AUDIT_DB").id = "33333333-3333-4333-8333-333333333333"; },
    (candidate) => { candidate.resources.bindings.splice(candidate.resources.bindings.findIndex((binding) => binding.name === "RAFT_CLIENT_SECRET"), 1); },
  ]) {
    const candidate = validVersion();
    mutation(candidate);
    assert.throws(() => verifyVersion(JSON.stringify(candidate), expected));
  }
});

test("requires persisted full-sampling invocation logs in staging Worker settings", () => {
  const valid = {
    success: true,
    result: {
      observability: {
        enabled: true,
        head_sampling_rate: 1,
        logs: {
          enabled: true,
          head_sampling_rate: 1,
          invocation_logs: true,
          persist: true,
        },
      },
    },
  };
  assert.doesNotThrow(() => verifyObservabilitySettings(JSON.stringify(valid)));
  for (const field of ["enabled", "invocation_logs", "persist"]) {
    const candidate = structuredClone(valid);
    if (field === "enabled") candidate.result.observability.enabled = false;
    else candidate.result.observability.logs[field] = false;
    assert.throws(
      () => verifyObservabilitySettings(JSON.stringify(candidate)),
      /persisted observability is not fully enabled/,
      field,
    );
  }
});
