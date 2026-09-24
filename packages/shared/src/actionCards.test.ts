import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTION_CARD_ACTION_TYPES,
  actionCardActionSchema,
  buildActionCardPresentation,
} from "./actionCards.js";

test("action cards: migration export is not an action-card operation", () => {
  assert.equal((ACTION_CARD_ACTION_TYPES as readonly string[]).includes("migration:export"), false);
  assert.equal(actionCardActionSchema.safeParse({
    type: "migration:export",
    targetComputer: "computer-a",
  }).success, false);
});

test("action cards: app owner recovery is a typed human-commit operation", () => {
  assert.equal((ACTION_CARD_ACTION_TYPES as readonly string[]).includes("integration:recover_app_owner"), true);
  assert.equal(actionCardActionSchema.safeParse({
    type: "integration:recover_app_owner",
    clientKey: "demo-app",
    targetAgent: "box",
    draftHint: "Recover an orphaned app.",
  }).success, true);
});

test("action cards: Marketplace install binds the exact app, requester, and scopes", () => {
  const parsed = actionCardActionSchema.safeParse({
    type: "integration:install_marketplace_app",
    clientId: "11111111-1111-4111-8111-111111111111",
    clientKey: "me-build",
    clientName: "Me Build",
    clientNameSha256: "a".repeat(64),
    agentId: "22222222-2222-4222-8222-222222222222",
    agentName: "Peng",
    scopes: ["openid", "profile"],
  });
  assert.equal(parsed.success, true);
  assert.equal((ACTION_CARD_ACTION_TYPES as readonly string[]).includes("integration:install_marketplace_app"), true);
  if (!parsed.success) return;
  const presentation = buildActionCardPresentation(parsed.data);
  assert.equal(presentation.confirmLabel, "Install App");
  assert.equal(presentation.genericApprovalAllowed, true);
  assert.equal(presentation.riskLevel, "elevated");
  assert.equal(presentation.displayItems.some((item) => item.key === "clientNameSha256"), false);
});

test("action cards: app registration can defer client key generation to commit", () => {
  const parsed = actionCardActionSchema.safeParse({
    type: "integration:register_app",
    name: "Generated App",
    returnUrl: "https://generated.example/auth/raft/callback",
    draftHint: "Create this app.",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.type, "integration:register_app");
    assert.equal(parsed.data.clientKey, undefined);
  }
});

test("action cards: generic approval is server-authorized only for inline actions", () => {
  const register = buildActionCardPresentation({
    type: "integration:register_app",
    name: "Build Monitor",
    returnUrl: "https://build.example/oauth/callback",
    scopes: ["identity", "profile"],
  });
  const dialogBacked = buildActionCardPresentation({
    type: "agent:create",
    name: "Build Agent",
  });
  const retired = buildActionCardPresentation({
    type: "integration:update_app_registration",
    clientKey: "build-monitor",
    name: "Build Monitor 2",
  });

  assert.equal(register.genericApprovalAllowed, true);
  assert.equal(register.confirmLabel, "Register App");
  assert.deepEqual(
    register.displayItems.find((item) => item.key === "scopes"),
    { key: "scopes", value: "identity, profile" },
  );
  assert.equal(dialogBacked.genericApprovalAllowed, false);
  assert.equal(retired.genericApprovalAllowed, false);
});

test("action cards: presentation redacts secret-shaped fields recursively", () => {
  const action = {
    type: "integration:register_app",
    name: "Build Monitor",
    returnUrl: "https://build.example/oauth/callback",
    scopes: [],
    clientSecret: "must-never-persist",
    advanced: { accessToken: "nested-must-never-persist", mode: "safe" },
  };

  // Production actions are schema-validated and cannot contain these hostile
  // fields. The cast exercises the defensive presentation boundary itself.
  const presentation = buildActionCardPresentation(action as Parameters<typeof buildActionCardPresentation>[0]);
  const encoded = JSON.stringify(presentation);

  assert.equal(encoded.includes("must-never-persist"), false);
  assert.equal(encoded.includes("nested-must-never-persist"), false);
  assert.deepEqual(
    presentation.displayItems.find((item) => item.key === "clientSecret"),
    { key: "clientSecret", value: "Hidden", redacted: true },
  );
  assert.equal(
    presentation.displayItems.find((item) => item.key === "advanced")?.value,
    "accessToken: Hidden, mode: safe",
  );
});
