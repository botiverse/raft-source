import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import {
  __setFailpointsForTests,
  __resetFailpointsForTests,
  InMemoryFailpointRegistry,
} from "@botiverse/raft-shared";
import type { Database } from "../db";
import { messages, tasks } from "../db/schema";
import {
  createJointChannel,
  acceptJointChannelInvite,
  removeHuman,
  addHuman,
} from "../services/channelService";
import {
  createTasks,
  assignTask,
  updateTaskStatus,
} from "../services/taskService";
import { JointTaskWriteDeniedError } from "../services/jointTaskWriteAuthority";
import { createHttpClient } from "./integration/http";
import { createSeed } from "./integration/seed";
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function waitingOn(db: Database, blockerPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows =
      await db.execute(sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
      AND wait_event_type='Lock' AND ${blockerPid}=ANY(pg_blocking_pids(pid))`);
    if (rows.rows.length) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("actual competing writer did not wait for the held transaction");
}
export async function jointHumanWriteConcurrency({
  db,
  seed,
  baseUrl,
}: {
  db: Database;
  seed: ReturnType<typeof createSeed>;
  baseUrl: string;
}) {
  const owner = await seed.human(),
    victim = await seed.human();
  const h = await seed.server({ owner, members: [victim] }),
    b = await seed.server({ owner, members: [victim] });
  const created = await createJointChannel({
    hostServerId: h.id,
    createdByUserId: owner.id,
    name: "actual-writer-races",
    targetServerSlug: b.slug,
    invitedPeople: [`@${owner.name}`],
    userIds: [victim.id],
  });
  const target = await acceptJointChannelInvite({
    inviteId: created.invites[0]!.id,
    targetServerId: b.id,
    acceptedByUserId: owner.id,
  });
  const http = createHttpClient(baseUrl).as(victim, b);
  const send = (content: string) =>
    http.request("/api/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channelId: target.id, content }),
    });
  const persisted = async (content: string) =>
    (
      await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.channelId, created.jointChannel.canonicalChannelId),
            eq(messages.content, content),
          ),
        )
    ).length;
  {
    const ready = latch(),
      release = latch();
    let pid = 0;
    const removal = db.transaction(async (tx) => {
      pid = Number(
        (await tx.execute(sql`SELECT pg_backend_pid() pid`)).rows[0]!.pid,
      );
      await removeHuman(created.channel.id, victim.id, { self: true }, tx);
      ready.resolve();
      await release.promise;
    });
    await Promise.race([ready.promise, removal]);
    const posting = send("removed-first must not persist");
    try {
      await waitingOn(db, pid);
    } finally {
      release.resolve();
      await removal;
    }
    const response = await posting;
    assert.equal(response.status, 403, await response.clone().text());
    assert.equal(await persisted("removed-first must not persist"), 0);
  }
  await addHuman(created.channel.id, victim.id);
  {
    const ready = latch(),
      release = latch();
    const registry = new InMemoryFailpointRegistry({
      sleep: async () => {
        ready.resolve();
        await release.promise;
      },
    });
    registry.configure("server.message.newChatTransaction.afterFacts", {
      effect: "delay",
      payload: 0,
      mode: "once",
    });
    __setFailpointsForTests(registry);
    const posting = send("send-first remains one valid message");
    let removal: Promise<unknown> | undefined;
    try {
      const first = await Promise.race([
        ready.promise.then(() => true),
        posting.then(async (response) => {
          throw new Error(
            `message did not reach held persistence: ${response.status} ${await response.clone().text()}`,
          );
        }),
      ]);
      assert.equal(first, true);
      // The remover can wait on the earlier channel row fence before it
      // reaches the membership advisory lock. Observe its actual blocker.
      const held = await db.execute(sql`SELECT pid FROM pg_stat_activity
        WHERE datname=current_database() AND state='idle in transaction' AND pid<>pg_backend_pid()`);
      assert.equal(
        held.rows.length,
        1,
        "one actual message transaction is paused",
      );
      removal = removeHuman(created.channel.id, victim.id, { self: true });
      await waitingOn(db, Number(held.rows[0]!.pid));
    } finally {
      release.resolve();
      __resetFailpointsForTests();
    }
    const response = await posting;
    assert.equal(response.status, 200, await response.clone().text());
    await removal;
    assert.equal(await persisted("send-first remains one valid message"), 1);
  }
  await addHuman(created.channel.id, victim.id);
  const made = await createTasks(
    created.jointChannel.canonicalChannelId,
    "user",
    owner.id,
    [{ title: "task authority race" }],
    { initiatingServerId: h.id },
  );
  const task = made.tasks[0]!;
  const assigned = await assignTask(
    task.id,
    { type: "user", id: victim.id },
    "user",
    owner.id,
    { serverId: h.id },
  );
  assert.notEqual(typeof assigned, "string");
  {
    const ready = latch(),
      release = latch();
    const registry = new InMemoryFailpointRegistry({
      sleep: async () => {
        ready.resolve();
        await release.promise;
      },
    });
    registry.configure("server.task.canonicalStatus.afterAuthorizationRead", {
      effect: "delay",
      payload: 0,
      mode: "once",
    });
    __setFailpointsForTests(registry);
    const writing = updateTaskStatus(
      task.id,
      "in_progress",
      victim.id,
      "user",
      b.id,
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    try {
      await Promise.race([
        ready.promise,
        writing.then((result) => {
          throw new Error(
            `task did not reach authorization pause: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      await removeHuman(created.channel.id, victim.id, { self: true });
    } finally {
      release.resolve();
      __resetFailpointsForTests();
    }
    const result = await writing;
    assert.ok(
      "error" in result && result.error instanceof JointTaskWriteDeniedError,
    );
    const [unchanged] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id));
    assert.equal(unchanged!.status, "todo");
  }
  await addHuman(created.channel.id, victim.id);
  {
    const ready = latch(),
      release = latch();
    let pid = 0;
    const writing = db.transaction(async (tx) => {
      pid = Number(
        (await tx.execute(sql`SELECT pg_backend_pid() pid`)).rows[0]!.pid,
      );
      const result = await updateTaskStatus(
        task.id,
        "in_progress",
        victim.id,
        "user",
        b.id,
      );
      assert.notEqual(typeof result, "string");
      ready.resolve();
      await release.promise;
    });
    await Promise.race([ready.promise, writing]);
    const removal = removeHuman(created.channel.id, victim.id, { self: true });
    try {
      await waitingOn(db, pid);
    } finally {
      release.resolve();
      await writing;
    }
    await removal;
    const [committed] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.id, task.id));
    assert.equal(committed!.status, "in_progress");
  }
}
