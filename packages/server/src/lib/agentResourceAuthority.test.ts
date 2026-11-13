import assert from "node:assert/strict";
import { test } from "vitest";
import type { ServerRole } from "@botiverse/raft-shared";
import { decideAgentResourceAuthority, roleCanInspectAgentPrivateSurfaces } from "./actorPermissions";

const OWNER = "owner-user";
const OTHER = "other-user";
// The owner also created it, so a creator exception would show up here.
const assistant = { creatorType: "user", creatorId: OWNER, assistantOwnerUserId: OWNER };
const ordinary = { creatorType: "user", creatorId: OWNER, assistantOwnerUserId: null };

type Row = { who: string; caller: string; role: ServerRole | null; manage: string; stop: string };

// The owner's role column is the owner's current role: `null` after removal.
const MATRIX: Row[] = [
  { who: "owner (member)", caller: OWNER, role: "member", manage: "allowed", stop: "allowed" },
  { who: "owner (server admin)", caller: OWNER, role: "admin", manage: "allowed", stop: "allowed" },
  { who: "server owner", caller: OTHER, role: "owner", manage: "assistant_owner_only", stop: "allowed" },
  { who: "server admin", caller: OTHER, role: "admin", manage: "assistant_owner_only", stop: "allowed" },
  { who: "member", caller: OTHER, role: "member", manage: "assistant_owner_only", stop: "assistant_owner_only" },
  { who: "guest", caller: OTHER, role: "guest", manage: "assistant_owner_only", stop: "assistant_owner_only" },
  { who: "owner removed from the server", caller: OWNER, role: null, manage: "assistant_owner_only", stop: "assistant_owner_only" },
];

test("a personal assistant's lifecycle is its owner's; server owner/admin may only stop it", () => {
  for (const row of MATRIX) {
    for (const capability of ["editAgents", "controlAgentRuntime", "deleteAgents", "issueAgentCredentials", "manageExternalAuth"] as const) {
      assert.equal(decideAgentResourceAuthority(row.role, row.caller, assistant, capability), row.manage, `${row.who}: ${capability}`);
    }
    assert.equal(decideAgentResourceAuthority(row.role, row.caller, assistant, "controlAgentRuntime", { stop: true }), row.stop, `${row.who}: stop`);
    assert.equal(roleCanInspectAgentPrivateSurfaces(row.role, row.caller, assistant), row.manage === "allowed", `${row.who}: private surfaces`);
  }
});

test("an ordinary agent keeps the capability-or-creator rule", () => {
  assert.equal(decideAgentResourceAuthority("admin", OTHER, ordinary, "editAgents"), "allowed");
  assert.equal(decideAgentResourceAuthority("member", OTHER, ordinary, "editAgents"), "forbidden");
  assert.equal(decideAgentResourceAuthority("member", OWNER, ordinary, "editAgents"), "allowed", "its creator");
  assert.equal(decideAgentResourceAuthority("member", OTHER, ordinary, "controlAgentRuntime", { stop: true }), decideAgentResourceAuthority("member", OTHER, ordinary, "controlAgentRuntime"), "stop changes nothing for an ordinary agent");
});

test("an assistant whose owner left the server: a server owner/admin may delete it, nothing else", () => {
  const orphan = { ...assistant, assistantOwnerIsMember: false };
  assert.equal(decideAgentResourceAuthority("admin", OTHER, orphan, "deleteAgents"), "allowed");
  assert.equal(decideAgentResourceAuthority("owner", OTHER, orphan, "deleteAgents"), "allowed");
  assert.equal(decideAgentResourceAuthority("member", OTHER, orphan, "deleteAgents"), "assistant_owner_only");
  assert.equal(decideAgentResourceAuthority("admin", OTHER, orphan, "editAgents"), "assistant_owner_only");
  assert.equal(decideAgentResourceAuthority("admin", OTHER, orphan, "controlAgentRuntime"), "assistant_owner_only");
  assert.equal(roleCanInspectAgentPrivateSurfaces("admin", OTHER, orphan), false, "its private surfaces stay closed");
  // While the owner is a member, deletion is theirs alone.
  assert.equal(decideAgentResourceAuthority("admin", OTHER, { ...assistant, assistantOwnerIsMember: true }, "deleteAgents"), "assistant_owner_only");
});
