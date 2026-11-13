import assert from "node:assert/strict";
import { ACTION_CARD_TYPES_WITHOUT_AUTHORITY, actionCardTypeAuthority } from "./actionCardAuthority";
import { STORED_ACTION_CARD_ACTION_TYPES } from "./actionCards";

test("every stored action card type has an authority row with a reason", () => {
  for (const type of STORED_ACTION_CARD_ACTION_TYPES) {
    const authority = actionCardTypeAuthority(type);
    assert.ok(authority.why.length > 0, type);
  }
});

test("only types that take no server permission are open to a Guest (the web's list derives from this)", () => {
  assert.deepEqual(
    [...ACTION_CARD_TYPES_WITHOUT_AUTHORITY].sort(),
    // assistant:owner_action: only the assistant's owner decides (its form handler), on their own route's checks.
    ["agent:approve_call", "assistant:owner_action", "feedback:submit", "question:ask"],
  );
});

test("agent:migrate takes what POST /api/agents/:id/migrate takes: the Agent's creator, or migrateAgents", () => {
  // `agent`: the server checks the card's agentId with userCanActOnAgentResource(role, user, agent, "migrateAgents"),
  // the rule the migrate route checks (currentUserCanActOnAgent(..., "migrateAgents")).
  assert.deepEqual(
    { ...actionCardTypeAuthority("agent:migrate"), why: undefined },
    { kind: "agent", capability: "migrateAgents", why: undefined },
  );
});
