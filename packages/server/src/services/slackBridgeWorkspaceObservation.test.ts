import assert from "node:assert/strict";

import { readSlackWorkspaceObservation } from "./slackBridgeProviderRuntime";
import type { SlackBridgeProvisioningProviderAuthority, SlackBridgeProvisioningProviderResult } from "./slackBridgeProvisioningControlPlane";

const AUTHORITY: SlackBridgeProvisioningProviderAuthority = {
  installId: "workspace-observation-test",
  providerAppId: "A_TEST",
  providerAuthorityId: "T_TEST",
  botUserId: "U_BOT",
  connectionEpoch: 1,
  credentialRevision: 1,
  now: new Date("2026-10-28T00:00:00Z"),
};
const AUTH = { kind: "fact", fact: { team_id: "T_TEST", api_app_id: "A_TEST", user_id: "U_BOT", team: "Test" } } as const;
type QueryResult = SlackBridgeProvisioningProviderResult<Record<string, unknown>>;

for (const kind of ["failed", "unverified"] as const) {
  test(`an ${kind} auth observation never claims OAuth passed or reads the directory`, async () => {
    const methods: string[] = [];
    const result = await readSlackWorkspaceObservation(AUTHORITY, async (method) => {
      methods.push(method);
      return { kind };
    });
    assert.equal(result.oauth, kind);
    assert.deepEqual(methods, ["auth.test"]);
  });
}

for (const field of ["team_id", "api_app_id", "user_id"] as const) {
  test(`an auth ${field} mismatch fails OAuth before directory enumeration`, async () => {
    const methods: string[] = [];
    const result = await readSlackWorkspaceObservation(AUTHORITY, async (method) => {
      methods.push(method);
      return { kind: "fact", fact: { ...AUTH.fact, [field]: "WRONG_IDENTITY" } };
    });
    assert.equal(result.oauth, "failed");
    assert.deepEqual(methods, ["auth.test"]);
  });
}

const DIRECTORY_FAILURES: Array<[string, QueryResult]> = [
  ["rate limit", { kind: "unverified", retryAfterMs: 60_000 }],
  ["provider rejection", { kind: "failed", slackError: "missing_scope" }],
  ["malformed inventory", { kind: "fact", fact: { channels: null } }],
];
for (const [label, directory] of DIRECTORY_FAILURES) {
  test(`${label} after a valid auth observation preserves the OAuth result`, async () => {
    const result = await readSlackWorkspaceObservation(AUTHORITY, async (method) => method === "auth.test" ? AUTH : directory);
    assert.equal(result.oauth, "passed");
    assert.notEqual(result.directory.kind, "fact", "no partial directory is published");
    if (directory.kind === "unverified") assert.deepEqual(result.directory, directory);
  });
}

test("a directory exception preserves OAuth while an auth exception stays unverified", async () => {
  const afterAuth = await readSlackWorkspaceObservation(AUTHORITY, async (method) => {
    if (method === "auth.test") return AUTH;
    throw new Error("directory transport stopped");
  });
  assert.deepEqual(afterAuth, { oauth: "passed", directory: { kind: "unverified" } });
  const beforeAuth = await readSlackWorkspaceObservation(AUTHORITY, async () => { throw new Error("auth unavailable"); });
  assert.deepEqual(beforeAuth, { oauth: "unverified", directory: { kind: "unverified" } });
});

test("complete directory publication retains its matched OAuth observation", async () => {
  const observed = await readSlackWorkspaceObservation(AUTHORITY, async (method) => method === "auth.test" ? AUTH : {
    kind: "fact", fact: { channels: [{ id: "C_TEST", name: "general", is_private: false, is_member: true }], response_metadata: { next_cursor: "" } },
  });
  assert.deepEqual(observed, { oauth: "passed", directory: { kind: "fact", fact: {
    workspaceName: "Test", channels: [{ id: "C_TEST", name: "general", privacyClass: "public", isMember: true }],
  } } });
});
