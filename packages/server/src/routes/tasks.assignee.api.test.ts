import { fixturePasswordHash } from "../test/integration/credentials.js";
import { createApiTest } from "../test/integration/apiTest.js";
/**
 * Assignee coverage, driven the way a real user drives it: over HTTP, with a
 * logged-in session, against a task that already exists on the board.
 *
 * The feature @stdrc asked for is "set the assignee", not "claim": a person must
 * be able to assign to someone else, assign to themselves, and **withdraw** an
 * assignment they made to someone else. Permission is member-level, not admin.
 * `claim` stays for un-upgraded Computers.
 *
 * The properties that are easy to get wrong, and are therefore each pinned
 * below rather than left to the happy path:
 *
 *  - **assign must not advance status; claim must.** Handing work to someone
 *    else does not assert on their behalf that it has started.
 *  - **a refused assign writes nothing** — to either table.
 *  - **a lost OCC race changes nothing and reports the current revision**, so
 *    the client can re-read instead of guessing.
 *  - **a no-op re-assign does not burn a revision**, or it would invalidate
 *    every other client's token for no reason.
 */
import assert from "node:assert/strict";

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { users, serverMembers, tasks, taskEvents, messages } from "../db/schema.js";
import { createChannel, addHuman, addAgent } from "../services/channelService.js";
import { createServer } from "../services/serverService.js";
import { createAgent } from "../services/agentService.js";
import * as taskService from "../services/taskService.js";

const test = createApiTest({ humanActivityMuteFlagDefaultEnabled: true, onboardingOpenerFlagDefaultEnabled: false });

async function seedUser(label: string) {
  const [user] = await getDb().insert(users).values({
    email: `${label}-${randomUUID()}@slock.test`,
    name: `${label}-${randomUUID().slice(0, 8)}`,
    displayName: label,
    passwordHash: await fixturePasswordHash("password123"),
    emailVerified: true,
    // Fixed rather than ambient: nothing here depends on "now".
    profileSetupCompletedAt: new Date("2026-01-01T00:00:00.000Z"),
  }).returning();
  return user;
}

async function login(baseUrl: string, email: string) {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  assert.equal(res.status, 200, `login failed for ${email}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

/**
 * Owner + a plain `member` + an agent, all in one channel, plus one task.
 * The member is the interesting actor: everything here must work for someone
 * with no admin capability at all.
 */
async function setup(slug: string) {
  const db = getDb();
  const owner = await seedUser(`${slug}-owner`);
  const member = await seedUser(`${slug}-member`);
  const outsider = await seedUser(`${slug}-outsider`);
  const server = await createServer(`Assign ${slug}`, `${slug}-${randomUUID()}`, owner.id);
  const channel = await createChannel(server.id, slug);
  // Server membership first -- `addHuman` refuses a user who is not already a
  // member of the channel's server.
  await db.insert(serverMembers).values({ serverId: server.id, userId: member.id, role: "member" });
  // The outsider is a server member but NOT in the channel.
  await db.insert(serverMembers).values({ serverId: server.id, userId: outsider.id, role: "member" });
  await addHuman(channel.id, owner.id);
  await addHuman(channel.id, member.id);

  const agent = await createAgent(server.id, `${slug}-agent-${randomUUID().slice(0, 6)}`, { runtime: "claude" });
  await addAgent(channel.id, agent.id);

  const { tasks: [task] } = await taskService.createTasks(
    channel.id, "user", owner.id, [{ title: `${slug} task` }],
  );
  return { owner, member, outsider, agent, server, channel, task };
}

function headers(token: string, serverId: string) {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "X-Server-Id": serverId,
  };
}

async function setAssignee(
  baseUrl: string, token: string, serverId: string, taskId: string, body: unknown,
) {
  return fetch(`${baseUrl}/api/tasks/${taskId}/assignee`, {
    method: "PATCH",
    headers: headers(token, serverId),
    body: JSON.stringify(body),
  });
}

async function readTask(taskId: string) {
  const [row] = await getDb().select().from(tasks).where(eq(tasks.id, taskId));
  return row;
}

test("a plain member can assign a task to someone else — and it does not start the task", async ({ app }) => {
  const { member, owner, server, task } = await setup("assign-basic");
  const token = await login(app.baseUrl, member.email);

  const before = await readTask(task.id);
  assert.equal(before.status, "todo");

  const res = await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });
  assert.equal(res.status, 200, await res.clone().text());

  const after = await readTask(task.id);
  assert.equal(after.claimedById, owner.id, "assignee must be recorded");
  assert.equal(after.claimedByType, "user");
  assert.equal(after.revision, before.revision + 1, "a real assignment bumps the OCC token");

  // ⭐ The asymmetry with claim. Assigning work to someone else must not
  // announce on their behalf that it has started.
  assert.equal(after.status, "todo", "assign must NOT advance status");
  assert.equal(after.claimedAt, null, "assigning to someone else does not stamp claimedAt");
});

test("claim still starts the task — the retained path is not quietly re-pointed at assign", async ({ app }) => {
  const { member, server, task } = await setup("assign-claim-compat");
  const token = await login(app.baseUrl, member.email);

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/claim`, {
    method: "PATCH",
    headers: headers(token, server.id),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const after = await readTask(task.id);
  assert.equal(after.claimedById, member.id);
  assert.equal(after.status, "in_progress", "claim MUST advance todo -> in_progress");
  assert.ok(after.claimedAt instanceof Date, "claim stamps claimedAt");
});

test("assigning to yourself records ownership only — no claimedAt, no status change", async ({ app }) => {
  const { member, server, task } = await setup("assign-self");
  const token = await login(app.baseUrl, member.email);

  const res = await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: member.id },
  });
  assert.equal(res.status, 200, await res.clone().text());

  const after = await readTask(task.id);
  assert.equal(after.claimedById, member.id);
  assert.equal(after.status, "todo", "assign is not claim");
  // ⭐ This assertion is inverted from its first version, deliberately.
  // It used to require claimedAt to be STAMPED on self-assignment, by
  // analogy with `claim`. That was wrong — see the regression test below.
  assert.equal(after.claimedAt, null, "assign must not assert that work started");
});

/**
 * Regression: self-assign must not lock the task out of `in_progress`.
 *
 * `writeCanonicalStatus` rejects `todo -> in_progress` when `claimedAt` is
 * already set, reading it as "someone started this concurrently". Before this
 * was fixed, `assign` stamped `claimedAt` on a self-assignment while leaving
 * the status at `todo` — a combination only `claim` could previously produce,
 * and only alongside `in_progress`. The result: you assigned a task to
 * yourself and then could not start it, with the actively misleading error
 * `task start state changed concurrently`.
 *
 * This matters most for the web flow, where an *assigned* task starts through
 * the status endpoint (an unassigned one goes through claim) — so the UI path
 * for a task you just gave yourself would have been a dead end.
 */
test("self-assign then start: the status route still moves todo -> in_progress", async ({ app }) => {
  const { member, server, task } = await setup("assign-start");
  const token = await login(app.baseUrl, member.email);

  await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: member.id },
  });
  const mid = await readTask(task.id);
  assert.equal(mid.status, "todo");
  assert.equal(mid.claimedAt, null, "precondition: assign left no start-marker");

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/status`, {
    method: "PATCH",
    headers: headers(token, server.id),
    body: JSON.stringify({ status: "in_progress" }),
  });
  assert.equal(res.status, 200, `starting a self-assigned task must work: ${await res.clone().text()}`);

  const after = await readTask(task.id);
  assert.equal(after.status, "in_progress");
  assert.ok(after.claimedAt instanceof Date, "starting the work does stamp claimedAt");
});

test("a member can withdraw an assignment made to someone else", async ({ app }) => {
  const { member, owner, server, task } = await setup("assign-withdraw");
  const token = await login(app.baseUrl, member.email);

  await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });
  // Move it along, so we can prove unassign preserves status.
  await getDb().update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, task.id));

  const res = await setAssignee(app.baseUrl, token, server.id, task.id, { assignee: null });
  assert.equal(res.status, 200, await res.clone().text());

  const after = await readTask(task.id);
  assert.equal(after.claimedById, null, "assignment withdrawn");
  assert.equal(after.claimedByType, null);
  assert.equal(after.claimedAt, null);
  assert.equal(after.status, "in_progress", "unassign must not roll the status back");
});

test("an agent can be the assignee", async ({ app }) => {
  const { member, agent, server, task } = await setup("assign-agent");
  const token = await login(app.baseUrl, member.email);

  const res = await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "agent", id: agent.id },
  });
  assert.equal(res.status, 200, await res.clone().text());

  const after = await readTask(task.id);
  assert.equal(after.claimedByType, "agent");
  assert.equal(after.claimedById, agent.id);
});

test("assigning to someone outside the channel is refused and writes nothing", async ({ app }) => {
  const { member, outsider, server, task } = await setup("assign-outsider");
  const token = await login(app.baseUrl, member.email);
  const before = await readTask(task.id);

  const res = await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: outsider.id },
  });
  assert.equal(res.status, 409, await res.clone().text());

  const after = await readTask(task.id);
  assert.equal(after.claimedById, null, "an invisible obligation must not be created");
  assert.equal(after.revision, before.revision, "a refused assign must not burn a revision");
});

test("a stale expectedRevision loses, changes nothing, and reports the current revision", async ({ app }) => {
  const { member, owner, server, task } = await setup("assign-occ");
  const token = await login(app.baseUrl, member.email);

  const stale = (await readTask(task.id)).revision;
  // Someone else moves first.
  await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: member.id },
  });
  const afterFirst = await readTask(task.id);
  assert.notEqual(afterFirst.revision, stale, "precondition: the first write moved the token");

  const res = await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
    expectedRevision: stale,
  });
  assert.equal(res.status, 409);
  const body = await res.json() as { error: string; currentRevision: number };
  assert.equal(body.currentRevision, afterFirst.revision, "the client is told what to re-read");

  const after = await readTask(task.id);
  assert.equal(after.claimedById, member.id, "the stale writer must not overwrite the winner");
  assert.equal(after.revision, afterFirst.revision, "and must not bump the token");
});

test("re-assigning to the current assignee is a no-op that does not burn a revision", async ({ app }) => {
  const { member, owner, server, task } = await setup("assign-noop");
  const token = await login(app.baseUrl, member.email);

  await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });
  const settled = await readTask(task.id);

  const res = await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });
  assert.equal(res.status, 200);

  const after = await readTask(task.id);
  assert.equal(after.revision, settled.revision, "a no-op must not invalidate other clients' tokens");
});

test("a done task cannot be reassigned", async ({ app }) => {
  const { member, owner, server, task } = await setup("assign-done");
  const token = await login(app.baseUrl, member.email);
  await getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
  const before = await readTask(task.id);

  const res = await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });
  assert.equal(res.status, 409, await res.clone().text());

  const after = await readTask(task.id);
  assert.equal(after.claimedById, before.claimedById);
  assert.equal(after.revision, before.revision);
});

test("every assignment change records exactly one assignee_changed event, with both sides", async ({ app }) => {
  const { member, owner, server, task } = await setup("assign-audit");
  const token = await login(app.baseUrl, member.email);

  await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });
  await setAssignee(app.baseUrl, token, server.id, task.id, { assignee: null });

  const events = await getDb().select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
  const assigneeEvents = events.filter((e) => e.eventType === "assignee_changed");
  assert.equal(assigneeEvents.length, 2, "one event per change, no more and no fewer");

  const [assigned, unassigned] = assigneeEvents;
  assert.equal((assigned.payload as Record<string, unknown>).assigneeId, owner.id);
  assert.equal((assigned.payload as Record<string, unknown>).previousAssigneeId, null);
  assert.equal((unassigned.payload as Record<string, unknown>).assigneeId, null);
  assert.equal(
    (unassigned.payload as Record<string, unknown>).previousAssigneeId, owner.id,
    "the audit trail must say who it was taken from",
  );
});

test("assignment never writes the message side", async ({ app }) => {
  const { member, owner, server, task } = await setup("assign-no-shadow");
  const token = await login(app.baseUrl, member.email);

  await setAssignee(app.baseUrl, token, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });

  const rows = await getDb().select().from(messages);
  assert.ok(
    !rows.some((m) => m.taskStatus != null || m.taskAssigneeId != null),
    "P3 made messages.task_* dead storage; assignment must not revive it",
  );
});

test("a malformed assignee body is rejected before anything is written", async ({ app }) => {
  const { member, server, task } = await setup("assign-validation");
  const token = await login(app.baseUrl, member.email);
  const before = await readTask(task.id);

  for (const [label, body] of [
    ["missing assignee key", {}],
    ["bad type", { assignee: { type: "robot", id: "x" } }],
    ["missing id", { assignee: { type: "user" } }],
    ["non-integer revision", { assignee: null, expectedRevision: 1.5 }],
  ] as const) {
    const res = await setAssignee(app.baseUrl, token, server.id, task.id, body);
    assert.equal(res.status, 400, `${label} should be a 400, got ${res.status}`);
  }

  const after = await readTask(task.id);
  assert.equal(after.revision, before.revision, "no rejected body may have written");
});

/**
 * @stdrc's ruling (2026-08-03): only DELETE is creator/admin-restricted.
 * Everything else — create, create+assign, claim, unclaim, assign, and
 * **status** — is a channel-member action. "你想象一个正常的 to-do list
 * 管理软件，它没理由是只有 admin 能操作的。"
 *
 * These pin the newly-opened surfaces over HTTP so a future tightening has to
 * fail a test rather than pass silently.
 */
test("a non-assignee member can change status — status is not assignee-only", async ({ app }) => {
  const { member, owner, server, task } = await setup("perm-status");
  const memberToken = await login(app.baseUrl, member.email);

  // Give the task to the owner, then have a different member move it.
  await setAssignee(app.baseUrl, memberToken, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/status`, {
    method: "PATCH",
    headers: headers(memberToken, server.id),
    body: JSON.stringify({ status: "in_progress" }),
  });
  assert.equal(res.status, 200, `a non-assignee must be able to move status: ${await res.clone().text()}`);

  const after = await readTask(task.id);
  assert.equal(after.status, "in_progress");
  assert.equal(after.claimedById, owner.id, "changing status must not steal the assignee");
});

test("a non-assignee member can unclaim someone else's task", async ({ app }) => {
  const { member, owner, server, task } = await setup("perm-unclaim");
  const memberToken = await login(app.baseUrl, member.email);
  await setAssignee(app.baseUrl, memberToken, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/unclaim`, {
    method: "PATCH",
    headers: headers(memberToken, server.id),
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await readTask(task.id)).claimedById, null);
});

test("delete stays restricted — a non-creator member is refused", async ({ app }) => {
  const { member, server, task } = await setup("perm-delete");
  const memberToken = await login(app.baseUrl, member.email);

  // The task was created by the owner; `member` is neither creator nor admin.
  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}`, {
    method: "DELETE",
    headers: headers(memberToken, server.id),
  });
  assert.equal(res.status, 403, "delete is the one action that stays creator/admin-only");
  assert.ok(await readTask(task.id), "the task must still exist");
});

/**
 * Opening unclaim to members split two things that used to be the same row: the
 * ACTOR doing the unclaiming, and the person being unclaimed. The event writer
 * had been passing the *previous assignee's* type as the actor type together
 * with the *requester's* id -- correct only while the two were forced to match.
 *
 * @stdrc: "unclaim也只需要member，是因为他本质就是set assignee为空" -- so its
 * audit record has to answer the same questions `assignTask(null)` answers.
 */
test("unclaiming someone else's task records the actor, and who it was taken from", async ({ app }) => {
  const { member, owner, server, task } = await setup("unclaim-audit");
  const memberToken = await login(app.baseUrl, member.email);

  // The task belongs to a human; an agent is not involved yet.
  await setAssignee(app.baseUrl, memberToken, server.id, task.id, {
    assignee: { type: "user", id: owner.id },
  });

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/unclaim`, {
    method: "PATCH",
    headers: headers(memberToken, server.id),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const events = await getDb().select().from(taskEvents).where(eq(taskEvents.taskId, task.id));
  const unclaimEvent = events
    .filter((e) => e.eventType === "assignee_changed")
    .at(-1);
  assert.ok(unclaimEvent, "unclaim must leave an assignee_changed event");

  // The actor is the member who pressed the button...
  assert.equal(unclaimEvent.actorType, "user");
  assert.equal(unclaimEvent.actorId, member.id, "actor must be the requester, not the previous assignee");

  // ...and the trail still says who lost the task.
  const payload = unclaimEvent.payload as Record<string, unknown>;
  assert.equal(payload.assigneeId, null);
  assert.equal(payload.previousAssigneeId, owner.id, "taking work off someone must be attributable");
  assert.equal(payload.previousAssigneeType, "user");
});

/**
 * The case that actually pins the actor TYPE. The test above happens to have a
 * human assignee and a human actor, so the old buggy expression
 * (`previousAssigneeType ?? "user"`) produced the right answer by coincidence.
 * Here the task belongs to an AGENT and a HUMAN takes it away, so the buggy form
 * writes actorType "agent" alongside a user's id -- an actor tuple that resolves
 * to nobody.
 */
test("a human unclaiming an agent's task is not recorded as an agent", async ({ app }) => {
  const { member, agent, server, task } = await setup("unclaim-actor-type");
  const memberToken = await login(app.baseUrl, member.email);

  await setAssignee(app.baseUrl, memberToken, server.id, task.id, {
    assignee: { type: "agent", id: agent.id },
  });

  const res = await fetch(`${app.baseUrl}/api/tasks/${task.id}/unclaim`, {
    method: "PATCH",
    headers: headers(memberToken, server.id),
  });
  assert.equal(res.status, 200, await res.clone().text());

  const unclaimEvent = (await getDb().select().from(taskEvents).where(eq(taskEvents.taskId, task.id)))
    .filter((e) => e.eventType === "assignee_changed")
    .at(-1);
  assert.ok(unclaimEvent);

  assert.equal(unclaimEvent.actorType, "user", "the actor is the human who pressed unclaim");
  assert.equal(unclaimEvent.actorId, member.id);

  const payload = unclaimEvent.payload as Record<string, unknown>;
  assert.equal(payload.previousAssigneeType, "agent", "the agent is who it was taken FROM");
  assert.equal(payload.previousAssigneeId, agent.id);
});

/**
 * Real-world unlocker, from external ticket `9a84e7f7` (#proj-frontend:982079b2,
 * relayed by @Stone 2026-08-07). The reported deadlock, on shipped code:
 *
 *   an implementation agent holds a task that has reached `in_review`; the
 *   independent review agent cannot take it, because the task is still reserved
 *   to the implementation agent. On staging there is NO post-create assign
 *   surface at all (`assignTask` does not exist there) and `unclaim` refuses
 *   anyone who is not the assignee — so nobody, admin included, can release it.
 *   The reporter's only escape was to file a successor task, which they
 *   explicitly did not want to do.
 *
 * This pins the whole escape route end to end, not just that the endpoint
 * answers 200: a THIRD party clears the reservation while the task sits in
 * `in_review`, and a DIFFERENT actor then successfully claims it.
 */
test("in_review deadlock: a third party can unassign, and a different actor can then claim", async ({ app }) => {
  const { owner, member, agent, server, channel, task } = await setup("inreview-unlock");
  const ownerToken = await login(app.baseUrl, owner.email);
  const memberToken = await login(app.baseUrl, member.email);

  // The implementation agent holds it, and the work has reached in_review.
  await setAssignee(app.baseUrl, ownerToken, server.id, task.id, {
    assignee: { type: "agent", id: agent.id },
  });
  const toReview = await fetch(`${app.baseUrl}/api/tasks/${task.id}/status`, {
    method: "PATCH",
    headers: headers(ownerToken, server.id),
    body: JSON.stringify({ status: "in_review" }),
  });
  assert.equal(toReview.status, 200, await toReview.clone().text());
  assert.equal((await readTask(task.id)).claimedById, agent.id, "precondition: reserved to the agent");

  // ⭐ The step that did not exist before: someone who is NOT the assignee
  // clears the reservation, while the task is in_review.
  const released = await setAssignee(app.baseUrl, memberToken, server.id, task.id, { assignee: null });
  assert.equal(released.status, 200, `a third party must be able to release: ${await released.clone().text()}`);

  const afterRelease = await readTask(task.id);
  assert.equal(afterRelease.claimedById, null, "the reservation must actually be gone");
  assert.equal(afterRelease.status, "in_review", "releasing must NOT roll the work backwards");

  // ⭐ And the point of the whole exercise: a different actor can now take it.
  const claimed = await fetch(`${app.baseUrl}/api/tasks/${task.id}/claim`, {
    method: "PATCH",
    headers: headers(memberToken, server.id),
  });
  assert.equal(claimed.status, 200, `the review actor must be able to claim: ${await claimed.clone().text()}`);
  assert.equal((await readTask(task.id)).claimedById, member.id, "the task is now held by the new actor");
  assert.ok(channel);
});
