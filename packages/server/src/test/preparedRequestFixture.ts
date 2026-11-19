// RFC 085 request:prepare test fixture: entries of the tests' own on the delegable list (the list is empty in
// production until the first templates; setDelegableCardRegistryForTest), the server flag, a world to prepare in,
// and helpers to prepare, decide and read cards. Used by routes/preparedRequestCards.api.test.ts and
// routes/preparedRequestCards.safety.api.test.ts.
//
// Entries: `channel:archive` over the real POST /api/channels/:id/archive (its own archiveChannels check, run as the
// person); `member:remove` over the real DELETE /api/servers/:id/members/:memberId (it writes its own audit row);
// `agent:stop` over POST /api/agents/:id/stop, whose runs a stand-in runner answers (setOwnerRouteDispatcherForTest)
// when a test needs a 5xx, no answer, a throw or a race.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  PREPARED_REQUEST_CARD_FEATURE_FLAG_KEY,
  preparedRequestFormId,
  type ActionCardMetadata,
  type PreparedRequestAction,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, channels, featureFlagRules, featureFlags, messages } from "../db/schema";
import * as channelService from "../services/channelService";
import * as serverService from "../services/serverService";
import { setOwnerRouteDispatcherForTest, type OwnerRouteDispatcher } from "../services/assistantOwnerActionCards";
import { setDelegableCardRegistryForTest } from "../services/delegableCardRegistry";
import type { DelegableCardRoute, DelegableRouteKey } from "../services/delegableCardRoutes";
import type { DelegableSummaryTemplate, DelegableViewer } from "../services/delegableSummaryTemplates";
import { setPreparedRequestHooksForTest, setPreparedRequestPerDayForTest } from "../services/preparedRequestCards";
import { createAgent } from "../services/agentService";
import { AGENT_CHANNEL_NOT_FOUND_REFUSAL } from "../routes/agentRouteRefusals";
import { post, seed, type Fixture, type Who } from "./actionCardFormFixture";

// ── The test list ────────────────────────────────────────────────────────────

export const NOT_FOUND = { ok: false as const, status: 404 as const, refusal: AGENT_CHANNEL_NOT_FOUND_REFUSAL };

export async function viewerSeesChannel(channelId: string, serverId: string, viewer: DelegableViewer): Promise<boolean> {
  if (viewer.kind === "agent") return channelService.canAgentAccessChannel(channelId, viewer.agentId);
  if (viewer.kind === "user") return channelService.canUserAccessChannel(channelId, viewer.userId, serverId as never);
  return true;
}

/** Archive a channel: its id and whether it is private are what the person approves. */
export const archiveTemplate: DelegableSummaryTemplate = {
  display: {
    title: "actionCard.field.channel",
    verb: "actionCard.assistantOwnerAction.form.confirm",
    fields: [{ label: "actionCard.field.channel", value: "channel" }],
  },
  async model(request, ctx) {
    const channel = await channelService.getChannel(request.params.id!);
    if (!channel || channel.serverId !== ctx.serverId || !await viewerSeesChannel(channel.id, ctx.serverId, ctx.viewer)) return NOT_FOUND;
    return { ok: true, model: { channel: { kind: "channel", id: channel.id }, visibility: { kind: "text", text: channel.type === "private" ? "private" : "public" } } };
  },
  async names(model, ctx) {
    const entry = model.channel;
    if (!entry || entry.kind !== "channel") return {};
    const channel = await channelService.getChannel(entry.id);
    if (!channel) return {};
    // Everyone in the conversation: the name of a public channel only.
    const shown = ctx.viewer.kind === "conversation" ? channel.type !== "private" : await viewerSeesChannel(channel.id, ctx.serverId, ctx.viewer);
    return shown ? { channels: { [channel.id]: channel.name } } : {};
  },
};

/** Stop an agent: the agent, and a reason the body carries (trimmed by the body schema: only its output is sent). */
export const stopTemplate: DelegableSummaryTemplate = {
  display: { title: "actionCard.title.migrateAgent", verb: "actionCard.assistantOwnerAction.form.confirm", fields: [{ label: "actionCard.field.agent", value: "agent" }] },
  async model(request) {
    return { ok: true, model: { agent: { kind: "agent", id: request.params.id! } } };
  },
  async names(model) {
    const entry = model.agent;
    return entry && entry.kind === "agent" ? { agents: { [entry.id]: `named-${entry.id.slice(0, 4)}` } } : {};
  },
};

/** Remove a member from the server: the member is what the person approves. */
export const removeTemplate: DelegableSummaryTemplate = {
  display: { title: "actionCard.field.agent", verb: "actionCard.assistantOwnerAction.form.confirm", fields: [] },
  async model(request) {
    return { ok: true, model: { member: { kind: "user", id: request.params.memberId! } } };
  },
  async names() {
    return {};
  },
};

export const TEST_ROUTES: Record<string, DelegableCardRoute> = {
  "DELETE /api/servers/:id/members/:memberId": {
    summaryTemplate: "test.member.remove",
    paramsSchema: z.strictObject({ id: z.uuid(), memberId: z.uuid() }),
    bodySchema: z.strictObject({}),
    permission: "removeMembers",
    operation: {
      name: "member:remove",
      argsSchema: z.strictObject({ member: z.string().min(1) }),
      async resolve(args, ctx) {
        const userId = await channelService.resolveUserByName(ctx.serverId, String(args.member).replace(/^@/, ""));
        if (!userId || !await serverService.isMember(ctx.serverId, userId)) return NOT_FOUND;
        return { ok: true, params: { id: ctx.serverId, memberId: userId }, body: {} };
      },
      doc: { summary: "Remove a member from the server.", args: { member: "their handle" }, confirmer: "a server owner or admin", example: { member: "@alice" } },
    },
  },
  "POST /api/channels/:id/archive": {
    summaryTemplate: "test.channel.archive",
    paramsSchema: z.strictObject({ id: z.uuid() }),
    bodySchema: z.strictObject({}),
    permission: "archiveChannels",
    operation: {
      name: "channel:archive",
      argsSchema: z.strictObject({ channel: z.string().min(1) }),
      async resolve(args, ctx) {
        const found = await channelService.resolveChannelByName(ctx.serverId, ctx.agentId, String(args.channel)).catch(() => null);
        if (!found || !await channelService.canAgentAccessChannel(found.channelId, ctx.agentId)) return NOT_FOUND;
        return { ok: true, params: { id: found.channelId }, body: {} };
      },
      doc: { summary: "Archive a channel.", args: { channel: "#name" }, confirmer: "a server owner or admin", example: { channel: "#ops" } },
    },
  },
  "POST /api/agents/:id/stop": {
    summaryTemplate: "test.agent.stop",
    paramsSchema: z.strictObject({ id: z.uuid() }),
    bodySchema: z.strictObject({ reason: z.string().trim().max(50) }),
    permission: "stopAgents",
    operation: {
      name: "agent:stop",
      argsSchema: z.strictObject({ agent: z.string().min(1), why: z.string().default("") }),
      async resolve(args, ctx) {
        const id = await channelService.resolveAgentByName(ctx.serverId, String(args.agent).replace(/^@/, ""), {});
        return id ? { ok: true, params: { id }, body: { reason: String(args.why) } } : NOT_FOUND;
      },
      doc: { summary: "Stop an agent.", args: { agent: "its handle", why: "a reason" }, confirmer: "a server owner or admin", example: { agent: "@builder" } },
    },
  },
};

export const TEST_TEMPLATES = { "test.channel.archive": archiveTemplate, "test.agent.stop": stopTemplate, "test.member.remove": removeTemplate };

/** The tests' list (`routes` replaces it, as a review or a deploy might). */
export function installList(routes: Record<string, DelegableCardRoute> = TEST_ROUTES) {
  setDelegableCardRegistryForTest({ routes: routes as Record<DelegableRouteKey, DelegableCardRoute>, templates: TEST_TEMPLATES });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Turns the flag off for every server again (its rules gone). */
export async function disableFlag() {
  await getDb().delete(featureFlagRules).where(eq(featureFlagRules.flagKey, PREPARED_REQUEST_CARD_FEATURE_FLAG_KEY));
}

/** Changes a stored card's action, on its row and its carrier alike (as a bug, or a hand in the database, might). */
export async function tamper(messageId: string, change: (action: PreparedRequestAction) => PreparedRequestAction) {
  const metadata = await stored(messageId);
  const action = change(metadata.action);
  await getDb().update(actionCards).set({ payload: action }).where(eq(actionCards.messageId, messageId));
  await getDb().update(messages).set({ actionMetadata: { ...metadata, action } }).where(eq(messages.id, messageId));
}

export async function enableFlag(serverId: string) {
  await getDb().insert(featureFlags)
    .values({ key: PREPARED_REQUEST_CARD_FEATURE_FLAG_KEY, randomizationUnit: "server", salt: "test", defaultEnabled: false })
    .onConflictDoNothing();
  await getDb().insert(featureFlagRules).values({ id: randomUUID(), flagKey: PREPARED_REQUEST_CARD_FEATURE_FLAG_KEY, stage: "server", priority: 0, decision: "allow", values: [serverId] });
}

/** What the Agent API answers that these tests read (parsed JSON: a field the answer lacks reads as undefined). */
export interface AgentApiAnswer {
  messageId: string;
  metadata: ActionCardMetadata;
  existing?: boolean;
  alreadyWithdrawn?: boolean;
  /** A request card's echo (prepare) or its withdraw receipt. */
  preparedRequest: { summary: string; title?: string; for?: string; operation?: string; result?: string; outcome?: string };
  error: string;
  code: string;
  errorCode: string;
  suggestedNextAction: string;
  retryAfterSeconds?: number;
}

export async function agentApi(baseUrl: string, key: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}/internal/agent-api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : {}) as AgentApiAnswer };
}

export const prepare = (baseUrl: string, f: Fixture, action: Record<string, unknown>) =>
  agentApi(baseUrl, f.agentKey, "/prepare-action", { target: `#${f.channel.name}`, action: { type: "request:prepare", ...action } });

/** A world: the fixture, the flag on, the list installed, and a public channel to archive that the agent and the owner are in. */
export async function world(app: Parameters<typeof seed>[0], options: { flag?: boolean } = {}) {
  const f = await seed(app);
  if (options.flag !== false) await enableFlag(f.server.id);
  installList();
  const target = await channelService.createChannel(f.server.id, `ops-${randomUUID().slice(0, 6)}`);
  await channelService.addHuman(target.id, f.owner.id);
  await channelService.addHuman(target.id, f.alice.id);
  await channelService.addAgent(target.id, f.agent.id);
  const worker = await createAgent(f.server.id, `worker-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  return { ...f, target, worker };
}
export type World = Awaited<ReturnType<typeof world>>;

export async function prepareArchive(baseUrl: string, w: World, to: Who = "owner", note?: string) {
  const res = await prepare(baseUrl, w, { to: `@${w[to].name}`, operation: "channel:archive", args: { channel: `#${w.target.name}` }, ...(note ? { note } : {}) });
  assert.equal(res.status, 201, res.text);
  return res.body;
}

export async function prepareStop(baseUrl: string, w: World, to: Who = "owner", why = "  quiet please  ") {
  const res = await prepare(baseUrl, w, { to: `@${w[to].name}`, operation: "agent:stop", args: { agent: `@${w.worker.name}`, why } });
  assert.equal(res.status, 201, res.text);
  return res.body;
}

export async function stored(messageId: string): Promise<ActionCardMetadata & { action: PreparedRequestAction }> {
  const [row] = await getDb().select({ actionMetadata: messages.actionMetadata }).from(messages).where(eq(messages.id, messageId));
  return row!.actionMetadata as ActionCardMetadata & { action: PreparedRequestAction };
}

/** The person's form for the card as it is now (its id is the digest it shows). */
export async function decide(baseUrl: string, w: World, who: Who, messageId: string, decision: "confirm" | "decline", formId?: string) {
  const id = formId ?? preparedRequestFormId((await stored(messageId)).action.digest);
  return post(baseUrl, w, who, `${messageId}/execute`, { expectedState: "prepared", form: { id, values: { decision } } });
}

/** The card's replies to its agent, in its thread. */
export async function replies(w: World, messageId: string): Promise<string[]> {
  const [thread] = await getDb().select().from(channels).where(and(eq(channels.type, "thread"), eq(channels.parentMessageId, messageId)));
  if (!thread) return [];
  const rows = await getDb().select().from(messages).where(and(eq(messages.channelId, thread.id), eq(messages.systemSubtype, "action_card.result_reply")));
  return rows.map((row) => row.content).filter((content) => content.startsWith(`@${w.agent.name} `));
}

export async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

export function stubRunner(answer: (input: Parameters<OwnerRouteDispatcher>[0]) => Promise<Awaited<ReturnType<OwnerRouteDispatcher>>>) {
  const calls: Parameters<OwnerRouteDispatcher>[0][] = [];
  setOwnerRouteDispatcherForTest(async (input) => { calls.push(input); return answer(input); });
  return calls;
}

export function reset() {
  setOwnerRouteDispatcherForTest(null);
  setDelegableCardRegistryForTest(null);
  setPreparedRequestPerDayForTest(null);
  setPreparedRequestHooksForTest(null);
}

