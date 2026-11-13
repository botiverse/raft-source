/** Local-first client tables (store/localTables, #triage:458d78f1). */
import assert from "node:assert/strict";
import {
  actorsTable,
  clearLocalTablesForUser,
  createLocalTable,
  localTables,
  serversTable,
  userGeneration,
} from "../src/store/localTables";
import type { ActorRow, LocalTableWrite, ServerScope } from "../src/store/localTables";

type Row = { id: string; name: string };
const scope: ServerScope = { userId: "u1", serverId: "s1" };

function table() {
  return createLocalTable<Row, ServerScope>({ name: "channels", schema: 1, scopeKind: "server", keyOf: (row) => row.id });
}

test("a full list replaces the scope and makes it fresh; a partial answer keeps other rows and freshness", () => {
  const t = table();
  assert.equal(t.freshness(scope), "empty");
  t.upsert(scope, [{ id: "a", name: "A" }]);
  assert.equal(t.freshness(scope), "empty");
  t.replaceFromFullList(scope, [{ id: "b", name: "B" }, { id: "c", name: "C" }]);
  assert.deepEqual(t.list(scope).map((row) => row.id), ["b", "c"]);
  assert.equal(t.freshness(scope), "fresh");
  t.upsert(scope, [{ id: "c", name: "C2" }, { id: "d", name: "D" }]);
  assert.deepEqual(t.list(scope).map((row) => row.name), ["B", "C2", "D"]);
  assert.equal(t.freshness(scope), "fresh");
  t.remove(scope, ["b", "missing"]);
  assert.deepEqual(t.list(scope).map((row) => row.id), ["c", "d"]);
});

test("scopes are separate per user and server", () => {
  const t = table();
  t.upsert(scope, [{ id: "a", name: "A" }]);
  assert.equal(t.get({ userId: "u1", serverId: "s2" }, "a"), undefined);
  assert.equal(t.get({ userId: "u2", serverId: "s1" }, "a"), undefined);
  assert.equal(t.get(scope, "a")?.name, "A");
});

test("list keeps the same array until the scope changes", () => {
  const t = table();
  t.upsert(scope, [{ id: "a", name: "A" }]);
  const first = t.list(scope);
  assert.ok(t.list(scope) === first);
  t.upsert(scope, [{ id: "b", name: "B" }]);
  assert.ok(t.list(scope) !== first);
});

test("hydrate marks the scope local, notifies subscribers once and emits no write", () => {
  const t = table();
  const writes: LocalTableWrite[] = [];
  t.onWrite((write) => writes.push(write));
  let notified = 0;
  t.subscribe(scope, () => notified++);
  t.hydrate(scope, [{ id: "a", name: "A" }]);
  assert.equal(notified, 1);
  assert.equal(t.freshness(scope), "local");
  assert.equal(t.get(scope, "a")?.name, "A");
  assert.equal(writes.length, 0);
  t.replaceFromFullList(scope, [{ id: "b", name: "B" }]);
  assert.equal(t.freshness(scope), "fresh");
  assert.deepEqual(writes.map((write) => write.kind), ["replace"]);
});

test("a late hydrate never overwrites what the server already wrote", () => {
  for (const write of [
    (t: ReturnType<typeof table>) => t.upsert(scope, [{ id: "new", name: "N" }]),
    (t: ReturnType<typeof table>) => t.replaceFromFullList(scope, [{ id: "new", name: "N" }]),
    (t: ReturnType<typeof table>) => t.remove(scope, ["old"]),
  ]) {
    const t = table();
    write(t);
    const before = t.freshness(scope);
    let notified = 0;
    t.subscribe(scope, () => notified++);
    t.hydrate(scope, [{ id: "old", name: "O" }]);
    assert.equal(t.get(scope, "old"), undefined);
    assert.equal(t.freshness(scope), before);
    assert.equal(notified, 0);
  }
});

test("writes report the table, scope, kind and changed keys", () => {
  const t = table();
  const writes: LocalTableWrite[] = [];
  t.onWrite((write) => writes.push(write));
  t.upsert(scope, [{ id: "a", name: "A" }]);
  t.remove(scope, ["a", "x"]);
  t.clear(scope);
  assert.deepEqual(writes, [
    { table: "channels", scope, kind: "upsert", keys: ["a"] },
    { table: "channels", scope, kind: "remove", keys: ["a"] },
    { table: "channels", scope, kind: "clear", keys: [] },
  ]);
});

test("clear empties the scope, keeps subscribers, and allows a new hydrate", () => {
  const t = table();
  let notified = 0;
  t.subscribe(scope, () => notified++);
  t.replaceFromFullList(scope, [{ id: "a", name: "A" }]);
  t.clear(scope);
  assert.equal(t.list(scope).length, 0);
  assert.equal(t.freshness(scope), "empty");
  t.upsert(scope, [{ id: "b", name: "B" }]);
  assert.equal(notified, 3);
  t.clear(scope);
  t.hydrate(scope, [{ id: "c", name: "C" }]);
  assert.equal(t.freshness(scope), "local");
});

test("a table rejects a scope of the wrong kind", () => {
  assert.throws(() => serversTable.replaceFromFullList({ userId: "u1", serverId: "s1" } as never, []), /user scope/);
  assert.throws(() => actorsTable.subscribe({ userId: "u1" } as never, () => {}), /server scope/);
});

test("clearing a user covers every registered table and leaves other users alone", () => {
  const actor: ActorRow = { kind: "agent", id: "a1", homeServerId: "s9", name: "bot", displayName: null, avatarUrl: null };
  actorsTable.upsert({ userId: "u1", serverId: "s1" }, [actor]);
  actorsTable.upsert({ userId: "u1", serverId: "s2" }, [actor]);
  actorsTable.upsert({ userId: "u2", serverId: "s1" }, [actor]);
  serversTable.replaceFromFullList({ userId: "u1" }, []);
  assert.deepEqual(localTables().map((t) => t.name), ["me", "servers", "channels", "memberships", "actors"]);
  clearLocalTablesForUser("u1");
  assert.equal(actorsTable.get({ userId: "u1", serverId: "s1" }, "agent:a1"), undefined);
  assert.equal(actorsTable.get({ userId: "u1", serverId: "s2" }, "agent:a1"), undefined);
  assert.equal(serversTable.freshness({ userId: "u1" }), "empty");
  assert.equal(actorsTable.get({ userId: "u2", serverId: "s1" }, "agent:a1")?.name, "bot");
  assert.equal(actorsTable.scopesOf("u1").length, 0);
});

test("clearing a user bumps that user's generation, even with no scope in memory", () => {
  const before = userGeneration("u3");
  const other = userGeneration("u4");
  clearLocalTablesForUser("u3");
  assert.equal(userGeneration("u3"), before + 1);
  assert.equal(userGeneration("u4"), other);
});

test("an upsert that changes nothing keeps the row, the list and stays silent", () => {
  const t = table();
  t.upsert(scope, [{ id: "a", name: "A" }, { id: "b", name: "B" }]);
  const row = t.get(scope, "a");
  const list = t.list(scope);
  let notified = 0;
  const writes: LocalTableWrite[] = [];
  t.subscribe(scope, () => { notified += 1; });
  t.onWrite((write) => writes.push(write));
  t.upsert(scope, [{ id: "a", name: "A" }, { id: "b", name: "B" }]);
  assert.ok(t.get(scope, "a") === row, "same row reference");
  assert.ok(t.list(scope) === list, "same list reference");
  assert.equal(notified, 0);
  assert.equal(writes.length, 0, "no write event");

  // Only the changed row is written and reported.
  t.upsert(scope, [{ id: "a", name: "A" }, { id: "b", name: "B2" }]);
  assert.ok(t.get(scope, "a") === row);
  assert.equal(notified, 1);
  assert.deepEqual(writes.map((write) => write.keys), [["b"]]);
});

test("an unchanged upsert still counts as a server write for hydrate", () => {
  const t = table();
  t.hydrate(scope, [{ id: "a", name: "A" }]);
  t.upsert(scope, [{ id: "a", name: "A" }]);
  t.hydrate(scope, [{ id: "z", name: "Z" }]);
  assert.deepEqual(t.list(scope).map((row) => row.id), ["a"]);
});
