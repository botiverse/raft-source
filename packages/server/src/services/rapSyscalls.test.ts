import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { agents, servers, users } from "../db/schema.js";
import { BUILT_IN_RAP_APPS } from "./rapBuiltinAppManifests.js";
import { parseManifest, SYSCALLS, type AppId } from "./rapRegistry.js";
// Namespace import on purpose: the declarable<=>callable tooth below must look
// up exports BY THE CANONICAL NAME rather than importing a hand-written set,
// otherwise the check is a third copy of the list it is meant to protect.
import * as rapSyscallSurface from "./rapSyscalls.js";
import * as storeSurface from "./rapRegistryStore.js";
import { runWithMintedRapEvent } from "./rapInvocationContext.js";
import {
  createRapRegistryForTests,
  raiseDueEvent,
  registerHookHandlers,
  type RapCatalogEntry
} from "./rapRegistryStore.js";
import {
  createRapTimersForTests,
  createNotifyForTests,
  createResolveConversationForTests,
  type RapTimerSeam,
  notify,
  type DeliverySeam,
  type NotifyOutcome,
} from "./rapSyscalls.js";


const ALPHA = "x.alpha" as AppId;
const BUILT_IN = BUILT_IN_RAP_APPS.find((candidate) => candidate.appId === "system.canary");
if (!BUILT_IN) throw new Error("test fixture system.canary is missing from the built-in catalog");
const builtInNotificationClass = BUILT_IN.manifest.notifications[0];
if (!builtInNotificationClass) throw new Error("test fixture system.canary has no notification class");
const builtInPayload = {
  notificationClass: builtInNotificationClass,
  body: "hello",
};

afterEach(async () => {
  await closeTestDatabase();
});

async function seed(suffix: string) {
  await openTestDatabase("pglite://");
  const db = getDb();
  const [owner] = await db.insert(users).values({
    id: `10000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    email: `owner-${suffix}@example.com`,
    name: `owner-${suffix}`,
    displayName: `owner-${suffix}`,
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [server] = await db.insert(servers).values({
    id: `20000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    name: `Server ${suffix}`,
    slug: `server-${suffix}`,
    ownerId: owner.id,
  }).returning();
  const [agent] = await db.insert(agents).values({
    id: `30000000-0000-4000-8000-${suffix.padStart(12, "0")}`,
    serverId: server.id,
    name: `agent-${suffix}`,
    runtime: "codex",
  }).returning();
  return { serverId: server.id, agentId: agent.id };
}

function testEntry(
  agentIds: readonly string[],
  overrides: Record<string, unknown> = {},
): RapCatalogEntry {
  return {
    appId: ALPHA,
    rawManifest: {
      app_id: ALPHA,
      hooks: [],
      syscalls: ["notify", "resolveConversation"],
      notifications: ["x.event"],
      ...overrides,
    },
    grant: { kind: "explicit_agent_ids", agentIds },
  };
}

/** Records what reached the seam, so "refused" can be told from "delivered". */
function recordingSeam(
  result: (
    conversationId: string,
    invocation: { eventId: string },
  ) => NotifyOutcome,
): DeliverySeam & { calls: string[]; eventIds: string[] } {
  const calls: string[] = [];
  const eventIds: string[] = [];
  return {
    calls,
    eventIds,
    async raise(conversationId, _payload, invocation) {
      calls.push(conversationId);
      eventIds.push(invocation.eventId);
      return result(conversationId, invocation);
    },
  };
}

const woke = (conversationId: string, invocation: { eventId: string }): NotifyOutcome => ({
  kind: "l2_woke",
  conversationId,
  eventId: invocation.eventId,
});

test("notify resolves a built-in's all-agent grant and reaches the delivery seam", async () => {
  const { serverId, agentId } = await seed("01");
  const seam = recordingSeam(woke);

  const out = await notify(serverId, BUILT_IN.appId, { agentId }, builtInPayload, seam);
  assert.equal(out.kind, "l2_woke");
  if (out.kind === "l2_woke") assert.equal(out.eventId, seam.eventIds[0]);
  assert.equal(seam.calls.length, 1, "a granted subject must actually reach the seam");
});

test("GRANT reverse tooth: an existing but explicitly ungranted subject is refused before delivery", async () => {
  const { serverId, agentId } = await seed("02");
  const [other] = await getDb().insert(agents).values({
    id: "30000000-0000-4000-8000-000000000902",
    serverId,
    name: "existing-ungranted",
    runtime: "codex",
  }).returning();
  const registry = createRapRegistryForTests([testEntry([agentId])]);
  const testNotify = createNotifyForTests(registry);
  const seam = recordingSeam(woke);

  const out = await testNotify(
    serverId,
    ALPHA,
    { agentId: other.id },
    { notificationClass: "x.event", body: "hello" },
    seam,
  );
  assert.deepEqual(out, { kind: "refused", reason: "no_grant_for_subject" });
  assert.deepEqual(seam.calls, [], "a refusal must stop BEFORE delivery, not be filtered after it");
});

test("an app outside the built-in catalog is refused", async () => {
  const { serverId, agentId } = await seed("03");
  const seam = recordingSeam(woke);
  const out = await notify(
    serverId,
    ALPHA,
    { agentId },
    { notificationClass: "x.event", body: "hello" },
    seam,
  );
  assert.deepEqual(out, { kind: "refused", reason: "not_installed" });
  assert.deepEqual(seam.calls, []);
});

test("declaring no notify syscall refuses it -- catalog membership is not ambient authority", async () => {
  const { serverId, agentId } = await seed("04");
  const registry = createRapRegistryForTests([testEntry([agentId], {
    syscalls: ["resolveConversation"],
  })]);
  const testNotify = createNotifyForTests(registry);
  const seam = recordingSeam(woke);

  const out = await testNotify(
    serverId,
    ALPHA,
    { agentId },
    { notificationClass: "x.event", body: "hello" },
    seam,
  );
  assert.deepEqual(out, { kind: "refused", reason: "syscall_not_declared" });
  assert.deepEqual(seam.calls, []);
});

test("an undeclared notification class is refused -- notify is not a blanket grant", async () => {
  const { serverId, agentId } = await seed("05");
  const seam = recordingSeam(woke);

  const out = await notify(
    serverId,
    BUILT_IN.appId,
    { agentId },
    { notificationClass: "something_else", body: "x" },
    seam,
  );
  assert.deepEqual(out, { kind: "refused", reason: "notification_class_not_declared" });
  assert.deepEqual(seam.calls, []);
});

test("suppressed is a DIFFERENT outcome from woke, so an app cannot record it as sent", async () => {
  const { serverId, agentId } = await seed("06");
  const seam = recordingSeam((conversationId, invocation) => ({
    kind: "l1_suppressed",
    conversationId,
    reason: "debounced",
    eventId: invocation.eventId,
  }));

  const out = await notify(serverId, BUILT_IN.appId, { agentId }, builtInPayload, seam);
  assert.equal(out.kind, "l1_suppressed");
  assert.notEqual(out.kind, "l2_woke");
});

test("an undetermined outcome has its own literal and is not folded into refused", async () => {
  const { serverId, agentId } = await seed("07");
  const seam = recordingSeam(() => ({ kind: "not_established", reason: "timeout" }));

  const out = await notify(serverId, BUILT_IN.appId, { agentId }, builtInPayload, seam);
  assert.equal(out.kind, "not_established");
  assert.notEqual(out.kind, "refused");
});

test("no outcome claims layer 3 -- consume/ACK is carried by the message system", () => {
  const kinds = ["l1_raised", "l2_woke", "l1_suppressed", "refused", "not_established"];
  assert.equal(kinds.filter((kind) => kind.startsWith("l3")).length, 0);
});

test("a seam cannot substitute another event identity", async () => {
  const { serverId, agentId } = await seed("08");
  const registry = createRapRegistryForTests([testEntry([agentId])]);
  const testNotify = createNotifyForTests(registry);
  const seam = recordingSeam((conversationId) => ({
    kind: "l2_woke",
    conversationId,
    eventId: "event-other",
  }));

  const out = await testNotify(serverId, ALPHA, { agentId }, { notificationClass: "x.event", body: "hello" }, seam);

  assert.deepEqual(out, { kind: "not_established", reason: "state_not_returned" });
  assert.equal(seam.calls.length, 1, "identity mismatch is detected after the attempted raise");
});

test("a notify raised inside onDue inherits the OS-minted due-event identity", async () => {
  const { serverId, agentId } = await seed("09");
  const seam = recordingSeam(woke);
  // ALPHA is a test app, not a built-in, so the syscall must run against the
  // test catalog; the identity contract under test is unaffected by which
  // registry resolves the grant.
  const registry = createRapRegistryForTests([testEntry([agentId], { hooks: ["onDue"] })]);
  const testNotify = createNotifyForTests(registry);
  registerHookHandlers(serverId, ALPHA, {
    onDue: () => testNotify(serverId, ALPHA, { agentId }, { notificationClass: "x.event", body: "hello" }, seam),
  });
  // #6102 removed installApp; this test only needed a PARSED manifest from it.
  const parsed = parseManifest({
    app_id: ALPHA,
    hooks: ["onDue"],
    syscalls: ["notify", "resolveConversation"],
    notifications: ["x.event"],
  });
  assert.equal(parsed.kind, "parsed");
  if (parsed.kind !== "parsed") return;

  const dispatch = await raiseDueEvent(serverId, ALPHA, parsed.manifest, {
    subjectAgentId: agentId,
    data: { same: "payload" },
  });

  assert.equal(dispatch.kind, "called");
  if (dispatch.kind !== "called") return;
  assert.equal(seam.eventIds.length, 1);
  assert.equal(dispatch.eventId, seam.eventIds[0]);
  assert.deepEqual(dispatch.result, {
    kind: "l2_woke",
    conversationId: seam.calls[0],
    eventId: dispatch.eventId,
  });
});

test("no callable context entry accepts a caller-chosen seam identity", async () => {
  const { serverId, agentId } = await seed("10");
  const registry = createRapRegistryForTests([testEntry([agentId])]);
  const testNotify = createNotifyForTests(registry);
  const seam = recordingSeam(woke);
  const chosen = "caller-chosen-event-id";
  let forgedCalls = 0;

  await assert.rejects(
    async () => (runWithMintedRapEvent as unknown as (
      eventId: string,
      fn: () => Promise<void>,
    ) => Promise<void>)(chosen, async () => {
      forgedCalls += 1;
    }),
    TypeError,
  );
  assert.equal(forgedCalls, 0);
  assert.deepEqual(seam.eventIds, []);

  const outcome = await runWithMintedRapEvent(
    () => testNotify(serverId, ALPHA, { agentId }, { notificationClass: "x.event", body: "hello" }, seam),
  );
  assert.equal(outcome.kind, "l2_woke");
  assert.equal(seam.eventIds.length, 1);
  assert.notEqual(seam.eventIds[0], chosen);
});

function recordingTimerSeam(): RapTimerSeam & {
  scheduled: Parameters<RapTimerSeam["schedule"]>[0][];
  cancelled: Parameters<RapTimerSeam["cancel"]>[0][];
} {
  const scheduled: Parameters<RapTimerSeam["schedule"]>[0][] = [];
  const cancelled: Parameters<RapTimerSeam["cancel"]>[0][] = [];
  return {
    scheduled,
    cancelled,
    async schedule(input) {
      scheduled.push(input);
      return { timerId: "timer-1" as never, nextFireAt: input.fireAtMs };
    },
    async cancel(input) {
      cancelled.push(input);
      return "cancelled";
    },
  };
}

test("schedule and cancel refuse undeclared authority before touching the timer seam", async () => {
  const { serverId, agentId } = await seed("11");
  const registry = createRapRegistryForTests([testEntry([agentId], {
    syscalls: ["notify", "resolveConversation"],
  })]);
  const timers = createRapTimersForTests(registry);
  const seam = recordingTimerSeam();
  const spec = {
    fireAtMs: 2_000,
    sourceId: "reminder-1",
    data: { reminderId: "reminder-1", version: 1, catchup: false },
  };

  assert.deepEqual(
    await timers.schedule(serverId, ALPHA, { agentId }, spec, seam),
    { kind: "refused", reason: "syscall_not_declared" },
  );
  assert.deepEqual(
    await timers.cancel(serverId, ALPHA, { agentId }, spec.sourceId, seam),
    { kind: "refused", reason: "syscall_not_declared" },
  );
  assert.deepEqual(seam.scheduled, []);
  assert.deepEqual(seam.cancelled, []);
});

test("timer syscalls refuse an existing but ungranted subject before touching the seam", async () => {
  const { serverId, agentId } = await seed("14");
  const [other] = await getDb().insert(agents).values({
    id: "30000000-0000-4000-8000-000000000914",
    serverId,
    name: "timer-ungranted",
    runtime: "codex",
  }).returning();
  const registry = createRapRegistryForTests([testEntry([agentId], {
    hooks: ["onDue"],
    syscalls: ["schedule", "cancel"],
  })]);
  const timers = createRapTimersForTests(registry);
  const seam = recordingTimerSeam();

  assert.deepEqual(await timers.schedule(serverId, ALPHA, { agentId: other.id }, {
    fireAtMs: 2_000,
    sourceId: "reminder-ungranted",
    data: { reminderId: "reminder-ungranted", version: 1, catchup: false },
  }, seam), { kind: "refused", reason: "no_grant_for_subject" });
  assert.deepEqual(
    await timers.cancel(serverId, ALPHA, { agentId: other.id }, "reminder-ungranted", seam),
    { kind: "refused", reason: "no_grant_for_subject" },
  );
  assert.deepEqual(seam.scheduled, []);
  assert.deepEqual(seam.cancelled, []);
});

test("schedule and cancel resolve the granted subject and preserve the closed timer projection", async () => {
  const { serverId, agentId } = await seed("12");
  const registry = createRapRegistryForTests([testEntry([agentId], {
    hooks: ["onDue"],
    syscalls: ["schedule", "cancel"],
  })]);
  const timers = createRapTimersForTests(registry);
  const seam = recordingTimerSeam();
  const data = { reminderId: "reminder-2", version: 7, catchup: true };

  assert.deepEqual(
    await timers.schedule(serverId, ALPHA, { agentId }, {
      fireAtMs: 3_000,
      sourceId: "reminder-2",
      data,
    }, seam),
    { kind: "scheduled", timerId: "timer-1", nextFireAt: 3_000 },
  );
  assert.deepEqual(seam.scheduled, [{
    serverId,
    appId: ALPHA,
    subjectAgentId: agentId,
    fireAtMs: 3_000,
    sourceId: "reminder-2",
    data,
  }]);
  assert.deepEqual(
    await timers.cancel(serverId, ALPHA, { agentId }, "reminder-2", seam),
    { kind: "cancelled" },
  );
  assert.deepEqual(seam.cancelled, [{
    serverId,
    appId: ALPHA,
    subjectAgentId: agentId,
    sourceId: "reminder-2",
  }]);
});

/**
 * Task #141-A: declarable => callable, GENERATED from the canonical list.
 *
 * The pairing this protects: a manifest may declare exactly the names in
 * `SYSCALLS`, so every one of those names must have a public callable of that
 * name on the syscall surface. `readOwnState`/`writeOwnState` failed precisely
 * here -- declarable for months with nothing behind them.
 *
 * ⚠️ WHAT THIS DOES NOT PROVE (@XX's correction on this card, carried
 * deliberately): "an exported async function whose name matches" is NOT the
 * same as "an authorized execution surface". This tooth proves the NAME is
 * reachable; the contract each callable enforces is proven by the behavioural
 * tests below, one syscall at a time. ⛔ Do not cite this test as evidence that
 * a syscall checks installation, declaration, or grant.
 *
 * It is generated rather than listed so that adding a name to the canonical
 * array immediately demands a callable, instead of quietly passing a check that
 * enumerates yesterday's names.
 */
test("§141: every declarable syscall name resolves to a public callable", () => {
  const surface = rapSyscallSurface as unknown as Record<string, unknown>;
  // Anti-vacuity: an empty or unreadable canonical list would make the loop
  // below pass by iterating nothing, reporting coverage that never ran.
  assert.ok(
    SYSCALLS.length >= 4,
    `canonical syscall list looks truncated (${SYSCALLS.length}) -- refusing to report a coverage this test did not perform`,
  );
  for (const name of SYSCALLS) {
    assert.equal(
      typeof surface[name],
      "function",
      `syscall "${name}" is declarable in a manifest but has no public callable of that name on the syscall surface -- declarable-but-uncallable is the defect this card deleted two names for`,
    );
  }
});

/**
 * @XX's narrowing (task #141-A): the contract is NOT "the canonical name is
 * callable" -- it is "the canonical name is the public syscall bound by
 * installed -> declared -> granted". So the load-bearing teeth call the REAL
 * public export `rapSyscallSurface.resolveConversation`, never
 * `createResolveConversationForTests`.
 *
 * ⚠️ Why this distinction is load-bearing, measured rather than assumed: with
 * every behavioural test routed through the test factory, rebinding the public
 * export to the STORE primitive left the whole suite 32/32 GREEN. The factory
 * is a PARALLEL path -- proving it correct proves nothing about the export an
 * app actually reaches (@Maggie predicted the shape; the false green was then
 * reproduced). Identity comparison alone is not enough either: a forwarding
 * wrapper around the store primitive passes any `!==` check while still never
 * reading the manifest. Only calling the export and observing a REFUSAL in a
 * state the store primitive would have RESOLVED pins the real relationship.
 */
const UNDECLARING_BUILT_IN = BUILT_IN_RAP_APPS.find(
  (candidate) => !(candidate.manifest.syscalls as readonly string[]).includes("resolveConversation"),
);
if (!UNDECLARING_BUILT_IN) {
  throw new Error(
    "no built-in app omits `resolveConversation` -- the installed+granted+undeclared state this tooth needs is unreachable, so it must fail rather than pass blind",
  );
}

test("§141 PUBLIC EXPORT: installed and granted but UNDECLARED is refused", async () => {
  const { serverId, agentId } = await seed("24");
  // This built-in is installed and grants every agent on the server, and its
  // manifest does not declare `resolveConversation`. The store primitive would
  // happily resolve this exact state -- it only checks the grant. The public
  // syscall must refuse it, and that difference is the whole point of the
  // wrapper existing.
  const out = await rapSyscallSurface.resolveConversation(
    serverId,
    UNDECLARING_BUILT_IN.appId,
    { agentId },
  );
  assert.deepEqual(
    out,
    { kind: "refused", reason: "syscall_not_declared" },
    "the public export resolved (or refused for the wrong reason) a subject whose app never declared the syscall -- the canonical name is bound to something that does not enforce §2 Q3",
  );
});

test("§141 PUBLIC EXPORT: a declaring built-in over a granted subject resolves", async () => {
  const { serverId, agentId } = await seed("25");
  // The positive control: without it, the refusal above could be produced by a
  // public export that refuses everything.
  const out = await rapSyscallSurface.resolveConversation(serverId, BUILT_IN.appId, { agentId });
  assert.equal(out.kind, "resolved", "a declaring, granted built-in must resolve through the public export");
  if (out.kind !== "resolved") return;
  assert.ok(out.conversationId.length > 0, "a resolution must carry the conversation id");
});

/**
 * @ApplePI's independently-derived mutation on the previous exact: move
 * `registry.resolveConversation` ABOVE the declaration check. The returned
 * value does not change -- the refusal is still `syscall_not_declared` -- but
 * an app that never declared the syscall has already reached the grant/store
 * lookup. No value-comparing tooth can see that, because no value differs.
 *
 * The contract frozen for the public surface is ORDERED: installed -> declared
 * -> granted. Declaration gates the grant lookup, so an undeclared app must
 * cause exactly ZERO grant resolutions. Counting the calls is the only
 * observation that distinguishes the two orders.
 *
 * ⚠️ This tooth uses the injectable factory ON PURPOSE: the observation is a
 * call count inside the wrapper, which requires a seam. It does not replace the
 * public-export teeth above -- those pin WHICH symbol the canonical name binds
 * to; this one pins the ORDER inside it. Two different failures, two teeth.
 */
test("§141: an undeclared app never reaches the grant/store lookup", async () => {
  const { serverId, agentId } = await seed("26");
  const base = createRapRegistryForTests([testEntry([agentId], { syscalls: ["notify"] })]);
  let grantLookups = 0;
  const recording = {
    getInstalledApp: base.getInstalledApp,
    async resolveConversation(...args: Parameters<typeof base.resolveConversation>) {
      grantLookups += 1;
      // Deliberately still SUCCEEDS if reached: the defect must be visible in
      // the count alone, never rescued by this seam returning a refusal.
      return base.resolveConversation(...args);
    },
  };

  const resolve = createResolveConversationForTests(recording);
  const out = await resolve(serverId, ALPHA, { agentId });

  assert.deepEqual(
    out,
    { kind: "refused", reason: "syscall_not_declared" },
    "an undeclared syscall must still be refused for the declaration reason",
  );
  assert.equal(
    grantLookups,
    0,
    "an app that never declared the syscall reached the grant/store lookup -- declaration must GATE grant resolution, and this ordering is invisible to any check that only compares the returned value",
  );
});

test("§141: no canonical syscall name is bound to a rapRegistryStore export", () => {
  // Supplementary to the behavioural teeth above, NOT a replacement: this
  // catches the direct `export { storePrimitive as canonicalName }` form, while
  // a forwarding wrapper would slip past it and be caught by the refusal test.
  const surface = rapSyscallSurface as unknown as Record<string, unknown>;
  const storeExports = Object.values(storeSurface as unknown as Record<string, unknown>);
  for (const name of SYSCALLS) {
    assert.ok(
      !storeExports.includes(surface[name]),
      `syscall "${name}" resolves to a rapRegistryStore export -- store primitives resolve grants and never read the manifest, so binding the canonical name to one silently removes the declaration check`,
    );
  }
});

test("§141 resolveConversation: a declared syscall over a granted subject resolves", async () => {
  const { serverId, agentId } = await seed("20");
  const registry = createRapRegistryForTests([testEntry([agentId])]);
  const resolve = createResolveConversationForTests(registry);

  const out = await resolve(serverId, ALPHA, { agentId });
  assert.equal(out.kind, "resolved", "a declared syscall over a granted subject must resolve");
  if (out.kind !== "resolved") return;
  assert.ok(out.conversationId.length > 0, "a resolution must carry the conversation id");
});

/**
 * The reason this wrapper exists at all. The STORE primitive resolves a grant
 * and never looks at the manifest, so an app that never declared
 * `resolveConversation` would still get a conversation id out of it. §2 Q3 says
 * the manifest is the whole answer -- so the public syscall must refuse here
 * even though the subject IS granted.
 */
test("§141 resolveConversation: an undeclared syscall is refused even WITH a grant", async () => {
  const { serverId, agentId } = await seed("21");
  const registry = createRapRegistryForTests([
    testEntry([agentId], { syscalls: ["notify"] }),
  ]);
  const resolve = createResolveConversationForTests(registry);

  const out = await resolve(serverId, ALPHA, { agentId });
  assert.deepEqual(
    out,
    { kind: "refused", reason: "syscall_not_declared" },
    "the grant exists, but the manifest never declared the syscall -- a grant is not a declaration",
  );
});

test("§141 resolveConversation: a declared syscall over an ungranted subject is refused", async () => {
  const { serverId, agentId } = await seed("22");
  // A DIFFERENT agent that really exists on this server: the refusal must come
  // from the grant, not from the subject being absent.
  const [other] = await getDb().insert(agents).values({
    id: "30000000-0000-4000-8000-000000000922",
    serverId,
    name: "existing-ungranted-resolve",
    runtime: "codex",
  }).returning();
  const registry = createRapRegistryForTests([testEntry([agentId])]);
  const resolve = createResolveConversationForTests(registry);

  const out = await resolve(serverId, ALPHA, { agentId: other.id });
  assert.deepEqual(out, { kind: "refused", reason: "no_grant_for_subject" });
});

test("§141 resolveConversation: an uninstalled app is refused before anything else", async () => {
  const { serverId, agentId } = await seed("23");
  const registry = createRapRegistryForTests([]);
  const resolve = createResolveConversationForTests(registry);

  const out = await resolve(serverId, ALPHA, { agentId });
  assert.deepEqual(out, { kind: "refused", reason: "not_installed" });
});
