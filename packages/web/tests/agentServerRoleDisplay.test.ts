import assert from "node:assert/strict";
import test from "node:test";
import { resolveAgentServerRoleDisplay } from "../src/utils/agentServerRoleDisplay.js";

// task #261 (artin, 2026-09-03): ① unrecognized role -> show the server's name, first letter
// upper-cased; ②A no role (no membership row) -> no chip; ②B deleted -> no chip.

test("admin and member stay known roles", () => {
  assert.deepEqual(resolveAgentServerRoleDisplay("admin"), { kind: "known", role: "admin" });
  assert.deepEqual(resolveAgentServerRoleDisplay("member"), { kind: "known", role: "member" });
});

test("an unrecognized role shows the name the server sent, first letter upper-cased (①)", () => {
  // Old code rendered "No role" here: it knew there was a role and said there was none.
  const moderator = resolveAgentServerRoleDisplay("moderator");
  assert.equal(moderator.kind, "unrecognized");
  assert.equal(moderator.kind === "unrecognized" && moderator.label, "Moderator");
  const owner = resolveAgentServerRoleDisplay("owner");
  assert.equal(owner.kind === "unrecognized" && owner.label, "Owner");
});

test("only the first character is touched; the rest of an unrecognized role is not rewritten", () => {
  const upper = resolveAgentServerRoleDisplay("MODERATOR");
  assert.equal(upper.kind === "unrecognized" && upper.label, "MODERATOR");
  const camel = resolveAgentServerRoleDisplay("readOnly");
  assert.equal(camel.kind === "unrecognized" && camel.label, "ReadOnly");
});

test("whitespace is trimmed before deciding", () => {
  assert.deepEqual(resolveAgentServerRoleDisplay("  admin "), { kind: "known", role: "admin" });
  assert.deepEqual(resolveAgentServerRoleDisplay("   "), { kind: "hidden" });
});

test("no role from the server (no membership row) hides the chip (②A)", () => {
  assert.deepEqual(resolveAgentServerRoleDisplay(null), { kind: "hidden" });
  assert.deepEqual(resolveAgentServerRoleDisplay(undefined), { kind: "hidden" });
  assert.deepEqual(resolveAgentServerRoleDisplay(""), { kind: "hidden" });
});

test("a deleted agent hides the chip even if a role is still cached (②B)", () => {
  assert.deepEqual(resolveAgentServerRoleDisplay("admin", "2026-09-01T00:00:00Z"), { kind: "hidden" });
});
