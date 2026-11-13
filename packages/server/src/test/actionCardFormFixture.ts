// form.v1 (S2) test fixture: channel:create made a form card through
// setActionCardFormHandlerForTest, a server with people who may and may not
// be chosen, and execute helpers. Used by actionCards.formSubmit.api.test.ts
// (PGlite) and actionCardFormSubmit.realPg.test.ts (real PostgreSQL races).
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import {
  actionCardFormIssue,
  type ActionCardAction,
  type ActionCardFormIssue,
  type ActionCardFormValue,
  type ActionCardMetadata,
  type ActionCardSpecMsg,
} from "@botiverse/raft-shared";
import { getDb } from "../db/index";
import { actionCards, channels, serverMembers, users } from "../db/schema";
import { createServer } from "../services/serverService";
import { createAgent } from "../services/agentService";
import * as channelService from "../services/channelService";
import { mintAgentCredential } from "../services/agentCredentialService";
import { updateAgentScopes } from "../services/agentScopesService";
import { prepareActionCard } from "../services/actionCardsService";
import { setActionCardFormHandlerForTest, type ActionCardFormHandler } from "../services/actionCardForms";
import { fixturePasswordHash, tokenForHuman } from "./integration/credentials";

export const FORM = "create_channel";
/** Never in a result: it may only ever be in action_cards.submitted_input. */
export const SENTINEL = "note-sentinel-6f1d";

export const msg = (key: string, en: string): ActionCardSpecMsg => ({ key: `actionCard.test.${key}`, text: { en } });

export interface CreateInput { name: string; visibility: "public" | "private"; members: string[]; note?: string }

/**
 * channel:create as a form card: the agent's proposal prefills the form, the
 * person may change it. validate checks the pickers for THIS person; execute
 * creates the channel through execute's transaction.
 */
export function channelCreateFormHandler(options: { failAfterCreate?: boolean } = {}) {
  const calls = { validate: 0, execute: 0 };
  const handler: ActionCardFormHandler<"channel:create", CreateInput> = {
    buildForm(action, ctx) {
      return {
        [FORM]: {
          title: msg("form.title", "Create a channel"),
          submitLabel: msg("form.submit", "Create Channel"),
          fields: [
            { type: "TextInput", name: "name", label: msg("form.name", "Name"), required: true, maxLength: 80, default: action.name },
            {
              type: "Select", name: "visibility", label: msg("form.visibility", "Visibility"), required: true,
              options: [{ value: "public", label: msg("form.public", "Public") }, { value: "private", label: msg("form.private", "Private") }],
              default: action.visibility ?? "public",
            },
            { type: "TextArea", name: "note", label: msg("form.note", "Note"), maxLength: 40 },
            {
              type: "MemberPicker", name: "members", label: msg("form.members", "Members"), kinds: ["human"], scope: "server", multiple: true, maxItems: 3,
              default: (action.initialHumans ?? []).map((id) => ({ kind: "user" as const, id, fallback: ctx.names?.users?.[id] ?? id.slice(0, 8) })),
            },
            { type: "ChannelPicker", name: "copyFrom", label: msg("form.copyFrom", "Copy members from"), scope: "visible", multiple: false },
            { type: "Toggle", name: "announce", label: msg("form.announce", "Announce"), default: false },
          ],
        },
      };
    },
    async validate(values, ctx) {
      calls.validate += 1;
      const issues: ActionCardFormIssue[] = [];
      const issue = actionCardFormIssue;
      for (const id of (values.members as string[] | undefined) ?? []) {
        const [user] = await ctx.executor.select({ id: users.id }).from(users).where(eq(users.id, id));
        if (!user) { issues.push(issue("members", "not_found")); break; }
        const [member] = await ctx.executor.select({ userId: serverMembers.userId }).from(serverMembers)
          .where(and(eq(serverMembers.serverId, ctx.serverId), eq(serverMembers.userId, id)));
        if (!member) { issues.push(issue("members", "not_allowed")); break; }
      }
      for (const id of (values.copyFrom as string[] | undefined) ?? []) {
        const [channel] = await ctx.executor.select({ id: channels.id }).from(channels).where(and(eq(channels.id, id), eq(channels.serverId, ctx.serverId)));
        if (!channel) issues.push(issue("copyFrom", "not_found"));
        else if (!await channelService.canUserAccessChannel(id, ctx.userId, ctx.serverId, { executor: ctx.executor })) issues.push(issue("copyFrom", "not_allowed"));
      }
      if (issues.length > 0) return { issues };
      return {
        input: {
          name: values.name as string,
          visibility: values.visibility === "private" ? "private" : "public",
          members: (values.members as string[] | undefined) ?? [],
          ...(typeof values.note === "string" ? { note: values.note } : {}),
        },
      };
    },
    async execute(input, ctx) {
      calls.execute += 1;
      const channel = await channelService.createChannel(ctx.serverId, input.name, undefined, input.visibility === "private" ? "private" : "channel", {
        type: "user", id: ctx.userId, initialUserIds: input.members, executor: ctx.executor,
        actionCardMessageId: ctx.messageId, actionCardConfirmationVersion: ctx.confirmationVersion,
      });
      if (options.failAfterCreate) throw new Error("the handler failed after its first write");
      return { kind: "channel", id: channel.id, name: channel.name };
    },
  };
  setActionCardFormHandlerForTest("channel:create", handler);
  return calls;
}

export async function seedUser(label: string) {
  const suffix = randomUUID().slice(0, 8);
  const [user] = await getDb().insert(users).values({
    email: `${label}-${suffix}@test.invalid`,
    name: `${label}-${suffix}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    profileSetupCompletedAt: new Date(),
  }).returning();
  return user!;
}

export type Delivery = { agentId: string; payload: Record<string, unknown> };

export function installRecordingOrchestrator(app: { set: (key: string, value: unknown) => void }): Delivery[] {
  const deliveries: Delivery[] = [];
  const deliverMessage = async (agentId: string, payload: Record<string, unknown>) => {
    deliveries.push({ agentId, payload });
    return { status: "queued", reason: "test" };
  };
  app.set("agentOrchestrator", {
    deliverMessage,
    deliverMessagesOnChannel: (_channelId: string, batch: ReadonlyArray<{ agentId: string; message: Record<string, unknown> }>) =>
      batch.map(({ agentId, message }) => deliverMessage(agentId, message)),
    loadDeliveryGates: async () => null,
    recordAgentRaftAction: async () => {},
  });
  return deliveries;
}

/** Every `io.to(room).emit(...)` the app makes (the real socket server still sends them). */
export function recordEmits(app: { get: (key: string) => unknown }): Array<{ room: string; event: string; payload: unknown }> {
  const emitted: Array<{ room: string; event: string; payload: unknown }> = [];
  const io = app.get("io") as { to: (room: string) => { emit: (event: string, ...args: unknown[]) => boolean } };
  const to = io.to.bind(io);
  io.to = (room: string) => {
    const operator = to(room);
    const emit = operator.emit.bind(operator);
    operator.emit = (event: string, ...args: unknown[]) => {
      emitted.push({ room, event, payload: args[0] });
      return emit(event, ...args);
    };
    return operator;
  };
  return emitted;
}

export async function seed(app: { app: { set: (key: string, value: unknown) => void; get: (key: string) => unknown } }) {
  const deliveries = installRecordingOrchestrator(app.app);
  const emitted = recordEmits(app.app);
  const owner = await seedUser("form-owner");
  const alice = await seedUser("form-alice");
  const bob = await seedUser("form-bob");
  const outsider = await seedUser("form-outsider");
  const server = await createServer("Form Cards", `form-cards-${randomUUID().slice(0, 8)}`, owner.id);
  await createServer("Elsewhere", `elsewhere-${randomUUID().slice(0, 8)}`, outsider.id);
  await getDb().insert(serverMembers).values([
    { serverId: server.id, userId: alice.id, role: "member" },
    { serverId: server.id, userId: bob.id, role: "member" },
  ]);
  const channel = await channelService.createChannel(server.id, `form-room-${randomUUID().slice(0, 6)}`);
  await channelService.addHuman(channel.id, owner.id);
  await channelService.addHuman(channel.id, alice.id);
  const hidden = await channelService.createChannel(server.id, `hidden-${randomUUID().slice(0, 6)}`, undefined, "private");
  await channelService.addHuman(hidden.id, bob.id);
  const agent = await createAgent(server.id, `form-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await channelService.addAgent(channel.id, agent.id);
  await updateAgentScopes({ agentId: agent.id, scopes: ["action:prepare", "message:read"], updatedByUserId: owner.id });
  const minted = await mintAgentCredential({ agentId: agent.id, scopes: ["read", "tasks"], name: "form-cards", issuedVia: "computer", createdByUserId: null });
  return {
    owner, alice, bob, outsider, server, channel, hidden, agent, deliveries, emitted, agentKey: minted.apiKey,
    tokens: { owner: await tokenForHuman(owner.email), alice: await tokenForHuman(alice.email), bob: await tokenForHuman(bob.email) },
  };
}
export type Fixture = Awaited<ReturnType<typeof seed>>;
export type Who = keyof Fixture["tokens"];

export const headers = (f: Fixture, who: Who) => ({ Authorization: `Bearer ${f.tokens[who]}`, "Content-Type": "application/json", "X-Server-Id": f.server.id });

export async function prepareCreate(f: Fixture, action: Partial<Extract<ActionCardAction, { type: "channel:create" }>> = {}) {
  return prepareActionCard({
    serverId: f.server.id,
    requesterAgentId: f.agent.id,
    targetChannelId: f.channel.id,
    action: { type: "channel:create", name: "launch-room", visibility: "public", initialHumans: [f.bob.id], ...action },
  });
}

/** What /api/actions answers, read loosely: a test asserts on whichever fields its case expects. */
export interface ActionsResponseBody {
  messageId: string;
  metadata: ActionCardMetadata;
  error: string;
  errorCode: string;
  issues: ActionCardFormIssue[];
}

/** `client`: the sending client's own headers (X-Raft-Client-Platform, User-Agent). */
export async function post(baseUrl: string, f: Fixture, who: Who, path: string, body: unknown, client: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}/api/actions/${path}`, { method: "POST", headers: { ...headers(f, who), ...client }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, text, body: (text ? JSON.parse(text) : null) as ActionsResponseBody };
}

export const submit = (baseUrl: string, f: Fixture, who: Who, messageId: string, values: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  post(baseUrl, f, who, `${messageId}/execute`, { expectedState: "prepared", expectedConfirmationVersion: 1, form: { id: FORM, values }, ...extra });

export const goodValues = (f: Fixture): Record<string, ActionCardFormValue> =>
  ({ name: "launch-room", visibility: "private", note: SENTINEL, members: [f.bob.id], announce: true });

export async function cardRow(messageId: string) {
  const [row] = await getDb().select().from(actionCards).where(eq(actionCards.messageId, messageId));
  return row!;
}


export const channelsNamed = async (serverId: string, name: string) =>
  getDb().select({ id: channels.id, type: channels.type }).from(channels).where(and(eq(channels.serverId, serverId), eq(channels.name, name)));

/** A hook that lets `count` callers through together (each waits for the last). */
export function barrier(count: number): () => Promise<void> {
  let waiting = 0;
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return async () => { waiting += 1; if (waiting >= count) open(); await opened; };
}
