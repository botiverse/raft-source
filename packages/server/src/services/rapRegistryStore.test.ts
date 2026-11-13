import { dbTest as test } from "../test/integration/dbTest";
import { closeTestDatabase, openTestDatabase } from "../test/integration/database";
import assert from "node:assert/strict";
import { getDb } from "../db/index";
import { agentChannelReadCursors, agents, channelAgents, channels, servers, users } from "../db/schema";
import { and, eq } from "drizzle-orm";
import { createMessage } from "./messageService";
import { BUILT_IN_RAP_APPS } from "./rapBuiltinAppManifests";
import { parseManifest, type AppId, type AppManifest } from "./rapRegistry";
import * as registryStoreModule from "./rapRegistryStore";
import {
  clearHookHandlers,
  createRapRegistryForTests,
  dispatchHook,
  getInstalledApp,
  listInstalledApps,
  listRegistry,
  raiseDueEvent,
  isRegisterableHook,
  registerHookHandlers,
  REGISTERABLE_HOOKS,
  resolveConversation,
  type AppHookHandlers,
  type RapCatalogEntry,
} from "./rapRegistryStore";



// Test-only ids. Real built-in names live in the manifest module and are read
// through its exported constants rather than repeated in OS-layer source.
const ALPHA = "x.alpha" as AppId;
const BETA = "x.beta" as AppId;

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

function manifestOf(appId: AppId, overrides: Record<string, unknown> = {}) {
  return {
    app_id: appId,
    hooks: [],
    syscalls: ["notify", "resolveConversation"],
    notifications: ["x.event"],
    ...overrides,
  };
}

function explicitEntry(appId: AppId, agentIds: readonly string[]): RapCatalogEntry {
  return {
    appId,
    rawManifest: manifestOf(appId),
    grant: { kind: "explicit_agent_ids", agentIds },
  };
}

function parsedManifest(raw: unknown): AppManifest {
  const parsed = parseManifest(raw);
  if (parsed.kind !== "parsed") throw new Error(`manifest rejected: ${parsed.reason} (${parsed.detail})`);
  return parsed.manifest;
}

test("the production catalog is exactly the three closed built-in manifests", async () => {
  const { serverId } = await seed("01");
  assert.deepEqual(BUILT_IN_RAP_APPS, [
    {
      appId: "system.reminder",
      manifest: {
        app_id: "system.reminder",
        hooks: [],
        syscalls: [],
        notifications: [],
        config: {},
      },
      grant: "all_server_agents",
    },
    {
      appId: "system.cleaner",
      manifest: {
        app_id: "system.cleaner",
        hooks: [],
        // #204: Cleaner holds NO Server delivery authority. `notifications`
        // below is class identity only; the classes are minted Computer-local
        // and transient by #203.
        syscalls: [],
        notifications: ["memory_size_hint", "disk_space_hint", "backup_ignore_hint"],
        config: {
          enabled: { type: "boolean", default: true },
          threshold_bytes: {
            type: "integer",
            default: 65_536,
            minimum: 4_096,
            maximum: 1_073_741_824,
          },
          interval_seconds: {
            type: "integer",
            default: 3_600,
            minimum: 900,
            maximum: 604_800,
          },
        },
      },
      grant: "all_server_agents",
    },
    {
      appId: "system.canary",
      manifest: {
        app_id: "system.canary",
        hooks: [],
        syscalls: ["resolveConversation", "notify"],
        notifications: ["canary.ping"],
        config: {},
      },
      grant: "all_server_agents",
    },
  ]);

  const listing = await listRegistry(serverId);
  assert.deepEqual(listing.unreadable, []);
  assert.deepEqual(
    listing.apps.map((app) => app.appId),
    BUILT_IN_RAP_APPS.map((definition) => definition.appId).sort(),
  );
  assert.ok(listing.apps.every((app) => app.installedAt === null));
});

test("onDue receives an OS-minted event envelope and returns the same identity", async () => {
  const { serverId, agentId } = await seed("14");
  const observed: unknown[] = [];
  registerHookHandlers(serverId, ALPHA, {
    onDue: (value) => {
      observed.push(value);
      return { status: "handled" };
    },
  });
  // #6102 removed installApp; all this test needed from it was a PARSED
  // manifest, so parse it directly. The onDue identity contract is unchanged --
  // only how a manifest is obtained changed.
  const parsed = parseManifest({
    app_id: ALPHA,
    hooks: ["onDue"],
    syscalls: ["notify"],
  });
  assert.equal(parsed.kind, "parsed");
  if (parsed.kind !== "parsed") return;

  const input = { subjectAgentId: agentId, data: { version: 1 } };
  const first = await raiseDueEvent(serverId, ALPHA, parsed.manifest, input);
  const second = await raiseDueEvent(serverId, ALPHA, parsed.manifest, input);

  assert.equal(observed.length, 2);
  assert.equal(first.kind, "called");
  assert.equal(second.kind, "called");
  if (first.kind !== "called" || second.kind !== "called") return;
  assert.match(first.eventId ?? "", /^[0-9a-f-]{36}$/);
  assert.match(second.eventId ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(first.eventId, second.eventId, "equal due payloads must remain distinct events");
  assert.equal((observed[0] as { eventId: string }).eventId, first.eventId);
  assert.equal((observed[1] as { eventId: string }).eventId, second.eventId);
  assert.deepEqual(first.result, { status: "handled" });
  assert.deepEqual(second.result, { status: "handled" });
});

test("a resource cannot be allocated for an app that is not installed", async () => {
  const { serverId, agentId } = await seed("15");
  // The other half of the invariant: if a resource could exist without an owner
  // row, the single delete would have nothing to cascade FROM and the orphan
  // would be structural rather than accidental.
  const refused = await resolveConversation(serverId, ALPHA, agentId);
  assert.equal(refused.kind, "refused");
});

test("declared built-in hooks are a subset of the slots registerable on this exact", () => {
  // task #151 made REGISTERABLE_HOOKS the single source that both AppHookHandlers
  // and the runtime not_registerable check derive from, so the slot list is read
  // from there.
  const registerable = new Set<string>(REGISTERABLE_HOOKS);
  assert.ok(registerable.size > 0, "no registerable slots: refuse to report a blind GREEN");

  const unsupported = BUILT_IN_RAP_APPS.flatMap((definition) =>
    definition.manifest.hooks
      .filter((hook) => !registerable.has(hook))
      .map((hook) => `${definition.appId}:${hook}`));
  assert.deepEqual(
    unsupported,
    [],
    "a manifest declared a hook before its registerable event envelope; land declaration, slot, and event-carrying dispatch together",
  );
});

test("install and uninstall capabilities are absent for immutable v1 built-ins", () => {
  assert.equal("installApp" in registryStoreModule, false);
  assert.equal("uninstallApp" in registryStoreModule, false);
});

test("enumeration reports malformed and app-id-mismatched constants instead of dropping them", async () => {
  const { serverId } = await seed("02");
  const registry = createRapRegistryForTests([
    { appId: ALPHA, rawManifest: { app_id: "NOT VALID" }, grant: { kind: "all_server_agents" } },
    { appId: BETA, rawManifest: manifestOf(ALPHA), grant: { kind: "all_server_agents" } },
  ]);
  const listing = await registry.listRegistry(serverId);
  assert.deepEqual(listing.apps, []);
  assert.deepEqual(listing.unreadable, [ALPHA, BETA]);
});

test("registry construction snapshots caller-owned catalog objects", async () => {
  const { serverId } = await seed("13");
  const raw = manifestOf(ALPHA);
  const registry = createRapRegistryForTests([{
    appId: ALPHA,
    rawManifest: raw,
    grant: { kind: "all_server_agents" },
  }]);

  raw.app_id = BETA;
  raw.syscalls = [];
  const stored = await registry.getInstalledApp(serverId, ALPHA);
  assert.ok(stored);
  assert.deepEqual(stored.manifest.syscalls, ["notify", "resolveConversation"]);
});

test("a built-in grants every existing agent on this server, not a build-time id list", async () => {
  const { serverId, agentId } = await seed("03");
  const [laterAgent] = await getDb().insert(agents).values({
    id: "30000000-0000-4000-8000-000000000903",
    serverId,
    name: "created-after-code-shipped",
    runtime: "codex",
  }).returning();
  const appId = BUILT_IN_RAP_APPS[0].appId;

  assert.equal((await resolveConversation(serverId, appId, agentId)).kind, "resolved");
  assert.equal((await resolveConversation(serverId, appId, laterAgent.id)).kind, "resolved");
});

test("the all-agent rule is still scoped to agents that exist on the named server", async () => {
  const first = await seed("04");
  const db = getDb();
  const [secondOwner] = await db.insert(users).values({
    id: "10000000-0000-4000-8000-000000000904",
    email: "owner-second-server@example.com",
    name: "owner-second-server",
    displayName: "owner-second-server",
    passwordHash: "hash",
    emailVerified: true,
  }).returning();
  const [secondServer] = await db.insert(servers).values({
    id: "20000000-0000-4000-8000-000000000904",
    name: "Second server",
    slug: "second-server-04",
    ownerId: secondOwner.id,
  }).returning();
  const appId = BUILT_IN_RAP_APPS[0].appId;

  // The agent exists in this database, but belongs to a different server. A
  // check by id alone would incorrectly grant it.
  const refused = await resolveConversation(secondServer.id, appId, first.agentId);
  assert.deepEqual(refused, { kind: "refused", reason: "no_grant_for_subject" });
});

test("conversation identity is stable across calls and registry reconstruction", async () => {
  const { serverId, agentId } = await seed("06");
  const entry = explicitEntry(ALPHA, [agentId]);
  const firstRegistry = createRapRegistryForTests([entry]);
  const secondRegistry = createRapRegistryForTests([entry]);

  const first = await firstRegistry.resolveConversation(serverId, ALPHA, agentId);
  const again = await firstRegistry.resolveConversation(serverId, ALPHA, agentId);
  const reconstructed = await secondRegistry.resolveConversation(serverId, ALPHA, agentId);
  assert.equal(first.kind, "resolved");
  assert.deepEqual(again, first);
  assert.deepEqual(reconstructed, first);
});

test("a restored conversation with history starts the re-added agent's read position at its latest message", async () => {
  const { serverId, agentId } = await seed("16");
  const registry = createRapRegistryForTests([explicitEntry(ALPHA, [agentId])]);
  const first = await registry.resolveConversation(serverId, ALPHA, agentId);
  assert.equal(first.kind, "resolved");
  if (first.kind !== "resolved") return;
  const cursorOf = async () => (await getDb().select().from(agentChannelReadCursors).where(and(
    eq(agentChannelReadCursors.agentId, agentId),
    eq(agentChannelReadCursors.channelId, first.conversationId),
  )))[0]?.lastReadSeq;
  assert.equal(await cursorOf(), undefined, "a new, empty conversation needs no row: no row is position 0");

  await createMessage(first.conversationId, "agent", agentId, "history one");
  const latest = await createMessage(first.conversationId, "agent", agentId, "history two");
  await getDb().delete(channelAgents).where(eq(channelAgents.channelId, first.conversationId));
  await getDb().update(channels).set({ deletedAt: new Date() }).where(eq(channels.id, first.conversationId));

  const restored = await registry.resolveConversation(serverId, ALPHA, agentId);
  assert.deepEqual(restored, first);
  assert.equal(await cursorOf(), latest.seq, "history from before the re-join is read (#8292's rule)");
});

test("unknown apps are refused rather than receiving ambient identity", async () => {
  const { serverId, agentId } = await seed("07");
  const refused = await resolveConversation(serverId, ALPHA, agentId);
  assert.deepEqual(refused, { kind: "refused", reason: "not_installed" });
  assert.equal(await getInstalledApp(serverId, ALPHA), null);
});

test("GRANT reverse tooth: an existing but explicitly ungranted agent is refused", async () => {
  const { serverId, agentId } = await seed("08");
  const [other] = await getDb().insert(agents).values({
    id: "30000000-0000-4000-8000-000000000908",
    serverId,
    name: "existing-ungranted",
    runtime: "codex",
  }).returning();
  const registry = createRapRegistryForTests([explicitEntry(ALPHA, [agentId])]);

  assert.equal((await registry.resolveConversation(serverId, ALPHA, agentId)).kind, "resolved");
  assert.deepEqual(
    await registry.resolveConversation(serverId, ALPHA, other.id),
    { kind: "refused", reason: "no_grant_for_subject" },
  );
});

test("hook dispatch calls a declared and registered handler", async () => {
  const { serverId } = await seed("09");
  let called = 0;
  registerHookHandlers(serverId, ALPHA, { onEnable: () => { called += 1; } });
  const manifest = parsedManifest(manifestOf(ALPHA, { hooks: ["onEnable"] }));
  assert.deepEqual(await dispatchHook(serverId, ALPHA, "onEnable", manifest), { kind: "called" });
  assert.equal(called, 1);
  clearHookHandlers(serverId, ALPHA);
});

test("hook dispatch refuses undeclared hooks even when a handler exists", async () => {
  const { serverId } = await seed("10");
  let called = 0;
  registerHookHandlers(serverId, ALPHA, { onEnable: () => { called += 1; } });
  const manifest = parsedManifest(manifestOf(ALPHA));
  assert.deepEqual(await dispatchHook(serverId, ALPHA, "onEnable", manifest), { kind: "not_declared" });
  assert.equal(called, 0);
  clearHookHandlers(serverId, ALPHA);
});

test("declared-but-unimplemented and throwing hooks remain distinct outcomes", async () => {
  const { serverId } = await seed("11");
  const manifest = parsedManifest(manifestOf(ALPHA, { hooks: ["onDisable"] }));
  assert.deepEqual(await dispatchHook(serverId, ALPHA, "onDisable", manifest), { kind: "no_handler" });

  registerHookHandlers(serverId, ALPHA, { onDisable: () => { throw new Error("app blew up"); } });
  assert.deepEqual(
    await dispatchHook(serverId, ALPHA, "onDisable", manifest),
    { kind: "threw", error: "app blew up" },
  );
  clearHookHandlers(serverId, ALPHA);
});

test("production enumeration is server-independent but still returns parsed copies", async () => {
  const { serverId } = await seed("12");
  const first = await listInstalledApps(serverId);
  const second = await listInstalledApps("another-server-id");
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
});

/**
 * task #151: `no_handler` used to be returned for a hook the ABI offers no slot
 * for, blaming the app for a door it was never given. The four outcomes below are
 * about DIFFERENT PARTIES, so collapsing any two of them destroys the finding:
 *
 *   not_declared     the app chose not to declare it
 *   not_registerable the PLATFORM offers no slot -- no app could implement it
 *   no_handler       the app could have registered one and did not
 *   called / threw    it actually ran
 */
test("§151: declared-but-unregisterable is attributed to the platform, not to the app", async () => {
  const { serverId } = await seed("151a");

  // Order matters: an undeclared hook is not_declared even though it is also
  // unregisterable. Reversing the two checks would hide the app's own choice.
  const undeclared = parsedManifest(manifestOf(ALPHA, { hooks: ["onDisable"] }));
  assert.deepEqual(
    await dispatchHook(serverId, ALPHA, "onThresholdCrossed", undeclared),
    { kind: "not_declared" },
    "an undeclared hook must report not_declared -- the registerability check must not run first",
  );

  const declared = parsedManifest(manifestOf(ALPHA, { hooks: ["onThresholdCrossed"] }));
  assert.deepEqual(
    await dispatchHook(serverId, ALPHA, "onThresholdCrossed", declared),
    { kind: "not_registerable" },
    "declared but no ABI slot must blame the platform, not the app",
  );

  // A registerable hook with nothing registered is still the app's omission.
  const lifecycle = parsedManifest(manifestOf(ALPHA, { hooks: ["onDisable"] }));
  assert.deepEqual(await dispatchHook(serverId, ALPHA, "onDisable", lifecycle), { kind: "no_handler" });
});

/**
 * @XX's negative control. The ABI decides registerability; a handler smuggled
 * past the type system must not be able to buy a `called`, because the envelope
 * that hook needs still does not exist -- calling it would hand the app an
 * occurrence it cannot identify, which is the silent false success §4d-8b exists
 * to prevent.
 */
test("§151: a cast-injected handler cannot make an unregisterable hook report called", async () => {
  const { serverId } = await seed("151b");
  const declared = parsedManifest(manifestOf(ALPHA, { hooks: ["onThresholdCrossed"] }));

  let ran = false;
  registerHookHandlers(serverId, ALPHA, {
    onThresholdCrossed: () => { ran = true; },
  } as unknown as AppHookHandlers);

  assert.deepEqual(
    await dispatchHook(serverId, ALPHA, "onThresholdCrossed", declared),
    { kind: "not_registerable" },
    "a cast past the slot list must not reach the handler",
  );
  assert.equal(ran, false, "the smuggled handler must never have been invoked");
  clearHookHandlers(serverId, ALPHA);
});

/**
 * @XX's auto-unblock tooth. The runtime classification and the compile-time slot
 * list must be the SAME fact, so that when task #142 lands the onThresholdCrossed
 * envelope, adding the name to REGISTERABLE_HOOKS is the only edit needed and
 * `not_registerable` retires by itself. If this ever needs a second list edited,
 * task #151 has not closed.
 */
test("§151: runtime registerability is derived from the canonical slot list, not a parallel one", async () => {
  for (const hook of REGISTERABLE_HOOKS) {
    assert.equal(isRegisterableHook(hook), true, `${hook} is in the canonical list but classifies as unregisterable`);
  }
  assert.equal(
    isRegisterableHook("onThresholdCrossed"),
    false,
    "onThresholdCrossed is absent from the canonical list, so it must classify as unregisterable",
  );

  // The type side of the same fact: a slot exists exactly for the canonical names.
  const slotted: AppHookHandlers = {};
  assert.deepEqual(Object.keys(slotted), []);
});

