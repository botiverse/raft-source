import assert from "node:assert/strict";
import { editOAuthClientDraft, emptyOAuthClientDraft, oauthClientPayload } from "../src/components/settings/mcpApps/managedMcpOAuthClient";

test("Connection edits preserve omitted client data and explicitly switch to automatic registration", () => {
  for (const flag of [true, false, undefined]) assert.equal(oauthClientPayload(editOAuthClientDraft(flag)), undefined);
  assert.equal(oauthClientPayload({ ...editOAuthClientDraft(true), mode: "automatic", preserveAutomatic: false }), null);
});

test("registered client payload contains only the selected authentication fields", () => {
  const draft = { ...emptyOAuthClientDraft(), mode: "custom" as const, clientId: "id", clientSecret: "secret" };
  assert.deepEqual(oauthClientPayload(draft), { clientId: "id", tokenEndpointAuthMethod: "none" });
  assert.deepEqual(oauthClientPayload({ ...draft, method: "client_secret_post", scope: " read ", offline: true }), {
    clientId: "id", clientSecret: "secret", tokenEndpointAuthMethod: "client_secret_post", scope: "read", requestOfflineAccess: true,
  });
});
