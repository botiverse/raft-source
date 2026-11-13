import { createApiTest } from "../test/integration/apiTest";
import assert from "node:assert/strict";
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db/index";
import { channels, durableTasks, jointChannelMembers, jointChannelServers, jointMembershipDepartures, jointMembershipRemovals, messages } from "../db/schema";
import type { Server as SocketServer } from "socket.io";
import { addMember, removeMember } from "../services/serverService";
import {
  configureJointHostSideArchiveEffects,
  jointHostSideArchiveMessage,
  jointHostSideArchiveRegistry,
  setJointHostSideArchiveFailpointForTests,
} from "../services/jointHostSideArchive";
import { claimExpiredDurableTasks, runDurableTask } from "../services/durableTasks";
import type { AgentOrchestrator } from "../services/agentOrchestrator";
import { unarchiveChannel } from "../services/channelService";
import { addBoundHostGuest, guestState, seedJoint, type JointHostSideFixture } from "../test/jointHostSideArchiveFixture";
import { onSocketAccessRevoked } from "../socket/accessRevocation";
import { headers } from "./channels.api.fixtures";
import { channelActorHasCapability, resolveChannelActorContext } from "../lib/channelActorPermissions";

/**
 * cindyz 2026-10-30: when the last human member from the host leaves a joint
 * channel (computed membership), the channel is archived for every side,
 * behind the host's external_channels_v1. Partners' leaves never archive it.
 */
const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true });

const TASK_KIND = "joint.host_side_archive";

type Joint = JointHostSideFixture;

async function addHostMember(baseUrl: string, f: Joint) {
  const added = await fetch(`${baseUrl}/api/channels/${f.hostProjection.id}/members`, {
    method: "POST",
    headers: headers(f.token.hostOwner, f.hostServer.id),
    body: JSON.stringify({ userId: f.hostMember.id }),
  });
  assert.equal(added.status, 200, await added.clone().text());
}

async function leave(baseUrl: string, token: string, serverId: string, channelId: string) {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}/leave`, { method: "POST", headers: headers(token, serverId) });
  assert.equal(response.status, 200, await response.text());
}

async function archivedAt(f: Joint) {
  const rows = await getDb().select({ id: channels.id, archivedAt: channels.archivedAt }).from(channels)
    .where(inArray(channels.id, [f.hostProjection.id, f.peerProjection.id]));
  return Object.fromEntries(rows.map((row) => [row.id === f.hostProjection.id ? "host" : "peer", row.archivedAt !== null]));
}

async function archiveTasks() {
  return getDb().select({ id: durableTasks.id, state: durableTasks.state }).from(durableTasks).where(eq(durableTasks.kind, TASK_KIND));
}

/** The archive runs as the removal's post-commit task: wait for it to settle. */
async function settled() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const tasks = await archiveTasks();
    if (tasks.every((task) => task.state !== "open")) return tasks;
    if (Date.now() > deadline) assert.fail(`archive task still open: ${JSON.stringify(tasks)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function leaveArchivesJoint(baseUrl: string, token: string, serverId: string, channelId: string) {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}`, { headers: headers(token, serverId) });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  return (JSON.parse(raw) as { leaveArchivesJoint?: boolean }).leaveArchivesJoint;
}

async function unarchiveAs(baseUrl: string, token: string, serverId: string, channelId: string, status: number) {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}/unarchive`, { method: "POST", headers: headers(token, serverId) });
  assert.equal(response.status, status, await response.text());
}

async function archivedList(baseUrl: string, token: string, serverId: string) {
  const response = await fetch(`${baseUrl}/api/channels?archived=only`, { headers: headers(token, serverId) });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  return JSON.parse(raw) as Array<{ id: string; joined: boolean; channelCapabilities?: Record<string, boolean> }>;
}

test("the last host member leaving archives the joint for every side; partners still read it", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  assert.equal(await leaveArchivesJoint(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id), true,
    "the host's only member is warned");
  assert.equal(await leaveArchivesJoint(app.baseUrl, f.token.peerMember, f.peerServer.id, f.peerProjection.id), false,
    "a partner's member is not");

  await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
  const tasks = await settled();
  assert.deepEqual(tasks.map((task) => task.state), ["succeeded"]);
  assert.deepEqual(await archivedAt(f), { host: true, peer: true }, "archived on every side");
  const [hostRow] = await getDb().select({ archivedByUserId: channels.archivedByUserId }).from(channels).where(eq(channels.id, f.hostProjection.id));
  assert.equal(hostRow?.archivedByUserId, null, "nobody archived it by hand");

  const read = await fetch(`${app.baseUrl}/api/messages/channel/${f.peerProjection.id}?limit=50`, { headers: headers(f.token.peerMember, f.peerServer.id) });
  const body = await read.text();
  assert.equal(read.status, 200, body);
  const expected = jointHostSideArchiveMessage("JHSA Host");
  const deadline = Date.now() + 5_000;
  while (!(await getDb().select({ content: messages.content }).from(messages)).some((row) => row.content === expected)) {
    if (Date.now() > deadline) assert.fail("the archive's system message was not posted");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const send = await fetch(`${app.baseUrl}/api/messages`, {
    method: "POST",
    headers: headers(f.token.peerMember, f.peerServer.id),
    body: JSON.stringify({ channelId: f.peerProjection.id, content: "still here?" }),
  });
  assert.notEqual(send.status, 200, "the archived channel is read-only for partners");

  // Nobody from the host is left in it: a host admin brings it back.
  await unarchiveAs(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id, 200);
  assert.deepEqual(await archivedAt(f), { host: false, peer: false }, "unarchived");

  await leave(app.baseUrl, f.token.peerMember, f.peerServer.id, f.peerProjection.id);
  await settled();
  assert.equal((await archiveTasks()).length, 1, "a partner's leave after the unarchive doesn't archive it again");
  assert.deepEqual(await archivedAt(f), { host: false, peer: false });
});

test("a host member leaving while another host member remains doesn't archive", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  await addHostMember(app.baseUrl, f);
  assert.equal(await leaveArchivesJoint(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id), false);
  await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
  await settled();
  assert.equal((await archiveTasks()).length, 0);
  assert.deepEqual(await archivedAt(f), { host: false, peer: false });
  assert.equal(await leaveArchivesJoint(app.baseUrl, f.token.hostMember, f.hostServer.id, f.hostProjection.id), true,
    "now the remaining host member is the last");
});

test("partners' members leaving, down to the last, never archive", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  await leave(app.baseUrl, f.token.peerMember, f.peerServer.id, f.peerProjection.id);
  await leave(app.baseUrl, f.token.peerOwner, f.peerServer.id, f.peerProjection.id);
  await settled();
  assert.equal((await archiveTasks()).length, 0);
  const [host] = await getDb().select({ archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, f.hostProjection.id));
  assert.equal(host?.archivedAt, null, "the host's copy stays open");
});

/**
 * Through the channel's remove-member route the host side can't empty: only a
 * host-side manager who is in the channel can remove a member (a partner's
 * owner may not), and they stay. The host side empties through the server:
 */
async function lastHostMemberIsHostMember(baseUrl: string, f: Joint) {
  await addHostMember(baseUrl, f);
  await leave(baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
  await settled();
  assert.deepEqual(await archivedAt(f), { host: false, peer: false });
}

test("a host admin removing the last host member from the host server archives it", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  await lastHostMemberIsHostMember(app.baseUrl, f);
  const removed = await fetch(`${app.baseUrl}/api/servers/${f.hostServer.id}/members/${f.hostMember.id}`, {
    method: "DELETE", headers: headers(f.token.hostAdmin, f.hostServer.id),
  });
  assert.equal(removed.status, 200, await removed.text());
  await settled();
  assert.deepEqual(await archivedAt(f), { host: true, peer: true });
});

test("the last host member leaving the host server archives it", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  await lastHostMemberIsHostMember(app.baseUrl, f);
  const left = await fetch(`${app.baseUrl}/api/servers/${f.hostServer.id}/leave`, {
    method: "POST", headers: headers(f.token.hostMember, f.hostServer.id),
  });
  assert.equal(left.status, 200, await left.text());
  await settled();
  assert.deepEqual(await archivedAt(f), { host: true, peer: true });
});

test("a host member who is also a partner's member leaving the partner server doesn't archive", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  await addMember(f.peerServer.id, f.hostOwner.id, "member");
  await removeMember(f.peerServer.id, f.hostOwner.id, { reason: "left" });
  await settled();
  assert.equal((await archiveTasks()).length, 0);
  assert.deepEqual(await archivedAt(f), { host: false, peer: false });
});

test("two last host members leaving at once archive it exactly once", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  await addHostMember(app.baseUrl, f);
  await Promise.all([
    leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id),
    leave(app.baseUrl, f.token.hostMember, f.hostServer.id, f.hostProjection.id),
  ]);
  const tasks = await settled();
  assert.equal(tasks.length, 1, "exactly one of the two leaves saw the host side empty");
  assert.deepEqual(await archivedAt(f), { host: true, peer: true });
});

test("external channels off for the host: the last host member leaving doesn't archive", async ({ app }) => {
  const f = await seedJoint(app.baseUrl, { externalChannels: false });
  assert.equal(await leaveArchivesJoint(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id), false);
  await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
  await settled();
  assert.equal((await archiveTasks()).length, 0);
  assert.deepEqual(await archivedAt(f), { host: false, peer: false });
});

// P1 failure boundaries: an attempt that fails after the archive committed but
// before the task completed is retried by recovery.

type TestApp = { io: SocketServer; app: { get(name: string): unknown; set(name: string, value: unknown): unknown } };

const EXPECTED = jointHostSideArchiveMessage("JHSA Host");

/**
 * Wraps the app's socket server: records `room:event` for every
 * `io.to(room).emit(event)`, and `room:message:new:<content>` for messages.
 * Installed for the task (configureJointHostSideArchiveEffects) and the routes (app "io").
 */
function recordSocketEvents(app: TestApp) {
  const events: string[] = [];
  const io = new Proxy(app.io, {
    get(target, prop) {
      if (prop === "to") {
        return (room: string) => {
          const operator = target.to(room);
          return new Proxy(operator, {
            get(op, key) {
              if (key === "emit") return (event: string, ...args: unknown[]) => {
                events.push(`${room}:${event}`);
                const content = (args[0] as { content?: unknown } | undefined)?.content;
                if (event === "message:new" && typeof content === "string") events.push(`${room}:message:new:${content}`);
                const channel = (args[0] as { channel?: { id?: unknown; serverId?: unknown } } | undefined)?.channel;
                if (event === "channel:updated" && channel) events.push(`${room}:channel:updated:${String(channel.id)}@${String(channel.serverId)}`);
                return (op.emit as (...a: unknown[]) => boolean)(event, ...args);
              };
              const value = Reflect.get(op, key);
              return typeof value === "function" ? value.bind(op) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  configureJointHostSideArchiveEffects({ io, orchestrator: app.app.get("agentOrchestrator") as AgentOrchestrator });
  app.app.set("io", io);
  return events;
}

function delivered(events: readonly string[], f: Joint, content = EXPECTED) {
  return {
    host: events.includes(`channel:${f.hostProjection.id}:message:new:${content}`),
    peer: events.includes(`channel:${f.peerProjection.id}:message:new:${content}`),
  };
}

async function eventually(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(what);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The partner's own history: GET messages on the partner's copy, as its member. */
async function partnerHistoryShows(baseUrl: string, f: Joint, content = EXPECTED) {
  const response = await fetch(`${baseUrl}/api/messages/channel/${f.peerProjection.id}?limit=50`, { headers: headers(f.token.peerMember, f.peerServer.id) });
  const raw = await response.text();
  assert.equal(response.status, 200, raw);
  return (raw.match(new RegExp(JSON.stringify(content).slice(1, -1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
}

function failOnceAt(stage: "applied" | "published") {
  let failed = false;
  setJointHostSideArchiveFailpointForTests((reached) => {
    if (reached !== stage || failed) return;
    failed = true;
    throw new Error(`failpoint ${stage}`);
  });
}

async function firstAttemptFailed() {
  await eventually(async () => {
    const [task] = await getDb().select({ lastError: durableTasks.lastError, claimedBy: durableTasks.claimedBy })
      .from(durableTasks).where(eq(durableTasks.kind, TASK_KIND));
    return Boolean(task?.lastError) && task?.claimedBy === null;
  }, "first attempt did not fail");
}

/** What the recovery loop does once the retry is due (or a lease expired). */
async function recover() {
  const claims = await claimExpiredDurableTasks({ workerId: "jhsa-recovery", registry: jointHostSideArchiveRegistry, now: new Date(Date.now() + 86_400_000), limit: 10 });
  assert.equal(claims.length, 1, "the task is due");
  return runDurableTask(claims[0]!, jointHostSideArchiveRegistry);
}

async function archiveMessages() {
  return (await getDb().select({ content: messages.content }).from(messages)).filter((row) => row.content === EXPECTED).length;
}

async function archivedStamp(channelId: string) {
  const [row] = await getDb().select({ archivedAt: channels.archivedAt }).from(channels).where(eq(channels.id, channelId));
  return row?.archivedAt?.toISOString() ?? null;
}

test("the archive notice is in the partner's own history and reaches the partner's copy live", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  const events = recordSocketEvents(app as unknown as TestApp);
  await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
  await settled();
  assert.deepEqual(delivered(events, f), { host: true, peer: true }, "message:new on both servers' copies");
  assert.equal(await partnerHistoryShows(app.baseUrl, f), 1, "once, in the partner's history");
  assert.equal(await archiveMessages(), 1);
});

test("a host admin archiving a joint by hand: partners see the notice too (pre-#13168 route bug)", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  const events = recordSocketEvents(app as unknown as TestApp);
  const archived = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/archive`, {
    method: "POST", headers: headers(f.token.hostOwner, f.hostServer.id),
  });
  assert.equal(archived.status, 200, await archived.text());
  const content = "📦 jhsa-host-owner archived this channel";
  await eventually(() => delivered(events, f, content).peer, "the partner's copy got no message:new");
  assert.equal(delivered(events, f, content).host, true);
  assert.equal(await partnerHistoryShows(app.baseUrl, f, content), 1, "in the partner's history");
});

// Failure boundaries: an attempt failing after the archive committed (its
// notice row and inbox facts committed with it) but before the task completed.

test("an attempt failing after the notice row is written, before delivery: the retry delivers that row to both servers", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  const events = recordSocketEvents(app as unknown as TestApp);
  failOnceAt("applied");
  try {
    await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
    await firstAttemptFailed();
    assert.deepEqual(await archivedAt(f), { host: true, peer: true });
    assert.equal(await archiveMessages(), 1, "the row was written with the archive");
    assert.deepEqual(delivered(events, f), { host: false, peer: false }, "nothing delivered yet");

    assert.equal(await recover(), "succeeded");
    assert.deepEqual(delivered(events, f), { host: true, peer: true }, "the retry delivers it to both copies");
    for (const id of [f.hostProjection.id, f.peerProjection.id]) {
      assert.ok(events.includes(`channel:${id}:channel:updated`), `the retry publishes ${id}`);
    }
    assert.equal(await archiveMessages(), 1, "still one row");
    assert.equal(await partnerHistoryShows(app.baseUrl, f), 1);
  } finally {
    setJointHostSideArchiveFailpointForTests(null);
  }
});

test("an attempt failing after its publication: the retry re-delivers the same row and archives nothing twice", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  const events = recordSocketEvents(app as unknown as TestApp);
  failOnceAt("published");
  try {
    await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
    await firstAttemptFailed();
    const stamp = await archivedStamp(f.hostProjection.id);
    events.length = 0;

    assert.equal(await recover(), "succeeded");
    assert.deepEqual(delivered(events, f), { host: true, peer: true });
    assert.equal(await archiveMessages(), 1, "no second row");
    assert.equal(await archivedStamp(f.hostProjection.id), stamp, "not archived again");
    assert.equal(await partnerHistoryShows(app.baseUrl, f), 1);
  } finally {
    setJointHostSideArchiveFailpointForTests(null);
  }
});

test("an attempt failing after the archive commit, then unarchived: the retry doesn't archive again", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  recordSocketEvents(app as unknown as TestApp);
  failOnceAt("applied");
  try {
    await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
    await firstAttemptFailed();
    await unarchiveChannel(f.hostProjection.id);
    assert.deepEqual(await archivedAt(f), { host: false, peer: false });

    assert.equal(await recover(), "succeeded");
    assert.deepEqual(await archivedAt(f), { host: false, peer: false }, "the unarchive stands");
    assert.equal(await archiveMessages(), 1, "the archive's notice stays history; no second one");
  } finally {
    setJointHostSideArchiveFailpointForTests(null);
  }
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

test("overlapping attempts (a lease expired while the first still ran): one archive, one notice, both servers get it", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  // No inline run: the test drives the first attempt with its own claim.
  configureJointHostSideArchiveEffects(null);
  await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
  const [row] = await getDb().select().from(durableTasks).where(eq(durableTasks.kind, TASK_KIND));
  assert.ok(row?.claimedBy && row.attempts === 1, "the first attempt's claim");
  const events = recordSocketEvents(app as unknown as TestApp);

  // Attempt 1 stalls before applying; attempt 2 stalls after its archive
  // committed, with the task still open. Only the attempt number then tells
  // attempt 1's receipt from attempt 2's.
  const firstAtStart = gate(); const resumeFirst = gate();
  const secondApplied = gate(); const resumeSecond = gate();
  setJointHostSideArchiveFailpointForTests(async (stage, attempt) => {
    if (stage === "start" && attempt === 1) { firstAtStart.open(); await resumeFirst.opened; }
    if (stage === "applied" && attempt === 2) { secondApplied.open(); await resumeSecond.opened; }
  });
  try {
    const first = runDurableTask({ task: row, claimedBy: row.claimedBy, attempt: 1 }, jointHostSideArchiveRegistry);
    await firstAtStart.opened;

    // Its lease expires; recovery claims the task (attempt 2) and archives.
    const second = recover();
    await secondApplied.opened;
    assert.deepEqual(await archivedAt(f), { host: true, peer: true });
    const [open] = await getDb().select({ state: durableTasks.state, attempts: durableTasks.attempts }).from(durableTasks).where(eq(durableTasks.kind, TASK_KIND));
    assert.deepEqual(open, { state: "open", attempts: 2 }, "attempt 2 holds the open task");
    // Worst case for attempt 1: the channel is open again, so its re-check passes.
    await unarchiveChannel(f.hostProjection.id);

    resumeFirst.open();
    assert.equal(await first, "fenced");
    assert.deepEqual(await archivedAt(f), { host: false, peer: false }, "attempt 1's archive rolled back with its rejected receipt");
    assert.equal(await archiveMessages(), 1, "attempt 1's notice rolled back with it");

    resumeSecond.open();
    assert.equal(await second, "succeeded");
    assert.deepEqual(delivered(events, f), { host: true, peer: true }, "attempt 2 delivers its notice to both copies");
    assert.equal(await archiveMessages(), 1, "exactly one notice");
    assert.equal(await partnerHistoryShows(app.baseUrl, f), 1);
  } finally {
    resumeFirst.open(); resumeSecond.open();
    setJointHostSideArchiveFailpointForTests(null);
  }
});

// P3: Guests bound to the host's copy are joint members but never host-side
// members, and the archive ends their host membership.

/** Counts the Guest's membership-removal socket revocations (finishRemovedMember's). */
function countGuestRevocations(f: Joint, guestId: string) {
  let count = 0;
  const stop = onSocketAccessRevoked(async (revocation) => {
    if ("userId" in revocation && revocation.userId === guestId && revocation.removedFromServerId === f.hostServer.id) count++;
  });
  return { count: () => count, stop };
}

async function guestCanOpen(baseUrl: string, f: Joint, token: string) {
  const response = await fetch(`${baseUrl}/api/channels/${f.hostProjection.id}`, { headers: headers(token, f.hostServer.id) });
  return response.status === 200;
}

test("a bound host Guest doesn't keep the host side alive: the last member leaving archives it and ends the Guest", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  const g = await addBoundHostGuest(f);
  assert.equal(await guestCanOpen(app.baseUrl, f, g.token), true, "fixture: the Guest can open the channel");
  assert.equal(await leaveArchivesJoint(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id), true,
    "the Guest doesn't count as a host member");
  const revocations = countGuestRevocations(f, g.guest.id);
  try {
    await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
    await settled();
    assert.deepEqual(await archivedAt(f), { host: true, peer: true });
    assert.deepEqual(await guestState(f, g.guest.id), { hostMember: false, jointMember: false }, "the Guest's host membership ended");
    assert.equal(await guestCanOpen(app.baseUrl, f, g.token), false, "the Guest lost access");
    assert.equal(revocations.count(), 1, "the Guest's connections were cut once");
  } finally {
    revocations.stop();
  }
});

test("an attempt failing after the archive ended a Guest: the retry finishes the Guest's removal exactly once", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  const g = await addBoundHostGuest(f);
  recordSocketEvents(app as unknown as TestApp);
  const revocations = countGuestRevocations(f, g.guest.id);
  failOnceAt("applied");
  try {
    await leave(app.baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
    await firstAttemptFailed();
    assert.deepEqual(await guestState(f, g.guest.id), { hostMember: false, jointMember: false }, "the membership ended with the archive");
    assert.equal(revocations.count(), 0, "its after-commit effects not run yet");
    const [task] = await getDb().select({ payload: durableTasks.payload }).from(durableTasks).where(eq(durableTasks.kind, TASK_KIND));
    const ended = (task?.payload as { applied?: { endedGuests?: Array<{ userId: string }> } }).applied?.endedGuests ?? [];
    assert.deepEqual(ended.map((guest) => guest.userId), [g.guest.id], "kept with the applied receipt");

    assert.equal(await recover(), "succeeded");
    assert.equal(revocations.count(), 1, "the retry finished the Guest's removal once");
    assert.equal(await guestCanOpen(app.baseUrl, f, g.token), false);
    assert.equal(await archiveMessages(), 1);
  } finally {
    revocations.stop();
    setJointHostSideArchiveFailpointForTests(null);
  }
});

/**
 * Product (2026-11): an auto-archived joint stays in the host's archived
 * channel list so a host owner/admin can bring it back; no notice. With nobody
 * from the host left in it, the owner/admin is not a member: only while it is
 * archived AND its host side is empty may they see it and unarchive it, and the
 * unarchive rejoins them. Everyone else keeps today's refusals.
 */
const NOT_FOUND = { status: 404, body: { error: "Channel not found" } };
const NOT_ADMIN = { status: 403, body: { error: "Only admins can unarchive channels" } };

async function refusedUnarchive(baseUrl: string, token: string, serverId: string, channelId: string, expected: { status: number; body: unknown }) {
  const response = await fetch(`${baseUrl}/api/channels/${channelId}/unarchive`, { method: "POST", headers: headers(token, serverId) });
  assert.deepEqual({ status: response.status, body: await response.json() }, expected);
}

async function inArchivedList(baseUrl: string, token: string, serverId: string, channelId: string) {
  return (await archivedList(baseUrl, token, serverId)).find((channel) => channel.id === channelId);
}

async function autoArchived(baseUrl: string) {
  const f = await seedJoint(baseUrl);
  await leave(baseUrl, f.token.hostOwner, f.hostServer.id, f.hostProjection.id);
  await settled();
  assert.deepEqual(await archivedAt(f), { host: true, peer: true });
  return f;
}

test("archived with an empty host side: the host owner and admin see it in the archived list", async ({ app }) => {
  const f = await autoArchived(app.baseUrl);
  for (const [who, token] of [["owner", f.token.hostOwner], ["admin", f.token.hostAdmin]] as const) {
    const row = await inArchivedList(app.baseUrl, token, f.hostServer.id, f.hostProjection.id);
    assert.ok(row, `the host ${who} sees it`);
    assert.equal(row.joined, false);
    assert.equal(row.channelCapabilities?.archiveChannels, true, `the host ${who} may unarchive it`);
    const all = await fetch(`${app.baseUrl}/api/channels?archived=include`, { headers: headers(token, f.hostServer.id) });
    assert.ok((await all.json() as Array<{ id: string }>).some((channel) => channel.id === f.hostProjection.id),
      `the web's list (archived=include) has it for the host ${who}`);
  }
  assert.equal(await inArchivedList(app.baseUrl, f.token.hostMember, f.hostServer.id, f.hostProjection.id), undefined,
    "a plain host member doesn't see it");
});

test("a joint archived by hand with host members still in it stays hidden from a host admin outside it", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  await addHostMember(app.baseUrl, f);
  const archived = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/archive`, { method: "POST", headers: headers(f.token.hostOwner, f.hostServer.id) });
  assert.equal(archived.status, 200, await archived.text());
  assert.deepEqual(await archivedAt(f), { host: true, peer: true });
  assert.equal(await inArchivedList(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id), undefined);
  await refusedUnarchive(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id, NOT_FOUND);
  assert.deepEqual(await archivedAt(f), { host: true, peer: true });
});

test("a host admin outside an emptied joint unarchives it and is back in, in one step; it isn't archived again", async ({ app }) => {
  const f = await autoArchived(app.baseUrl);
  await unarchiveAs(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id, 200);
  assert.deepEqual(await archivedAt(f), { host: false, peer: false }, "unarchived on every side");
  const read = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}`, { headers: headers(f.token.hostAdmin, f.hostServer.id) });
  const body = await read.text();
  assert.equal(read.status, 200, body);
  assert.equal((JSON.parse(body) as { joined?: boolean }).joined, true, "the admin is a member");
  const listed = await fetch(`${app.baseUrl}/api/channels`, { headers: headers(f.token.hostAdmin, f.hostServer.id) });
  assert.equal((await listed.json() as Array<{ id: string; joined: boolean }>).find((channel) => channel.id === f.hostProjection.id)?.joined, true,
    "in the admin's channel list");
  assert.equal(await leaveArchivesJoint(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id), true,
    "the admin is now the host side");
  await settled();
  assert.equal((await archiveTasks()).length, 1, "no second archive");
  assert.deepEqual(await archivedAt(f), { host: false, peer: false });
});

test("an emptied joint: a plain host member, a partner's owner, a Guest and an agent keep today's refusals", async ({ app }) => {
  const f = await autoArchived(app.baseUrl);
  await refusedUnarchive(app.baseUrl, f.token.hostMember, f.hostServer.id, f.hostProjection.id, NOT_FOUND);
  await refusedUnarchive(app.baseUrl, f.token.peerOwner, f.peerServer.id, f.peerProjection.id, NOT_ADMIN);
  // The archive ended any bound Guest, so the rule itself: the admin's context
  // as a Guest or as an agent grants nothing.
  const admin = await resolveChannelActorContext(f.hostServer.id, f.hostProjection.id, "user", f.hostAdmin.id);
  assert.ok(admin?.jointAuthority?.recoverableByHostAdmin);
  assert.equal(channelActorHasCapability(admin, "archiveChannels"), true);
  assert.equal(channelActorHasCapability({ ...admin, serverRole: "guest" }, "archiveChannels"), false, "a Guest");
  assert.equal(channelActorHasCapability({ ...admin, actorType: "agent" }, "archiveChannels"), false, "an agent");
  for (const capability of ["addChannelMembers", "removeChannelMembers", "editChannelMetadata", "deleteChannels", "federateChannels"] as const) {
    assert.equal(channelActorHasCapability(admin, capability), false, `nothing else: ${capability}`);
  }
  assert.deepEqual(await archivedAt(f), { host: true, peer: true });
});

test("a host admin outside a joint still can't add members to it (as on staging)", async ({ app }) => {
  const f = await seedJoint(app.baseUrl);
  const added = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/members`, {
    method: "POST", headers: headers(f.token.hostAdmin, f.hostServer.id), body: JSON.stringify({ userId: f.hostAdmin.id }),
  });
  assert.deepEqual({ status: added.status, body: await added.json() }, NOT_FOUND);
  const batch = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/members/batch`, {
    method: "POST", headers: headers(f.token.hostAdmin, f.hostServer.id), body: JSON.stringify({ userIds: [f.hostAdmin.id] }),
  });
  assert.deepEqual({ status: batch.status, body: await batch.json() }, NOT_FOUND);
});

test("someone from the host is back in the archived joint before the admin acts: today's refusal", async ({ app }) => {
  const f = await autoArchived(app.baseUrl);
  assert.ok(await inArchivedList(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id));
  // A partner's member, still in the joint, joins the host server: the host side is no longer empty.
  await addMember(f.hostServer.id, f.peerMember.id, "member");
  assert.equal(await inArchivedList(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id), undefined);
  await refusedUnarchive(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id, NOT_FOUND);
  assert.deepEqual(await archivedAt(f), { host: true, peer: true });
});

test("the unarchive answers, and announces the rejoin, with the host's own copy", async ({ app }) => {
  const f = await autoArchived(app.baseUrl);
  const events = recordSocketEvents(app as unknown as TestApp);
  const response = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/unarchive`, { method: "POST", headers: headers(f.token.hostAdmin, f.hostServer.id) });
  const body = await response.json() as { id: string; serverId: string; archivedAt: string | null };
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual({ id: body.id, serverId: body.serverId, archivedAt: body.archivedAt }, { id: f.hostProjection.id, serverId: f.hostServer.id, archivedAt: null });
  assert.ok(events.includes(`user:${f.hostAdmin.id}:channel:updated:${f.hostProjection.id}@${f.hostServer.id}`), events.join("\n"));
  assert.ok(events.includes(`server:${f.hostServer.id}:channel:members-updated`), events.join("\n"));
  assert.ok(!events.some((event) => event.includes(`channel:updated:${f.peerProjection.id}@`) && event.startsWith(`user:${f.hostAdmin.id}`)),
    "never the partner's copy");
});

test("a host admin whose old membership is still being removed: the unarchive is refused and rolled back until the cleanup ends", async ({ app }) => {
  const f = await autoArchived(app.baseUrl);
  // An old membership of the admin's, its removal recorded but not yet
  // processed (as a departure leaves it): it doesn't count as the host side.
  const [projection] = await getDb().select({ jointId: jointChannelServers.jointChannelId }).from(jointChannelServers)
    .where(eq(jointChannelServers.localChannelId, f.hostProjection.id));
  const jointId = projection!.jointId;
  await getDb().insert(jointChannelMembers).values({ jointChannelId: jointId, userId: f.hostAdmin.id });
  const [departure] = await getDb().insert(jointMembershipDepartures).values({
    jointChannelId: jointId, serverId: f.hostServer.id, localChannelId: f.hostProjection.id,
  }).returning();
  await getDb().insert(jointMembershipRemovals).values({ departureId: departure!.id, userId: f.hostAdmin.id });

  assert.ok(await inArchivedList(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id), "still listed for recovery");
  const refused = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/unarchive`, { method: "POST", headers: headers(f.token.hostAdmin, f.hostServer.id) });
  const body = await refused.json() as { code?: string; error?: string; retryAfterSeconds?: number };
  assert.equal(refused.status, 409, JSON.stringify(body));
  assert.equal(body.code, "joint_cleanup_pending");
  assert.equal(body.error, "This channel is still finishing removing a member. Try again in a moment.");
  assert.deepEqual(await archivedAt(f), { host: true, peer: true }, "rolled back: still archived on every side");
  assert.ok(await inArchivedList(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id), "still listed");

  // The cleanup ends (as jointMembershipDeparture does): the old membership and
  // the removal row are gone and the departure completed.
  await getDb().delete(jointChannelMembers).where(and(eq(jointChannelMembers.jointChannelId, jointId), eq(jointChannelMembers.userId, f.hostAdmin.id)));
  // Halfway (the old row gone, the removal not yet): addHuman's own pending
  // check refuses the join; the same 409, and still archived.
  const halfway = await fetch(`${app.baseUrl}/api/channels/${f.hostProjection.id}/unarchive`, { method: "POST", headers: headers(f.token.hostAdmin, f.hostServer.id) });
  assert.equal(halfway.status, 409, await halfway.clone().text());
  assert.equal((await halfway.json() as { code?: string }).code, "joint_cleanup_pending");
  assert.deepEqual(await archivedAt(f), { host: true, peer: true });
  await getDb().delete(jointMembershipRemovals).where(eq(jointMembershipRemovals.departureId, departure!.id));
  await getDb().update(jointMembershipDepartures).set({ completedAt: new Date() }).where(eq(jointMembershipDepartures.id, departure!.id));
  await unarchiveAs(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id, 200);
  assert.deepEqual(await archivedAt(f), { host: false, peer: false });
  assert.equal(await leaveArchivesJoint(app.baseUrl, f.token.hostAdmin, f.hostServer.id, f.hostProjection.id), true, "the admin is the host side");
});
