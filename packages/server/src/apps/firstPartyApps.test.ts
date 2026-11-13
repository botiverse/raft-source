// The first-party app registry and what core derives from it (first-party app
// mechanism §一, §三, §六): the registrations' checks, the system apps that
// need a delivery guard and the guard used, where routes are mounted, the
// object and event kinds recordObjectEvent accepts (with homes and
// recipients), and AgentMessage.app_event.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appAgentApiRoutesOf, asServerId, firstPartyAppAgentApis, type ArtifactAgentNotice, type ReactionAgentNotice } from "@botiverse/raft-shared";
import type { Database } from "../db/index";
import { agents, objectEventRecipients, objectEvents, thirdPartyAgentEvents } from "../db/schema";
import type { AppObjectKind, FirstPartyApp } from "../platform/apps";
import { mountFirstPartyAppInternals, mountFirstPartyAppWebApis } from "../routes/firstPartyAppRoutes";
import {
  AGENT_API_WRITE_BUDGET_ROUTES,
  agentApiMountOf,
  firstPartyAppAgentApiLargeBodies,
  internalAgentApiRouter,
} from "../routes/internalAgentApi";
import { AGENT_API_WRITE_BUDGETS } from "../services/agentApiWriteLimits";
import { ObjectEventRejected, recordObjectEvent, type ObjectEventInput } from "../services/objectEvents";
import { buildSystemAppAgentMessage, createSystemAppAgentEvent } from "../services/systemAppAgentEvents";
import { isSystemAppDeliveryGuarded, partitionDeliverableSystemAppEvents, systemAppsRequiringDeliveryGuard } from "../services/systemAppDeliveryGuards";
import { dbTest as test } from "../test/integration/dbTest";
import type { createSeed } from "../test/integration/seed";
import { appNoticeKinds, checkRegistrations, firstPartyApp, firstPartyAppOfSystemApp, firstPartyApps, messageReactionApps, registeredObjectKind } from "./firstPartyApps";

/** An object kind with no objects (homes and summaries of nothing). */
const objectKind = (kind: string, events: string[], objectTables: string[]): AppObjectKind =>
  ({ kind, events, objectTables, homes: async () => new Map(), parseRef: (ref) => ref, summarize: async () => [] });
const app = (over: Partial<FirstPartyApp> = {}): FirstPartyApp => ({
  id: "docs",
  flag: "docs_v0",
  objectKinds: [objectKind("doc", ["edited"], ["docs"])],
  systemApp: "system.docs",
  ...over,
});

test("registrations: unique ids and object kinds, system.<id>, distinct events per kind", () => {
  assert.doesNotThrow(() => checkRegistrations(firstPartyApps()));
  assert.doesNotThrow(() => checkRegistrations([app()]));
  assert.throws(() => checkRegistrations([app(), app()]), /docs is registered twice/);
  assert.throws(() => checkRegistrations([app({ systemApp: "system.other" })]), /must be system\.docs/);
  assert.throws(() => checkRegistrations([app({ id: "Docs", systemApp: "system.Docs" })]), /not lowercase/);
  assert.throws(() => checkRegistrations([app(), app({ id: "sheets", systemApp: "system.sheets" })]), /object kind doc is registered twice/);
  assert.throws(() => checkRegistrations([app({ objectKinds: [objectKind("doc", ["edited", "edited"], [])] })]), /distinct event kinds/);
  assert.throws(() => checkRegistrations([app({ objectKinds: [objectKind("doc", [], [])] })]), /distinct event kinds/);
  // A notice kind (agentNotice.kinds) names what no app owns: never a registered object kind, its own or another app's.
  const noticing = (kinds: string[], over: Partial<FirstPartyApp> = {}) => app({ agentNotice: { schema: { safeParse: () => ({ success: false }) }, deliverable: async () => new Map(), kinds }, ...over });
  assert.doesNotThrow(() => checkRegistrations([noticing(["message"])]));
  assert.throws(() => checkRegistrations([noticing(["message", "message"])]), /names a notice kind twice/);
  assert.throws(() => checkRegistrations([noticing(["doc"])]), /notice kind doc of docs is a registered object kind/);
  assert.throws(() => checkRegistrations([app(), noticing(["doc"], { id: "sheets", systemApp: "system.sheets", objectKinds: [] })]), /notice kind doc of sheets is a registered object kind/);
});

test("the registry lists reaction notices: no object of its own, notices about a message, told of reactions", () => {
  const reactions = firstPartyApp("reaction-notices");
  assert.equal(reactions?.systemApp, "system.reaction-notices");
  assert.equal(firstPartyAppOfSystemApp("system.reaction-notices")?.id, "reaction-notices");
  assert.equal(reactions?.flag, "agent_reaction_notices_v0");
  assert.deepEqual(reactions?.objectKinds, []);
  assert.deepEqual(appNoticeKinds(reactions!), ["message"]);
  assert.deepEqual(appNoticeKinds(firstPartyApp("artifacts")!), ["artifact"]);
  // A notice kind registers no object: `message` is still not an object kind.
  assert.equal(registeredObjectKind("message"), undefined);
  assert.deepEqual(messageReactionApps().map((entry) => entry.id), ["reaction-notices"]);
  assert.equal(isSystemAppDeliveryGuarded("system.reaction-notices"), true);
});

test("the registry lists Artifacts, and its object kind and events; every app's system app maps back to it", () => {
  assert.ok(firstPartyApps().some((entry) => entry.id === "artifacts"));
  for (const entry of firstPartyApps()) assert.equal(firstPartyAppOfSystemApp(entry.systemApp)?.id, entry.id, entry.id);
  assert.equal(firstPartyApp("artifacts")?.systemApp, "system.artifacts");
  assert.equal(firstPartyAppOfSystemApp("system.artifacts")?.id, "artifacts");
  assert.equal(firstPartyAppOfSystemApp("system.assistant"), undefined);
  const artifact = registeredObjectKind("artifact");
  assert.equal(artifact?.app.id, "artifacts");
  assert.deepEqual(artifact?.objectKind.events, ["version", "comment", "comment_edited", "comment_deleted", "renamed", "moved", "deleted", "review", "comment_resolved", "comment_reopened"]);
  assert.deepEqual(artifact?.objectKind.objectTables, ["items", "versions", "comments"]);
  assert.equal(registeredObjectKind("message"), undefined);
});

test("delivery guards: every app with agent notices requires one, and its registered guard is the one run", async ({ db, seed }) => {
  assert.deepEqual([...systemAppsRequiringDeliveryGuard()].sort(), firstPartyApps().filter((entry) => entry.agentNotice).map((entry) => entry.systemApp).sort());
  assert.equal(isSystemAppDeliveryGuarded("system.artifacts"), true);
  assert.equal(isSystemAppDeliveryGuarded("system.assistant"), false);
  // A notice about an Artifact that doesn't exist: the registered guard vetoes
  // it (a missing guard would withhold it instead).
  const { serverId, agentId } = await seedAgent(db, seed);
  const event = await createSystemAppAgentEvent({
    serverId, agentId, systemApp: "system.artifacts", kind: "notification", summary: "s", ttlMs: 60_000,
    payload: { app_event: { app: "artifacts", kind: "artifact", ...notice(`pt_${randomUUID()}`) } },
  });
  const split = await partitionDeliverableSystemAppEvents([event], (row) => row);
  assert.deepEqual([split.deliverable.length, split.vetoed.length, split.withheld.length], [0, 1, 0]);
  const [row] = await db.select({ status: thirdPartyAgentEvents.status }).from(thirdPartyAgentEvents).where(eq(thirdPartyAgentEvents.id, event.id));
  assert.equal(row!.status, "expired");
});

test("mounting: each app's agent API, web API and internal routes where the registration puts them", () => {
  const layers = (internalAgentApiRouter as unknown as { stack: Array<{ route?: { path: string; methods?: Record<string, boolean> } }> }).stack;
  const agentRoutes = layers.flatMap((layer) => (layer.route ? [`${Object.keys(layer.route.methods ?? {}).join(",").toUpperCase()} ${layer.route.path}`] : []));
  // Every route of every app's fragment is mounted (internalAgentApi.contract.test.ts checks each exactly once).
  for (const { app: id, route } of appAgentApiRoutesOf(firstPartyAppAgentApis)) {
    assert.ok(agentRoutes.includes(`${route.method} ${route.path}`), `${id}: ${route.method} ${route.path}`);
  }
  assert.deepEqual(firstPartyAppAgentApiLargeBodies().map((body) => [body.app, body.method, body.path]), [["artifacts", "POST", "/internal/agent-api/artifacts/push"]]);

  const limits: string[] = [];
  const web = mountFirstPartyAppWebApis((key) => {
    limits.push(key);
    return (_req, _res, next) => next();
  }, (_req, _res, next) => next(), []);
  // Each app with a web API is at /api/<id>, its rate limits named <id>.*; Artifacts' are these.
  assert.deepEqual(web.routers.map((entry) => entry.path).sort(), firstPartyApps().filter((entry) => entry.routes?.webApi).map((entry) => `/api/${entry.id}`).sort());
  // Account routes (no server scoping) only where an app declares one: Artifacts' `GET /:id/open`.
  assert.deepEqual(web.accountRouters.map((entry) => entry.path), ["/api/artifacts"]);
  assert.ok(limits.every((key) => firstPartyApps().some((entry) => key.startsWith(`${entry.id}.`))), limits.join(", "));
  assert.deepEqual(limits.filter((key) => key.startsWith("artifacts.")).sort(), ["artifacts.attachmentSaves", "artifacts.commentImages", "artifacts.dashboard", "artifacts.downloadZip", "artifacts.frame", "artifacts.homeChange", "artifacts.locate", "artifacts.mentionCandidates", "artifacts.shareAudience", "artifacts.write"]);
  const internals = mountFirstPartyAppInternals().map((entry) => entry.path);
  assert.ok(internals.includes("/internal/artifacts-content"));
  // The publish check Worker's lease and result (task #130), behind a token of its own.
  assert.ok(internals.includes("/internal/artifacts-check"));
});

test("mounting: an app mounts only its own agent API routes (under /<id>/), never a core route or another app's", () => {
  const docs = agentApiMountOf(app());
  const refused = /first-party app docs may mount only its own agent API routes \(\/internal\/agent-api\/docs\/…\); messageSend is \/send/;
  assert.throws(() => docs.json("messageSend", "x", async () => ({ kind: "json", body: {} }) as never), refused, "a core route");
  assert.throws(() => docs.bytes("artifactFile", "x", async () => ({ kind: "error" }) as never), /artifactFile is \/artifacts\/:artifact\/files\/:path/, "another app's route");
  assert.throws(() => docs.upload("artifactUpload", "x", async () => ({ kind: "error" }) as never), /artifactUpload/);
  assert.throws(() => docs.objectFileUpload("artifactCommentImageUpload", "x", async () => ({ kind: "error" }) as never), /artifactCommentImageUpload/);
  assert.throws(() => docs.largeBody("artifactPublish", 1, { notEnabled: { kind: "error", status: 403, body: { error: "x", code: "X" } }, onBodyError: () => null }), /artifactPublish/);
  // Artifacts' own routes are accepted: they mounted at load (the test above finds them). A refused one registers nothing.
});

type RouteLayer = { route?: { path: string; methods?: Record<string, boolean>; stack: Array<{ handle: { __agentApiWriteBudget?: string; __agentApiClientGate?: string } }> } };
const agentApiLayers = () => (internalAgentApiRouter as unknown as { stack: RouteLayer[] }).stack;
/** The write budgets a route's handlers charge (core's budget tags its own), in order, and the app's client gate (which leads every app route). */
const budgetsOf = (layer: RouteLayer | undefined) => {
  const stack = layer?.route?.stack ?? [];
  return {
    gate: stack[0]?.handle.__agentApiClientGate ?? null,
    budgets: stack.flatMap((entry) => (entry.handle.__agentApiWriteBudget ? [entry.handle.__agentApiWriteBudget] : [])),
  };
};

test("write budgets: every app agent API route but a GET spends core's agent write budgets, a push's file uploads their own class", () => {
  const layers = agentApiLayers();
  const classes: Record<string, string> = {};
  for (const { app: id, route } of appAgentApiRoutesOf(firstPartyAppAgentApis)) {
    const layer = layers.find((entry) => entry.route?.path === route.path && entry.route.methods?.[route.method.toLowerCase()]);
    const { gate, budgets } = budgetsOf(layer);
    assert.equal(gate, id, `${route.key}: the app's client gate leads the chain`);
    if (route.method === "GET") {
      assert.deepEqual(budgets, [], `${route.key}: a read is never counted`);
      continue;
    }
    assert.equal(budgets.length, 1, `${route.key}: one budget`);
    classes[route.key] = budgets[0]!;
  }
  // The route map pins it: Artifacts' writes in artifactWrites (apart from core's otherWrites), the push's per-file uploads in artifactUploads.
  assert.deepEqual(classes, {
    artifactPublish: "artifactWrites",
    artifactImport: "artifactWrites",
    artifactUpload: "artifactUploads",
    artifactCommentImageUpload: "artifactWrites",
    artifactComment: "artifactWrites",
    artifactReview: "artifactWrites",
    artifactCommentResolve: "artifactWrites",
    artifactCommentReopen: "artifactWrites",
    artifactSubscribe: "artifactWrites",
    artifactUnsubscribe: "artifactWrites",
    artifactMove: "artifactWrites",
    artifactDelete: "artifactWrites",
    artifactSaveAttachment: "artifactWrites",
  });
  // A large body is charged ahead of its parser (app.ts), by the same class, and passed at the route; the app's client gate goes first there too.
  assert.deepEqual(firstPartyAppAgentApiLargeBodies().map((body) => [body.path, (body.limit as { __agentApiWriteBudget?: string } | null)?.__agentApiWriteBudget]), [["/internal/agent-api/artifacts/push", "artifactWrites"]]);
  assert.deepEqual(firstPartyAppAgentApiLargeBodies().map((body) => (body.clientGate as { __agentApiClientGate?: string }).__agentApiClientGate), ["artifacts"]);
  // At least twice the busiest real minute (2026-11-01..08): uploads 82 / 82, Artifacts' other writes 6 / 6 and pushes 5 / 7.
  assert.deepEqual(AGENT_API_WRITE_BUDGETS.artifactUploads, { perAgent: 600, perServer: 1200, what: "artifact file uploads" });
  assert.deepEqual(AGENT_API_WRITE_BUDGETS.artifactWrites, { perAgent: 60, perServer: 600, what: "artifact changes" });
});

test("write budgets: an app's write route is budgeted without asking, and one with no class refuses to mount", () => {
  const mount = agentApiMountOf(app({ id: "artifacts", systemApp: "system.artifacts", objectKinds: [objectKind("artifact", ["edited"], [])] }));
  assert.equal("rateLimit" in mount, false);
  const before = agentApiLayers().length;
  mount.json("artifactMove", "x", async () => ({ kind: "error", status: 500, body: { error: "x", code: "X" } }));
  mount.upload("artifactUpload", "x", async () => ({ kind: "empty" }));
  mount.objectFileUpload("artifactCommentImageUpload", "x", async () => ({ kind: "error", status: 500, body: { error: "x", code: "X" } }));
  mount.json("artifactRead", "x", async () => ({ kind: "error", status: 500, body: { error: "x", code: "X" } }));
  const added = agentApiLayers().slice(before).map((layer) => [layer.route?.path, budgetsOf(layer).budgets]);
  assert.deepEqual(added, [
    ["/artifacts/:artifact/home", ["artifactWrites"]],
    ["/artifacts/uploads/:sha256", ["artifactUploads"]],
    ["/artifacts/:artifact/comment-images", ["artifactWrites"]],
    ["/artifacts/:artifact", []],
  ]);
  const kept = AGENT_API_WRITE_BUDGET_ROUTES.artifactDelete;
  delete AGENT_API_WRITE_BUDGET_ROUTES.artifactDelete;
  try {
    const count = agentApiLayers().length;
    assert.throws(() => mount.json("artifactDelete", "x", async () => ({ kind: "empty" }) as never), /artifactDelete writes but has no write budget class/);
    assert.equal(agentApiLayers().length, count, "nothing mounted");
  } finally {
    AGENT_API_WRITE_BUDGET_ROUTES.artifactDelete = kept;
  }
});

async function seedAgent(db: Database, seed: ReturnType<typeof createSeed>) {
  const owner = await seed.human();
  const server = await seed.server({ owner });
  const [agent] = await db.insert(agents).values({ serverId: server.id, name: `a-${randomUUID().slice(0, 8)}` }).returning();
  return { owner, server, serverId: server.id, agentId: agent!.id };
}

const notice = (id: string): ArtifactAgentNotice => ({
  artifact: { id, title: "Site" },
  reason: "subscribed",
  following: { kind: "commented", version: null },
  comments: { count: 1, latest: [{ id: "c_1", author: { type: "agent", name: "b" }, version: 2, path: null, createdAt: "2030-01-02T03:04:05.000Z", excerpt: "hi", truncated: false, bodyChars: 2 }] },
  version: null,
});

test("app_event: a registered app's notice, checked by its schema, next to third_party_event; nothing else gets one", async ({ db, seed }) => {
  const { serverId, agentId } = await seedAgent(db, seed);
  const body = notice("pt_abc");
  const event = (systemApp: "system.artifacts" | "system.assistant", appEvent: unknown) => createSystemAppAgentEvent({
    serverId, agentId, systemApp, kind: "notification", summary: "New comment", payload: { app_event: appEvent }, ttlMs: 60_000,
  });
  const good = await event("system.artifacts", { app: "artifacts", kind: "artifact", ...body });
  const message = buildSystemAppAgentMessage(good);
  assert.deepEqual(message.app_event, { app: "artifacts", kind: "artifact", ...body });
  assert.equal("artifact_event" in message, false, "no field named for one app");
  // Old daemons keep reading the event as before.
  assert.deepEqual(message.third_party_event?.payload, { app_event: { app: "artifacts", kind: "artifact", ...body } });
  assert.equal(message.content.split("\n")[0], "System notification: New comment");

  for (const [why, row] of [
    ["another system app", await event("system.assistant", { app: "artifacts", kind: "artifact", ...body })],
    ["fails the schema", await event("system.artifacts", { app: "artifacts", kind: "artifact", reason: "nope" })],
    ["another app's id", await event("system.artifacts", { app: "docs", kind: "artifact", ...body })],
    ["not the app's object kind", await event("system.artifacts", { app: "artifacts", kind: "doc", ...body })],
    ["not an object", await event("system.artifacts", "x")],
  ] as const) {
    assert.equal("app_event" in buildSystemAppAgentMessage(row), false, why);
  }
});

test("app_event: a notice about a kind the app only names (agentNotice.kinds), checked by its schema as any", async ({ db, seed }) => {
  const { serverId, agentId } = await seedAgent(db, seed);
  const body: ReactionAgentNotice = {
    message: { id: randomUUID(), channelId: randomUUID(), conversation: "#proj-x", replyTarget: "#proj-x:3f2a1c9e", excerpt: "Deploy plan", excerptTruncated: false },
    reactor: { id: randomUUID(), kind: "human", name: "tygg" },
    emoji: "✅",
    reactedAt: "2030-01-02T03:04:05.000Z",
  };
  const event = (appEvent: unknown) => createSystemAppAgentEvent({
    serverId, agentId, systemApp: "system.reaction-notices", kind: "notification", summary: "tygg reacted", payload: { app_event: appEvent }, ttlMs: 60_000,
  });
  assert.deepEqual(buildSystemAppAgentMessage(await event({ app: "reaction-notices", kind: "message", ...body })).app_event, { app: "reaction-notices", kind: "message", ...body });
  for (const [why, row] of [
    ["another app's object kind", await event({ app: "reaction-notices", kind: "artifact", ...body })],
    ["fails the schema", await event({ app: "reaction-notices", kind: "message", emoji: "✅" })],
    ["another app's id", await event({ app: "artifacts", kind: "message", ...body })],
  ] as const) {
    assert.equal("app_event" in buildSystemAppAgentMessage(row), false, why);
  }
});

test("recordObjectEvent: only registered kinds and events, nothing written otherwise", async ({ db, seed }) => {
  const { serverId, agentId } = await seedAgent(db, seed);
  const objectId = `pt_${randomUUID()}`;
  const input = (over: Partial<ObjectEventInput>): ObjectEventInput => ({
    serverId: asServerId(serverId), kind: "artifact", objectId, eventKind: "comment", home: { kind: "public" },
    actor: { type: "agent", id: agentId }, data: {}, recipients: [], ...over,
  });
  await assert.rejects(recordObjectEvent(db, input({ kind: "doc" })), (error: unknown) => error instanceof ObjectEventRejected && /object kind "doc" is not registered/.test(error.message));
  await assert.rejects(recordObjectEvent(db, input({ eventKind: "reacted" })), (error: unknown) => error instanceof ObjectEventRejected && /event "reacted" is not registered for artifact/.test(error.message));
  await assert.rejects(recordObjectEvent(db, input({ home: { kind: "server", serverId: asServerId(randomUUID()) } })), ObjectEventRejected);
  assert.equal((await db.select().from(objectEvents).where(eq(objectEvents.objectId, objectId))).length, 0);
  // Every registered event of the kind goes in, the declared-only ones too.
  for (const eventKind of registeredObjectKind("artifact")!.objectKind.events) await recordObjectEvent(db, input({ eventKind }));
  assert.equal((await db.select().from(objectEvents).where(eq(objectEvents.objectId, objectId))).length, 10);
});

test("recordObjectEvent: the home and the recipients, one row each with its strongest reason, the actor left out, in the caller's transaction", async ({ db, seed }) => {
  const { owner, server, serverId, agentId } = await seedAgent(db, seed);
  const channel = await seed.channel({ server, members: [owner] });
  const objectId = `pt_${randomUUID()}`;
  const [user1, user2, agent2] = [randomUUID(), randomUUID(), randomUUID()];
  const input: ObjectEventInput = {
    serverId: asServerId(serverId),
    kind: "artifact",
    objectId,
    eventKind: "comment",
    home: { kind: "conversation", channelId: channel.id },
    actor: { type: "agent", id: agentId },
    data: { position: 3 },
    recipients: [
      { actor: { type: "user", id: user1 }, reason: "following" },
      { actor: { type: "user", id: user1 }, reason: "mentioned" },
      { actor: { type: "user", id: user2 }, reason: "owner" },
      { actor: { type: "user", id: user2 }, reason: "following" },
      { actor: { type: "agent", id: agent2 }, reason: "following" },
      // The actor itself: never its own recipient.
      { actor: { type: "agent", id: agentId }, reason: "mentioned" },
    ],
  };
  // Rolled back with the caller's transaction: neither the event nor its recipients.
  await assert.rejects(db.transaction(async (tx) => {
    await recordObjectEvent(tx, input);
    throw new Error("rollback");
  }), /rollback/);
  assert.equal((await db.select().from(objectEvents).where(eq(objectEvents.objectId, objectId))).length, 0);

  const recorded = await db.transaction((tx) => recordObjectEvent(tx, input));
  const [row] = await db.select().from(objectEvents).where(eq(objectEvents.id, recorded.id));
  assert.deepEqual([row!.objectKind, row!.eventKind, row!.homeKind, row!.homeChannelId, row!.data], ["artifact", "comment", "conversation", channel.id, { position: 3 }]);
  const recipients = await db.select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, recorded.id));
  assert.deepEqual(
    recipients.map((entry) => [entry.recipientType, entry.recipientId, entry.reason]).sort(),
    [["agent", agent2, "following"], ["user", user1, "mentioned"], ["user", user2, "owner"]].sort(),
  );
  // A server or public home has no conversation; an orphan keeps its kind.
  const server2 = await recordObjectEvent(db, { ...input, home: { kind: "server", serverId: asServerId(serverId) }, recipients: [] });
  const orphan = await recordObjectEvent(db, { ...input, home: { kind: "conversation", channelId: null }, recipients: [] });
  const homes = await db.select({ id: objectEvents.id, kind: objectEvents.homeKind, channel: objectEvents.homeChannelId }).from(objectEvents).where(eq(objectEvents.objectId, objectId));
  assert.deepEqual(homes.find((entry) => entry.id === server2.id), { id: server2.id, kind: "server", channel: null });
  assert.deepEqual(homes.find((entry) => entry.id === orphan.id), { id: orphan.id, kind: "conversation", channel: null });
  // Recipients go with their event.
  await db.delete(objectEvents).where(eq(objectEvents.id, recorded.id));
  assert.equal((await db.select().from(objectEventRecipients).where(eq(objectEventRecipients.eventId, recorded.id))).length, 0);
});
