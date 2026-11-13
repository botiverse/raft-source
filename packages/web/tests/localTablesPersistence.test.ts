/** store/localTables/persistence: the local tables on the device (#triage:458d78f1). */
import assert from "node:assert/strict";
import { createLocalTable, userGeneration, clearLocalTablesForUser } from "../src/store/localTables";
import type { LocalTable, LocalTableScope, ServerScope, UserScope } from "../src/store/localTables";
import {
  __storedMeRowForTest,
  createLocalTablePersistence,
  LOCAL_TABLES_MAX_AGE_MS,
  LOCAL_TABLES_MAX_SERVERS,
} from "../src/store/localTables/persistence";
import type { LocalTableRecord, LocalTableStore } from "../src/store/localTables/persistence";
import type { User } from "../src/store/authStore";

type Row = { id: string; name: string };

function memoryStore() {
  const records = new Map<string, LocalTableRecord>();
  let gate: Promise<void> | null = null;
  const store: LocalTableStore = {
    async listUser(userId) {
      if (gate) await gate;
      return [...records.values()].filter((record) => record.userId === userId).map((record) => structuredClone(record));
    },
    async listUserIds() {
      return [...new Set([...records.values()].map((record) => record.userId))];
    },
    async put(record) {
      records.set(record.id, structuredClone(record));
    },
    async delete(ids) {
      for (const id of ids) records.delete(id);
    },
    async deleteUser(userId) {
      for (const [id, record] of records) if (record.userId === userId) records.delete(id);
    },
  };
  return { store, records, hold: (until: Promise<void>) => (gate = until) };
}

function tables() {
  const servers = createLocalTable<Row, UserScope>({ name: "servers", schema: 1, scopeKind: "user", keyOf: (row) => row.id });
  const channels = createLocalTable<Row, ServerScope>({ name: "channels", schema: 1, scopeKind: "server", keyOf: (row) => row.id });
  return { servers, channels, list: [servers, channels] as unknown as LocalTable<unknown, LocalTableScope>[] };
}

const u1 = { userId: "u1" };
const s1 = { userId: "u1", serverId: "s1" };

test("a server write reaches the device and comes back at the next boot as local", async () => {
  const { store, records } = memoryStore();
  const a = tables();
  const writer = createLocalTablePersistence(store, { tables: a.list, now: () => 1_000 });
  a.servers.replaceFromFullList(u1, [{ id: "s1", name: "One" }]);
  a.channels.replaceFromFullList(s1, [{ id: "c1", name: "general" }]);
  await writer.flush();
  assert.deepEqual([...records.keys()].sort(), ["channels|u1:s1", "servers|u1"]);
  writer.stop();

  const b = tables();
  const reader = createLocalTablePersistence(store, { tables: b.list, now: () => 2_000 });
  await reader.hydrate("u1");
  assert.equal(b.channels.get(s1, "c1")?.name, "general");
  assert.equal(b.channels.freshness(s1), "local");
  assert.equal(b.servers.freshness(u1), "local");
  reader.stop();
});

test("hydrate keeps only the session's person; without a session the device is cleared", async () => {
  const { store, records } = memoryStore();
  for (const userId of ["u1", "u2"]) {
    await store.put({ id: `servers|${userId}`, table: "servers", schema: 1, userId, serverId: null, savedAt: 1, rows: [{ id: "s", name: "S" }] });
  }
  const t = tables();
  const p = createLocalTablePersistence(store, { tables: t.list, now: () => 2 });
  await p.hydrate("u1");
  assert.deepEqual([...records.keys()], ["servers|u1"]);
  assert.equal(t.servers.get({ userId: "u2" }, "s"), undefined);
  await p.hydrate(null);
  assert.equal(records.size, 0);
  p.stop();
});

test("a clear while the device is being read wins: nothing comes back", async () => {
  const { store, hold } = memoryStore();
  await store.put({ id: "servers|u1", table: "servers", schema: 1, userId: "u1", serverId: null, savedAt: 1, rows: [{ id: "s", name: "S" }] });
  let release!: () => void;
  hold(new Promise<void>((resolve) => (release = resolve)));
  const t = tables();
  const p = createLocalTablePersistence(store, { tables: t.list, now: () => 2 });
  const before = userGeneration("u1");
  const hydrating = p.hydrate("u1");
  clearLocalTablesForUser("u1");
  assert.equal(userGeneration("u1"), before + 1);
  release();
  await hydrating;
  assert.equal(t.servers.get(u1, "s"), undefined);
  assert.equal(t.servers.freshness(u1), "empty");
  p.stop();
});

test("forget deletes the person's tables in memory and on the device", async () => {
  const { store, records } = memoryStore();
  const t = tables();
  const p = createLocalTablePersistence(store, { tables: t.list, now: () => 1 });
  t.channels.replaceFromFullList(s1, [{ id: "c1", name: "general" }]);
  await p.flush();
  t.channels.upsert(s1, [{ id: "c2", name: "random" }]);
  await p.forget("u1");
  await p.flush();
  assert.equal(records.size, 0);
  assert.equal(t.channels.list(s1).length, 0);
  p.stop();
});

test("a server missing from a full server list takes its scopes with it", async () => {
  const { store, records } = memoryStore();
  const t = tables();
  const p = createLocalTablePersistence(store, { tables: t.list, now: () => 1 });
  t.servers.replaceFromFullList(u1, [{ id: "s1", name: "One" }, { id: "s2", name: "Two" }]);
  t.channels.replaceFromFullList(s1, [{ id: "c1", name: "general" }]);
  t.channels.replaceFromFullList({ userId: "u1", serverId: "s2" }, [{ id: "c9", name: "secret" }]);
  await p.flush();
  t.servers.replaceFromFullList(u1, [{ id: "s1", name: "One" }]);
  await p.flush();
  assert.equal(t.channels.get({ userId: "u1", serverId: "s2" }, "c9"), undefined);
  assert.ok(!records.has("channels|u1:s2"));
  assert.ok(records.has("channels|u1:s1"));
  p.stop();
});

test("records of another schema, too old, or past the server cap are dropped", async () => {
  const { store, records } = memoryStore();
  const now = LOCAL_TABLES_MAX_AGE_MS * 2;
  await store.put({ id: "servers|u1", table: "servers", schema: 0, userId: "u1", serverId: null, savedAt: now, rows: [] });
  await store.put({ id: "channels|u1:old", table: "channels", schema: 1, userId: "u1", serverId: "old", savedAt: now - LOCAL_TABLES_MAX_AGE_MS - 1, rows: [] });
  for (let i = 0; i <= LOCAL_TABLES_MAX_SERVERS; i++) {
    await store.put({ id: `channels|u1:s${i}`, table: "channels", schema: 1, userId: "u1", serverId: `s${i}`, savedAt: now - 1_000 + i, rows: [{ id: `c${i}`, name: "x" }] });
  }
  const t = tables();
  const p = createLocalTablePersistence(store, { tables: t.list, now: () => now });
  await p.hydrate("u1");
  await p.flush();
  assert.ok(!records.has("servers|u1"));
  assert.ok(!records.has("channels|u1:old"));
  // The least recently saved server (s0) goes; the newest LOCAL_TABLES_MAX_SERVERS stay.
  assert.ok(!records.has("channels|u1:s0"));
  assert.equal(t.channels.get({ userId: "u1", serverId: "s0" }, "c0"), undefined);
  assert.equal(t.channels.get({ userId: "u1", serverId: `s${LOCAL_TABLES_MAX_SERVERS}` }, `c${LOCAL_TABLES_MAX_SERVERS}`)?.name, "x");
  p.stop();
});

test("the person's row on the device keeps only what the app shows", () => {
  const stored = __storedMeRowForTest({
    id: "u1",
    name: "ada",
    email: "ada@example.com",
    signupRole: "engineer",
    lastObservedTimezone: "Europe/London",
    profileSetupProvider: "github",
    referralSource: "friend",
    usedDesktopAppRecently: true,
    someFieldAddedLater: "x",
  } as unknown as User) as Record<string, unknown>;
  assert.equal(stored.name, "ada");
  assert.equal(stored.email, "ada@example.com");
  assert.equal(stored.referralSource, null);
  for (const field of ["signupRole", "lastObservedTimezone", "profileSetupProvider", "usedDesktopAppRecently", "someFieldAddedLater"]) {
    assert.ok(!(field in stored), field);
  }
});
