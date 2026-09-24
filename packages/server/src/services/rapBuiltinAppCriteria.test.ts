import { dbTest as test } from "../test/integration/dbTest.js";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database.js";
/**
 * task #138 criteria re-run, on the v1 HARDCODED built-in arrangement.
 *
 * Why this file exists: items 2 and 3 previously went GREEN against a registry
 * where the app under test WAS installed through the registry. Under v1 the
 * built-ins are hardcoded and never travel that path, so carrying those greens
 * across was an ARGUMENT ("identity and delivery do not depend on how the app
 * registered"), not a measurement. This converts the argument into one.
 *
 * No app id or notification class is written here. Every case is parameterised
 * over the manifest module's exported catalog and uses each entry's OWN
 * declared strings. That is required by the criteria's X2 name-containment rule
 * (the manifest module is the single OS-layer file permitted to name an app),
 * and it also makes the run stronger: the properties below are asserted for
 * every shipped built-in rather than for one hand-picked entry.
 */
import assert from "node:assert/strict";
import { afterEach } from "vitest";
import { getDb } from "../db/index.js";
import { agents, servers, users } from "../db/schema.js";
import { BUILT_IN_RAP_APPS } from "./rapBuiltinAppManifests.js";
import type { AppId } from "./rapRegistry.js";
import { getInstalledApp, resolveConversation } from "./rapRegistryStore.js";
import { notify, type DeliverySeam, type NotifyOutcome } from "./rapSyscalls.js";


const ABSENT_APP = "x.not-a-built-in" as AppId;

/** Each delivery-enabled entry's own class, read from the catalog. */
function firstNotificationClass(app: (typeof BUILT_IN_RAP_APPS)[number]): string {
  const classes: readonly string[] = app.manifest.notifications;
  assert.ok(classes.length > 0, `${app.appId} declares no notification class`);
  return classes[0];
}

afterEach(async () => {
  await closeTestDatabase();
});

let seedCounter = 0;
async function seed() {
  seedCounter += 1;
  const suffix = String(700 + seedCounter);
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

function recordingSeam(): DeliverySeam {
  return {
    async raise(conversationId, _payload, invocation): Promise<NotifyOutcome> {
      return { kind: "l1_raised", conversationId, eventId: invocation.eventId };
    },
  };
}

// ---- ITEM 2: obtain session identity, as a hardcoded built-in -------------
test("item 2 GREEN: every built-in resolves a conversation through §3, and it is stable", async () => {
  const { serverId, agentId } = await seed();

  for (const app of BUILT_IN_RAP_APPS) {
    const first = await resolveConversation(serverId, app.appId, agentId);
    assert.equal(first.kind, "resolved", `${app.appId}: a hardcoded built-in must still obtain identity via §3`);
    const second = await resolveConversation(serverId, app.appId, agentId);
    assert.equal(
      second.kind === "resolved" && second.conversationId,
      first.kind === "resolved" && first.conversationId,
      `${app.appId}: A4 requires ONE persistent conversation per (app_id, agent_id)`,
    );
  }
});

test("item 2 POSITIVE CONTROL runs on the production path and goes RED", async () => {
  const { serverId, agentId } = await seed();

  // An app the built-in catalog does not contain. This is the point: it
  // exercises getInstalledApp, which IS in productionRegistry, so the control
  // travels the SAME path as the item it guards.
  assert.equal(await getInstalledApp(serverId, ABSENT_APP), null);
  const refused = await resolveConversation(serverId, ABSENT_APP, agentId);
  assert.notEqual(refused.kind, "resolved", "an app with no registry entry must not obtain identity");
});

/**
 * Server delivery authority is the `notify` syscall claim. #204 split it from
 * notification-class identity: Cleaner keeps `memory_size_hint` while holding no
 * Server authority at all, because its notifications are minted Computer-local
 * and transient by #203.
 */
function declaresServerNotify(app: (typeof BUILT_IN_RAP_APPS)[number]): boolean {
  return (app.manifest.syscalls as readonly string[]).includes("notify");
}

// ---- ITEM 3: deliver one notification -------------------------------------
test("item 3: each Server-delivered built-in's notify reaches the delivery seam", async () => {
  const { serverId, agentId } = await seed();

  // #204: Server delivery authority is declared by the `notify` SYSCALL, not by
  // owning a notification class. `notifications` is class identity alone — an
  // app may name its classes while minting them Computer-local.
  for (const app of BUILT_IN_RAP_APPS.filter((candidate) => declaresServerNotify(candidate))) {
    const outcome = await notify(
      serverId,
      app.appId,
      { agentId },
      { notificationClass: firstNotificationClass(app), body: "" },
      recordingSeam(),
    );
    assert.ok(
      outcome.kind === "l1_raised" || outcome.kind === "l2_woke",
      `${app.appId}: expected the notification to be raised, got ${outcome.kind}`,
    );
  }
});

test("Computer-local built-ins declare no Server notification authority", async () => {
  const { serverId, agentId } = await seed();
  // #204: the Computer-local set is "declares no `notify` syscall". Such an app
  // MAY still own notification classes — identity without Server authority — so
  // this set is no longer keyed on `notifications` being empty.
  const localApps = BUILT_IN_RAP_APPS.filter((candidate) => !declaresServerNotify(candidate));
  assert.ok(localApps.length > 0, "the catalog must exercise the Computer-local declaration shape");

  for (const app of localApps) {
    assert.equal(app.manifest.hooks.length, 0, `${app.appId}: local execution must not register a Server hook`);
    assert.equal((app.manifest.syscalls as readonly string[]).includes("notify"), false, `${app.appId}: local execution must not regain Server notify`);
    // Fails closed for a class it OWNS, not only for an undeclared one —
    // otherwise the refusal could come from class validation rather than from
    // the missing delivery authority this test exists to check.
    const ownedClass = app.manifest.notifications[0] ?? "x.local-only";
    const outcome = await notify(
      serverId,
      app.appId,
      { agentId },
      { notificationClass: ownedClass, body: "" },
      recordingSeam(),
    );
    assert.equal(outcome.kind, "refused", `${app.appId}: Server notification must fail closed`);
  }
});

/**
 * ITEM 3's POSITIVE CONTROL IS NOT RUNNABLE HERE, AND THIS TEST PROVES IT
 * RATHER THAN ASSERTING IT.
 *
 * The control the criteria require is: notify an EXISTING-BUT-UNGRANTED subject
 * and require a refusal. Under v1 every built-in carries grant
 * "all_server_agents", so on the production catalog no such subject can exist.
 * The only refusal still reachable comes from ABSENCE -- a refusal for a
 * DIFFERENT REASON, which is exactly the defect these criteria were repaired
 * for earlier.
 *
 * So item 3 is NOT_OBSERVED on the production path, and this test makes that a
 * measured fact rather than a claim.
 */
test("item 3 NOT_OBSERVED: no existing-but-ungranted subject exists on the production catalog", async () => {
  const { serverId, agentId } = await seed();

  // (a) every built-in grants every agent on the server.
  // #204: Server delivery authority is declared by the `notify` SYSCALL, not by
  // owning a notification class. `notifications` is class identity alone — an
  // app may name its classes while minting them Computer-local.
  for (const app of BUILT_IN_RAP_APPS.filter((candidate) => declaresServerNotify(candidate))) {
    assert.equal(
      app.grant,
      "all_server_agents",
      `${app.appId} must be all_server_agents for this blind spot to be the stated one`,
    );
  }

  // #204: Server delivery authority is declared by the `notify` SYSCALL, not by
  // owning a notification class. `notifications` is class identity alone — an
  // app may name its classes while minting them Computer-local.
  for (const app of BUILT_IN_RAP_APPS.filter((candidate) => declaresServerNotify(candidate))) {
    // (b) the existing agent IS granted -- so the intended control cannot be built.
    const granted = await notify(
      serverId,
      app.appId,
      { agentId },
      { notificationClass: firstNotificationClass(app), body: "" },
      recordingSeam(),
    );
    assert.notEqual(granted.kind, "refused", `${app.appId}: an existing agent is always granted under v1`);

    // (c) the only reachable RED is absence, NOT lack of grant. A control built
    //     on this would be the wrong-reason refusal the criteria reject.
    const refused = await notify(
      serverId,
      app.appId,
      { agentId: "30000000-0000-4000-8000-000000000999" },
      { notificationClass: firstNotificationClass(app), body: "" },
      recordingSeam(),
    );
    assert.equal(refused.kind, "refused", `${app.appId}: a missing agent is refused -- for absence, not for grant`);
  }
});
