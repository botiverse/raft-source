import assert from "node:assert/strict";
import { readSlackConversationMember, readSlackWorkspaceObservation } from "./slackBridgeProviderRuntime";

const subject = { providerConversationId: "C_PRIVATE", providerUserId: "U_AUTHORIZER" };
const page = (members: unknown[], cursor: string) => ({ kind: "fact" as const,
  fact: { members, response_metadata: { next_cursor: cursor } } });

test("private membership uses the exact OAuth human and follows all pages", async () => {
  const calls: Record<string, unknown>[] = [];
  const result = await readSlackConversationMember(subject, async body => {
    calls.push(body);
    return calls.length === 1 ? page(["U_OTHER"], "next") : page(["U_AUTHORIZER"], "");
  });
  assert.deepEqual(result, { kind: "fact", fact: true });
  assert.deepEqual(calls, [{ channel: "C_PRIVATE", limit: 200 }, { channel: "C_PRIVATE", limit: 200, cursor: "next" }]);
  assert.deepEqual(await readSlackConversationMember(subject, async () => page(["U_OTHER"], "")), { kind: "fact", fact: false });
});

test("incomplete or malformed private membership is not negative or positive proof", async () => {
  assert.deepEqual(await readSlackConversationMember(subject, async () => ({ kind: "fact", fact: { members: ["U_OTHER"] } })), { kind: "unverified" });
  assert.deepEqual(await readSlackConversationMember(subject, async () => page(["U_OTHER"], "loop")), { kind: "unverified" });
  assert.deepEqual(await readSlackConversationMember(subject, async () => ({ kind: "failed" })), { kind: "failed" });
  assert.deepEqual(await readSlackConversationMember(subject, async () => page(["U_AUTHORIZER", null], "")), { kind: "unverified" });
});

test("workspace directory refuses a channel without an explicit privacy classification", async () => {
  const authority = { installId: "I", providerAppId: "A", providerAuthorityId: "T", botUserId: "B",
    connectionEpoch: 1, credentialRevision: 1, now: new Date() };
  const result = await readSlackWorkspaceObservation(authority, async method => method === "auth.test"
    ? { kind: "fact", fact: { team_id: "T", user_id: "B" } }
    : { kind: "fact", fact: { channels: [{ id: "C", name: "secret", is_member: true }], response_metadata: { next_cursor: "" } } });
  assert.equal(result.directory.kind, "unverified");
});
