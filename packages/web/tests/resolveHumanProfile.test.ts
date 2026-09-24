import assert from "node:assert/strict";
import test from "node:test";
import { resolveHumanProfile } from "../src/components/member/resolveHumanProfile";
import type { HumanProfile } from "../src/components/member/HumanDetailPanel";
import type { ServerMember } from "../src/store/serverStore";

const liveMember: ServerMember = {
  userId: "user-1",
  email: "member@example.com",
  gravatarHash: "hash",
  name: "member",
  displayName: "Member",
  description: "live description",
  avatarUrl: null,
  role: "admin",
  joinedAt: "2026-05-15T00:00:00.000Z",
};

const fallbackHuman: HumanProfile = {
  ...liveMember,
  displayName: "Fallback",
  description: "fallback description",
  role: "member",
  membershipStatus: "active",
  createdAgents: [{
    id: "agent-1",
    name: "assistant",
    displayName: null,
    avatarUrl: null,
    runtime: "codex",
    status: "running",
  }],
};

test("live member fields win over fetched profile fallback", () => {
  const resolved = resolveHumanProfile(liveMember, fallbackHuman);

  assert.equal(resolved?.role, "admin");
  assert.equal(resolved?.displayName, "Member");
  assert.equal(resolved?.description, "live description");
  assert.equal(resolved?.membershipStatus, "active");
  assert.deepEqual(resolved?.createdAgents, fallbackHuman.createdAgents);
});

test("live member alone becomes an active human profile", () => {
  const resolved = resolveHumanProfile(liveMember, null);

  assert.equal(resolved?.role, "admin");
  assert.equal(resolved?.membershipStatus, "active");
  assert.deepEqual(resolved?.createdAgents, []);
});
