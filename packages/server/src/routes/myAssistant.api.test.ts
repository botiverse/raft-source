// RFC 075 v4 "my assistant": GET/POST/PATCH/DELETE /api/servers/:id/assistant.
// Pins the gate (personal_assistant flag AND the antiproton hosted runtime),
// that POST creates a hosted agent linked to the caller with only its owner
// DM, one assistant per owner, that every assistant is Ottie (no rename),
// archive, and the assistant's `assistantOf` context block.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY, PRO_AGENT_SEAT_BLOCK_SIZE } from "@botiverse/raft-shared";
import { tokenForHuman } from "../test/integration/credentials";
import { createApiTest } from "../test/integration/apiTest";
import { seedBoundGuest } from "../test/guestFixture";
import { getDb } from "../db/index";
import { agentCredentials, agentRuntimeProvisions, agents, channelAgents, channels, featureFlagRules, featureFlags, inboxTargetMuteStates, messageMentions, servers, subscriptions, users } from "../db/schema";
import * as channelService from "../services/channelService";
import { createJoinLink, getInviteInfo } from "../services/inviteService";
import { buildServerInfoAgentSummaries } from "./internal";
import { mintAgentCredential } from "../services/agentCredentialService";
import { ASSISTANT_DEFAULT_INSTRUCTIONS, ASSISTANT_INSTRUCTIONS_VERSION, ASSISTANT_OWNER_NOTES_MAX_LENGTH } from "../services/assistantInstructions";
import { providerAgentInstructions, queueAssistantInstructionUpgrades } from "../services/agentRuntimeProvisionService";
import { createAgent } from "../services/agentService";
import { countAgents, getServerBillingUsage } from "../services/planService";
import { createFeatureFlag, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY } from "../services/featureFlagService";
import { addMember } from "../services/serverService";
import { __setAgentRuntimeProviderTransportForTests } from "../services/agentRuntimeProviderService";
import { createServer, headers, seedUser } from "./channels.api.fixtures";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });
const requireWeb = createRequire(new URL("../../../web/package.json", import.meta.url));
const { io: clientIo } = requireWeb("socket.io-client") as { io: (url: string, options: Record<string, unknown>) => any };

const ENV_KEYS = ["SLOCK_PROVIDER_CREDENTIAL_KEY", "SERVER_URL", "DEPLOYMENT_ENV", "ANTIPROTON_PROVISIONING_TOKEN"] as const;

/** The antiproton deployment is configured; the provider answers every call with success. */
async function withHostedRuntime<T>(run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SLOCK_PROVIDER_CREDENTIAL_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.SERVER_URL = "https://raft.example.test/";
  delete process.env.DEPLOYMENT_ENV;
  process.env.ANTIPROTON_PROVISIONING_TOKEN = "pt-fake-provider-token-0123456789abcdef";
  __setAgentRuntimeProviderTransportForTests({
    baseUrl: "https://antiproton.example.test",
    fetch: async (input, init) => init?.method === "POST" && String(input).endsWith("/provision/agents")
      ? Response.json({ providerAgentId: `raft_${(JSON.parse(String(init.body)) as { raftAgentId: string }).raftAgentId}`, status: "active", push: { registered: true } }, { status: 201 })
      : Response.json({}),
  });
  try {
    return await run();
  } finally {
    __setAgentRuntimeProviderTransportForTests(null);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
}

async function setPersonalAssistantFlag(enabled: boolean) {
  const [existing] = await getDb().select().from(featureFlags).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
  if (existing) {
    await getDb().update(featureFlags).set({ defaultEnabled: enabled }).where(eq(featureFlags.key, PERSONAL_ASSISTANT_FEATURE_FLAG_KEY));
    return;
  }
  await createFeatureFlag({ key: PERSONAL_ASSISTANT_FEATURE_FLAG_KEY, randomizationUnit: "server", enabled: true, defaultEnabled: enabled });
}

async function allowHostedRuntimeFor(serverId: string) {
  const [existing] = await getDb().select({ key: featureFlags.key }).from(featureFlags).where(eq(featureFlags.key, ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY));
  if (!existing) await createFeatureFlag({ key: ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY, randomizationUnit: "server", defaultEnabled: false });
  await getDb().insert(featureFlagRules).values({
    id: randomUUID(),
    flagKey: ANTIPROTON_HOSTED_RUNTIME_FEATURE_FLAG_KEY,
    stage: "server",
    priority: -100,
    decision: "allow",
    values: [serverId],
  });
}

async function seed() {
  const suffix = randomUUID().slice(0, 8);
  const owner = await seedUser(`my-assistant-owner-${suffix}@slock.test`, `owner-${suffix}`);
  const peer = await seedUser(`my-assistant-peer-${suffix}@slock.test`, `peer-${suffix}`);
  const server = await createServer("My Assistant", `my-assistant-${suffix}`, owner.id);
  await addMember(server.id, peer.id);
  return { owner, peer, server };
}

type Seed = Awaited<ReturnType<typeof seed>>;

async function call(baseUrl: string, s: Seed, method: string, body?: unknown, email = s.owner.email) {
  const token = await tokenForHuman(email);
  const res = await fetch(`${baseUrl}/api/servers/${s.server.id}/assistant`, {
    method,
    headers: headers(token, s.server.id),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() as Record<string, any> };
}

test("my assistant is hidden and refused until both the flag and the hosted runtime are on", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed();
    await setPersonalAssistantFlag(false);
    await allowHostedRuntimeFor(s.server.id);
    assert.deepEqual((await call(app.baseUrl, s, "GET")).body, { enabled: false, assistant: null });
    const flagOff = await call(app.baseUrl, s, "POST", { name: "Ada" });
    assert.equal(flagOff.status, 403);
    assert.equal(flagOff.body.code, "assistant_not_enabled");

    await setPersonalAssistantFlag(true);
    const other = await seed();
    // The flag alone is not enough: this server has no hosted runtime.
    assert.deepEqual((await call(app.baseUrl, other, "GET")).body, { enabled: false, assistant: null });
    assert.equal((await call(app.baseUrl, other, "POST", { name: "Ada" })).status, 403);
    assert.deepEqual((await call(app.baseUrl, s, "GET")).body, { enabled: true, assistant: null });
  });
});

test("a Guest has no personal assistant: GET answers as if the feature were off, and nothing can be created or changed", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed();
    await setPersonalAssistantFlag(true);
    await allowHostedRuntimeFor(s.server.id);
    const suffix = randomUUID().slice(0, 8);
    const guest = await seedUser(`my-assistant-guest-${suffix}@slock.test`, `guest-${suffix}`);
    await seedBoundGuest({ serverId: s.server.id, userId: guest.id });

    assert.deepEqual((await call(app.baseUrl, s, "GET", undefined, guest.email)).body, { enabled: false, assistant: null });
    for (const [method, body] of [["POST", { name: "Ada" }], ["PATCH", { instructions: "hi" }], ["DELETE", undefined]] as const) {
      const refused = await call(app.baseUrl, s, method, body, guest.email);
      assert.deepEqual([method, refused.status, refused.body.code], [method, 403, "assistant_not_enabled"]);
    }
    const guestAssistants = await getDb().select({ id: agents.id }).from(agents)
      .where(and(eq(agents.serverId, s.server.id), eq(agents.assistantOwnerUserId, guest.id)));
    assert.equal(guestAssistants.length, 0);

    // A member of the same Server still gets one.
    assert.equal((await call(app.baseUrl, s, "POST", {})).status, 201);
  });
});

test("POST creates one hosted assistant linked to the caller, in its owner DM only", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed();
    await setPersonalAssistantFlag(true);
    await allowHostedRuntimeFor(s.server.id);

    // Every assistant is Ottie: a name an older client still sends is ignored, not refused.
    const created = await call(app.baseUrl, s, "POST", { name: "  Ada  " });
    assert.equal(created.status, 201);
    assert.equal(created.body.enabled, true);
    const mine = created.body.assistant as { id: string; agentId: string; name: string; dmChannelId: string };
    assert.equal(mine.name, "Ottie");
    assert.equal(mine.id, mine.agentId);
    assert.ok(mine.dmChannelId);

    const [row] = await getDb().select().from(agents).where(eq(agents.id, mine.agentId));
    assert.equal(row.assistantOwnerUserId, s.owner.id);
    assert.equal(row.name, `${s.owner.name}-assistant`);
    assert.equal(row.displayName, "Ottie");
    assert.equal(row.avatarUrl, "pixel:ottie");
    const [provision] = await getDb().select().from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, mine.agentId));
    assert.equal(provision?.provider, "antiproton");
    // Only the scopes its route allowlist needs: no `mcp` or `server`.
    const credentials = await getDb().select({ scopes: agentCredentials.scopes }).from(agentCredentials).where(eq(agentCredentials.agentId, mine.agentId));
    assert.equal(credentials.length, 1);
    assert.deepEqual([...credentials[0].scopes].sort(), ["reactions", "read", "send"]);
    const memberships = await getDb().select({ channelId: channelAgents.channelId }).from(channelAgents).where(eq(channelAgents.agentId, mine.agentId));
    assert.deepEqual(memberships.map((m) => m.channelId), [mine.dmChannelId], "only the owner DM");
    // Its DM stays out of the owner's Activity, push kept (channels.assistantDmActivity.api.test.ts).
    const [dmRow] = await getDb().select().from(inboxTargetMuteStates).where(eq(inboxTargetMuteStates.sourceChannelId, mine.dmChannelId));
    assert.deepEqual(
      dmRow && { receiverId: dmRow.receiverId, activityMuted: dmRow.activityMuted, muteFromSeq: dmRow.muteFromSeq, pushMuted: dmRow.pushMuted },
      { receiverId: s.owner.id, activityMuted: true, muteFromSeq: 0, pushMuted: false },
    );

    assert.deepEqual((await call(app.baseUrl, s, "GET")).body, created.body);
    const again = await call(app.baseUrl, s, "POST", { name: "Bea" });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, "assistant_exists");
    assert.deepEqual(again.body.assistant, mine);

    // Another member gets their own, not the owner's.
    assert.deepEqual((await call(app.baseUrl, s, "GET", undefined, s.peer.email)).body, { enabled: true, assistant: null });
  });
});

test("the assistant's context carries its owner's id, handle, display name, time zone, language and DM target", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed();
    await setPersonalAssistantFlag(true);
    await allowHostedRuntimeFor(s.server.id);
    await getDb().update(users).set({ displayName: "Ada Owner", firstObservedTimezone: "Asia/Shanghai", firstObservedTimezoneAt: new Date(), lastObservedTimezone: "Asia/Shanghai", lastObservedTimezoneAt: new Date() }).where(eq(users.id, s.owner.id));
    const created = await call(app.baseUrl, s, "POST", { name: "Ada" });
    const agentId = created.body.assistant.agentId as string;
    const { apiKey } = await mintAgentCredential({ agentId, scopes: ["read"], name: "my-assistant-test", issuedVia: "computer", createdByUserId: null });

    const context = async () => {
      const res = await fetch(`${app.baseUrl}/internal/agent-api/context`, { headers: { Authorization: `Bearer ${apiKey}` } });
      assert.equal(res.status, 200);
      return (await res.json() as { agent: { assistantOf: unknown } }).agent.assistantOf;
    };
    const { ownerActions, ...of } = await context() as { ownerActions: Array<{ tool: string }> };
    assert.deepEqual(of, { userId: s.owner.id, name: s.owner.name, displayName: "Ada Owner", raftCheck: false, timezone: "Asia/Shanghai", language: null, dmTarget: `dm:@${s.owner.name}~human` });
    // What it may do as its owner (assistantOwnerActions.api.test.ts pins the rest).
    assert.deepEqual(ownerActions.map((action) => action.tool), ["mute_conversation", "set_notification_level", "move_conversation", "pin_conversation", "arrange_conversations", "move_agent", "save_message", "list_owner_channels", "get_owner_notification_settings", "get_owner_sidebar", "list_owner_agents", "list_owner_computers", "list_owner_saved_messages"]);
    // A stated preference wins over the observed browser zone.
    await getDb().update(users).set({ preferredTimezone: "Europe/Berlin" }).where(eq(users.id, s.owner.id));
    assert.equal((await context() as { timezone: string }).timezone, "Europe/Berlin");
    // The UI language is the fallback; the translation language wins once set.
    await getDb().update(users).set({ displayLanguage: "en" }).where(eq(users.id, s.owner.id));
    assert.equal((await context() as { language: string }).language, "en");
    await getDb().update(users).set({ preferredLanguage: "zh-CN" }).where(eq(users.id, s.owner.id));
    assert.equal((await context() as { language: string }).language, "zh-CN");
  });
});

test("PATCH refuses a rename (the name is fixed) and DELETE archives the caller's assistant", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed();
    await setPersonalAssistantFlag(true);
    await allowHostedRuntimeFor(s.server.id);
    assert.equal((await call(app.baseUrl, s, "PATCH", { name: "Bea" })).body.code, "assistant_not_found");
    assert.equal((await call(app.baseUrl, s, "DELETE")).body.code, "assistant_not_found");

    const created = await call(app.baseUrl, s, "POST", { name: "Ada" });
    const agentId = created.body.assistant.agentId as string;
    assert.equal(created.body.assistant.name, "Ottie");
    for (const body of [{ name: "" }, { name: "Bea" }, { name: "Ottie" }, { name: "Bea", readsDms: false }]) {
      const renamed = await call(app.baseUrl, s, "PATCH", body);
      assert.deepEqual([renamed.status, renamed.body.code], [400, "assistant_name_fixed"], JSON.stringify(body));
    }
    // Nothing changed, the other fields of a refused request included.
    const [unchanged] = await getDb().select({ displayName: agents.displayName, avatarUrl: agents.avatarUrl, readsDms: agents.assistantReadsDms }).from(agents).where(eq(agents.id, agentId));
    assert.deepEqual(unchanged, { displayName: "Ottie", avatarUrl: "pixel:ottie", readsDms: true });

    // RFC 077: the owner's own DM-reading switch, on by default.
    assert.equal(created.body.assistant.readsDms, true);
    assert.equal((await call(app.baseUrl, s, "PATCH", {})).body.code, "invalid_request");
    assert.equal((await call(app.baseUrl, s, "PATCH", { readsDms: "no" })).body.code, "invalid_reads_dms");
    const closed = await call(app.baseUrl, s, "PATCH", { readsDms: false });
    assert.equal(closed.status, 200);
    assert.deepEqual(closed.body.assistant, { ...created.body.assistant, readsDms: false });
    assert.equal((await call(app.baseUrl, s, "GET")).body.assistant.readsDms, false);
    // RFC 077: "send as me", on for a new assistant (task #8); the owner turns it off and on.
    assert.equal(created.body.assistant.sendAsOwner, true);
    assert.equal(closed.body.assistant.sendAsOwner, true);
    assert.equal((await call(app.baseUrl, s, "PATCH", { sendAsOwner: 1 })).body.code, "invalid_send_as_owner");
    assert.equal((await call(app.baseUrl, s, "PATCH", { sendAsOwner: false })).body.assistant.sendAsOwner, false);
    assert.equal((await call(app.baseUrl, s, "GET")).body.assistant.sendAsOwner, false);
    assert.equal((await call(app.baseUrl, s, "PATCH", { sendAsOwner: true })).body.assistant.sendAsOwner, true);

    const deleted = await call(app.baseUrl, s, "DELETE");
    assert.equal(deleted.status, 200);
    assert.deepEqual(deleted.body, { enabled: true, assistant: null });
    const live = await getDb().select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.deletedAt)));
    assert.equal(live.length, 0, "archived");
    assert.deepEqual((await call(app.baseUrl, s, "GET")).body, { enabled: true, assistant: null });

    // A fresh one can be created after the old one is gone.
    assert.equal((await call(app.baseUrl, s, "POST", { name: "Cy" })).status, 201);
  });
});

test("a plain member creates and deletes their own assistant, and cannot rename it", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed();
    await setPersonalAssistantFlag(true);
    await allowHostedRuntimeFor(s.server.id);
    const asPeer = (method: string, body?: unknown) => call(app.baseUrl, s, method, body, s.peer.email);

    const created = await asPeer("POST", { name: "Pip" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const [row] = await getDb().select().from(agents).where(eq(agents.id, created.body.assistant.agentId));
    assert.equal(row.assistantOwnerUserId, s.peer.id);
    assert.equal(created.body.assistant.name, "Ottie");
    assert.equal((await asPeer("PATCH", { name: "Pippa" })).body.code, "assistant_name_fixed");
    // The server owner has no assistant of their own here, and cannot reach the member's through this API.
    assert.deepEqual((await call(app.baseUrl, s, "GET")).body, { enabled: true, assistant: null });
    assert.equal((await asPeer("DELETE")).status, 200);
    assert.deepEqual((await asPeer("GET")).body, { enabled: true, assistant: null });
  });
});

test("the Ottie avatar is reserved for assistants: no other agent may take it; an ordinary rename still works", async ({ app }) => {
  const s = await seed();
  const token = await tokenForHuman(s.owner.email);
  const agentsCall = async (method: string, path: string, body: unknown) => {
    const res = await fetch(`${app.baseUrl}/api/agents${path}`, { method, headers: headers(token, s.server.id), body: JSON.stringify(body) })
      .catch((err: unknown) => { throw new Error(`${method} /api/agents${path} ${JSON.stringify(body)}: ${String(err)}`); });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const reserved = await agentsCall("POST", "", { name: `fan-${randomUUID().slice(0, 6)}`, external: true, avatarUrl: "pixel:ottie" });
  assert.deepEqual([reserved.status, reserved.body.code], [400, "avatar_reserved"]);

  const plain = await createAgent(s.server.id, `plain-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: s.owner.id });
  for (const avatarUrl of ["pixel:ottie", " pixel:ottie "]) {
    const taken = await agentsCall("PATCH", `/${plain.id}`, { avatarUrl });
    assert.deepEqual([taken.status, taken.body.code], [400, "avatar_reserved"], avatarUrl);
  }
  const renamed = await agentsCall("PATCH", `/${plain.id}`, { displayName: "Ottie Fan", avatarUrl: "pixel:fox" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  const [row] = await getDb().select({ displayName: agents.displayName, avatarUrl: agents.avatarUrl }).from(agents).where(eq(agents.id, plain.id));
  assert.deepEqual(row, { displayName: "Ottie Fan", avatarUrl: "pixel:fox" });
});

test("the Ottie migration renames assistants made before it and queues their runtime PATCH, once", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed();
    await setPersonalAssistantFlag(true);
    await allowHostedRuntimeFor(s.server.id);
    const agentId = (await call(app.baseUrl, s, "POST", {})).body.assistant.agentId as string;
    const plain = await createAgent(s.server.id, `plain-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: s.owner.id, displayName: "Ada", avatarUrl: "pixel:fox" });
    // An assistant as one was before: the name and avatar its owner picked.
    await getDb().update(agents).set({ displayName: "Ada", avatarUrl: "pixel:fox" }).where(eq(agents.id, agentId));
    await getDb().update(agentRuntimeProvisions).set({ state: "active", attemptCount: 3 }).where(eq(agentRuntimeProvisions.agentId, agentId));
    const revision = async () => (await getDb().select({ desired: agentRuntimeProvisions.desiredRevision, attempts: agentRuntimeProvisions.attemptCount }).from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agentId)))[0]!;
    const before = await revision();

    const drizzleDir = new URL("../../drizzle/", import.meta.url);
    const file = readdirSync(drizzleDir).find((name) => name.endsWith("_assistant_named_ottie.sql"));
    assert.ok(file, "fixture: the migration exists");
    const statements = readFileSync(new URL(file, drizzleDir), "utf8").split("--> statement-breakpoint");
    const migrate = () => getDb().transaction(async (tx) => {
      for (const statement of statements) await tx.execute(sql.raw(statement));
    });
    await migrate();
    const profile = async (id: string) => (await getDb().select({ displayName: agents.displayName, avatarUrl: agents.avatarUrl }).from(agents).where(eq(agents.id, id)))[0]!;
    assert.deepEqual(await profile(agentId), { displayName: "Ottie", avatarUrl: "pixel:ottie" });
    assert.deepEqual(await revision(), { desired: before.desired + 1, attempts: 0 }, "a due profile PATCH");
    assert.deepEqual(await profile(plain.id), { displayName: "Ada", avatarUrl: "pixel:fox" }, "any other agent keeps its own");
    await migrate();
    assert.deepEqual(await revision(), { desired: before.desired + 1, attempts: 0 }, "a second run queues nothing");
  });
});

test("an assistant takes no agent seat: a full server still creates one, and seat usage doesn't count it", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed();
    await setPersonalAssistantFlag(true);
    await allowHostedRuntimeFor(s.server.id);
    // The fixture pins servers to the unlimited `founder` plan; billing applies to `free` + a Pro subscription.
    await getDb().update(servers).set({ plan: "free" }).where(eq(servers.id, s.server.id));
    await getDb().insert(subscriptions).values({
      serverId: s.server.id,
      plan: "pro",
      provider: "stripe",
      stripeCustomerId: `cus_${randomUUID()}`,
      stripeSubscriptionId: `sub_${randomUUID()}`,
      stripeProPackItemId: `si_pro_${randomUUID()}`,
      status: "active",
      provisionedHumanSeats: 1,
      provisionedAgentSeats: PRO_AGENT_SEAT_BLOCK_SIZE,
      proPackQuantity: 1,
      trialFreePackQuantity: 1,
      firstPackTrialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      createdByUserId: s.owner.id,
      updatedByUserId: s.owner.id,
    });
    // Fill every agent seat.
    const fill = async () => {
      for (let i = 0; ; i += 1) {
        assert.ok(i < 100, "fixture: the seat limit was never reached");
        try {
          await createAgent(s.server.id, `filler-${i}-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: s.owner.id });
        } catch (err) {
          assert.match(String((err as Error).message), /limit reached/);
          return;
        }
      }
    };
    await fill();
    const usageBefore = await getServerBillingUsage(getDb(), s.server.id);

    const created = await call(app.baseUrl, s, "POST", { name: "Ada" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const peerCreated = await call(app.baseUrl, s, "POST", { name: "Bea" }, s.peer.email);
    assert.equal(peerCreated.status, 201, JSON.stringify(peerCreated.body));
    assert.deepEqual(await getServerBillingUsage(getDb(), s.server.id), usageBefore, "two assistants, no seat used");
    assert.equal(await countAgents(s.server.id), usageBefore.agents);
    // The server is still full for an ordinary agent.
    await assert.rejects(
      createAgent(s.server.id, `after-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: s.owner.id }),
      /limit reached/,
    );
  });
});

test("an assistant is its owner's, not a server member: no member list, count or #all audience shows it, its DM keeps it", async ({ app }) => {
  await withHostedRuntime(async () => {
    const s = await seed();
    await setPersonalAssistantFlag(true);
    await allowHostedRuntimeFor(s.server.id);
    const token = await tokenForHuman(s.owner.email);
    const get = async <T>(path: string): Promise<T> => {
      const res = await fetch(`${app.baseUrl}${path}`, { headers: headers(token, s.server.id) });
      assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
      return res.json() as Promise<T>;
    };
    // #all starts hidden; reveal it so its virtual audience is a member list.
    const [allChannel] = await getDb().update(channels).set({ type: "channel" })
      .where(and(eq(channels.serverId, s.server.id), eq(channels.name, "all"))).returning();
    assert.ok(allChannel);
    const plain = await createAgent(s.server.id, `plain-${randomUUID().slice(0, 6)}`, { runtime: "codex", creatorType: "user", creatorId: s.owner.id });
    const room = await channelService.createChannel(s.server.id, `room-${randomUUID().slice(0, 6)}`, undefined, "channel", { type: "user", id: s.owner.id });
    await channelService.addAgent(room.id, plain.id);
    const { token: joinToken } = await createJoinLink(s.server.id, s.owner.id);
    const inviteCountBefore = (await getInviteInfo(joinToken))?.agentCount;

    const created = await call(app.baseUrl, s, "POST", { name: "Ada" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mine = created.body.assistant as { agentId: string; dmChannelId: string };
    const [row] = await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, mine.agentId));
    const handle = row!.name;

    const allMembers = (await get<{ agents: Array<{ id: string }> }>(`/api/channels/${allChannel.id}/members`)).agents.map((a) => a.id);
    const forward = await get<{ targets: Array<{ type: string; id: string }> }>(`/api/messages/forward/targets/search?q=${encodeURIComponent(handle)}`);
    const audience = (await channelService.getChannelAgents(allChannel.id)).map((a) => a.id);
    const serverInfo = (await buildServerInfoAgentSummaries(s.server.id)).map((a) => a.name);
    for (const [label, ids] of Object.entries({ allMembers, audience })) {
      assert.ok(!ids.includes(mine.agentId), `${label} lists the assistant: ${JSON.stringify(ids)}`);
      assert.ok(ids.includes(plain.id), `${label} must keep the ordinary agent`);
    }
    // Not offered as an agent to start a conversation with; the owner's DM with it stays a target.
    assert.ok(!forward.targets.some((t) => t.type === "agent" && t.id === mine.agentId), JSON.stringify(forward));
    assert.ok(forward.targets.some((t) => t.type === "dm" && t.id === mine.agentId), JSON.stringify(forward));
    assert.ok(!serverInfo.includes(handle));
    assert.ok(serverInfo.includes(plain.name));
    assert.equal((await getInviteInfo(joinToken))?.agentCount, inviteCountBefore);

    // The directory keeps it (its messages resolve their sender) and marks it out of member lists.
    const directory = await get<Array<{ id: string; inMemberLists?: boolean }>>("/api/agents");
    assert.equal(directory.find((a) => a.id === mine.agentId)?.inMemberLists, false);
    assert.equal(directory.find((a) => a.id === plain.id)?.inMemberLists, undefined);
    assert.equal((await get<{ inMemberLists?: boolean }>(`/api/agents/${mine.agentId}`)).inMemberLists, false);

    // No mention candidate in a channel...
    const send = await fetch(`${app.baseUrl}/api/messages`, {
      method: "POST",
      headers: headers(token, s.server.id),
      body: JSON.stringify({ channelId: room.id, content: `@${handle} and @${plain.name} ping` }),
    });
    assert.equal(send.status, 200, await send.clone().text());
    const { id: mentionMessageId } = await send.json() as { id: string };
    const mentioned = await getDb().select({ targetId: messageMentions.targetId }).from(messageMentions)
      .where(eq(messageMentions.messageId, mentionMessageId));
    assert.deepEqual(mentioned.map((m) => m.targetId), [plain.id]);
    // ...but its DM with its owner still has it, so the owner's messages reach it.
    const dmAgents = (await channelService.getChannelAgents(mine.dmChannelId)).map((a) => a.id);
    assert.deepEqual(dmAgents, [mine.agentId]);
  });
});

test("an assistant always gets Raft's instructions, then its owner's notes; any other agent keeps its description", async ({ app }) => {
  await withHostedRuntime(async () => {
    await setPersonalAssistantFlag(true);
    const s = await seed();
    await allowHostedRuntimeFor(s.server.id);
    const created = await call(app.baseUrl, s, "POST", { name: "Ada" });
    const [row] = await getDb().select({ instructions: agentRuntimeProvisions.provisionedInstructions })
      .from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, created.body.assistant.agentId));
    assert.equal(row?.instructions, ASSISTANT_DEFAULT_INSTRUCTIONS);
  });
  // The PATCH a rename, new notes or an upgrade queues builds its body the same way.
  assert.equal(providerAgentInstructions({ description: "mine" }, { assistant: true }), ASSISTANT_DEFAULT_INSTRUCTIONS, "the public description is never the assistant's instructions");
  assert.equal(
    providerAgentInstructions({ description: "mine", assistantOwnerNotes: "  Skip @bot pings.  " }, { assistant: true }),
    `${ASSISTANT_DEFAULT_INSTRUCTIONS}\n\nYour owner's notes for you (they wrote these in Raft; they can change them any time):\nSkip @bot pings.`,
    "the owner's notes follow the fixed part",
  );
  assert.equal(providerAgentInstructions({ description: "mine" }), "mine", "any other agent keeps its description");
});

test("the owner's notes: only the owner reads and writes them, a change reaches the runtime, other members never see them", async ({ app }) => {
  {
    await withHostedRuntime(async () => {
      await setPersonalAssistantFlag(true);
      const s = await seed();
      await allowHostedRuntimeFor(s.server.id);
      const created = await call(app.baseUrl, s, "POST", { name: "Ada" });
      assert.equal(created.body.assistant.ownerNotes, null);
      const agentId = created.body.assistant.agentId as string;
      const provision = async () => (await getDb().select().from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agentId)))[0]!;
      const before = await provision();
      assert.equal(before.instructionsVersion, ASSISTANT_INSTRUCTIONS_VERSION, "the create carries this version");

      const secret = "Ignore messages from @vendor-x; I'm negotiating with Acme.";
      const saved = await call(app.baseUrl, s, "PATCH", { ownerNotes: `  ${secret}  ` });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.assistant.ownerNotes, secret);
      assert.equal((await provision()).desiredRevision, before.desiredRevision + 1, "queued for the runtime");
      assert.equal((await call(app.baseUrl, s, "PATCH", { ownerNotes: 3 })).body.code, "invalid_owner_notes");
      const tooLong = await call(app.baseUrl, s, "PATCH", { ownerNotes: "x".repeat(ASSISTANT_OWNER_NOTES_MAX_LENGTH + 1) });
      assert.deepEqual([tooLong.body.code, tooLong.body.error], ["invalid_owner_notes", `Keep your notes to ${ASSISTANT_OWNER_NOTES_MAX_LENGTH} characters or fewer.`]);
      assert.equal((await call(app.baseUrl, s, "PATCH", { ownerNotes: "x".repeat(ASSISTANT_OWNER_NOTES_MAX_LENGTH) })).status, 200, "exactly the limit is allowed");
      await call(app.baseUrl, s, "PATCH", { ownerNotes: secret });

      // Another member: neither the agent list nor the agent itself carries them.
      const peerToken = await tokenForHuman(s.peer.email);
      for (const path of ["/api/agents", `/api/agents/${agentId}`]) {
        const res = await fetch(`${app.baseUrl}${path}`, { headers: headers(peerToken, s.server.id) });
        assert.equal((await res.text()).includes("vendor-x"), false, path);
      }
      // The peer's own my-assistant view is theirs (none), never the owner's.
      assert.equal((await call(app.baseUrl, s, "GET", undefined, s.peer.email)).body.assistant, null);

      // Clearing: empty text is no notes.
      assert.equal((await call(app.baseUrl, s, "PATCH", { ownerNotes: "   " })).body.assistant.ownerNotes, null);
    });
  }
});

test("an instructions upgrade reaches every live assistant once, without a script", async ({ app }) => {
  {
    await withHostedRuntime(async () => {
      await setPersonalAssistantFlag(true);
      const s = await seed();
      await allowHostedRuntimeFor(s.server.id);
      const agentId = (await call(app.baseUrl, s, "POST", { name: "Ada" })).body.assistant.agentId as string;
      const provision = async () => (await getDb().select().from(agentRuntimeProvisions).where(eq(agentRuntimeProvisions.agentId, agentId)))[0]!;
      const set = (values: Partial<typeof agentRuntimeProvisions.$inferInsert>) => getDb().update(agentRuntimeProvisions).set(values).where(eq(agentRuntimeProvisions.agentId, agentId));
      // Active, nothing pending, provider on an older version.
      await set({ state: "active", desiredRevision: 3, syncedRevision: 3, instructionsVersion: "2026-10-01.1", lastErrorCode: null });

      await queueAssistantInstructionUpgrades();
      assert.equal((await provision()).desiredRevision, 4, "queued");
      await queueAssistantInstructionUpgrades();
      assert.equal((await provision()).desiredRevision, 4, "not again while that PATCH is pending");

      // Current version: nothing to do. A refused PATCH (standing error): not resent every pass.
      await set({ desiredRevision: 4, syncedRevision: 4, instructionsVersion: ASSISTANT_INSTRUCTIONS_VERSION });
      await queueAssistantInstructionUpgrades();
      assert.equal((await provision()).desiredRevision, 4);
      await set({ instructionsVersion: null, lastErrorCode: "http_400" });
      await queueAssistantInstructionUpgrades();
      assert.equal((await provision()).desiredRevision, 4);
      // An agent that is no assistant is never queued.
      await set({ lastErrorCode: null });
      await getDb().update(agents).set({ assistantOwnerUserId: null }).where(eq(agents.id, agentId));
      await queueAssistantInstructionUpgrades();
      assert.equal((await provision()).desiredRevision, 4);
    });
  }
});

test("the assistant instructions name no clock time and no tool (the runtime states those)", () => {
  assert.doesNotMatch(ASSISTANT_DEFAULT_INSTRUCTIONS, /\d{1,2}:\d{2}/);
  assert.doesNotMatch(ASSISTANT_DEFAULT_INSTRUCTIONS, /\b(assistant_send_as_owner|messages_send|assistant_preferences|raft__)/);
  assert.ok(ASSISTANT_DEFAULT_INSTRUCTIONS.length <= 8_000, "fits the provider's instructions limit");
});

test("nobody but its owner finds a personal assistant: not a member, not a server owner or admin, by list, id, name or event", async ({ app }) => {
  await withHostedRuntime(async () => {
    await setPersonalAssistantFlag(true);
    const s = await seed();
    await allowHostedRuntimeFor(s.server.id);
    const suffix = randomUUID().slice(0, 8);
    const admin = await seedUser(`my-assistant-admin-${suffix}@slock.test`, `admin-${suffix}`);
    const member = await seedUser(`my-assistant-member-${suffix}@slock.test`, `member-${suffix}`);
    await addMember(s.server.id, admin.id, "admin");
    await addMember(s.server.id, member.id);
    const plain = await createAgent(s.server.id, `plain-${suffix}`, { runtime: "codex", creatorType: "user", creatorId: s.owner.id });

    // Every viewer's socket on this server, listening for directory events.
    const viewers = { owner: s.owner, admin, member, assistantOwner: s.peer };
    const sockets = await Promise.all(Object.entries(viewers).map(async ([label, user]) => {
      const socket = clientIo(app.baseUrl, { auth: { token: await tokenForHuman(user.email), serverId: s.server.id }, transports: ["websocket"], autoConnect: false });
      const created: string[] = [];
      socket.on("agent:created", (payload: { agent: { id: string } }) => created.push(payload.agent.id));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label}: no rooms:joined`)), 4_000);
        socket.once("rooms:joined", () => { clearTimeout(timer); resolve(); });
        socket.connect();
      });
      return { label, socket, created };
    }));
    try {
      // The peer (a plain member) creates theirs.
      const made = await call(app.baseUrl, s, "POST", { name: "Ada" }, s.peer.email);
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const assistantId = made.body.assistant.agentId as string;
      const [row] = await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, assistantId));
      const handle = row!.name;

      const ownerSide = sockets.find((entry) => entry.label === "assistantOwner")!;
      for (let i = 0; i < 40 && !ownerSide.created.includes(assistantId); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(ownerSide.created.includes(assistantId), "its owner hears agent:created");
      await new Promise((resolve) => setTimeout(resolve, 150));
      for (const entry of sockets.filter((e) => e.label !== "assistantOwner")) {
        assert.ok(!entry.created.includes(assistantId), `${entry.label} heard agent:created for another person's assistant`);
      }

      for (const [label, user] of Object.entries(viewers)) {
        const token = await tokenForHuman(user.email);
        const isOwner = label === "assistantOwner";
        const list = await fetch(`${app.baseUrl}/api/agents`, { headers: headers(token, s.server.id) });
        assert.equal(list.status, 200);
        const ids = (await list.json() as Array<{ id: string }>).map((a) => a.id);
        assert.equal(ids.includes(assistantId), isOwner, `${label}: GET /api/agents`);
        assert.ok(ids.includes(plain.id), `${label} keeps the ordinary agent`);
        const byId = await fetch(`${app.baseUrl}/api/agents/${assistantId}`, { headers: headers(token, s.server.id) });
        assert.equal(byId.status, isOwner ? 200 : 404, `${label}: GET /api/agents/:id`);
        assert.equal(await channelService.resolveAgentByName(s.server.id, handle, { userId: user.id }), isOwner ? assistantId : null, `${label}: by name`);
      }
      // The assistant finds itself; a finder with no identity finds none.
      assert.equal(await channelService.resolveAgentByName(s.server.id, handle, { agentId: assistantId }), assistantId);
      assert.equal(await channelService.resolveAgentByName(s.server.id, handle, {}), null);

      // Name collisions reveal nothing: an assistant-shaped handle is refused
      // the same way whether or not someone has that assistant.
      const ownerToken = await tokenForHuman(s.owner.email);
      const tryCreate = async (name: string) => {
        const res = await fetch(`${app.baseUrl}/api/agents`, { method: "POST", headers: headers(ownerToken, s.server.id), body: JSON.stringify({ name, runtime: "codex" }) });
        return { status: res.status, code: (await res.json() as { code?: string }).code };
      };
      const taken = await tryCreate(handle);
      const free = await tryCreate(`nobody-${suffix}-assistant`);
      assert.deepEqual(taken, { status: 400, code: "agent_name_reserved_for_assistants" });
      assert.deepEqual(free, taken, "an existing assistant's handle answers exactly as an unused one");
    } finally {
      for (const entry of sockets) entry.socket.disconnect();
    }
  });
});
