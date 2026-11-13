import { createApiTest } from "../test/integration/apiTest";
// antiproton held-call approvals, Raft's side (docs/contracts/hosted-agent-approvals.md):
// the signed hint, the pull, the cards (owner, or every owner and admin once
// the owner left), the decision through the card's form (decider re-checked at
// the click, retries, every refusal antiproton can give), the forward-only
// state, the reconcile and its watermark, the audit, and the delivery reports
// (the first card or nobody to send it to). antiproton is a fake
// behind the provider transport.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";

import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, vi } from "vitest";
import type { ActionCardMetadata, ActionCardResult, AgentApproveCallAction } from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import {
  actionCards,
  agents,
  agentRuntimeApprovalCards,
  agentRuntimeApprovalSync,
  agentRuntimeApprovals,
  agentRuntimeProvisions,
  integrationAuditEvents,
  messages,
  serverMembers,
} from "../db/schema";
import { createAgent, deleteAgent } from "../services/agentService";
import { ActionCardError, prepareActionCard } from "../services/actionCardsService";
import { __setAgentRuntimeProviderTransportForTests } from "../services/agentRuntimeProviderService";
import {
  ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV,
  DELIVERY_RESEND_WINDOW_MS,
  reconcileApprovals,
  RECONCILE_FAILED_ROW_GRACE_MS,
  RECONCILE_OVERLAP_MS,
  setApprovalDecideRetryDelayForTest,
  setApprovalFaultForTest,
  settleApprovalPullsForTest,
  syncApprovalCards,
} from "../services/agentRuntimeApprovalService";
import * as channelService from "../services/channelService";
import { createServer } from "../services/serverService";
import { installRecordingOrchestrator, seedUser } from "../test/actionCardFormFixture";
import { tokenForHuman } from "../test/integration/credentials";
import { enrollSecondFactor, useTotpSecretKey } from "../test/integration/secondFactor";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
useTotpSecretKey();

// antiproton's hint signing key (its private half stays at antiproton) and another one.
const HINT_KEY_ID = "ap-test-1";
const HINT_KEY = generateKeyPairSync("ed25519");
const OTHER_KEY = generateKeyPairSync("ed25519");
const rawPublicKey = (key: KeyObject) => Buffer.from(key.export({ format: "jwk" }).x!, "base64url").toString("base64");
const HINT_PUBLIC_KEYS = JSON.stringify({ [HINT_KEY_ID]: rawPublicKey(HINT_KEY.publicKey) });
const TOKEN = "pt-test-provider-token";
const BASE = "https://antiproton.test";
const ENV_KEYS = ["ANTIPROTON_PROVISIONING_TOKEN", ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.ANTIPROTON_PROVISIONING_TOKEN = TOKEN;
  process.env[ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV] = HINT_PUBLIC_KEYS;
  setApprovalDecideRetryDelayForTest(0);
});

afterEach(async () => {
  setApprovalFaultForTest(null);
  await settleApprovalPullsForTest();
  __setAgentRuntimeProviderTransportForTests(null);
  setApprovalDecideRetryDelayForTest(null);
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

// ---------------------------------------------------------------------------
// A fake antiproton: holds by operation id, every call recorded, decide and
// delivery answers scriptable.

type Item = Record<string, unknown> & { operationId: string; raftAgentId: string; raftServerId: string; status: string; updatedAt?: string };
type Call = { method: string; path: string; query: URLSearchParams; body: unknown; authorization: string | null };

function fakeAntiproton(options: { pageSize?: number } = {}) {
  const holds = new Map<string, Item>();
  const calls: Call[] = [];
  const decideScript: Array<(body: { decision: string; decidedBy: { raftUserId: string; role: string } }, item: Item | undefined) => Response | Promise<Response>> = [];
  const deliveryScript: Array<(body: Record<string, unknown>, item: Item | undefined) => Response | Promise<Response>> = [];
  let agentListStatus = 200;
  let agentListCode = "not_found";
  // Recent, as real rows are: a failed reconcile row holds the watermark only within its grace.
  let clock = Date.now() - 20 * 60_000;
  const touch = (item: Item) => { clock += 1000; item.updatedAt = new Date(clock).toISOString(); };
  __setAgentRuntimeProviderTransportForTests({
    baseUrl: BASE,
    fetch: (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path: url.pathname, query: url.searchParams, body, authorization: new Headers(init?.headers).get("authorization") });
      const decide = /^\/provision\/agents\/by-raft-agent\/([^/]+)\/approvals\/([^/]+)\/decide$/.exec(url.pathname);
      if (decide && method === "POST") {
        const item = holds.get(decodeURIComponent(decide[2]!));
        const scripted = decideScript.shift();
        if (scripted) return scripted(body, item);
        if (!item) return Response.json({ error: { code: "approval_not_found" } }, { status: 404 });
        const decision = body.decision === "approve" ? "approved" : "denied";
        if (item.status !== "pending") {
          const same = item.status === decision || (decision === "approved" && ["executed", "failed"].includes(item.status));
          if (same) return Response.json({ approval: item, replay: true });
          return Response.json({ error: { code: "approval_already_decided", status: item.status }, approval: item }, { status: 409 });
        }
        Object.assign(item, { status: decision, decidedBy: { via: "raft", ...body.decidedBy }, decidedAt: new Date(clock).toISOString() });
        touch(item);
        return Response.json({ approval: item, replay: false });
      }
      const delivery = /^\/provision\/agents\/by-raft-agent\/([^/]+)\/approvals\/([^/]+)\/delivery$/.exec(url.pathname);
      if (delivery && method === "POST") {
        const item = holds.get(decodeURIComponent(delivery[2]!));
        const scripted = deliveryScript.shift();
        if (scripted) return scripted(body, item);
        if (!item) return Response.json({ error: { code: "approval_not_found" } }, { status: 404 });
        return Response.json({ recorded: true });
      }
      const list = /^\/provision\/agents\/by-raft-agent\/([^/]+)\/approvals$/.exec(url.pathname);
      if (list && method === "GET") {
        if (agentListStatus !== 200) return Response.json({ error: { code: agentListCode } }, { status: agentListStatus });
        const raftAgentId = decodeURIComponent(list[1]!);
        return Response.json({ providerAgentId: `raft_${raftAgentId}`, raftAgentId, approvals: [...holds.values()].filter((item) => item.raftAgentId === raftAgentId) });
      }
      if (url.pathname === "/provision/approvals" && method === "GET") {
        const since = url.searchParams.get("updatedSince");
        const rows = [...holds.values()]
          .filter((item) => !since || Date.parse(item.updatedAt!) >= Date.parse(since))
          .sort((a, b) => Date.parse(a.updatedAt!) - Date.parse(b.updatedAt!));
        const start = Number(url.searchParams.get("cursor") ?? "0");
        const size = options.pageSize ?? 200;
        const page = rows.slice(start, start + size);
        return Response.json({ approvals: page, nextCursor: start + size < rows.length ? String(start + size) : null });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    }) as typeof globalThis.fetch,
  });
  return {
    holds,
    calls,
    decideScript,
    deliveryScript,
    setAgentListStatus(status: number, code = "not_found") { agentListStatus = status; agentListCode = code; },
    add(item: Item) { touch(item); holds.set(item.operationId, item); return item; },
    update(operationId: string, patch: Record<string, unknown>) { const item = holds.get(operationId)!; Object.assign(item, patch); touch(item); return item; },
    get lastUpdatedAt() { return new Date(clock).toISOString(); },
  };
}

function heldItem(agentId: string, serverId: string, operationId = `op_${randomUUID().replaceAll("-", "").slice(0, 20)}`, patch: Record<string, unknown> = {}): Item {
  const created = Date.now();
  return {
    operationId,
    providerAgentId: `raft_${agentId}`,
    raftAgentId: agentId,
    raftServerId: serverId,
    status: "pending",
    mount: "gh",
    plugin: "github",
    tool: "create_pull_request",
    service: null,
    action: null,
    args: { summary: "repo: botiverse/antiproton\ntitle: fix‮ the parser\nbody: [click](https://evil.example) **bold**", truncated: false, redactions: 1, withheld: false },
    outcome: null,
    heldBy: "policy",
    policyKey: null,
    route: { method: "POST", path: "/repos/botiverse/antiproton/pulls", repo: "botiverse/antiproton", pr: null, contentType: "application/json", body: "{}" },
    description: "Approving runs gh.create_pull_request once, exactly as shown; denying runs nothing.⁦",
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + 24 * 3600_000).toISOString(),
    decidedAt: null,
    decidedBy: null,
    ...patch,
  };
}

// ---------------------------------------------------------------------------
// The world: a server whose owner is not the agent's owner, an admin, a
// member, a hosted agent the agent owner created, and a computer agent.

async function seedWorld(app: { app: { set: (key: string, value: unknown) => void; get: (key: string) => unknown } }) {
  const deliveries = installRecordingOrchestrator(app.app);
  const serverOwner = await seedUser("ap-server-owner");
  const agentOwner = await seedUser("ap-agent-owner");
  const admin = await seedUser("ap-admin");
  const member = await seedUser("ap-member");
  const server = await createServer("Approvals", `approvals-${randomUUID().slice(0, 8)}`, serverOwner.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: agentOwner.id, role: "member" },
    { serverId: server.id, userId: admin.id, role: "admin" },
    { serverId: server.id, userId: member.id, role: "member" },
  ]);
  const agent = await createAgent(server.id, `hosted-${randomUUID().slice(0, 6)}`, { runtime: "claude", creatorType: "user", creatorId: agentOwner.id });
  await getDb().insert(agentRuntimeProvisions).values({
    agentId: agent.id, serverId: server.id, provider: "antiproton", state: "active", providerAgentId: `raft_${agent.id}`,
    provisionedName: agent.name, provisionedInstructions: "",
  });
  const computerAgent = await createAgent(server.id, `computer-${randomUUID().slice(0, 6)}`, { runtime: "claude", creatorType: "user", creatorId: agentOwner.id });
  const tokens = {
    serverOwner: await tokenForHuman(serverOwner.email),
    agentOwner: await tokenForHuman(agentOwner.email),
    admin: await tokenForHuman(admin.email),
    member: await tokenForHuman(member.email),
  };
  return { serverOwner, agentOwner, admin, member, server, agent, computerAgent, tokens, deliveries };
}
type World = Awaited<ReturnType<typeof seedWorld>>;
type Who = keyof World["tokens"];

function signed(body: string, options: { ts?: number; key?: KeyObject; keyId?: string } = {}) {
  const ts = options.ts ?? Math.floor(Date.now() / 1000);
  const signature = sign(null, Buffer.from(`${ts}.${body}`, "utf8"), options.key ?? HINT_KEY.privateKey).toString("base64");
  return {
    "Content-Type": "application/json",
    "X-Antiproton-Timestamp": String(ts),
    "X-Antiproton-Signature": `keyid=${options.keyId ?? HINT_KEY_ID}; ed25519=${signature}`,
    "X-Antiproton-Delivery-Id": randomUUID(),
  };
}

async function sendHint(baseUrl: string, body: unknown, headers?: Record<string, string>) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const res = await fetch(`${baseUrl}/api/integrations/antiproton/approvals`, { method: "POST", headers: headers ?? signed(raw), body: raw });
  return { status: res.status, body: await res.json().catch(() => null) as { error?: { code?: string } } | null };
}

async function hintFor(baseUrl: string, w: World, item: Item, type = "approval.requested") {
  const res = await sendHint(baseUrl, { type, operationId: item.operationId, providerAgentId: `raft_${w.agent.id}`, raftAgentId: w.agent.id, raftServerId: w.server.id, status: item.status });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  await settleApprovalPullsForTest();
}

async function cardsOf(operationId: string) {
  return getDb().select({
    userId: agentRuntimeApprovalCards.userId, messageId: agentRuntimeApprovalCards.messageId, channelId: messages.channelId, senderId: messages.senderId,
    metadata: messages.actionMetadata, state: actionCards.state, executedByUserId: actionCards.executedByUserId, executedAt: actionCards.executedAt,
    submittedInput: actionCards.submittedInput, result: actionCards.result,
  })
    .from(agentRuntimeApprovalCards)
    .innerJoin(agentRuntimeApprovals, eq(agentRuntimeApprovals.id, agentRuntimeApprovalCards.approvalId))
    .innerJoin(messages, eq(messages.id, agentRuntimeApprovalCards.messageId))
    .innerJoin(actionCards, eq(actionCards.messageId, agentRuntimeApprovalCards.messageId))
    .where(eq(agentRuntimeApprovals.operationId, operationId));
}

async function holdOf(operationId: string) {
  const [row] = await getDb().select().from(agentRuntimeApprovals).where(eq(agentRuntimeApprovals.operationId, operationId));
  return row;
}

async function decide(baseUrl: string, w: World, who: Who, messageId: string, decision: "approve" | "deny") {
  const res = await fetch(`${baseUrl}/api/actions/${messageId}/execute`, {
    method: "POST",
    headers: { Authorization: `Bearer ${w.tokens[who]}`, "Content-Type": "application/json", "X-Server-Id": w.server.id },
    body: JSON.stringify({ expectedState: "prepared", expectedConfirmationVersion: 1, form: { id: "decision", values: { decision } } }),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as { errorCode?: string; error?: string; metadata?: ActionCardMetadata } };
}

const decides = (calls: Call[]) => calls.filter((call) => call.path.endsWith("/decide"));
const reports = (calls: Call[]) => calls.filter((call) => call.path.endsWith("/delivery"));
const resultOf = (card: { result: unknown }) => card.result as Extract<ActionCardResult, { kind: "agent-call-approval" }> | null;

// ---------------------------------------------------------------------------

test("the migration added the approval tables", async ({ app }) => {
  void app;
  for (const table of [agentRuntimeApprovals, agentRuntimeApprovalCards, agentRuntimeApprovalSync]) {
    assert.deepEqual(await getDb().select().from(table).limit(1), []);
  }
});

test("a hint counts only signed with a configured key, under its key id, and fresh; nothing is pulled for a refused one", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const body = JSON.stringify({ type: "approval.requested", operationId: "op_1", raftAgentId: w.agent.id, raftServerId: w.server.id });
  const now = Math.floor(Date.now() / 1000);
  // The boundary is evaluated against the same second as the signed inputs,
  // even when a slow CI host takes longer than a second to issue requests.
  vi.spyOn(Date, "now").mockReturnValue(now * 1000);

  delete process.env[ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV];
  assert.equal((await sendHint(app.baseUrl, body)).status, 404, "no public keys: approvals are off, the route is not there");
  process.env[ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV] = JSON.stringify({ [HINT_KEY_ID]: "not a key" });
  assert.equal((await sendHint(app.baseUrl, body)).status, 404, "a refused key value: approvals are off too");
  process.env[ANTIPROTON_APPROVAL_HINT_PUBLIC_KEYS_ENV] = HINT_PUBLIC_KEYS;

  const refused: Array<[string, Record<string, string>, string, number, string]> = [
    ["another key", signed(body, { key: OTHER_KEY.privateKey }), body, 401, "approval_hint_signature_invalid"],
    ["a key id not configured", signed(body, { keyId: "ap-test-2" }), body, 401, "approval_hint_signature_invalid"],
    ["the HMAC format", { ...signed(body), "X-Antiproton-Signature": `sha256=${"0".repeat(64)}` }, body, 401, "approval_hint_signature_invalid"],
    // The header was X-Antiproton-Signature-256 under HMAC; a signature sent only there is no signature.
    ["the old -256 header name", (() => {
      const { "X-Antiproton-Signature": value, ...rest } = signed(body);
      return { ...rest, "X-Antiproton-Signature-256": value };
    })(), body, 401, "approval_hint_signature_invalid"],
    ["a changed body", signed(body), body.replace("op_1", "op_2"), 401, "approval_hint_signature_invalid"],
    ["301 s old", signed(body, { ts: now - 301 }), body, 401, "approval_hint_timestamp_invalid"],
    ["301 s ahead", signed(body, { ts: now + 301 }), body, 401, "approval_hint_timestamp_invalid"],
    ["no signature", { "Content-Type": "application/json", "X-Antiproton-Timestamp": String(now) }, body, 401, "approval_hint_signature_invalid"],
    ["no timestamp", { ...signed(body), "X-Antiproton-Timestamp": "" }, body, 401, "approval_hint_timestamp_invalid"],
    ["an uppercase signature", { ...signed(body), "X-Antiproton-Signature": signed(body)["X-Antiproton-Signature"].toUpperCase() }, body, 401, "approval_hint_signature_invalid"],
    ["a changed timestamp", { ...signed(body, { ts: now - 1 }), "X-Antiproton-Timestamp": String(now) }, body, 401, "approval_hint_signature_invalid"],
  ];
  for (const [label, headers, raw, status, code] of refused) {
    const res = await fetch(`${app.baseUrl}/api/integrations/antiproton/approvals`, { method: "POST", headers, body: raw });
    assert.equal(res.status, status, label);
    assert.deepEqual(await res.json(), { error: { code } }, label);
  }
  const notAnAgent = JSON.stringify({ type: "approval.requested", raftAgentId: "nope", raftServerId: w.server.id });
  assert.equal((await sendHint(app.baseUrl, notAnAgent)).status, 400, "signed, but not ids");
  assert.equal(fake.calls.length, 0, "a refused hint pulls nothing");

  assert.equal((await sendHint(app.baseUrl, body, signed(body, { ts: now - 299 }))).status, 202, "within the window");
  await settleApprovalPullsForTest();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]!.path, `/provision/agents/by-raft-agent/${w.agent.id}/approvals`);
  assert.equal(fake.calls[0]!.query.get("raftServerId"), w.server.id);
  assert.equal(fake.calls[0]!.authorization, `Bearer ${TOKEN}`, "pulled with Raft's own provider token");
});

test("a hint about anything but a hosted agent of that server pulls nothing", async ({ app }) => {
  const w = await seedWorld(app);
  const other = await seedWorld(app);
  const fake = fakeAntiproton();
  // Provisioned on the canary target: a hint signed with the default target's key is not about it.
  const canaryAgent = await createAgent(w.server.id, `canary-${randomUUID().slice(0, 6)}`, { runtime: "claude", creatorType: "user", creatorId: w.agentOwner.id });
  await getDb().insert(agentRuntimeProvisions).values({
    agentId: canaryAgent.id, serverId: w.server.id, provider: "antiproton", providerTarget: "canary", provisionedProfile: "raftbench_service",
    state: "active", provisionedName: canaryAgent.name, provisionedInstructions: "",
  });
  for (const [raftAgentId, raftServerId] of [[randomUUID(), w.server.id], [w.agent.id, other.server.id], [w.computerAgent.id, w.server.id], [canaryAgent.id, w.server.id]]) {
    const res = await sendHint(app.baseUrl, { type: "approval.requested", raftAgentId, raftServerId });
    assert.equal(res.status, 202, "a valid hint is acknowledged either way");
  }
  await settleApprovalPullsForTest();
  assert.deepEqual(fake.calls, []);
});

test("a held call becomes one card in the owner's DM with the agent, as plain text; a repeat posts no second card", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  await hintFor(app.baseUrl, w, item);

  const cards = await cardsOf(item.operationId);
  assert.equal(cards.length, 1, "one card, for the agent's owner only");
  const [card] = cards;
  assert.equal(card!.userId, w.agentOwner.id);
  assert.equal(card!.senderId, w.agent.id, "posted as the agent's message");
  const dm = await channelService.findOrCreateDM(w.server.id, w.agentOwner.id, w.agent.id);
  assert.equal(card!.channelId, dm!.id, "in the owner's DM with the agent");
  assert.equal(card!.state, "prepared");
  const metadata = card!.metadata as ActionCardMetadata;
  const action = metadata.action as AgentApproveCallAction;
  assert.equal(action.type, "agent:approve_call");
  assert.equal(action.decider, "owner");
  assert.equal(action.call, "gh.create_pull_request");
  assert.equal(action.summary, "repo: botiverse/antiproton\ntitle: fix the parser\nbody: [click](https://evil.example) **bold**", "bidi controls gone, markup kept as text");
  assert.equal(action.description.includes("⁦"), false);
  assert.equal(action.request, "POST /repos/botiverse/antiproton/pulls (botiverse/antiproton)");
  const forms = metadata.presentation?.card?.forms;
  assert.ok(forms?.decision?.submitLabels, "the decision form names the choice on its button");
  assert.equal(metadata.presentation?.genericApprovalAllowed, false);
  const hold = await holdOf(item.operationId);
  assert.equal(hold!.status, "pending");
  assert.equal(JSON.stringify(hold!.item).includes("‮"), false);
});

test("the card names the agent by display name, without @; an agent without one by its handle", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const titleOf = async (item: Item) => {
    await hintFor(app.baseUrl, w, item);
    const [card] = await cardsOf(item.operationId);
    const metadata = card!.metadata as ActionCardMetadata;
    return { agentName: (metadata.action as AgentApproveCallAction).agentName, title: metadata.presentation?.title };
  };

  await getDb().update(agents).set({ displayName: "Scout Bot" }).where(eq(agents.id, w.agent.id));
  assert.deepEqual(await titleOf(fake.add(heldItem(w.agent.id, w.server.id))), { agentName: "Scout Bot", title: "Approve a call by Scout Bot" });

  await getDb().update(agents).set({ displayName: null }).where(eq(agents.id, w.agent.id));
  assert.deepEqual(await titleOf(fake.add(heldItem(w.agent.id, w.server.id))), { agentName: w.agent.name, title: `Approve a call by ${w.agent.name}` });
});

test("the owner gone: every human owner and admin gets a card; the owner back, only the owner decides", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, w.agentOwner.id)));
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const cards = await cardsOf(item.operationId);
  assert.deepEqual(cards.map((card) => card.userId).sort(), [w.serverOwner.id, w.admin.id].sort(), "owners and admins, never a member");
  for (const card of cards) assert.equal(((card.metadata as ActionCardMetadata).action as AgentApproveCallAction).decider, "server_admin");

  // The owner rejoins: the admin's card is no longer theirs to decide on.
  await getDb().insert(serverMembers).values({ serverId: w.server.id, userId: w.agentOwner.id, role: "member" });
  const adminCard = cards.find((card) => card.userId === w.admin.id)!;
  const refused = await decide(app.baseUrl, w, "admin", adminCard.messageId, "approve");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.errorCode, "NOT_APPROVER");
  assert.equal(decides(fake.calls).length, 0, "antiproton never asked");

  // The owner leaves again and the admin is demoted: still refused, checked at the click.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, w.agentOwner.id)));
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, w.admin.id)));
  assert.equal((await decide(app.baseUrl, w, "admin", adminCard.messageId, "approve")).body.errorCode, "NOT_APPROVER");

  // The server owner decides; every card shows it, by role.
  const ownerCard = cards.find((card) => card.userId === w.serverOwner.id)!;
  const decided = await decide(app.baseUrl, w, "serverOwner", ownerCard.messageId, "deny");
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.deepEqual(decides(fake.calls).map((call) => call.body), [{ decision: "deny", decidedBy: { raftUserId: w.serverOwner.id, role: "server_owner" } }]);
  for (const card of await cardsOf(item.operationId)) {
    assert.equal(card.state, "executed");
    assert.deepEqual({ ...resultOf(card), decidedAt: null }, { kind: "agent-call-approval", status: "denied", decidedBy: { via: "raft", role: "server_owner" }, decidedAt: null, outcome: null });
    assert.equal(card.executedByUserId, card.userId === w.serverOwner.id ? w.serverOwner.id : null, "only the card decided on names who decided");
  }
});

test("the owner approves: antiproton gets the owner's id and role; the card shows approved, then the run's outcome", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const [card] = await cardsOf(item.operationId);
  const res = await decide(app.baseUrl, w, "agentOwner", card!.messageId, "approve");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(decides(fake.calls)[0]!.body, { decision: "approve", decidedBy: { raftUserId: w.agentOwner.id, role: "agent_owner" } });
  assert.equal(decides(fake.calls)[0]!.query.get("raftServerId"), w.server.id);
  let [after] = await cardsOf(item.operationId);
  assert.equal(after!.executedByUserId, w.agentOwner.id);
  assert.equal(resultOf(after!)?.status, "approved");

  fake.update(item.operationId, { status: "executed", outcome: { summary: "{\"number\":1234}‮", truncated: false, redactions: 0, withheld: false } });
  await hintFor(app.baseUrl, w, item, "approval.executed");
  [after] = await cardsOf(item.operationId);
  assert.equal(resultOf(after!)?.status, "executed");
  assert.deepEqual(resultOf(after!)?.outcome, { summary: "{\"number\":1234}", truncated: false, withheld: false });
  assert.equal(after!.executedByUserId, w.agentOwner.id, "who decided stays");
  assert.ok((after!.metadata as ActionCardMetadata).presentation?.card?.result, "the card shows its result");

  // A late report of an earlier state never moves it back.
  fake.update(item.operationId, { status: "pending", outcome: null });
  await hintFor(app.baseUrl, w, item);
  assert.equal((await holdOf(item.operationId))!.status, "executed");
  [after] = await cardsOf(item.operationId);
  assert.equal(resultOf(after!)?.status, "executed");

  // Raft does not tell the agent (no result reply in the card's thread): antiproton does, naming the decider by role only.
  const replies = await getDb().select({ content: messages.content }).from(messages).where(eq(messages.messageType, "system"));
  assert.equal(replies.some((reply) => reply.content.includes(card!.messageId.slice(0, 8))), false);
  assert.equal(JSON.stringify(w.deliveries).includes(card!.messageId.slice(0, 8)), false);
});

test("two-step verification on: Approve needs a sign-in that passed it (nothing reaches antiproton before); Deny never does", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const toDeny = fake.add(heldItem(w.agent.id, w.server.id));
  const toApprove = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, toDeny);
  await hintFor(app.baseUrl, w, toApprove);
  // The agent's owner's sign-in (made before) is unverified once two-step verification is on.
  const { backupCodes } = await enrollSecondFactor(w.agentOwner.id);

  const [denyCard] = await cardsOf(toDeny.operationId);
  const denied = await decide(app.baseUrl, w, "agentOwner", denyCard!.messageId, "deny");
  assert.equal(denied.status, 200, JSON.stringify(denied.body));
  assert.deepEqual(decides(fake.calls).map((call) => (call.body as { decision: string }).decision), ["deny"]);

  const [approveCard] = await cardsOf(toApprove.operationId);
  const refused = await decide(app.baseUrl, w, "agentOwner", approveCard!.messageId, "approve");
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.deepEqual(refused.body, {
    error: "Confirm it's you with your second step before approving this call.",
    code: "second_factor_step_up_required",
    methods: ["totp", "backup_code"],
  });
  assert.equal(decides(fake.calls).length, 1, "nothing reached antiproton");
  assert.equal((await cardsOf(toApprove.operationId))[0]!.state, "prepared");
  assert.equal((await holdOf(toApprove.operationId))!.status, "pending");

  const stepUp = await fetch(`${app.baseUrl}/api/auth/second-factor/step-up`, {
    method: "POST",
    headers: { Authorization: `Bearer ${w.tokens.agentOwner}`, "Content-Type": "application/json" },
    body: JSON.stringify({ backupCode: backupCodes[0] }),
  });
  assert.equal(stepUp.status, 200, await stepUp.text());
  const approved = await decide(app.baseUrl, w, "agentOwner", approveCard!.messageId, "approve");
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.deepEqual(decides(fake.calls).map((call) => (call.body as { decision: string }).decision), ["deny", "approve"]);
});

test("a timeout or 5xx is retried with the same decision; three failures leave the card to try again", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const [card] = await cardsOf(item.operationId);
  const unavailable = () => Response.json({ error: { code: "unavailable" } }, { status: 503 });
  fake.decideScript.push(unavailable, unavailable, unavailable);
  const failed = await decide(app.baseUrl, w, "agentOwner", card!.messageId, "approve");
  assert.equal(failed.status, 503);
  assert.equal(failed.body.errorCode, "APPROVAL_PROVIDER_UNAVAILABLE");
  assert.equal(decides(fake.calls).length, 3);
  assert.equal((await cardsOf(item.operationId))[0]!.state, "prepared", "nothing recorded: the person tries again");

  fake.decideScript.push(unavailable, unavailable);
  const ok = await decide(app.baseUrl, w, "agentOwner", card!.messageId, "approve");
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const calls = decides(fake.calls);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((call) => JSON.stringify(call.body) === JSON.stringify(calls[0]!.body)), "the same decision every time");
});

test("decided elsewhere, expired, gone, someone else's replay: refused, and every card shows how it ended", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const holds = Array.from({ length: 5 }, () => fake.add(heldItem(w.agent.id, w.server.id)));
  for (const item of holds) await hintFor(app.baseUrl, w, item);
  const cardOf = async (item: Item) => (await cardsOf(item.operationId))[0]!;

  // Approved on the antiproton console, before the owner clicks Deny.
  const [console_, expired, gone, replayOther, replayOwn] = holds as [Item, Item, Item, Item, Item];
  fake.update(console_.operationId, { status: "approved", decidedBy: { via: "console", approver: "ops@antiproton" }, decidedAt: new Date().toISOString() });
  let res = await decide(app.baseUrl, w, "agentOwner", (await cardOf(console_)).messageId, "deny");
  assert.deepEqual([res.status, res.body.errorCode, res.body.error], [409, "ALREADY_EXECUTED", "Already decided by the antiproton console."]);
  assert.equal(res.body.metadata?.state, "executed", "the refreshed card, which the web applies");
  let card = await cardOf(console_);
  assert.deepEqual([card.state, resultOf(card)?.status, resultOf(card)?.decidedBy], ["executed", "approved", { via: "console" }]);
  assert.equal(JSON.stringify(card.metadata).includes("ops@antiproton"), false, "the console sign-in is not kept");
  // A click on the card once it shows the end: the same sentence, before antiproton is asked.
  const before = decides(fake.calls).length;
  res = await decide(app.baseUrl, w, "agentOwner", card.messageId, "approve");
  assert.deepEqual([res.status, res.body.errorCode, res.body.error], [409, "ALREADY_EXECUTED", "Already decided by the antiproton console."]);
  assert.equal(decides(fake.calls).length, before);

  fake.decideScript.push((_body, item) => {
    Object.assign(item!, { status: "expired", decidedBy: { via: "expiry" }, decidedAt: new Date().toISOString() });
    return Response.json({ error: { code: "approval_expired", status: "expired" }, approval: item }, { status: 409 });
  });
  res = await decide(app.baseUrl, w, "agentOwner", (await cardOf(expired)).messageId, "approve");
  assert.deepEqual([res.status, res.body.errorCode, res.body.error], [409, "ALREADY_EXECUTED", "Nobody decided this call in time; it expired and nothing was run."]);
  card = await cardOf(expired);
  assert.deepEqual([card.state, resultOf(card)?.status], ["executed", "expired"]);

  fake.holds.delete(gone.operationId);
  res = await decide(app.baseUrl, w, "agentOwner", (await cardOf(gone)).messageId, "approve");
  assert.deepEqual([res.status, res.body.errorCode, res.body.error], [409, "ALREADY_EXECUTED", "antiproton no longer has this call; nothing will run."]);
  card = await cardOf(gone);
  assert.deepEqual([card.state, resultOf(card)?.status], ["executed", "unavailable"]);

  // Same decision already recorded, by someone else: theirs, not this person's.
  fake.update(replayOther.operationId, { status: "approved", decidedBy: { via: "raft", raftUserId: w.serverOwner.id, role: "server_owner" }, decidedAt: new Date().toISOString() });
  res = await decide(app.baseUrl, w, "agentOwner", (await cardOf(replayOther)).messageId, "approve");
  assert.deepEqual([res.status, res.body.errorCode, res.body.error], [409, "ALREADY_EXECUTED", "Already decided by a server owner."]);
  card = await cardOf(replayOther);
  assert.deepEqual([card.state, resultOf(card)?.decidedBy, card.executedByUserId], ["executed", { via: "raft", role: "server_owner" }, null]);

  // The owner's own earlier decision (the first answer was lost): a replay, and it counts.
  fake.decideScript.push((body, item) => {
    Object.assign(item!, { status: "approved", decidedBy: { via: "raft", ...body.decidedBy }, decidedAt: new Date().toISOString() });
    return new Response("upstream timeout", { status: 504 });
  });
  res = await decide(app.baseUrl, w, "agentOwner", (await cardOf(replayOwn)).messageId, "approve");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  card = await cardOf(replayOwn);
  assert.deepEqual([card.state, resultOf(card)?.status, card.executedByUserId], ["executed", "approved", w.agentOwner.id]);
});

test("the reconcile reads every page from just before the watermark and keeps the largest updatedAt; one replica at a time", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton({ pageSize: 2 });
  const items = Array.from({ length: 3 }, () => fake.add(heldItem(w.agent.id, w.server.id)));
  // A hold of an agent this deployment does not have: read, and left alone.
  fake.add(heldItem(randomUUID(), w.server.id));
  const first = await reconcileApprovals({ target: "default", io: null });
  assert.deepEqual(first, { pages: 2, rows: 4, failed: 0 });
  const lists = () => fake.calls.filter((call) => call.path === "/provision/approvals");
  assert.equal(lists()[0]!.query.get("updatedSince"), null, "the first run reads it all");
  assert.equal(lists()[1]!.query.get("cursor"), "2");
  for (const item of items) assert.equal((await cardsOf(item.operationId)).length, 1);
  const [sync] = await getDb().select().from(agentRuntimeApprovalSync).where(eq(agentRuntimeApprovalSync.providerTarget, "default"));
  assert.equal(sync!.watermark?.toISOString(), fake.lastUpdatedAt);
  assert.equal(sync!.leaseUntil, null);

  fake.update(items[0]!.operationId, { status: "denied", decidedBy: { via: "console", approver: "x" }, decidedAt: new Date().toISOString() });
  await reconcileApprovals({ target: "default", io: null });
  assert.equal(lists().at(-1)!.query.get("updatedSince"), new Date(sync!.watermark!.getTime() - RECONCILE_OVERLAP_MS).toISOString());
  assert.equal(resultOf((await cardsOf(items[0]!.operationId))[0]!)?.status, "denied");

  // Another replica holds the lease: this one does not run.
  await getDb().update(agentRuntimeApprovalSync).set({ leaseUntil: new Date(Date.now() + 60_000) });
  assert.equal(await reconcileApprovals({ target: "default", io: null }), null);
});

test("the reconcile pulls a pending hold past its deadline from its agent, and ends one antiproton no longer has", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  await getDb().update(agentRuntimeApprovals).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentRuntimeApprovals.operationId, item.operationId));
  fake.update(item.operationId, { expiresAt: new Date(Date.now() - 1000).toISOString() });
  fake.holds.delete(item.operationId);
  const before = fake.calls.length;
  await reconcileApprovals({ target: "default", io: null });
  await settleApprovalPullsForTest();
  assert.ok(fake.calls.slice(before).some((call) => call.path === `/provision/agents/by-raft-agent/${w.agent.id}/approvals`), "pulled from the agent");
  assert.equal((await holdOf(item.operationId))!.status, "unavailable");
  assert.equal(resultOf((await cardsOf(item.operationId))[0]!)?.status, "unavailable");
});

test("an agent never prepares an approval card", async ({ app }) => {
  const w = await seedWorld(app);
  const dm = await channelService.findOrCreateDM(w.server.id, w.agentOwner.id, w.agent.id);
  const action: AgentApproveCallAction = {
    type: "agent:approve_call", approvalId: randomUUID(), agentId: w.agent.id, agentName: w.agent.name, call: "gh.merge", plugin: null, heldBy: "agent",
    summary: "merge it", summaryTruncated: false, summaryWithheld: false, request: null, description: "", createdAt: new Date().toISOString(), expiresAt: null, decider: "owner",
  };
  await assert.rejects(
    prepareActionCard({ serverId: w.server.id, requesterAgentId: w.agent.id, targetChannelId: dm!.id, action: action as never, agentAuthored: true }),
    (err: unknown) => err instanceof ActionCardError && err.code === "INVALID_ACTION",
  );
  assert.equal((await getDb().select().from(actionCards).where(eq(actionCards.requesterAgentId, w.agent.id))).length, 0);
});

test("every decision attempt is audited with the decider's role and what came of it, never a token", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const [card] = await cardsOf(item.operationId);
  await decide(app.baseUrl, w, "member", card!.messageId, "approve");
  await decide(app.baseUrl, w, "agentOwner", card!.messageId, "approve");
  const rows = await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "agent_runtime.approval_decided"));
  const decided = rows.find((row) => row.outcome === "success");
  assert.ok(decided, JSON.stringify(rows));
  assert.equal(decided.actorId, w.agentOwner.id);
  assert.equal(decided.eventCategory, "runtime");
  assert.deepEqual(decided.metadata, { operationId: item.operationId, decision: "approve", role: "agent_owner", result: "decided", providerStatus: 200, attempts: 1 });
  assert.equal(JSON.stringify(rows).includes(TOKEN), false);
});

test("the card completes only through its form: a generic approve or a client's result is refused, and nothing reaches antiproton", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const [card] = await cardsOf(item.operationId);
  const post = (path: string, body: unknown) => fetch(`${app.baseUrl}/api/actions/${card!.messageId}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${w.tokens.agentOwner}`, "Content-Type": "application/json", "X-Server-Id": w.server.id },
    body: JSON.stringify(body),
  });
  for (const [path, body] of [
    ["execute", { expectedState: "prepared", expectedConfirmationVersion: 1 }],
    ["mark-executed", { result: { kind: "agent-call-approval", status: "approved", decidedBy: { via: "raft", role: "agent_owner" }, decidedAt: null, outcome: null } }],
  ] as const) {
    const res = await post(path, body);
    assert.equal(res.status, 422, path);
    assert.equal(((await res.json()) as { errorCode: string }).errorCode, "FORM_REQUIRED", path);
  }
  const noChoice = await post("execute", { expectedState: "prepared", expectedConfirmationVersion: 1, form: { id: "decision", values: {} } });
  assert.equal(noChoice.status, 422, "Approve or Deny must be chosen");
  assert.equal(decides(fake.calls).length, 0);
  assert.equal((await cardsOf(item.operationId))[0]!.state, "prepared");
});

// ---------------------------------------------------------------------------
// Review round 1 (Tenny's no-lock conditions and the should-fix findings).

const auditRows = async () => (await getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "agent_runtime.approval_decided")))
  .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

test("the decider keeps their card even when a hint lands while antiproton answers; their repeat is a same-form retry", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const [card] = await cardsOf(item.operationId);
  // antiproton records the decision and its hint is pulled (every card shows it, nobody named) before its answer arrives.
  fake.decideScript.push(async (body, held) => {
    Object.assign(held!, { status: "approved", decidedBy: { via: "raft", ...body.decidedBy }, decidedAt: new Date().toISOString() });
    await hintFor(app.baseUrl, w, item, "approval.decided");
    const [flipped] = await cardsOf(item.operationId);
    assert.deepEqual([flipped!.state, flipped!.executedByUserId], ["executed", null], "the race: the hint ended the card first");
    return Response.json({ approval: held, replay: false });
  });
  const res = await decide(app.baseUrl, w, "agentOwner", card!.messageId, "approve");
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [after] = await cardsOf(item.operationId);
  assert.equal(after!.state, "executed");
  assert.equal(after!.executedByUserId, w.agentOwner.id, "the card names who decided, whichever wrote it first");
  assert.deepEqual(after!.submittedInput, { form: "decision", values: { decision: "approve" } });
  assert.equal((after!.metadata as ActionCardMetadata).executedByUserId, w.agentOwner.id);
  assert.ok(after!.executedAt);
  const again = await decide(app.baseUrl, w, "agentOwner", card!.messageId, "approve");
  assert.equal(again.status, 200, "their own repeat: the same form, no ALREADY_EXECUTED");
  assert.equal(decides(fake.calls).length, 1, "and antiproton is not asked again");
});

test("a hint that ran the call before antiproton's answer arrives: the hold stays executed and the decider's card shows the run", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const [card] = await cardsOf(item.operationId);
  fake.decideScript.push((body, held) => {
    Object.assign(held!, { status: "approved", decidedBy: { via: "raft", ...body.decidedBy }, decidedAt: new Date().toISOString() });
    return Response.json({ approval: { ...held }, replay: false });
  });
  const res = await decide(app.baseUrl, w, "agentOwner", card!.messageId, "approve");
  assert.equal(res.status, 200);
  // Now antiproton runs it and its hint arrives; a stale "approved" answer replayed later must not move it back.
  fake.update(item.operationId, { status: "executed", outcome: { summary: "ok", truncated: false, redactions: 0, withheld: false } });
  await hintFor(app.baseUrl, w, item, "approval.executed");
  const hold = await holdOf(item.operationId);
  assert.equal(hold!.status, "executed");
  assert.deepEqual(hold!.decidedBy, { via: "raft", role: "agent_owner" }, "antiproton's decidedBy, without the Raft user id");
  const [after] = await cardsOf(item.operationId);
  assert.deepEqual([resultOf(after!)?.status, after!.executedByUserId], ["executed", w.agentOwner.id]);
});

test("Tenny 1+2: two Raft deciders race; the second is told who decided first, by role, and the local hold keeps the first decision", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, w.agentOwner.id)));
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const cards = await cardsOf(item.operationId);
  const ownerCard = cards.find((card) => card.userId === w.serverOwner.id)!;
  const adminCard = cards.find((card) => card.userId === w.admin.id)!;
  // Both reach antiproton: the first is recorded only once the second has arrived; the second gets antiproton's 409.
  let firstRecorded = false;
  const pause = () => new Promise((resolve) => setTimeout(resolve, 5));
  fake.decideScript.push(async (body, held) => {
    while (decides(fake.calls).length < 2) await pause();
    Object.assign(held!, { status: body.decision === "approve" ? "approved" : "denied", decidedBy: { via: "raft", ...body.decidedBy }, decidedAt: new Date().toISOString() });
    firstRecorded = true;
    return Response.json({ approval: { ...held }, replay: false });
  }, async (_body, held) => {
    while (!firstRecorded) await pause();
    return Response.json({ error: { code: "approval_already_decided", status: held!.status }, approval: { ...held } }, { status: 409 });
  });
  const [approve, deny] = await Promise.all([
    decide(app.baseUrl, w, "serverOwner", ownerCard.messageId, "approve"),
    decide(app.baseUrl, w, "admin", adminCard.messageId, "deny"),
  ]);
  assert.equal(decides(fake.calls).length, 2, "a real race: both asked antiproton");
  const winner = approve.status === 200 ? { res: approve, who: w.serverOwner, role: "server_owner", status: "approved", text: "a server owner" }
    : { res: deny, who: w.admin, role: "server_admin", status: "denied", text: "a server admin" };
  const loser = winner.res === approve ? deny : approve;
  assert.equal(winner.res.status, 200, JSON.stringify(winner.res.body));
  assert.deepEqual([loser.status, loser.body.errorCode, loser.body.error], [409, "ALREADY_EXECUTED", `Already decided by ${winner.text}.`]);
  assert.deepEqual(resultOf({ result: loser.body.metadata?.result })?.decidedBy, { via: "raft", role: winner.role }, "the loser's refreshed card shows the first decision");
  const hold = await holdOf(item.operationId);
  assert.deepEqual([hold!.status, hold!.decidedBy], [winner.status, { via: "raft", role: winner.role }], "never the second decision");
  for (const card of await cardsOf(item.operationId)) {
    assert.equal(resultOf(card)?.status, winner.status);
    assert.equal(card.executedByUserId, card.userId === winner.who.id ? winner.who.id : null);
    assert.ok(card.executedAt, "every ended card says when");
  }
  const rows = await auditRows();
  assert.deepEqual(rows.map((row) => (row.metadata as { result: string }).result).sort(), ["already_decided", "decided"]);
});

test("Tenny 3: the decider is re-checked in the request that decides, and the audit keeps that click-time answer", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, w.agentOwner.id)));
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const cards = await cardsOf(item.operationId);
  // The card went to the admin as an admin; by the click they are a member.
  await getDb().update(serverMembers).set({ role: "member" }).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, w.admin.id)));
  const refused = await decide(app.baseUrl, w, "admin", cards.find((card) => card.userId === w.admin.id)!.messageId, "approve");
  assert.deepEqual([refused.status, refused.body.errorCode], [403, "NOT_APPROVER"]);
  assert.equal(decides(fake.calls).length, 0);
  const ok = await decide(app.baseUrl, w, "serverOwner", cards.find((card) => card.userId === w.serverOwner.id)!.messageId, "approve");
  assert.equal(ok.status, 200);
  const [notApprover, decided] = await auditRows();
  assert.equal(notApprover!.actorId, w.admin.id);
  assert.equal(notApprover!.outcome, "failure");
  assert.equal(notApprover!.targetId, (await holdOf(item.operationId))!.id);
  assert.deepEqual(notApprover!.metadata, { operationId: item.operationId, decision: "approve", role: null, result: "not_approver", providerStatus: null, attempts: 0 });
  assert.deepEqual(decided!.metadata, { operationId: item.operationId, decision: "approve", role: "server_owner", result: "decided", providerStatus: 200, attempts: 1 });
});

test("deleting the agent ends its open holds as unavailable on every card; an agent deleted some other way is caught by the reconcile", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  await deleteAgent(w.agent.id);
  assert.equal((await holdOf(item.operationId))!.status, "unavailable");
  const [card] = await cardsOf(item.operationId);
  assert.deepEqual([card!.state, resultOf(card!)?.status], ["executed", "unavailable"]);
  const late = await decide(app.baseUrl, w, "agentOwner", card!.messageId, "approve");
  assert.ok(late.status >= 400 && late.status < 500, `nothing left to decide: ${late.status} ${JSON.stringify(late.body)}`);
  assert.equal(decides(fake.calls).length, 0);

  const other = await seedWorld(app);
  const second = fake.add(heldItem(other.agent.id, other.server.id));
  await hintFor(app.baseUrl, other, second);
  await getDb().update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, other.agent.id));
  await reconcileApprovals({ target: "default", io: null });
  assert.equal((await holdOf(second.operationId))!.status, "unavailable");
  assert.equal(resultOf((await cardsOf(second.operationId))[0]!)?.status, "unavailable");
});

test("unavailable is Raft's guess: only antiproton's not_found ends a hold, an entry Raft cannot read still counts as listed, and a later report supersedes it", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);

  fake.setAgentListStatus(404, "route_not_found");
  await hintFor(app.baseUrl, w, item);
  assert.equal((await holdOf(item.operationId))!.status, "pending", "a 404 that is not the agent's not_found changes nothing");

  fake.setAgentListStatus(200);
  fake.update(item.operationId, { status: "awaiting_magic" });
  await hintFor(app.baseUrl, w, item);
  assert.equal((await holdOf(item.operationId))!.status, "pending", "listed, even though Raft cannot parse it");

  fake.update(item.operationId, { status: "pending" });
  fake.setAgentListStatus(404);
  await hintFor(app.baseUrl, w, item);
  assert.equal((await holdOf(item.operationId))!.status, "unavailable", "antiproton's not_found for the agent");
  assert.equal((await cardsOf(item.operationId))[0]!.state, "executed");

  fake.setAgentListStatus(200);
  await hintFor(app.baseUrl, w, item);
  assert.equal((await holdOf(item.operationId))!.status, "pending", "antiproton says it is still pending: that wins");
  const [reopened] = await cardsOf(item.operationId);
  assert.deepEqual([reopened!.state, reopened!.result, reopened!.executedAt], ["prepared", null, null], "the card is open again");
  assert.equal((await cardsOf(item.operationId)).length, 1, "the same card, not a second one");

  fake.update(item.operationId, { status: "denied", decidedBy: { via: "console", approver: "ops" }, decidedAt: new Date().toISOString() });
  fake.setAgentListStatus(404);
  await hintFor(app.baseUrl, w, item);
  fake.setAgentListStatus(200);
  await hintFor(app.baseUrl, w, item);
  assert.equal((await holdOf(item.operationId))!.status, "denied", "a final state supersedes unavailable too");
});

test("a hint costs the open and changed holds, not every hold ever: unchanged ended holds are skipped", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const holds = Array.from({ length: 4 }, () => fake.add(heldItem(w.agent.id, w.server.id)));
  for (const item of holds) await hintFor(app.baseUrl, w, item);
  for (const item of holds.slice(0, 3)) fake.update(item.operationId, { status: "denied", decidedBy: { via: "expiry" }, decidedAt: new Date().toISOString() });
  await hintFor(app.baseUrl, w, holds[0]!);
  const applied: string[] = [];
  setApprovalFaultForTest((stage, operationId) => { if (stage === "apply") applied.push(operationId); return false; });
  fake.update(holds[3]!.operationId, { description: "changed" });
  await hintFor(app.baseUrl, w, holds[3]!);
  assert.deepEqual(applied, [holds[3]!.operationId], "only the changed hold is recorded again");
});

test("one failing row does not stop the reconcile; the watermark waits for it, then passes it once it is old", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const [first, broken, third] = Array.from({ length: 3 }, () => fake.add(heldItem(w.agent.id, w.server.id)));
  setApprovalFaultForTest((stage, operationId) => stage === "apply" && operationId === broken!.operationId);
  const run = await reconcileApprovals({ target: "default", io: null });
  assert.deepEqual(run, { pages: 1, rows: 3, failed: 1 });
  assert.equal((await cardsOf(first!.operationId)).length, 1);
  assert.equal((await cardsOf(third!.operationId)).length, 1, "the rows after it are applied");
  let [sync] = await getDb().select().from(agentRuntimeApprovalSync);
  assert.equal(sync!.watermark?.toISOString(), first!.updatedAt, "held before the failed row, so the next run retries it");
  assert.equal(sync!.lastErrorCode, "row_failed");

  setApprovalFaultForTest(null);
  await reconcileApprovals({ target: "default", io: null });
  assert.equal((await cardsOf(broken!.operationId)).length, 1, "retried and applied");
  [sync] = await getDb().select().from(agentRuntimeApprovalSync);
  assert.equal(sync!.watermark?.toISOString(), third!.updatedAt);

  // A row older than the grace that keeps failing no longer holds the watermark back.
  const old = fake.add(heldItem(w.agent.id, w.server.id));
  old.updatedAt = new Date(Date.now() - RECONCILE_FAILED_ROW_GRACE_MS - 60_000).toISOString();
  await getDb().update(agentRuntimeApprovalSync).set({ watermark: null });
  setApprovalFaultForTest((stage, operationId) => stage === "apply" && operationId === old.operationId);
  await reconcileApprovals({ target: "default", io: null });
  [sync] = await getDb().select().from(agentRuntimeApprovalSync);
  assert.equal(sync!.watermark?.toISOString(), third!.updatedAt, "passed with a log line");
});

test("the local pass goes on past a hold whose cards fail", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const [stuck, fine] = Array.from({ length: 2 }, () => fake.add(heldItem(w.agent.id, w.server.id)));
  for (const item of [stuck!, fine!]) await hintFor(app.baseUrl, w, item);
  // The owner leaves: the local pass gives each hold cards for the owners and admins.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, w.agentOwner.id)));
  setApprovalFaultForTest((stage, operationId) => stage === "sync" && operationId === stuck!.operationId);
  await reconcileApprovals({ target: "default", io: null });
  assert.deepEqual((await cardsOf(fine!.operationId)).map((card) => card.userId).sort(), [w.agentOwner.id, w.serverOwner.id, w.admin.id].sort());
  assert.equal((await cardsOf(stuck!.operationId)).length, 1);
});

test("an oversized hint is refused before anything is read; a decision on a hold Raft no longer has is audited", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const big = JSON.stringify({ type: "approval.requested", raftAgentId: w.agent.id, raftServerId: w.server.id, padding: "x".repeat(17 * 1024) });
  assert.equal((await sendHint(app.baseUrl, big)).status, 413);
  assert.equal(fake.calls.length, 0);

  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const [card] = await cardsOf(item.operationId);
  const holdId = (await holdOf(item.operationId))!.id;
  await getDb().delete(agentRuntimeApprovals).where(eq(agentRuntimeApprovals.id, holdId));
  const res = await decide(app.baseUrl, w, "agentOwner", card!.messageId, "approve");
  assert.deepEqual([res.status, res.body.errorCode], [409, "APPROVAL_UNAVAILABLE"]);
  const [row] = await auditRows();
  assert.deepEqual([row!.targetId, (row!.metadata as { result: string }).result], [holdId, "unavailable"]);
});

// ---------------------------------------------------------------------------
// Delivery reports (only Raft knows whether a card reached anyone) and the
// expiry audit.

const answer = (status: number, code?: string) => () => (code ? Response.json({ error: { code } }, { status }) : new Response("", { status }));
const reconcile = () => reconcileApprovals({ target: "default", io: null });
const endedAuditRows = () => getDb().select().from(integrationAuditEvents).where(eq(integrationAuditEvents.eventType, "agent_runtime.approval_ended"));

/** Nobody decides the agent's holds: its owner left, and the server has no owner or admin. */
async function nobodyDecides(w: World) {
  await getDb().delete(serverMembers).where(and(
    eq(serverMembers.serverId, w.server.id),
    inArray(serverMembers.userId, [w.agentOwner.id, w.serverOwner.id, w.admin.id]),
  ));
}

test("delivery: the first card is reported once, at first_card_at, naming nobody; another decider's card or a reposted one reports nothing", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  // The owner gone: the server owner and the admin each get a card, in one sync.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, w.agentOwner.id)));
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  const cards = await cardsOf(item.operationId);
  assert.equal(cards.length, 2);
  let hold = (await holdOf(item.operationId))!;
  assert.ok(hold.firstCardAt, "recorded with the first card");
  const firstCardAt = hold.firstCardAt.toISOString();
  const [sent, ...more] = reports(fake.calls);
  assert.equal(more.length, 0, "one report for the hold, not one per card");
  assert.equal(sent!.method, "POST");
  assert.equal(sent!.path, `/provision/agents/by-raft-agent/${w.agent.id}/approvals/${item.operationId}/delivery`);
  assert.equal(sent!.query.get("raftServerId"), w.server.id);
  assert.equal(sent!.authorization, `Bearer ${TOKEN}`, "with Raft's provider token, like a decision");
  assert.deepEqual(Object.keys(sent!.body as object).sort(), ["deliveredAt", "outcome"], "exactly these keys");
  assert.deepEqual(sent!.body, { outcome: "delivered", deliveredAt: firstCardAt });
  const raw = JSON.stringify(sent!.body);
  for (const id of [w.serverOwner.id, w.admin.id, w.agentOwner.id, hold.id, ...cards.map((card) => card.messageId)]) {
    assert.equal(raw.includes(id), false, "never who it went to, nor a card or message");
  }
  assert.deepEqual([hold.deliveryReportResult, hold.deliveryReportedAt !== null, hold.noRecipientAt], ["accepted", true, null]);

  // A new admin gets a card later, and the admin's card goes with its message and is posted again.
  const second = await seedUser("ap-second-admin");
  await getDb().insert(serverMembers).values({ serverId: w.server.id, userId: second.id, role: "admin" });
  const adminCard = cards.find((card) => card.userId === w.admin.id)!;
  await getDb().delete(agentRuntimeApprovalCards).where(eq(agentRuntimeApprovalCards.messageId, adminCard.messageId));
  await reconcile();
  const after = await cardsOf(item.operationId);
  assert.deepEqual(after.map((card) => card.userId).sort(), [w.serverOwner.id, w.admin.id, second.id].sort());
  assert.notEqual(after.find((card) => card.userId === w.admin.id)!.messageId, adminCard.messageId, "the admin's card was posted again");
  hold = (await holdOf(item.operationId))!;
  assert.equal(hold.firstCardAt?.toISOString(), firstCardAt, "first_card_at never changes");
  assert.equal(reports(fake.calls).length, 1, "nothing reported again");

  // Every decider leaves and every card goes: it was delivered, so no_recipient is never recorded or sent.
  await nobodyDecides(w);
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, second.id)));
  await getDb().delete(agentRuntimeApprovalCards).where(eq(agentRuntimeApprovalCards.approvalId, hold.id));
  await reconcile();
  assert.equal((await holdOf(item.operationId))!.noRecipientAt, null);
  assert.equal(reports(fake.calls).length, 1);
});

test("delivery: a 5xx or 401 waits for the reconcile, which resends it once and it is final; a 409 is final as not_pending and never resent", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const warn = vi.spyOn(console, "warn");
  const error = vi.spyOn(console, "error");
  const logged = (spy: typeof warn) => spy.mock.calls.filter((call) => String(call[0]).includes("delivery report"));

  const failing = fake.add(heldItem(w.agent.id, w.server.id));
  fake.deliveryScript.push(answer(503, "unavailable"));
  await hintFor(app.baseUrl, w, failing);
  assert.equal(reports(fake.calls).length, 1);
  assert.deepEqual([(await holdOf(failing.operationId))!.deliveryReportedAt, (await holdOf(failing.operationId))!.deliveryReportResult], [null, null], "owed still");

  const notPending = fake.add(heldItem(w.agent.id, w.server.id));
  fake.deliveryScript.push(answer(409, "approval_not_pending"));
  await hintFor(app.baseUrl, w, notPending);
  let hold = (await holdOf(notPending.operationId))!;
  assert.deepEqual([hold.deliveryReportResult, hold.deliveryReportedAt !== null], ["not_pending", true], "final");
  assert.deepEqual([logged(warn).length, logged(error).length], [0, 0], "a 409 is logged only, never a warning or an error");

  const unauthorized = fake.add(heldItem(w.agent.id, w.server.id));
  fake.deliveryScript.push(answer(401, "unauthorized"));
  await hintFor(app.baseUrl, w, unauthorized);
  assert.equal((await holdOf(unauthorized.operationId))!.deliveryReportedAt, null);
  assert.equal(logged(warn).length, 1, "a 401 is a configuration problem: warned");
  assert.equal(reports(fake.calls).length, 3);

  await reconcile();
  const resent = reports(fake.calls).slice(3);
  assert.deepEqual(resent.map((call) => call.path.split("/")[6]).sort(), [failing.operationId, unauthorized.operationId].sort(), "the owed ones, not the 409");
  const firstSent = reports(fake.calls)[0]!;
  assert.deepEqual(resent.find((call) => call.path.includes(failing.operationId))!.body, firstSent.body, "the same report again");
  for (const item of [failing, unauthorized]) {
    hold = (await holdOf(item.operationId))!;
    assert.deepEqual([hold.deliveryReportResult, hold.deliveryReportedAt !== null], ["accepted", true]);
  }
  await reconcile();
  assert.equal(reports(fake.calls).length, 5, "a final answer is never resent");
  assert.equal(logged(error).length, 0);
});

test("delivery: 404 approval_not_found is final; a bare 404 (no such route there yet) waits for the reconcile alone, within its window", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const gone = fake.add(heldItem(w.agent.id, w.server.id));
  fake.deliveryScript.push(answer(404, "approval_not_found"));
  await hintFor(app.baseUrl, w, gone);
  const goneHold = (await holdOf(gone.operationId))!;
  assert.deepEqual([goneHold.deliveryReportResult, goneHold.deliveryReportedAt !== null], ["not_found", true]);

  const noRoute = fake.add(heldItem(w.agent.id, w.server.id));
  fake.deliveryScript.push(answer(404, "not_found"));
  await hintFor(app.baseUrl, w, noRoute);
  const old = fake.add(heldItem(w.agent.id, w.server.id));
  fake.deliveryScript.push(answer(404));
  await hintFor(app.baseUrl, w, old);
  for (const item of [noRoute, old]) assert.equal((await holdOf(item.operationId))!.deliveryReportedAt, null, "owed: not antiproton's approval_not_found");
  // Past the window: no longer resent.
  await getDb().update(agentRuntimeApprovals).set({ createdAt: new Date(Date.now() - DELIVERY_RESEND_WINDOW_MS - 60_000) }).where(eq(agentRuntimeApprovals.operationId, old.operationId));
  assert.equal(reports(fake.calls).length, 3);

  // A hint that changes the hold brings its cards in line, but resends nothing: only the reconcile does.
  fake.update(noRoute.operationId, { description: "changed" });
  await hintFor(app.baseUrl, w, noRoute);
  assert.equal(reports(fake.calls).length, 3);

  await reconcile();
  assert.deepEqual(reports(fake.calls).slice(3).map((call) => call.path.split("/")[6]), [noRoute.operationId]);
  const resent = (await holdOf(noRoute.operationId))!;
  assert.deepEqual([resent.deliveryReportResult, resent.deliveryReportedAt !== null], ["accepted", true]);
  assert.equal((await holdOf(old.operationId))!.deliveryReportedAt, null);
});

test("delivery: one report that fails does not stop the reconcile's resend of the others", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  // The resend goes newest hold first: the newer one fails, the older one comes after it.
  const [fine, stuck] = Array.from({ length: 2 }, () => fake.add(heldItem(w.agent.id, w.server.id)));
  fake.deliveryScript.push(answer(503), answer(503));
  await hintFor(app.baseUrl, w, fine!);
  assert.equal(reports(fake.calls).length, 2);
  assert.ok((await holdOf(stuck!.operationId))!.createdAt > (await holdOf(fine!.operationId))!.createdAt);
  setApprovalFaultForTest((stage, operationId) => stage === "report" && operationId === stuck!.operationId);
  await reconcile();
  assert.equal((await holdOf(stuck!.operationId))!.deliveryReportedAt, null);
  assert.equal((await holdOf(fine!.operationId))!.deliveryReportResult, "accepted", "resent past the one that failed");
  setApprovalFaultForTest(null);
  await reconcile();
  assert.equal((await holdOf(stuck!.operationId))!.deliveryReportResult, "accepted");
});

test("delivery: nobody to send a card to is reported once as no_recipient; a later first card supersedes it; once delivered, never no_recipient", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  await nobodyDecides(w);
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, item);
  assert.equal((await cardsOf(item.operationId)).length, 0);
  let hold = (await holdOf(item.operationId))!;
  assert.ok(hold.noRecipientAt);
  assert.equal(hold.firstCardAt, null);
  const noRecipient = { outcome: "no_recipient", checkedAt: hold.noRecipientAt.toISOString() };
  assert.deepEqual(reports(fake.calls).map((call) => call.body), [noRecipient]);
  assert.deepEqual(Object.keys(reports(fake.calls)[0]!.body as object).sort(), ["checkedAt", "outcome"], "exactly these keys");
  assert.equal(hold.deliveryReportResult, "accepted");

  await reconcile();
  assert.equal(reports(fake.calls).length, 1, "nobody again: not recorded or reported again");

  // An admin joins: their card is the hold's first, and delivered is reported after no_recipient.
  await getDb().insert(serverMembers).values({ serverId: w.server.id, userId: w.admin.id, role: "admin" });
  await reconcile();
  const [card] = await cardsOf(item.operationId);
  assert.ok(card);
  hold = (await holdOf(item.operationId))!;
  assert.ok(hold.firstCardAt);
  assert.deepEqual(reports(fake.calls).map((call) => call.body), [noRecipient, { outcome: "delivered", deliveredAt: hold.firstCardAt.toISOString() }]);
  assert.deepEqual([hold.deliveryReportResult, hold.noRecipientAt?.toISOString()], ["accepted", noRecipient.checkedAt]);

  // The admin leaves and the card's message goes: nobody again, but the hold was delivered.
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, w.server.id), eq(serverMembers.userId, w.admin.id)));
  await getDb().delete(agentRuntimeApprovalCards).where(eq(agentRuntimeApprovalCards.messageId, card.messageId));
  await reconcile();
  assert.equal(reports(fake.calls).length, 2, "no_recipient is never sent once delivered");
  assert.equal((await holdOf(item.operationId))!.noRecipientAt?.toISOString(), noRecipient.checkedAt);
});

test("delivery: a no_recipient answer that arrives after the first card does not settle the delivered report", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  await nobodyDecides(w);
  const item = fake.add(heldItem(w.agent.id, w.server.id));
  // While antiproton answers the no_recipient report, an admin joins and gets the first card; its delivered report fails.
  fake.deliveryScript.push(async () => {
    await getDb().insert(serverMembers).values({ serverId: w.server.id, userId: w.admin.id, role: "admin" });
    await syncApprovalCards((await holdOf(item.operationId))!.id);
    return Response.json({ recorded: true });
  }, answer(503));
  await hintFor(app.baseUrl, w, item);
  assert.deepEqual(reports(fake.calls).map((call) => (call.body as { outcome: string }).outcome), ["no_recipient", "delivered"]);
  let hold = (await holdOf(item.operationId))!;
  assert.ok(hold.firstCardAt);
  assert.equal(hold.deliveryReportedAt, null, "delivered is still owed");
  await reconcile();
  assert.deepEqual(reports(fake.calls).at(-1)!.body, { outcome: "delivered", deliveredAt: hold.firstCardAt.toISOString() });
  hold = (await holdOf(item.operationId))!;
  assert.deepEqual([hold.deliveryReportResult, hold.deliveryReportedAt !== null], ["accepted", true]);
});

test("an expired hold is audited once, with whether any card of it was ever delivered", async ({ app }) => {
  const w = await seedWorld(app);
  const fake = fakeAntiproton();
  const expire = (item: Item) => fake.update(item.operationId, { status: "expired", decidedBy: { via: "expiry" }, decidedAt: new Date().toISOString() });

  // A card that reached the owner; its message is gone by the end, the delivery is not.
  const carded = fake.add(heldItem(w.agent.id, w.server.id));
  await hintFor(app.baseUrl, w, carded);
  const cardedHold = (await holdOf(carded.operationId))!;
  await getDb().delete(agentRuntimeApprovalCards).where(eq(agentRuntimeApprovalCards.approvalId, cardedHold.id));
  expire(carded);
  await hintFor(app.baseUrl, w, carded);

  // Never a card: an assistant whose owner left (its only DM is its owner's, so no admin can get one).
  const other = await seedWorld(app);
  await getDb().update(agents).set({ assistantOwnerUserId: other.agentOwner.id }).where(eq(agents.id, other.agent.id));
  await getDb().delete(serverMembers).where(and(eq(serverMembers.serverId, other.server.id), eq(serverMembers.userId, other.agentOwner.id)));
  const lonely = fake.add(heldItem(other.agent.id, other.server.id));
  await hintFor(app.baseUrl, other, lonely);
  const lonelyHold = (await holdOf(lonely.operationId))!;
  assert.equal((await cardsOf(lonely.operationId)).length, 0);
  assert.ok(lonelyHold.noRecipientAt, "no DM to open with any admin: nobody to send it to");
  expire(lonely);
  await hintFor(app.baseUrl, other, lonely);

  // Reported again, by a hint and the reconcile: still one row each.
  await hintFor(app.baseUrl, w, carded);
  await reconcile();
  const rows = await endedAuditRows();
  assert.equal(rows.length, 2, JSON.stringify(rows));
  const byHold = new Map(rows.map((row) => [row.targetId, row]));
  assert.deepEqual(byHold.get(cardedHold.id)!.metadata, { operationId: carded.operationId, status: "expired", delivered: true });
  assert.deepEqual(byHold.get(lonelyHold.id)!.metadata, { operationId: lonely.operationId, status: "expired", delivered: false });
  const row = byHold.get(cardedHold.id)!;
  assert.deepEqual([row.serverId, row.eventCategory, row.outcome, row.actorType, row.subjectId], [w.server.id, "runtime", "success", "system", w.agent.id]);
});
