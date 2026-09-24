import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_GRANTABLE_SCOPES,
  AGENT_INTRINSIC_SCOPES,
  AGENT_SCOPE_GROUPS,
  hasScope,
  isAgentScope,
  isGrantableScope,
  isIntrinsicScope,
  sanitizeGrantedScopes,
  type AgentScopeSet,
} from "./agentScopes.js";

test("v1 default profile grants every grantable scope — no privilege tier", () => {
  // All 19 grantable scopes are default-on for the default profile; the contract has no
  // default-off subset. Sanity-check the count + that action:prepare is
  // present (this is the entry that previously sat in default-off).
  assert.equal(AGENT_GRANTABLE_SCOPES.length, 19);
  assert.ok((AGENT_GRANTABLE_SCOPES as readonly string[]).includes("server:update"));
  assert.ok((AGENT_GRANTABLE_SCOPES as readonly string[]).includes("inbox:receive"));
  assert.ok((AGENT_GRANTABLE_SCOPES as readonly string[]).includes("channel:create"));
  assert.ok((AGENT_GRANTABLE_SCOPES as readonly string[]).includes("channel:update"));
  assert.ok((AGENT_GRANTABLE_SCOPES as readonly string[]).includes("channel:add_member"));
  assert.ok((AGENT_GRANTABLE_SCOPES as readonly string[]).includes("channel:remove_member"));
  assert.ok((AGENT_GRANTABLE_SCOPES as readonly string[]).includes("channel:join"));
  assert.ok((AGENT_GRANTABLE_SCOPES as readonly string[]).includes("knowledge:read"));
  assert.ok((AGENT_GRANTABLE_SCOPES as readonly string[]).includes("action:prepare"));
});

test("intrinsic and grantable sets are disjoint", () => {
  for (const intrinsic of AGENT_INTRINSIC_SCOPES) {
    assert.ok(
      !(AGENT_GRANTABLE_SCOPES as readonly string[]).includes(intrinsic),
      `${intrinsic} should not be grantable`,
    );
  }
});

test("UI grouping covers every grantable scope exactly once", () => {
  const flattened = AGENT_SCOPE_GROUPS.flatMap((g) => g.scopes.map((r) => r.scope));
  assert.deepEqual([...flattened].sort(), [...AGENT_GRANTABLE_SCOPES].sort());
  assert.equal(new Set(flattened).size, flattened.length);
});

test("isGrantableScope only matches the 19 grantable literals", () => {
  assert.equal(isGrantableScope("message:send"), true);
  assert.equal(isGrantableScope("server:update"), true);
  assert.equal(isGrantableScope("channel:create"), true);
  assert.equal(isGrantableScope("channel:update"), true);
  assert.equal(isGrantableScope("channel:add_member"), true);
  assert.equal(isGrantableScope("channel:remove_member"), true);
  assert.equal(isGrantableScope("channel:join"), true);
  assert.equal(isGrantableScope("knowledge:read"), true);
  assert.equal(isGrantableScope("inbox:receive"), true);
  assert.equal(isGrantableScope("auth:whoami"), false);
  assert.equal(isGrantableScope("not:a:scope"), false);
});

test("isIntrinsicScope only matches the 4 intrinsic literals", () => {
  assert.equal(isIntrinsicScope("auth:whoami"), true);
  assert.equal(isIntrinsicScope("profile:write"), true);
  assert.equal(isIntrinsicScope("message:send"), false);
});

test("isAgentScope unions grantable + intrinsic", () => {
  assert.equal(isAgentScope("message:send"), true);
  assert.equal(isAgentScope("reminder:manage"), true);
  assert.equal(isAgentScope("definitely:not"), false);
});

test("sanitizeGrantedScopes drops unknown / non-grantable / duplicate / non-string entries", () => {
  assert.deepEqual(
    sanitizeGrantedScopes(["message:send", "auth:whoami", "garbage", "action:prepare"]),
    ["message:send", "action:prepare"],
  );
  assert.deepEqual(sanitizeGrantedScopes(["message:send", "message:send"]), ["message:send"]);
  assert.deepEqual(
    sanitizeGrantedScopes([null as unknown as string, 42 as unknown as string]),
    [],
  );
  assert.deepEqual(sanitizeGrantedScopes(null), []);
  assert.deepEqual(sanitizeGrantedScopes(undefined), []);
});

test("sanitizeGrantedScopes returns canonical AGENT_GRANTABLE_SCOPES order", () => {
  const result = sanitizeGrantedScopes([
    "task:write",
    "message:send",
    "server:read",
    "action:prepare",
  ]);
  assert.deepEqual(result, ["server:read", "message:send", "task:write", "action:prepare"]);
});

test("hasScope returns true for granted grantable scopes", () => {
  const set: AgentScopeSet = {
    agentId: "a",
    granted: ["message:send", "task:write"],
    mode: "custom",
    revision: 1,
    updatedAt: "2026-05-12T00:00:00Z",
  };
  assert.equal(hasScope(set, "message:send"), true);
  assert.equal(hasScope(set, "task:write"), true);
});

test("hasScope returns false for ungranted grantable scopes", () => {
  const set: AgentScopeSet = {
    agentId: "a",
    granted: ["message:send"],
    mode: "custom",
    revision: 1,
    updatedAt: "2026-05-12T00:00:00Z",
  };
  assert.equal(hasScope(set, "action:prepare"), false);
  assert.equal(hasScope(set, "server:read"), false);
});

test("hasScope short-circuits intrinsic scopes to true regardless of grant", () => {
  const set: AgentScopeSet = {
    agentId: "a",
    granted: [],
    mode: "custom",
    revision: 1,
    updatedAt: "2026-05-12T00:00:00Z",
  };
  assert.equal(hasScope(set, "auth:whoami"), true);
  assert.equal(hasScope(set, "profile:write"), true);
  assert.equal(hasScope(set, "reminder:manage"), true);
  // Even a null scope set still grants intrinsic capabilities — the agent
  // existing implies the intrinsic capability.
  assert.equal(hasScope(null, "auth:whoami"), true);
});

test("hasScope returns false for grantable scopes when scope set is null", () => {
  assert.equal(hasScope(null, "message:send"), false);
});
