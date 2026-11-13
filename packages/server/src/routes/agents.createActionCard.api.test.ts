// POST /api/agents from an agent:create action card (#triage #201): a card that
// a channel conversion froze, or that needs reconfirmation, is a typed 409 the
// dialog can show, refused before any Computer round-trip; never a 500.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { KIMI_SDK_FORM_DEFINITION_REF, type RuntimeConfig } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { fixturePasswordHash, tokenForHuman } from "../test/integration/credentials";
import { getDb } from "../db/index";
import { actionCards, agents, machines, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import { createChannel } from "../services/channelService";
import { createMessage } from "../services/messageService";
import {
  ActionCardConfirmationRequiredError,
  ActionCardConfirmationVersionMismatchError,
  ActionCardConversionFrozenError,
  ActionCardReconfirmationRequiredError,
  isActionCardConversionError,
} from "../services/actionCardConversionService";

const test = createApiTest();

async function seed(slug: string) {
  const [owner] = await getDb().insert(users).values({
    email: `${slug}@slock.test`,
    name: slug,
    displayName: slug,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  const server = await createServer(slug, slug, owner!.id);
  const requester = await createAgent(server.id, `${slug}-req`.slice(0, 30), { runtime: "codex" });
  const channel = await createChannel(server.id, `${slug}-room`.slice(0, 30));
  const message = await createMessage(channel.id, "agent", requester.id, "agent:create card");
  await getDb().insert(actionCards).values({
    serverId: server.id,
    messageId: message.id,
    requesterAgentId: requester.id,
    actionType: "agent:create",
    payload: { type: "agent:create", name: "from-card" },
  });
  const token = await tokenForHuman(owner!.email);
  const headers = { Authorization: `Bearer ${token}`, "X-Server-Id": server.id, "Content-Type": "application/json" };
  return { owner: owner!, server, messageId: message.id, headers };
}

async function postCreate(baseUrl: string, headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await fetch(`${baseUrl}/api/agents`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

test("isActionCardConversionError covers exactly the four card-writability refusals", () => {
  for (const err of [
    new ActionCardConversionFrozenError(),
    new ActionCardReconfirmationRequiredError(),
    new ActionCardConfirmationRequiredError(),
    new ActionCardConfirmationVersionMismatchError(),
  ]) {
    assert.ok(isActionCardConversionError(err), err.name);
    assert.equal(err.status, 409);
  }
  assert.ok(!isActionCardConversionError(new Error("x")));
});

test("a frozen, reconfirm-required or stale card refuses the create with its 409 code, not a 500", async ({ app }) => {
  const f = await seed("card-409");
  const cases: Array<{ label: string; freezeState?: "frozen" | "reconfirm_required"; body: Record<string, unknown>; code: string }> = [
    { label: "frozen", freezeState: "frozen", body: {}, code: "action_card_conversion_frozen" },
    { label: "reconfirm", freezeState: "reconfirm_required", body: {}, code: "action_card_reconfirmation_required" },
    { label: "stale version", freezeState: undefined, body: { actionCardConfirmationVersion: 2 }, code: "CONFIRMATION_VERSION_MISMATCH" },
    { label: "missing card", freezeState: undefined, body: { actionCardMessageId: randomUUID() }, code: "action_card_conversion_frozen" },
  ];
  for (const c of cases) {
    await getDb().update(actionCards).set({ freezeState: c.freezeState ?? "ready" }).where(eq(actionCards.messageId, f.messageId));
    const res = await postCreate(app.baseUrl, f.headers, {
      name: `card-${c.label.replace(/\s/g, "-")}`,
      runtime: "codex",
      actionCardMessageId: f.messageId,
      ...c.body,
    });
    assert.equal(res.status, 409, `${c.label}: ${res.text}`);
    const body = JSON.parse(res.text) as { code?: string; error?: string };
    assert.equal(body.code, c.code, c.label);
    assert.ok(body.error && body.error !== "Failed to create agent", c.label);
  }
  const created = await getDb().select({ id: agents.id }).from(agents).where(eq(agents.serverId, f.server.id));
  assert.equal(created.length, 1, "only the requester exists");
});

test("another server's card is refused exactly like a missing card, whatever its state", async ({ app }) => {
  const a = await seed("card-scope-a");
  const b = await seed("card-scope-b");
  const missing = await postCreate(app.baseUrl, a.headers, { name: "scope-missing", runtime: "codex", actionCardMessageId: randomUUID() });
  assert.equal(missing.status, 409, missing.text);
  // A writable card of server B must not pass, and a reconfirm-required or
  // version-gated one must not reveal its state through a distinct code.
  for (const [label, freezeState, extra] of [
    ["ready", "ready", {}],
    ["reconfirm", "reconfirm_required", {}],
    ["stale version", "ready", { actionCardConfirmationVersion: 2 }],
  ] as const) {
    await getDb().update(actionCards).set({ freezeState }).where(eq(actionCards.messageId, b.messageId));
    const res = await postCreate(app.baseUrl, a.headers, {
      name: `scope-${label.replace(/\s/g, "-")}`,
      runtime: "codex",
      actionCardMessageId: b.messageId,
      ...extra,
    });
    assert.equal(res.status, missing.status, `${label}: ${res.text}`);
    assert.equal(res.text, missing.text, label);
  }
  const created = await getDb().select({ id: agents.id }).from(agents).where(eq(agents.serverId, a.server.id));
  assert.equal(created.length, 1, "only the requester exists");
});

test("a frozen card is refused before Kimi model detection reaches the Computer", async ({ app }) => {
  const f = await seed("card-kimi");
  const [machine] = await getDb().insert(machines).values({
    serverId: f.server.id,
    userId: f.owner.id,
    name: "card-kimi-machine",
    apiKeyHash: "card-kimi-machine-hash",
    runtimes: ["kimi-sdk"],
  }).returning();
  const orchestrator = app.app.get("agentOrchestrator") as { detectMachineRuntimeModels: (...args: unknown[]) => Promise<unknown> };
  const original = orchestrator.detectMachineRuntimeModels;
  let detectCalls = 0;
  orchestrator.detectMachineRuntimeModels = async () => {
    detectCalls += 1;
    throw new Error("detect must not run for a frozen card");
  };
  try {
    await getDb().update(actionCards).set({ freezeState: "frozen" }).where(eq(actionCards.messageId, f.messageId));
    const runtimeConfig: RuntimeConfig = {
      version: 1,
      runtime: "kimi-sdk",
      model: { kind: "preset", id: "kimi-code/k3" },
      mode: { kind: "default" },
      reasoningEffort: "balanced-plus",
      envVars: null,
    };
    const res = await postCreate(app.baseUrl, f.headers, {
      name: "card-kimi-agent",
      machineId: machine!.id,
      formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
      runtimeConfig,
      actionCardMessageId: f.messageId,
    });
    assert.equal(res.status, 409, res.text);
    assert.equal((JSON.parse(res.text) as { code?: string }).code, "action_card_conversion_frozen");
    assert.equal(detectCalls, 0, "model detection ran before the card check");

    // Control: the same request on a writable card does reach detection.
    await getDb().update(actionCards).set({ freezeState: "ready" }).where(eq(actionCards.messageId, f.messageId));
    await postCreate(app.baseUrl, f.headers, {
      name: "card-kimi-agent",
      machineId: machine!.id,
      formDefinitionRef: KIMI_SDK_FORM_DEFINITION_REF,
      runtimeConfig,
      actionCardMessageId: f.messageId,
    });
    assert.equal(detectCalls, 1, "the control request should reach detection");
  } finally {
    orchestrator.detectMachineRuntimeModels = original;
  }
});

test("a missing or non-string name or a malformed card id is a 400, not a TypeError 500", async ({ app }) => {
  const f = await seed("card-name");
  for (const [label, body] of [
    ["missing name", { runtime: "codex" }],
    ["null name", { name: null, runtime: "codex" }],
    ["numeric name", { name: 42, runtime: "codex" }],
    ["external missing name", { external: true }],
    ["non-uuid card id", { name: "card-bad-id", runtime: "codex", actionCardMessageId: "not-a-uuid" }],
  ] as const) {
    const res = await postCreate(app.baseUrl, f.headers, body);
    assert.equal(res.status, 400, `${label}: ${res.text}`);
  }
});
