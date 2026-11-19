// RFC 085 PR3b: the first entries of the delegable list (services/delegableCardRoutes.ts) over their real routes, and
// what `raft action prepare --list` reads (GET /internal/agent-api/prepare-action/operations).
//
// Pins: agent:start and agent:stop prepare, confirm and run their real route as the person who confirms, through the
// route's own permission check (a member without stopAgents is refused by it, and the card stays open);
// channel:remove_admin lowers a channel admin to member only: any other role is refused at prepare (the args, the
// entry's body schema) and at commit (a stored card that says otherwise never runs); path params are ids at prepare
// and at commit; the list shows the entries only while request cards are on, and never a route the backstop refuses.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { preparedRequestAgentActionSchema } from "@botiverse/raft-shared";
import { createApiTest } from "../test/integration/apiTest";
import { getDb } from "../db/index";
import { agentOperatorEvents, channelHumans } from "../db/schema";
import * as channelService from "../services/channelService";
import { setDelegableCardRegistryForTest } from "../services/delegableCardRegistry";
import { DELEGABLE_CARD_ROUTES, type DelegableCardRoute, type DelegableRouteKey } from "../services/delegableCardRoutes";
import { DELEGABLE_SUMMARY_TEMPLATES } from "../services/delegableSummaryTemplates";
import { cardRow } from "../test/actionCardFormFixture";
import {
  decide, prepare, replies, reset, stored, stubRunner, tamper, waitFor, world, type World,
} from "../test/preparedRequestFixture";

const test = createApiTest();

type Body = Record<string, any>;

const START = "POST /api/agents/:id/start";
const STOP = "POST /api/agents/:id/stop";
const REMOVE_ADMIN = "PATCH /api/channels/:id/members/:targetType/:memberId/role";

/** The production list and templates, or the production list with entries of a test's own beside or instead of them. */
function useList(routes: Partial<Record<DelegableRouteKey, DelegableCardRoute>> = DELEGABLE_CARD_ROUTES) {
  setDelegableCardRegistryForTest({ routes: routes as Record<DelegableRouteKey, DelegableCardRoute>, templates: DELEGABLE_SUMMARY_TEMPLATES });
}

/**
 * The fixture's world on the production list: bob in the card's conversation and in the target channel too, alice a
 * channel admin of the target channel, and the orchestrator's stop recorded (the real stop route calls it).
 */
async function phase1(app: Parameters<typeof world>[0]) {
  const w = await world(app);
  useList();
  await channelService.addHuman(w.channel.id, w.bob.id);
  await channelService.addHuman(w.target.id, w.bob.id);
  await getDb().update(channelHumans).set({ role: "admin" }).where(and(eq(channelHumans.channelId, w.target.id), eq(channelHumans.userId, w.alice.id)));
  const stops: string[] = [];
  const orchestrator = app.app.get("agentOrchestrator") as Record<string, unknown>;
  orchestrator.stopAgent = async (agentId: string) => { stops.push(agentId); return { delivered: true }; };
  return { ...w, stops };
}

async function channelRole(w: World, userId: string): Promise<string | undefined> {
  const [row] = await getDb().select({ role: channelHumans.role }).from(channelHumans).where(and(eq(channelHumans.channelId, w.target.id), eq(channelHumans.userId, userId)));
  return row?.role;
}

const removeAdminArgs = (w: World, member: string) => ({ channel: `#${w.target.name}`, member });

async function listOperations(baseUrl: string, key: string) {
  const res = await fetch(`${baseUrl}/internal/agent-api/prepare-action/operations`, { headers: { Authorization: `Bearer ${key}` } });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Body };
}

// ── agent:start, agent:stop ──────────────────────────────────────────────────

test("agent:stop: prepared for the owner, confirmed, the real route stops the agent as the owner; the agent hears success", async ({ app }) => {
  const w = await phase1(app);
  try {
    const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` }, note: "It loops on the same task." });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.body.preparedRequest, {
      summary: `Stop @${w.worker.name} (Agent: @${w.worker.name})`, title: `Stop @${w.worker.name}`, for: `@${w.owner.name}`, operation: "agent:stop", result: "reply",
    });
    const action = (await stored(res.body.messageId)).action;
    assert.deepEqual([action.route, action.params, action.body, action.permission, action.template], [STOP, { id: w.worker.id }, {}, "stopAgents", "agent.stop"]);
    assert.deepEqual(action.summaryModel, { agent: { kind: "agent", id: w.worker.id } });

    const confirmed = await decide(app.baseUrl, w, "owner", res.body.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.deepEqual(w.stops, [w.worker.id], "the route ran");
    // The route's own record of who stopped it: the person who confirmed.
    const events = await getDb().select().from(agentOperatorEvents).where(eq(agentOperatorEvents.agentId, w.worker.id));
    assert.deepEqual(events.map((event) => [event.kind, event.actorUserId]), [["stop", w.owner.id]]);
    assert.equal((await cardRow(res.body.messageId)).executedByUserId, w.owner.id);
    const told = await waitFor(() => replies(w, res.body.messageId), (lines) => lines.length > 0);
    assert.match(told[0]!, /ended success\./);
  } finally {
    reset();
  }
});

test("agent:stop: a member without stopAgents confirms, the route itself refuses, nothing stops, and the card stays open", async ({ app }) => {
  const w = await phase1(app);
  try {
    const res = await prepare(app.baseUrl, w, { to: `@${w.alice.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(res.status, 201, res.text);
    // Only the named person decides: the owner, who could stop it, can't confirm alice's card.
    assert.equal((await decide(app.baseUrl, w, "owner", res.body.messageId, "confirm")).body.errorCode, "NOT_ADDRESSEE");
    const refused = await decide(app.baseUrl, w, "alice", res.body.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_refused");
    assert.equal((refused.body as Body).routeStatus, 403);
    assert.deepEqual(w.stops, [], "nothing stopped");
    const row = await cardRow(res.body.messageId);
    assert.equal(row.state, "prepared");
    assert.equal((await stored(res.body.messageId)).action.attempt, 2);
  } finally {
    reset();
  }
});

test("agent:start: the real route runs as the person (its own refusal comes back for an agent with no Computer), and the request is the agent's start with no body", async ({ app }) => {
  const w = await phase1(app);
  try {
    const res = await prepare(app.baseUrl, w, { to: `@${w.alice.name}`, operation: "agent:start", args: { agent: w.worker.name } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.body.preparedRequest.summary, `Start @${w.worker.name} (Agent: @${w.worker.name})`);
    assert.equal((res.body.preparedRequest as { title?: string }).title, `Start @${w.worker.name}`);
    // A member may run agents: past the route's permission check, its own next refusal is the person's.
    const refused = await decide(app.baseUrl, w, "alice", res.body.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.deepEqual([(refused.body as Body).routeStatus, (refused.body as Body).routeCode], [409, "machine_unassigned"]);

    const calls = stubRunner(async () => ({ status: 200, body: { ok: true } }));
    const confirmed = await decide(app.baseUrl, w, "alice", res.body.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.deepEqual(calls[0]!.request, { method: "POST", path: `/api/agents/${w.worker.id}/start`, body: {} });
    assert.equal(calls[0]!.ownerRequest.headers.authorization, `Bearer ${w.tokens.alice}`, "the person's own session");
  } finally {
    reset();
  }
});

test("agent:start and agent:stop: an agent the preparing agent can't find is the uniform refusal, and the args take no body", async ({ app }) => {
  const w = await phase1(app);
  try {
    const missing = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:start", args: { agent: "@no-such-agent" } });
    assert.equal(missing.status, 404, missing.text);
    assert.equal(missing.body.code, "user_not_found");
    const extra = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}`, envVars: "X=1" } });
    assert.equal(extra.status, 400, extra.text);
    assert.equal(extra.body.code, "invalid_args");
  } finally {
    reset();
  }
});

test("params are ids: a resolver that puts a word in an id's place is refused at prepare, and a stored one never runs", async ({ app }) => {
  const w = await phase1(app);
  const calls = stubRunner(async () => ({ status: 200, body: {} }));
  try {
    const stop = DELEGABLE_CARD_ROUTES[STOP];
    for (const id of ["me", "..", "not-a-uuid", `${w.worker.id}/x`]) {
      useList({ ...DELEGABLE_CARD_ROUTES, [STOP]: { ...stop, operation: { ...stop.operation, resolve: async () => ({ ok: true, params: { id }, body: {} }) } } });
      const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
      assert.equal(res.status, 400, `${id}: ${res.text}`);
      assert.equal(res.body.code, "invalid_args");
    }
    const removeAdmin = DELEGABLE_CARD_ROUTES[REMOVE_ADMIN];
    useList({ ...DELEGABLE_CARD_ROUTES, [REMOVE_ADMIN]: { ...removeAdmin, operation: { ...removeAdmin.operation, resolve: async () => ({ ok: true, params: { id: w.target.id, targetType: "user", memberId: "me" }, body: { role: "member" } }) } } });
    const word = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.alice.name}`) });
    assert.equal(word.status, 400, word.text);
    assert.equal(word.body.code, "invalid_args");

    useList();
    const card = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}` } });
    assert.equal(card.status, 201, card.text);
    await tamper(card.body.messageId, (action) => ({ ...action, params: { id: "me" } }));
    const refused = await decide(app.baseUrl, w, "owner", card.body.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_changed_unavailable");
    assert.equal(calls.length, 0, "nothing ran");
  } finally {
    reset();
  }
});

test("a template given a word in an id's place answers with the uniform refusal and never reads it (no 500, whatever a schema took)", async ({ app }) => {
  const w = await phase1(app);
  try {
    const ctx = { serverId: w.server.id as never, viewer: { kind: "user" as const, userId: w.owner.id } };
    for (const id of ["me", "..", "a"]) {
      const stop = await DELEGABLE_SUMMARY_TEMPLATES["agent.stop"]!.model({ params: { id }, body: {} }, ctx);
      assert.deepEqual([stop.ok, !stop.ok && stop.refusal.code], [false, "user_not_found"], id);
      const channel = await DELEGABLE_SUMMARY_TEMPLATES["channel.admin.remove"]!.model({ params: { id, targetType: "user", memberId: w.alice.id }, body: { role: "member" } }, ctx);
      assert.deepEqual([channel.ok, !channel.ok && channel.refusal.code], [false, "channel_not_found"], id);
      const member = await DELEGABLE_SUMMARY_TEMPLATES["channel.admin.remove"]!.model({ params: { id: w.target.id, targetType: "user", memberId: id }, body: { role: "member" } }, ctx);
      assert.deepEqual([member.ok, !member.ok && member.refusal.code], [false, "user_not_found"], id);
    }
  } finally {
    reset();
  }
});

// ── channel:remove_admin ────────────────────────────────────────────────────

test("channel:remove_admin: a channel admin lowered to member; confirmed, the real route runs as the owner", async ({ app }) => {
  const w = await phase1(app);
  try {
    const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.alice.name}`) });
    assert.equal(res.status, 201, res.text);
    assert.equal(
      res.body.preparedRequest.summary,
      `Remove channel admin from @${w.alice.name} in #${w.target.name} (Channel: #${w.target.name}; Member: @${w.alice.name})`,
    );
    const action = (await stored(res.body.messageId)).action;
    assert.deepEqual([action.route, action.params, action.body, action.permission], [REMOVE_ADMIN, { id: w.target.id, targetType: "user", memberId: w.alice.id }, { role: "member" }, "changeChannelMemberRoles"]);
    assert.deepEqual(action.summaryModel, { channel: { kind: "channel", id: w.target.id }, member: { kind: "user", id: w.alice.id }, role: { kind: "text", text: "member" } });

    const confirmed = await decide(app.baseUrl, w, "owner", res.body.messageId, "confirm");
    assert.equal(confirmed.status, 200, confirmed.text);
    assert.equal(await channelRole(w, w.alice.id), "member", "the route ran");
    assert.equal((await cardRow(res.body.messageId)).executedByUserId, w.owner.id);
  } finally {
    reset();
  }
});

test("channel:remove_admin: an agent member is named with ~agent when a person shares its handle", async ({ app }) => {
  const w = await phase1(app);
  try {
    const { channelAgents } = await import("../db/schema");
    await channelService.addAgent(w.target.id, w.worker.id);
    await getDb().update(channelAgents).set({ role: "admin" }).where(and(eq(channelAgents.channelId, w.target.id), eq(channelAgents.agentId, w.worker.id)));
    const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.worker.name}~agent`) });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual((await stored(res.body.messageId)).action.params, { id: w.target.id, targetType: "agent", memberId: w.worker.id });
    const asHuman = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.worker.name}~human`) });
    assert.equal(asHuman.status, 404, asHuman.text);
    assert.equal(asHuman.body.code, "user_not_found");
  } finally {
    reset();
  }
});

test("channel:remove_admin: any role but member is refused at prepare, by the args and by the entry's body schema", async ({ app }) => {
  const w = await phase1(app);
  try {
    for (const role of ["admin", "owner", "member"]) {
      const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: { ...removeAdminArgs(w, `@${w.bob.name}`), role } });
      assert.equal(res.status, 400, `${role}: ${res.text}`);
      assert.equal(res.body.code, "invalid_args", "the agent never names a role: the operation only lowers");
    }
    // A resolver that would send another role (a bug, or a later change): the entry's own body schema refuses it.
    const removeAdmin = DELEGABLE_CARD_ROUTES[REMOVE_ADMIN];
    for (const role of ["admin", "owner", "guest", "Member"]) {
      useList({ ...DELEGABLE_CARD_ROUTES, [REMOVE_ADMIN]: { ...removeAdmin, operation: { ...removeAdmin.operation, resolve: async () => ({ ok: true, params: { id: w.target.id, targetType: "user", memberId: w.bob.id }, body: { role } }) } } });
      const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.bob.name}`) });
      assert.equal(res.status, 400, `${role}: ${res.text}`);
      assert.equal(res.body.code, "invalid_args");
      assert.match(res.body.error, /body\.role/);
    }
    assert.equal(await channelRole(w, w.bob.id), "member");
  } finally {
    reset();
  }
});

test("channel:remove_admin: a stored card that would promote (role admin) is refused at commit and never runs", async ({ app }) => {
  const w = await phase1(app);
  const runs: unknown[] = [];
  try {
    const res = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.alice.name}`) });
    assert.equal(res.status, 201, res.text);
    // A hand in the database turns it into promoting bob.
    await tamper(res.body.messageId, (action) => ({ ...action, params: { ...action.params, memberId: w.bob.id }, body: { role: "admin" } }));
    stubRunner(async (input) => { runs.push(input); return { status: 200, body: {} }; });
    const refused = await decide(app.baseUrl, w, "owner", res.body.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body.errorCode, "request_changed_unavailable");
    assert.deepEqual(runs, [], "nothing ran");
    assert.equal(await channelRole(w, w.bob.id), "member");
    assert.equal(await channelRole(w, w.alice.id), "admin");
    assert.equal((await cardRow(res.body.messageId)).state, "expired", "the card ends changed_since_prepared");
  } finally {
    reset();
  }
});

test("channel:remove_admin: refused before a card for someone who isn't a channel admin, a server owner, or someone the agent can't see", async ({ app }) => {
  const w = await phase1(app);
  try {
    const plain = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.bob.name}`) });
    assert.equal(plain.status, 409, plain.text);
    assert.equal(plain.body.code, "not_channel_admin");
    const owner = await prepare(app.baseUrl, w, { to: `@${w.alice.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.owner.name}`) });
    assert.equal(owner.status, 409, owner.text);
    assert.equal(owner.body.code, "protected_server_role");
    // A private channel the agent isn't in reads as one that doesn't exist; a person not in the channel as nobody.
    const hidden = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: { channel: `#${w.hidden.name}`, member: `@${w.bob.name}` } });
    const missing = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: { channel: "#no-such-channel", member: `@${w.bob.name}` } });
    assert.deepEqual([hidden.status, hidden.body], [missing.status, missing.body]);
    assert.equal(hidden.body.code, "channel_not_found");
    const outsider = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.outsider.name}`) });
    const nobody = await prepare(app.baseUrl, w, { to: `@${w.owner.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, "@nobody-at-all") });
    assert.deepEqual([outsider.status, outsider.body], [nobody.status, nobody.body]);
    assert.equal(nobody.body.code, "user_not_found");
  } finally {
    reset();
  }
});

test("channel:remove_admin: a person who can't change channel roles confirms, the route refuses, and the admin stays an admin", async ({ app }) => {
  const w = await phase1(app);
  try {
    const res = await prepare(app.baseUrl, w, { to: `@${w.bob.name}`, operation: "channel:remove_admin", args: removeAdminArgs(w, `@${w.alice.name}`) });
    assert.equal(res.status, 201, res.text);
    const refused = await decide(app.baseUrl, w, "bob", res.body.messageId, "confirm");
    assert.equal(refused.status, 409, refused.text);
    assert.deepEqual([(refused.body as Body).routeStatus, (refused.body as Body).routeCode], [403, "channel_capability_required"]);
    assert.equal(await channelRole(w, w.alice.id), "admin");
    assert.equal((await cardRow(res.body.messageId)).state, "prepared");
  } finally {
    reset();
  }
});

// ── raft action prepare --list, and the Manual ───────────────────────────────

test("the Manual names every listed operation, and its request card example is one the list takes", () => {
  const manual = readFileSync(new URL("../../../../manual/agent-knowledge/action-cards.md", import.meta.url), "utf8");
  const section = manual.slice(manual.indexOf("**Ask a person to run an operation for you"), manual.indexOf("**Prepare an integration action card**"));
  for (const entry of Object.values(DELEGABLE_CARD_ROUTES)) assert.ok(section.includes(`\`${entry.operation.name}\``), entry.operation.name);
  const example = /raft action prepare --target "dm:@alice" <<'RAFTACTION'\n\s*(\{.*\})\n\s*RAFTACTION/.exec(section);
  assert.ok(example, "the heredoc form");
  const action = preparedRequestAgentActionSchema.parse(JSON.parse(example[1]!));
  const entry = Object.values(DELEGABLE_CARD_ROUTES).find((candidate) => candidate.operation.name === action.operation);
  assert.ok(entry, action.operation);
  assert.equal(entry.operation.argsSchema.safeParse(action.args).success, true);
});

test("the operations list: the production entries while request cards are on, from each entry's doc and its card copy", async ({ app }) => {
  const w = await phase1(app);
  try {
    const res = await listOperations(app.baseUrl, w.agentKey);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.enabled, true);
    assert.deepEqual(res.body.operations.map((op: Body) => op.operation), ["agent:start", "agent:stop", "channel:remove_admin"]);
    const [start, stop, removeAdmin] = res.body.operations as Body[];
    assert.deepEqual(stop!.personSees, { title: "Stop <agent>", button: "Stop agent" });
    assert.deepEqual(start!.args, [{ name: "agent", description: "the agent's handle, as `raft server info --agents` lists it", required: true }]);
    assert.deepEqual(removeAdmin!.personSees, { title: "Remove channel admin from <member> in <channel>", button: "Remove channel admin" });
    assert.deepEqual(removeAdmin!.args.map((arg: Body) => [arg.name, arg.required]), [["channel", true], ["member", true]]);
    assert.deepEqual(removeAdmin!.example, { channel: "#ops", member: "@alice" });
    assert.equal(typeof removeAdmin!.confirmer, "string");
  } finally {
    reset();
  }
});

test("the operations list: empty while request cards are off; never a route the runtime backstop refuses; optional args say so", async ({ app }) => {
  const w = await world(app, { flag: false });
  try {
    useList();
    const off = await listOperations(app.baseUrl, w.agentKey);
    assert.equal(off.status, 200, off.text);
    assert.deepEqual(off.body, { enabled: false, operations: [] });
  } finally {
    reset();
  }
  const on = await world(app);
  try {
    const stop = DELEGABLE_CARD_ROUTES[STOP];
    useList({
      [STOP]: { ...stop, operation: { ...stop.operation, argsSchema: z.strictObject({ agent: z.string(), why: z.string().optional() }), doc: { ...stop.operation.doc, args: { ...stop.operation.doc.args, why: "a reason" } } } },
      "POST /api/billing/checkout": { ...stop, paramsSchema: z.strictObject({}), operation: { ...stop.operation, name: "billing:checkout" } },
    } as Partial<Record<DelegableRouteKey, DelegableCardRoute>>);
    const res = await listOperations(app.baseUrl, on.agentKey);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body.operations.map((op: Body) => op.operation), ["agent:stop"]);
    assert.deepEqual(res.body.operations[0].args.map((arg: Body) => [arg.name, arg.required]), [["agent", true], ["why", false]]);
  } finally {
    reset();
  }
});
