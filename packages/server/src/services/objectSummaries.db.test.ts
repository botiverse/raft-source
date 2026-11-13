// Core's object summaries (first-party app mechanism §四) with a fake object
// kind: core decides who sees which object from the homes the kind reports,
// before the app is asked for anything, so summarize never receives a
// reference whose id the viewer can't see, and a summary for a reference core
// didn't hand over is never answered (a summarize answering another number of
// entries is refused). Core reads only a reference's id; the rest reaches
// summarize as it came, and a kind's parseRef may not change the id. One
// answer per reference, in order.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { asServerId, type ObjectSummary, type ServerId } from "@botiverse/raft-shared";
import { featureFlagRules, featureFlags } from "../db/schema";
import type { AppObjectDeleted, AppObjectHome, AppObjectRef, AppWebReader } from "../platform/apps";
import { dbTest as test } from "../test/integration/dbTest";
import { addHuman, createChannel } from "./channelService";
import { objectSummaries, readObjectRefs, visibleObjectsOf, type RegisteredObjectKind } from "./objectSummaries";

const FLAG = `docs_summaries_${randomUUID().slice(0, 8)}`;
const summaryOf = (ref: AppObjectRef): ObjectSummary => ({ title: `doc ${JSON.stringify(ref)}` }) as unknown as ObjectSummary;
/** A fake kind's reference: an id and a page. */
type DocRef = AppObjectRef & { page?: number };
const ref = (id: string, page?: number): DocRef => (page === undefined ? { id } : { id, page });

test("core filters by home before summarize: summarize gets only the references whose id the viewer sees, as they came; every reference answered in order", async ({ db, seed }) => {
  const owner = await seed.human();
  const viewer = await seed.human();
  const author = await seed.human();
  const server = await seed.server({ owner, members: [viewer, author] });
  const serverId = asServerId(server.id);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  const offOwner = await seed.human();
  const off = await seed.server({ owner: offOwner });
  await db.insert(featureFlags).values({ key: FLAG, randomizationUnit: "server", salt: "objects" });
  await db.insert(featureFlagRules).values({ flagKey: FLAG, stage: "server", priority: 0, decision: "allow", values: [server.id, peer.id] });
  const mine = await createChannel(server.id, `sum-mine-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(mine.id, viewer.id);
  const theirs = await createChannel(server.id, `sum-theirs-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(theirs.id, author.id);
  const peerChannel = await createChannel(peer.id, `sum-peer-${randomUUID().slice(0, 6)}`, undefined, "channel");

  const by = (user: { id: string }) => ({ type: "user" as const, id: user.id });
  const at = (sid: ServerId, homeKind: AppObjectHome["homeKind"], homeChannelId: string | null, made = by(author)): AppObjectHome => ({ serverId: sid, homeKind, homeChannelId, author: made });
  const homes = new Map<string, AppObjectHome>([
    ["in-my-channel", at(serverId, "conversation", mine.id)],
    ["in-their-channel", at(serverId, "conversation", theirs.id)],
    ["server-home", at(serverId, "server", null)],
    ["public", at(serverId, "public", null)],
    ["peer-channel", at(asServerId(peer.id), "conversation", peerChannel.id)],
    ["peer-server-home", at(asServerId(peer.id), "server", null)],
    ["peer-public", at(asServerId(peer.id), "public", null)],
    ["off-public", at(asServerId(off.id), "public", null)],
    ["orphan-of-another", at(serverId, "conversation", null)],
    ["orphan-of-mine", at(serverId, "conversation", null, by(viewer))],
  ]);
  const homesAsked: string[][] = [];
  const handed: AppObjectRef[][] = [];
  const registered: RegisteredObjectKind = {
    app: { id: "docs", flag: FLAG },
    objectKind: {
      kind: "doc",
      homes: async (ids) => {
        homesAsked.push([...ids]);
        return new Map(ids.flatMap((id) => (homes.has(id) ? [[id, homes.get(id)!] as const] : [])));
      },
      parseRef: (value) => value,
      summarize: async (_viewer, refs) => {
        handed.push([...refs]);
        // Nothing to show at page 9.
        return refs.map((asked) => ((asked as DocRef).page === 9 ? undefined : summaryOf(asked)));
      },
    },
  };
  const reader: AppWebReader = { userId: viewer.id, serverId, sessionFamilyId: null };
  const asked = [
    ref("in-their-channel"), ref("in-my-channel"), ref("missing"), ref("server-home"), ref("peer-channel"), ref("public"), ref("peer-server-home"),
    ref("peer-public"), ref("off-public"), ref("orphan-of-another"), ref("orphan-of-mine"), ref("in-my-channel"),
    ref("in-my-channel", 2), ref("in-their-channel", 2), ref("public", 9),
  ];
  const visibleIds = ["in-my-channel", "server-home", "public", "peer-public", "orphan-of-mine"];
  const ok = (asking: DocRef) => visibleIds.includes(asking.id) && asking.page !== 9;

  const answers = await objectSummaries(reader, registered, asked);
  assert.equal(homesAsked.length, 1, "one homes call");
  assert.deepEqual([...homesAsked[0]!].sort(), [...new Set(asked.map((asking) => asking.id))].sort(), "homes gets each id once");
  assert.equal(handed.length, 1, "one summarize call");
  assert.deepEqual(handed[0], asked.filter((asking) => visibleIds.includes(asking.id)), "summarize gets only the references whose id is visible, in order, extra fields kept");
  assert.deepEqual(answers.map((answer) => answer.ref), asked, "one answer per requested reference, in order, echoing it");
  assert.deepEqual(answers.map((answer) => (answer.ok ? "ok" : answer.reason)), asked.map((asking) => (ok(asking) ? "ok" : "unavailable")));
  assert.deepEqual(answers[5], { ref: ref("public"), ok: true, summary: summaryOf(ref("public")) });
  assert.deepEqual(answers[12], { ref: ref("in-my-channel", 2), ok: true, summary: summaryOf(ref("in-my-channel", 2)) }, "the same object at another page is its own answer");
  assert.deepEqual(answers[0], { ref: ref("in-their-channel"), ok: false, reason: "unavailable" }, "one it can't see");
  assert.deepEqual(answers[2], { ref: ref("missing"), ok: false, reason: "unavailable" }, "a missing id reads as one it can't see");
  assert.deepEqual(answers[14], { ref: ref("public", 9), ok: false, reason: "unavailable" }, "nothing to show at a reference reads the same");

  // Nothing visible: summarize isn't called at all.
  handed.length = 0;
  assert.deepEqual(await objectSummaries(reader, registered, [ref("in-their-channel"), ref("missing", 1)]), [
    { ref: ref("in-their-channel"), ok: false, reason: "unavailable" },
    { ref: ref("missing", 1), ok: false, reason: "unavailable" },
  ]);
  assert.equal(handed.length, 0);

  // A summarize answering another number of entries than references is a bug, never answered.
  for (const wrong of [(refs: readonly AppObjectRef[]) => [...refs.map(summaryOf), summaryOf(ref("in-their-channel"))], (refs: readonly AppObjectRef[]) => refs.slice(1).map(summaryOf)]) {
    const broken: RegisteredObjectKind = { ...registered, objectKind: { ...registered.objectKind, summarize: async (_viewer, refs) => wrong(refs) } };
    await assert.rejects(objectSummaries(reader, broken, [ref("public", 9), ref("public")]), /doc summarize answered \d entries for 2 references/);
  }

  // The filter alone: the server's owner sees another's orphan (owners and admins do), not a private channel it isn't in.
  const ownerSees = await visibleObjectsOf({ type: "user", id: owner.id, serverId }, registered, [...homes.keys()]);
  assert.ok(ownerSees.has("orphan-of-another") && !ownerSees.has("in-my-channel"), JSON.stringify([...ownerSees]));
});

test("a deleted object: core decides on the home it had, exactly as for a live one, before the kind's deleted summary; anyone else gets the plain `unavailable`", async ({ db, seed }) => {
  const owner = await seed.human();
  const viewer = await seed.human();
  const server = await seed.server({ owner, members: [viewer] });
  const serverId = asServerId(server.id);
  const peerOwner = await seed.human();
  const peer = await seed.server({ owner: peerOwner });
  const flag = `${FLAG}_gone`;
  await db.insert(featureFlags).values({ key: flag, randomizationUnit: "server", salt: "objects" });
  await db.insert(featureFlagRules).values({ flagKey: flag, stage: "server", priority: 0, decision: "allow", values: [server.id, peer.id] });
  const mine = await createChannel(server.id, `gone-mine-${randomUUID().slice(0, 6)}`, undefined, "private");
  await addHuman(mine.id, viewer.id);
  const theirs = await createChannel(server.id, `gone-theirs-${randomUUID().slice(0, 6)}`, undefined, "private");
  const at = (sid: ServerId, homeKind: AppObjectHome["homeKind"], homeChannelId: string | null): AppObjectHome => ({ serverId: sid, homeKind, homeChannelId, author: { type: "user", id: owner.id } });
  const live = new Map<string, AppObjectHome>([["live-mine", at(serverId, "conversation", mine.id)]]);
  const gone = new Map<string, AppObjectHome>([
    ["gone-mine", at(serverId, "conversation", mine.id)],
    ["gone-theirs", at(serverId, "conversation", theirs.id)],
    ["gone-peer-server", at(asServerId(peer.id), "server", null)],
    ["gone-peer-public", at(asServerId(peer.id), "public", null)],
    // A kind that reports a live id as deleted too is never asked about it: core asks only for ids `homes` left out.
    ["live-mine", at(serverId, "conversation", mine.id)],
  ]);
  const goneAsked: string[][] = [];
  const goneHanded: string[][] = [];
  const deletedSummaryOf = (id: string) => ({ id, gone: true }) as unknown as AppObjectDeleted;
  const registered: RegisteredObjectKind = {
    app: { id: "docs", flag },
    objectKind: {
      kind: "doc",
      homes: async (ids) => new Map(ids.flatMap((id) => (live.has(id) ? [[id, live.get(id)!] as const] : []))),
      parseRef: (value) => value,
      summarize: async (_viewer, refs) => refs.map(summaryOf),
      deleted: {
        homes: async (ids) => {
          goneAsked.push([...ids]);
          return new Map(ids.flatMap((id) => (gone.has(id) ? [[id, gone.get(id)!] as const] : [])));
        },
        // Answers even for ids it wasn't handed: core keeps only the ones it let through.
        summarize: async (_viewer, ids) => {
          goneHanded.push([...ids]);
          return new Map([...ids, "gone-theirs"].map((id) => [id, deletedSummaryOf(id)]));
        },
      },
    },
  };
  const reader: AppWebReader = { userId: viewer.id, serverId, sessionFamilyId: null };
  const asked = [ref("gone-mine"), ref("gone-theirs"), ref("gone-peer-server"), ref("gone-peer-public"), ref("missing"), ref("live-mine"), ref("gone-mine", 2)];
  const answers = await objectSummaries(reader, registered, asked);
  assert.deepEqual(goneAsked, [["gone-mine", "gone-theirs", "gone-peer-server", "gone-peer-public", "missing"]], "asked once, only for the ids `homes` left out");
  assert.deepEqual(goneHanded.map((ids) => [...ids].sort()), [["gone-mine", "gone-peer-public"]], "summarized only for the ones the viewer could see");
  const unavailable = (asking: DocRef) => ({ ref: asking, ok: false, reason: "unavailable" });
  const deleted = (asking: DocRef) => ({ ref: asking, ok: false, reason: "deleted", deleted: deletedSummaryOf(asking.id) });
  assert.deepEqual(answers, [
    deleted(ref("gone-mine")),
    unavailable(ref("gone-theirs")),
    unavailable(ref("gone-peer-server")),
    deleted(ref("gone-peer-public")),
    unavailable(ref("missing")),
    { ref: ref("live-mine"), ok: true, summary: summaryOf(ref("live-mine")) },
    deleted(ref("gone-mine", 2)),
  ]);

  // The flags as for a live one: the peer turns the app off, its public one is plain `unavailable`.
  await db.update(featureFlagRules).set({ values: [server.id] }).where(eq(featureFlagRules.flagKey, flag));
  assert.deepEqual(await objectSummaries(reader, registered, [ref("gone-peer-public")]), [unavailable(ref("gone-peer-public"))]);
  // A kind without `deleted`: every deleted object is plain `unavailable`.
  const plain: RegisteredObjectKind = { ...registered, objectKind: { ...registered.objectKind, deleted: undefined } };
  assert.deepEqual(await objectSummaries(reader, plain, [ref("gone-mine")]), [unavailable(ref("gone-mine"))]);
});

test("a kind reads its own references; one it refuses, or one it gives another id, refuses the request", () => {
  const kind = (parseRef: RegisteredObjectKind["objectKind"]["parseRef"]): RegisteredObjectKind => ({
    app: { id: "docs", flag: FLAG },
    objectKind: { kind: "doc", homes: async () => new Map(), parseRef, summarize: async () => [] },
  });
  const pages = kind((value) => (value.page === undefined || typeof value.page === "number" ? (value as DocRef) : null));
  assert.deepEqual(readObjectRefs(pages, [{ id: "a" }, { id: "a", page: 2 }]), [ref("a"), ref("a", 2)], "the kind's own fields kept");
  assert.equal(readObjectRefs(pages, [{ id: "a" }, { id: "b", page: "2" }]), null, "one it refuses");
  assert.equal(readObjectRefs(kind((value) => ({ ...value, id: `${value.id}-other` })), [{ id: "a" }]), null, "another id: core decides on the id the request named");
});
