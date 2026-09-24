import assert from "node:assert/strict";
import test from "node:test";
import { canViewAgentPrivateSurfaces } from "../src/utils/agentVisibility";

test("agent private surfaces are visible to server agent managers", () => {
  assert.equal(
    canViewAgentPrivateSurfaces({ creatorType: null, creatorId: null }, undefined, true),
    true,
  );
});

test("agent private surfaces are visible to the human creator", () => {
  assert.equal(
    canViewAgentPrivateSurfaces({ creatorType: "user", creatorId: "user-1" }, "user-1", false),
    true,
  );
});

test("agent private surfaces are hidden from non-creator members", () => {
  assert.equal(
    canViewAgentPrivateSurfaces({ creatorType: "user", creatorId: "user-1" }, "user-2", false),
    false,
  );
  assert.equal(
    canViewAgentPrivateSurfaces({ creatorType: "agent", creatorId: "agent-1" }, "user-1", false),
    false,
  );
});
