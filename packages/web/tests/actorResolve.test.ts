/** Actors table writers and the `/actors/resolve` resolver (store/localTables/actorResolve). */
import assert from "node:assert/strict";
import { AxiosError, AxiosHeaders } from "axios";
import { afterEach, beforeEach, test, vi } from "vitest";
import api from "../src/api/client";
import { useAgentStore } from "../src/store/agentStore";
import { actorKey, actorsTable } from "../src/store/localTables";
import type { ServerScope } from "../src/store/localTables";
import { ACTOR_RESOLVE_MAX_ACTORS } from "@botiverse/raft-shared";
import { requestActors, resetActorResolve, setActorScopeUserIdGetter } from "../src/store/localTables/actorResolve";
import { triggerServerReset } from "../src/store/serverResetRegistry";
import { useServerStore } from "../src/store/serverStore";

const scope: ServerScope = { userId: "me", serverId: "server-1" };
const originalGet = api.get.bind(api);
const originalPost = api.post.bind(api);

/** The server takes UUIDs only. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`;
}

type Call = { url: string; body: { actors: { kind: string; id: string }[] }; serverHeader: unknown };
let calls: Call[] = [];
let answer: (call: Call) => Promise<{ data: unknown }> = async () => ({ data: { actors: [] } });

function httpError(status: number) {
  return new AxiosError("failed", String(status), undefined, undefined, {
    status, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data: {},
  });
}

function resolved(kind: "human" | "agent", id: string, extra: Record<string, unknown> = {}) {
  return { kind, id, homeServerId: "server-2", name: id, displayName: `${id} D`, avatarUrl: `/a/${id}.png`, ...extra };
}

const echo = async (call: Call) => ({ data: { actors: call.body.actors.map((ref) => resolved(ref.kind as "human", ref.id)) } });

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  answer = async () => ({ data: { actors: [] } });
  setActorScopeUserIdGetter(() => "me");
  useServerStore.setState({ current: { id: "server-1", slug: "acme" }, serverEpoch: 1, members: [] } as never);
  useAgentStore.setState({ agents: [] } as never);
  actorsTable.clear(scope);
  resetActorResolve();
  api.post = (async (url: string, body: Call["body"], config?: { headers?: Record<string, unknown> }) => {
    const call = { url, body, serverHeader: config?.headers?.["X-Server-Id"] };
    calls.push(call);
    return answer(call);
  }) as typeof api.post;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  api.get = originalGet;
  api.post = originalPost;
  resetActorResolve();
  actorsTable.clear(scope);
  setActorScopeUserIdGetter(null);
});

async function settle() {
  await vi.advanceTimersByTimeAsync(100);
}

test("refs asked in one tick go out as one batch and fill the table", async () => {
  answer = echo;
  requestActors(scope, [{ kind: "agent", id: uuid(1) }]);
  requestActors(scope, [{ kind: "human", id: uuid(2) }, { kind: "agent", id: uuid(1) }]);
  assert.equal(calls.length, 0, "debounced");
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "/actors/resolve");
  assert.equal(calls[0]!.serverHeader, "server-1");
  assert.deepEqual(calls[0]!.body.actors, [{ kind: "agent", id: uuid(1) }, { kind: "human", id: uuid(2) }]);
  assert.equal(actorsTable.get(scope, actorKey("agent", uuid(1)))?.avatarUrl, `/a/${uuid(1)}.png`);
  assert.equal(actorsTable.get(scope, actorKey("human", uuid(2)))?.homeServerId, "server-2");
});

test("more than 200 refs are split into chunks of 200", async () => {
  const refs = Array.from({ length: ACTOR_RESOLVE_MAX_ACTORS + 5 }, (_, index) => ({ kind: "human" as const, id: uuid(index + 1) }));
  requestActors(scope, refs);
  await settle();
  assert.deepEqual(calls.map((call) => call.body.actors.length), [ACTOR_RESOLVE_MAX_ACTORS, 5]);
});

test("an id that is not a UUID is never sent: it would fail the whole batch", async () => {
  requestActors(scope, [{ kind: "human", id: "system" }, { kind: "agent", id: "not-a-uuid" }, { kind: "agent", id: uuid(3) }]);
  await settle();
  assert.deepEqual(calls.map((call) => call.body.actors), [[{ kind: "agent", id: uuid(3) }]]);
});

test("ids the server leaves out are not asked again; known rows are never asked", async () => {
  actorsTable.upsert(scope, [{ kind: "agent", id: uuid(1), homeServerId: "server-2", name: "k", displayName: null, avatarUrl: null }]);
  requestActors(scope, [{ kind: "agent", id: uuid(1) }, { kind: "agent", id: uuid(2) }]);
  await settle();
  assert.deepEqual(calls.map((call) => call.body.actors), [[{ kind: "agent", id: uuid(2) }]]);
  requestActors(scope, [{ kind: "agent", id: uuid(2) }]);
  await settle();
  assert.equal(calls.length, 1, "an absent id is not re-asked");

  // A server reset forgets what was asked.
  triggerServerReset();
  useServerStore.setState({ current: { id: "server-1", slug: "acme" } } as never);
  requestActors(scope, [{ kind: "agent", id: uuid(2) }]);
  await settle();
  assert.equal(calls.length, 2);
});

test("a sender a roster learned while the batch waited is not asked", async () => {
  requestActors(scope, [{ kind: "agent", id: uuid(1) }, { kind: "human", id: uuid(2) }, { kind: "human", id: uuid(3) }]);
  useAgentStore.setState({ agents: [{ id: uuid(1), name: "local", displayName: null, avatarUrl: null }] } as never);
  useServerStore.setState({ members: [{ userId: uuid(2), name: "alice", displayName: null, avatarUrl: null }] } as never);
  await settle();
  assert.deepEqual(calls.map((call) => call.body.actors), [[{ kind: "human", id: uuid(3) }]]);
});

test("an answer that lands after a server reset is dropped", async () => {
  let release!: (value: { data: unknown }) => void;
  answer = () => new Promise((resolve) => { release = resolve; });
  requestActors(scope, [{ kind: "agent", id: uuid(1) }]);
  await settle();
  assert.equal(calls.length, 1);
  triggerServerReset();
  useServerStore.setState({ current: { id: "server-1", slug: "acme" } } as never);
  release({ data: { actors: [resolved("agent", uuid(1))] } });
  await settle();
  assert.equal(actorsTable.get(scope, actorKey("agent", uuid(1))), undefined);
});

test("the resolver ignores an older server's gravatarHash, whatever its value, and drops malformed entries", async () => {
  answer = async () => ({
    data: {
      actors: [
        resolved("human", uuid(1), { homeServerId: "server-1", gravatarHash: "local-hash" }),
        resolved("human", uuid(2), { homeServerId: "server-2", gravatarHash: 42 }),
        resolved("agent", uuid(3), { name: 42 }),
        resolved("agent", uuid(4), { homeServerId: undefined }),
        { kind: "robot", id: uuid(5) },
        null,
      ],
    },
  });
  requestActors(scope, [1, 2, 3, 4, 5].map((n) => ({ kind: n < 3 ? "human" as const : "agent" as const, id: uuid(n) })));
  await settle();
  const local = actorsTable.get(scope, actorKey("human", uuid(1)));
  assert.ok(local, "this server's person is kept");
  assert.equal("gravatarHash" in local, false, "the hash is not stored");
  const remote = actorsTable.get(scope, actorKey("human", uuid(2)));
  assert.ok(remote, "the other server's person is kept, even with a malformed hash");
  assert.equal("gravatarHash" in remote, false, "the hash is not stored");
  assert.deepEqual(actorsTable.list(scope).map((row) => row.id).sort(), [uuid(1), uuid(2)]);
});

test("a 404 (older server) or 403 (guest) turns the resolver off for the scope", async () => {
  answer = async () => Promise.reject(httpError(404));
  requestActors(scope, [{ kind: "human", id: uuid(1) }]);
  await settle();
  requestActors(scope, [{ kind: "human", id: uuid(2) }]);
  await settle();
  assert.equal(calls.length, 1);

  const other: ServerScope = { userId: "me", serverId: "server-9" };
  answer = async () => Promise.reject(httpError(403));
  requestActors(other, [{ kind: "human", id: uuid(1) }]);
  await settle();
  requestActors(other, [{ kind: "human", id: uuid(3) }]);
  await settle();
  assert.equal(calls.length, 2);
});

test("a failed request warns once and does not retry the same refs", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  answer = async () => Promise.reject(httpError(500));
  requestActors(scope, [{ kind: "human", id: uuid(1) }, { kind: "human", id: uuid(4) }]);
  await settle();
  assert.equal(warn.mock.calls.length, 1, "one warning per batch");
  requestActors(scope, [{ kind: "human", id: uuid(1) }]);
  await settle();
  assert.equal(calls.length, 1);
  // Another ref still goes out: a 500 does not turn the resolver off.
  requestActors(scope, [{ kind: "human", id: uuid(2) }]);
  await settle();
  assert.equal(calls.length, 2);
});

test("loadMembers upserts this server's people (ignoring an older server's hash), keeping other rows", async () => {
  actorsTable.upsert(scope, [{ kind: "human", id: "remote", homeServerId: "server-2", name: "r", displayName: null, avatarUrl: "/r.png" }]);
  api.get = (async () => ({
    data: [{ userId: "u1", name: "alice", displayName: "Alice", avatarUrl: null, gravatarHash: "abc", role: "member" }],
  })) as typeof api.get;
  await useServerStore.getState().loadMembers();
  assert.deepEqual(actorsTable.get(scope, actorKey("human", "u1")), {
    kind: "human", id: "u1", homeServerId: "server-1", name: "alice", displayName: "Alice", avatarUrl: null,
  });
  assert.ok(actorsTable.get(scope, actorKey("human", "remote")), "a partial member list keeps other actors");
  assert.equal(actorsTable.freshness(scope), "empty", "an upsert makes nothing fresh");
});

test("loadAgents upserts agents with their home server, defaulting to the current one", async () => {
  api.get = (async () => ({
    data: [
      { id: "a1", name: "local", displayName: null, avatarUrl: "/l.png", status: "active" },
      { id: "a2", name: "remote", displayName: "Remote", avatarUrl: "/r.png", status: "active", serverId: "server-2" },
    ],
  })) as typeof api.get;
  await useAgentStore.getState().loadAgents();
  assert.equal(actorsTable.get(scope, actorKey("agent", "a1"))?.homeServerId, "server-1");
  assert.equal(actorsTable.get(scope, actorKey("agent", "a2"))?.homeServerId, "server-2");
  assert.equal(actorsTable.get(scope, actorKey("agent", "a2"))?.avatarUrl, "/r.png");
});

test("ensureAgentProfile writes only while its server is still current, and never guesses a home server", async () => {
  let release!: (value: { data: unknown }) => void;
  api.get = (() => new Promise<{ data: unknown }>((resolve) => { release = resolve; })) as typeof api.get;
  // Same epoch, only the current server changes: ensureAgentProfile has no epoch check of its own.
  const loading = useAgentStore.getState().ensureAgentProfile("ext-1");
  useServerStore.setState({ current: { id: "server-3", slug: "other" } } as never);
  release({ data: { id: "ext-1", name: "ext", displayName: null, avatarUrl: "/e.png", status: "active", serverId: "server-2" } });
  await loading;
  assert.equal(actorsTable.get(scope, actorKey("agent", "ext-1")), undefined);

  useServerStore.setState({ current: { id: "server-1", slug: "acme" } } as never);
  useAgentStore.setState({ agents: [] } as never);
  api.get = (async (url: string) => ({
    data: url.endsWith("ext-2")
      ? { id: "ext-2", name: "ext", displayName: null, avatarUrl: "/e.png", status: "active", serverId: "server-2" }
      : { id: "no-home", name: "n", displayName: null, avatarUrl: null, status: "active" },
  })) as typeof api.get;
  await useAgentStore.getState().ensureAgentProfile("ext-2");
  await useAgentStore.getState().ensureAgentProfile("no-home");
  assert.equal(actorsTable.get(scope, actorKey("agent", "ext-2"))?.homeServerId, "server-2");
  assert.equal(actorsTable.get(scope, actorKey("agent", "no-home")), undefined, "no serverId: skipped, not guessed");
});
