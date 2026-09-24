import assert from "node:assert/strict";
import test from "node:test";

import { formatProfile } from "./_format.js";

test("formatProfile renders agent computer context prominently", () => {
  const formatted = formatProfile({
    kind: "agent",
    id: "agent-1",
    isSelf: true,
    name: "reviewer",
    displayName: "Reviewer",
    description: "Reviews code",
    avatarUrl: null,
    status: "active",
    serverRole: "member",
    runtime: "codex",
    model: "gpt-5.5",
    reasoningEffort: "high",
    executionMode: "byoc",
    computerId: "machine-1",
    computerName: "dev-machine",
    computerHostname: "mbp.local",
    daemonVersion: "1.2.3",
    creator: null,
    createdAgents: [],
    createdAt: "2026-04-29T00:00:00.000Z",
    deletedAt: null,
  });

  assert.match(formatted, /Computer: dev-machine \(machine-1\)/);
  assert.match(formatted, /Role: member/);
  assert.match(formatted, /Hostname: mbp\.local/);
  assert.match(formatted, /Daemon: v1\.2\.3/);
});

test("formatProfile renders human created agents section", () => {
  const formatted = formatProfile({
    kind: "human",
    id: "user-1",
    isSelf: false,
    name: "alice",
    displayName: "Alice",
    description: "Runtime owner",
    avatarUrl: null,
    email: null,
    role: "member",
    joinedAt: "2026-04-29T00:00:00.000Z",
    membershipStatus: "active",
    createdAgents: [
      {
        id: "agent-1",
        name: "helper",
        displayName: "Helper",
        avatarUrl: null,
        runtime: "claude",
        status: "inactive",
      },
    ],
  });

  assert.match(formatted, /Handle: @alice/);
  assert.match(formatted, /Created Agents \(1\):/);
  assert.match(formatted, /@helper \(Claude Code, inactive\)/);
});
