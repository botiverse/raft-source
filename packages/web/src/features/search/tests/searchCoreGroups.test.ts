// Core's channels and people groups in web search (docs/contracts/web-search.md):
// the local rows paint first; the server's answer for the same words replaces
// a group's rows (order and status included); a group whose request failed
// keeps its local rows and marks the results incomplete.
import assert from "node:assert/strict";
import type { ChannelSearchHit, PersonSearchHit } from "@botiverse/raft-shared";
import { asSearchCursor } from "@botiverse/raft-shared";
import { channelHitToEntity, composeSearchEntityGroups, personHitToEntity } from "../searchEntities";
import type { CoreGroupAnswer, SearchEntityResult } from "../searchEntities";
import { coreGroupsForQuery, coreSearchReducer, readCorePage } from "../useCoreSearchGroups";
import type { CoreSearchState } from "../useCoreSearchGroups";

function channelHit(id: string, overrides: Partial<ChannelSearchHit> = {}): ChannelSearchHit {
  return { id, name: id, description: null, type: "channel", archived: false, joined: true, external: false, guest: false, canPost: true, requiredAction: null, ...overrides };
}

function personHit(id: string, overrides: Partial<PersonSearchHit> = {}): PersonSearchHit {
  return { kind: "human", id, name: id, displayName: null, avatarUrl: null, role: "member", guest: false, dmChannelId: null, canPost: false, requiredAction: "create_dm", ...overrides };
}

function localRow(key: string, type: SearchEntityResult["type"]): SearchEntityResult {
  return { key, type, title: key, subtitle: { kind: "channel" }, channelId: null, channelType: null, machineId: null, agentId: null, userId: null, archivedAt: null };
}

const local = [
  localRow("channel:local-1", "channel"),
  localRow("computer:m1", "computer"),
  localRow("human:local-u", "humanDm"),
];
const loading = { status: "loading" } as const;

test("before the server answers, every group shows its local rows", () => {
  const { groups, incomplete } = composeSearchEntityGroups({ query: "alp", local, channels: loading, people: loading, currentUserId: null });
  assert.deepEqual(groups.map((group) => [group.id, group.source, group.results.map((row) => row.key)]), [
    ["channels", "local", ["channel:local-1"]],
    ["people", "local", ["human:local-u"]],
    ["computers", "local", ["computer:m1"]],
  ]);
  assert.equal(incomplete, false);
});

test("the server's answer replaces the local rows of its group, in the server's order with its status; computers stay local", () => {
  const channels: CoreGroupAnswer<ChannelSearchHit> = {
    status: "ok",
    q: "alp",
    items: [
      channelHit("c-exact", { name: "alp" }),
      channelHit("c-not-joined", { joined: false, canPost: false, requiredAction: "join_channel" }),
      channelHit("c-archived", { archived: true, canPost: false }),
      channelHit("c-joint", { type: "joint", external: true, guest: true }),
    ],
    nextCursor: "channels.4.tag",
    total: 37,
    paging: false,
  };
  const people: CoreGroupAnswer<PersonSearchHit> = {
    status: "ok",
    q: "alp",
    items: [personHit("u-guest", { guest: true, role: "guest" }), personHit("a1", { kind: "agent", displayName: "Alpha", dmChannelId: "dm-1", canPost: true, requiredAction: null })],
    nextCursor: null,
    total: 2,
    paging: false,
  };
  const { groups, incomplete } = composeSearchEntityGroups({ query: " alp ", local, channels, people, currentUserId: "me" });
  assert.equal(incomplete, false);
  const [channelGroup, peopleGroup, computers] = groups;
  assert.deepEqual(
    channelGroup?.results.map((row) => row.key),
    ["channel:c-exact", "channel:c-not-joined", "channel:c-archived", "channel:c-joint"],
    "the local channel is gone: the server decides what is found",
  );
  assert.deepEqual({ source: channelGroup?.source, total: channelGroup?.total, hasMore: channelGroup?.hasMore }, { source: "server", total: 37, hasMore: true });
  assert.deepEqual(channelGroup?.results[1]?.status, { archived: false, joined: false, external: false, guest: false, canPost: false, requiredAction: "join_channel" });
  assert.equal(channelGroup?.results[2]?.status?.archived, true);
  assert.deepEqual({ external: channelGroup?.results[3]?.status?.external, guest: channelGroup?.results[3]?.status?.guest, type: channelGroup?.results[3]?.channelType }, { external: true, guest: true, type: "joint" });
  assert.deepEqual(peopleGroup?.results.map((row) => row.key), ["human:u-guest", "agent:a1"]);
  assert.equal(peopleGroup?.results[0]?.status?.guest, true);
  assert.deepEqual({ type: peopleGroup?.results[1]?.type, channelId: peopleGroup?.results[1]?.channelId, title: peopleGroup?.results[1]?.title }, { type: "agentDm", channelId: "dm-1", title: "Alpha" });
  assert.deepEqual({ id: computers?.id, source: computers?.source }, { id: "computers", source: "local" });
});

test("an answer for other words (the field moved on) never replaces the rows; an empty answer removes the group", () => {
  const stale: CoreGroupAnswer<ChannelSearchHit> = { status: "ok", q: "al", items: [channelHit("old")], nextCursor: null, total: 1, paging: false };
  assert.deepEqual(
    composeSearchEntityGroups({ query: "alp", local, channels: stale, people: loading, currentUserId: null }).groups[0]?.results.map((row) => row.key),
    ["channel:local-1"],
  );
  const empty: CoreGroupAnswer<ChannelSearchHit> = { status: "ok", q: "alp", items: [], nextCursor: null, total: 0, paging: false };
  assert.deepEqual(
    composeSearchEntityGroups({ query: "alp", local, channels: empty, people: loading, currentUserId: null }).groups.map((group) => group.id),
    ["people", "computers"],
    "the server found no channel: the local one is not findable",
  );
});

test("offline or a failed request: the group keeps its local rows and the results are marked incomplete", () => {
  const failed = { status: "failed", q: "alp" } as const;
  const { groups, incomplete } = composeSearchEntityGroups({ query: "alp", local, channels: failed, people: failed, currentUserId: null });
  assert.equal(incomplete, true);
  assert.deepEqual(groups.map((group) => [group.id, group.source]), [["channels", "local"], ["people", "local"], ["computers", "local"]]);
});

test("a person's row: the self DM, an agent's handle, a human's handle under a display name", () => {
  assert.deepEqual(personHitToEntity(personHit("me"), "me").subtitle, { kind: "selfDm" });
  assert.deepEqual(personHitToEntity(personHit("a", { kind: "agent", displayName: "Ada" }), "me").subtitle, { kind: "text", text: "@a" });
  assert.deepEqual(personHitToEntity(personHit("a", { kind: "agent" }), "me").subtitle, { kind: "agentDm" });
  assert.deepEqual(personHitToEntity(personHit("u", { displayName: "Una" }), "me").subtitle, { kind: "text", text: "u" });
  assert.equal(channelHitToEntity(channelHit("c", { description: "about c" })).description, "about c");
});

test("a leading # asks for channels only, @ for people only", () => {
  assert.deepEqual(coreGroupsForQuery("#gen"), ["channels"]);
  assert.deepEqual(coreGroupsForQuery("@ray"), ["people"]);
  assert.deepEqual(coreGroupsForQuery("ray"), ["channels", "people"]);
});

test("paging: a next page appends what isn't shown yet and moves the cursor; an answer of an older query is dropped", () => {
  let state: CoreSearchState = { generation: 0, channels: { status: "idle" }, people: { status: "idle" } };
  state = coreSearchReducer(state, { type: "start", generation: 1, q: "x", groups: ["channels", "people"] });
  state = coreSearchReducer(state, { type: "loaded", generation: 1, group: "channels", state: { status: "ok", q: "x", items: [channelHit("a"), channelHit("b")], nextCursor: asSearchCursor("c1"), total: 3, paging: false } });
  state = coreSearchReducer(state, { type: "paging", generation: 1, group: "channels", paging: true });
  state = coreSearchReducer(state, { type: "paged", generation: 1, group: "channels", items: [channelHit("b"), channelHit("c")], nextCursor: null, total: 3 });
  assert.equal(state.channels.status, "ok");
  if (state.channels.status !== "ok") return;
  assert.deepEqual(state.channels.items.map((item) => item.id), ["a", "b", "c"]);
  assert.equal(state.channels.nextCursor, null);
  assert.equal(state.channels.paging, false);
  const before = state;
  state = coreSearchReducer(state, { type: "loaded", generation: 0, group: "people", state: { status: "failed", q: "old" } });
  assert.ok(state === before, "a late answer of an older generation changes nothing");
});

test("a failed next page is kept on the group (Retry in Load more's place) until the next one starts or lands", () => {
  let state: CoreSearchState = { generation: 0, channels: { status: "idle" }, people: { status: "idle" } };
  state = coreSearchReducer(state, { type: "start", generation: 1, q: "x", groups: ["channels"] });
  state = coreSearchReducer(state, { type: "loaded", generation: 1, group: "channels", state: { status: "ok", q: "x", items: [channelHit("a")], nextCursor: asSearchCursor("c1"), total: 2, paging: false } });
  state = coreSearchReducer(state, { type: "paging", generation: 1, group: "channels", paging: true });
  state = coreSearchReducer(state, { type: "paging", generation: 1, group: "channels", paging: false, failed: true });
  const failedView = composeSearchEntityGroups({ query: "x", local: [], channels: state.channels as CoreGroupAnswer<ChannelSearchHit>, people: { status: "idle" }, currentUserId: null }).groups[0];
  assert.deepEqual({ pageFailed: failedView?.pageFailed, hasMore: failedView?.hasMore, rows: failedView?.results.length }, { pageFailed: true, hasMore: true, rows: 1 });
  state = coreSearchReducer(state, { type: "paging", generation: 1, group: "channels", paging: true });
  assert.equal(state.channels.status === "ok" && state.channels.pageFailed, false, "retrying clears it");
});

test("pending: a group still asked for these words has no server total yet; a failed or unasked one has its local count", () => {
  const pendingOf = (channels: CoreGroupAnswer<ChannelSearchHit>) =>
    composeSearchEntityGroups({ query: "alp", local, channels, people: { status: "idle" }, currentUserId: null }).groups.find((group) => group.id === "channels")?.pending;
  assert.equal(pendingOf(loading), true);
  assert.equal(pendingOf({ status: "ok", q: "al", items: [channelHit("old")], nextCursor: null, total: 1, paging: false }), true, "an answer for other words: the new one is coming");
  assert.equal(pendingOf({ status: "failed", q: "alp" }), false);
  assert.equal(pendingOf({ status: "idle" }), false);
  const composing = composeSearchEntityGroups({ query: "", local, channels: loading, people: loading, currentUserId: null });
  assert.equal(composing.pending, false, "no committed words (an open IME composition): nothing pending");
  assert.ok(composing.groups.every((group) => !group.pending));
  const retrying = composeSearchEntityGroups({ query: "alp", local, channels: { status: "loading", q: "alp", retry: true }, people: { status: "idle" }, currentUserId: null });
  assert.deepEqual({ pending: retrying.pending, retrying: retrying.retrying, incomplete: retrying.incomplete }, { pending: true, retrying: true, incomplete: false });
  assert.equal(pendingOf({ status: "ok", q: "alp", items: [channelHit("a")], nextCursor: null, total: 1, paging: false }), false);
});

test("readCorePage reads the group's page and its total; a group error is no page", () => {
  assert.deepEqual(
    readCorePage({ groups: [{ app: "channels", items: [channelHit("a")], nextCursor: "n", total: 9 }] }, "channels"),
    { items: [channelHit("a")], nextCursor: "n", total: 9 },
  );
  assert.equal(readCorePage({ groups: [{ app: "channels", error: "timeout" }] }, "channels"), null);
  assert.equal(readCorePage({ groups: [] }, "people"), null);
  assert.equal(readCorePage("nope", "people"), null);
});
